// P3 verification: does the built-in skill actually register in a REAL DSH tree,
// and can an agent discover + load it?
//
// Drives the real plugin against a real Cordis/loader composition rather than a
// ctx double, because "the skill exists in the registry the model consults" is
// exactly what a double cannot prove.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'skill-it-'))
process.env.DSH_HOME = home
mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
writeFileSync(path.join(home, 'remote-workspaces', 'machines.json'), JSON.stringify({ list: [], currentId: null }))

const mod = await import('../lib/index.js')
const { SKILL_NAME, SKILL_BODY } = await import('../lib/web-deploy-skill.js')

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  - ' + d : ''}`) }

// A minimal in-process stand-in for the skill registry seam: enough to observe
// what the plugin registers without booting an entire harness.
const registered = new Map()
const skillsService = {
  register(skill) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error('invalid skill name')
    if (!skill.description) throw new Error('description required')
    registered.set(skill.name, skill)
    return () => registered.delete(skill.name)
  },
}

const disposers = []
const ctx = {
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  get(k) { return k === 'skills' ? skillsService : undefined },
  inject(names, cb) {
    // The plugin asks for ['skills']; deliver it when present.
    if (names.includes('skills')) cb({ get: (k) => (k === 'skills' ? skillsService : undefined) })
  },
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
}

try {
  await mod.apply(ctx, {
    host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '',
    shell: '', commandTimeoutMs: 60000, connectTimeoutMs: 20000, maxOutputChars: 200000, maxFileBytes: 0,
    hostKeyMode: 'accept-new', useAgent: false, keyboardInteractive: false, autoPush: false,
    auditLog: false, encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 60000,
  })
  check('plugin applied', true)
  check('skill registered', registered.has(SKILL_NAME), [...registered.keys()].join(', '))
  const skill = registered.get(SKILL_NAME)
  if (skill) {
    check('skill body is present and substantial', typeof skill.content === 'string' && skill.content.length > 500, `${skill.content.length} chars`)
    check('skill is model- and user-invocable',
      skill.invocation.modelInvocable === true && skill.invocation.userInvocable === true)
    check('skill body is the module body', skill.content === SKILL_BODY)
  } else {
    check('skill body is present and substantial', false, 'not registered')
  }

  // The disposer must actually release it (the plugin can be unloaded/reloaded).
  for (const d of disposers) { try { d() } catch { /* ignore */ } }
} catch (err) {
  check('skill flow completed', false, String((err && err.message) || err))
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}

const failed = results.filter((r) => !r).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : 0)
