// Issue #46 P3 — the built-in deployment skill and the AI escape hatch.
//
// Layer 1 (lib/web-deploy.js) is deterministic and handles the common case. This
// layer exists for everything it cannot express, so what matters here is:
//   • the skill is registered correctly (or its absence never breaks the plugin);
//   • the skill BODY actually carries the two failure signatures measured on a
//     real host — a generic "install dsh" text would have been useless for both;
//   • the investigate prompt hands over the REAL evidence verbatim, because that
//     evidence is the entire reason the deterministic path gave up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SKILL_NAME, SKILL_BODY, registerDeploySkill, buildInvestigatePrompt } from '../lib/web-deploy-skill.js'
import { DEFAULT_INSTALL_VERSION, DEFAULT_PREFIX_SUFFIX } from '../lib/web-deploy.js'

// ── registration ────────────────────────────────────────────────────────────

/** A ctx double exposing only what the registrar touches. */
function ctxWith(skills, logger) {
  return { get: (k) => (k === 'skills' ? skills : undefined), ...(logger ? { logger } : {}) }
}

test('registration uses a valid kebab-case name and a real description', () => {
  assert.match(SKILL_NAME, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'the registry rejects other shapes')
  let captured
  const ok = registerDeploySkill(ctxWith({ register: (s) => { captured = s } }))
  assert.equal(ok, true)
  assert.equal(captured.name, SKILL_NAME)
  assert.ok(captured.description.length > 0, 'a description is required')
  assert.equal(typeof captured.content, 'string')
  assert.ok(captured.content.length > 500, 'the body must carry real guidance, not a stub')
  assert.equal(captured.source, 'dsh-openssh-remote')
})

test('the skill is reachable by BOTH the model and the settings button', () => {
  let captured
  registerDeploySkill(ctxWith({ register: (s) => { captured = s } }))
  // The button starts a session that must be able to load it; the model should
  // also be able to reach for it when an orw_* call fails in a deploy-shaped way.
  assert.deepEqual(captured.invocation, { modelInvocable: true, userInvocable: true })
})

test('a composition without a skill registry is not an error', () => {
  assert.equal(registerDeploySkill({ get: () => undefined }), false)
  assert.equal(registerDeploySkill({ get: () => ({}) }), false, 'no register() method')
})

test('a failing registry never breaks the plugin', () => {
  let warned
  const ok = registerDeploySkill(ctxWith(
    { register() { throw new Error('registry boom') } },
    { warn: (e) => { warned = e } },
  ))
  assert.equal(ok, false, 'the AI fallback is optional; the deterministic path must survive')
  assert.match(String(warned && warned.message), /deploy skill not registered/)
})

test('a registry that throws AND has no logger still returns false', () => {
  assert.equal(registerDeploySkill({ get: () => ({ register() { throw new Error('x') } }) }), false)
})

// ── the body must contain the hard-won knowledge ────────────────────────────

test('the body names the node-pty failure and its fix', () => {
  // Measured: this is the failure that made the feature necessary at all.
  assert.match(SKILL_BODY, /pty\.node/, 'the exact error text must appear')
  assert.match(SKILL_BODY, /linux-x64/, 'the missing prebuild is the root cause')
  assert.match(SKILL_BODY, new RegExp(DEFAULT_INSTALL_VERSION.replace(/\./g, '\\.')), 'the fixing version')
})

test('the body names the --no-open version difference', () => {
  assert.match(SKILL_BODY, /--no-open/)
  assert.match(SKILL_BODY, /unknown option/, 'the literal error is the searchable clue')
})

test('the body warns which errors are NOT deployment problems', () => {
  // Without this the agent may "fix" the remote for a host-side misconfiguration.
  for (const needle of ['NO_ADAPTER', 'no API key', 'QUOTA']) {
    assert.ok(SKILL_BODY.includes(needle), `must call out ${needle} as out of scope`)
  }
})

test('the body prescribes a private prefix, never a global install', () => {
  assert.ok(SKILL_BODY.includes(DEFAULT_PREFIX_SUFFIX), 'points at the private prefix')
  assert.match(SKILL_BODY, /不要.*npm i -g/, 'explicitly forbids the global install')
  assert.match(SKILL_BODY, /--prefix/, 'shows the private-prefix form')
})

test('the body carries the symlink trap that produced a false negative', () => {
  // Measured: dirname(dirname(realpath(.bin/dsh))) lands INSIDE the package, so a
  // good install looked like "pty missing".
  assert.match(SKILL_BODY, /符号链接/, 'names the symlink')
  assert.match(SKILL_BODY, /node_modules/, 'gives the correct walk-up rule')
})

test('the body requires end-to-end proof and cleanup, not just a successful install', () => {
  assert.match(SKILL_BODY, /端到端|证明/, 'installing is not the same as working')
  assert.match(SKILL_BODY, /token/, 'the proof is the startup token line')
  assert.match(SKILL_BODY, /清理/, 'must clean up what it started')
})

test('the body tells the agent to ask before escalating privileges', () => {
  assert.match(SKILL_BODY, /sudo/)
  assert.match(SKILL_BODY, /问用户|先确认|问我/, 'privilege changes need consent')
})

// ── the investigate prompt ──────────────────────────────────────────────────

test('the prompt names the skill so the agent loads it', () => {
  const p = buildInvestigatePrompt({ host: '10.0.0.5', user: 'dev' })
  assert.ok(p.includes(SKILL_NAME))
  assert.ok(p.includes('10.0.0.5'))
})

test('the prompt passes findings, facts and the raw error verbatim', () => {
  const p = buildInvestigatePrompt({
    host: 'h', findings: [{ severity: 'blocker', summary: 'pty missing', detail: 'detail here', code: 'PTY_MISSING' }],
    facts: { platform: 'Linux', ptyPrebuild: 'no' },
    error: 'the remote DSH exited during startup: Failed to load native module: pty.node',
  })
  assert.match(p, /\[blocker\] pty missing/)
  assert.match(p, /detail here/)
  assert.match(p, /"platform": "Linux"/, 'facts are included as JSON so nothing is paraphrased')
  assert.match(p, /Failed to load native module/, 'the raw error is the key evidence')
})

test('the prompt still makes sense with no context at all', () => {
  const p = buildInvestigatePrompt()
  assert.ok(p.includes(SKILL_NAME))
  assert.ok(p.length > 100, 'a bare prompt must still be actionable')
  assert.doesNotMatch(p, /undefined|null/, 'absent context must not leak placeholder text')
})

test('oversized context is bounded so the prompt cannot explode', () => {
  const p = buildInvestigatePrompt({
    host: 'h',
    error: 'x'.repeat(10000),
    facts: { blob: 'y'.repeat(10000) },
  })
  assert.ok(p.length < 6000, `prompt must stay bounded, was ${p.length}`)
})

test('the prompt restates the safety constraints', () => {
  const p = buildInvestigatePrompt({ host: 'h' })
  assert.match(p, /私有前缀/, 'private prefix, not global')
  assert.match(p, /清理/, 'cleanup')
  assert.match(p, /问我|先问/, 'ask before privilege changes')
})

// ── the body must not name tools that do not exist ──────────────────────────
// Found by a review: the body told the agent to call `orw_deploy_probe`, but the
// tool had never been registered — a hedge ("if available") made it not a crash,
// just a guaranteed dead end on the agent's first move.
test('every orw_* tool the skill names is actually registered', () => {
  const named = new Set([...SKILL_BODY.matchAll(/\borw_[a-z_]+/g)].map((m) => m[0]))
  assert.ok(named.size > 0, 'the body must point at real tools')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const registered = new Set([...src.matchAll(/name: '(orw_[a-z_]+)'/g)].map((m) => m[1]))
  const missing = [...named].filter((n) => !registered.has(n))
  assert.deepEqual(missing, [], `the skill names tools that do not exist: ${missing.join(', ')}`)
})

test('the tool-name check can actually detect a missing tool', () => {
  const src = "defineTool({ name: 'orw_exists' })"
  const registered = new Set([...src.matchAll(/name: '(orw_[a-z_]+)'/g)].map((m) => m[1]))
  assert.deepEqual(['orw_exists', 'orw_missing'].filter((n) => !registered.has(n)), ['orw_missing'])
})

test('the body does not hedge about whether orw_deploy_probe exists', () => {
  // "if available" would silently degrade the agent's first instruction.
  assert.doesNotMatch(SKILL_BODY, /orw_deploy_probe[^。\n]{0,12}(如果可用|若可用|if available)/)
  assert.match(SKILL_BODY, /orw_deploy_probe/, 'the primary tool must be named')
})
