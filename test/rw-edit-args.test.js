// rw_edit argument aliases: old/new vs old_string/new_string (+ file_path).
//
// Models habitually write old_string/new_string, matching the host's native edit
// tool (`dsh-tool-fs` declares file_path/old_string/new_string — verified in its
// lib/index.js:750-762). rw_edit only declared old/new, so defineTool's
// pre-execute schema validation rejected those calls with
//   `invalid arguments: missing required property "old"; missing required property "new"`
// and the model had to retry, usually with the other spelling.
//
// The original 4 cases come from PR #45 (@moesnow); this file extends them with
// the file_path alias and with the schema-shape assertions that make the
// mechanism explicit, since the fix depends on where `required` lives.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Build an isolated DSH_HOME with a machine registry and one mirror. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-edit-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })

  const machines = [
    { id: 'm-1', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-1' }))

  const cwd = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.11', port: 1, username: 'lucas', remotePath: '/home/lucas/proj' }))
  return { home, cwd }
}

function makeCtx() {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      inject: () => {},
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadTools(home) {
  process.env.DSH_HOME = home
  // Cache-busting query: apply() is stateful per module instance.
  const { apply } = await import(`../lib/index.js?edit=${Math.random()}`)
  const { ctx, tools } = makeCtx()
  await apply(ctx, { ...CONFIG })
  return tools
}

/** Run rw_edit and report the message it rejects with. */
const runEdit = (edit, args, cwd) =>
  edit.execute(args, execFor(cwd)).then(() => null, (e) => String(e.message))

/**
 * The proof that an argument spelling passed schema validation: the error is
 * from the SSH stage (unreachable 127.0.0.11), not "invalid arguments".
 * A schema rejection would never reach the network.
 */
const assertPassedValidation = (err, label) => {
  assert.ok(err, `${label}: an unreachable host must surface an error`)
  assert.ok(!/invalid arguments/.test(err), `${label}: must pass arg validation, got: ${err}`)
  assert.match(err, /127\.0\.0\.11/, `${label}: must proceed to the SSH stage, got: ${err}`)
}

test('rw_edit accepts old_string/new_string aliases without an INVALID_ARGS failure', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')
    assert.ok(edit, 'rw_edit must be registered')
    assertPassedValidation(
      await runEdit(edit, { path: '/home/lucas/proj/a.txt', old_string: 'x', new_string: 'y' }, cwd),
      'old_string/new_string',
    )
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit still accepts the original old/new names', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')
    assertPassedValidation(
      await runEdit(edit, { path: '/home/lucas/proj/a.txt', old: 'x', new: 'y' }, cwd),
      'old/new',
    )
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit accepts file_path as a path alias', async () => {
  // The host edit tool spells the path `file_path`; a model that mirrors the
  // native tool writes all three aliases together, so `path` must not be the
  // only accepted spelling.
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')
    assertPassedValidation(
      await runEdit(edit, { file_path: '/home/lucas/proj/a.txt', old_string: 'x', new_string: 'y' }, cwd),
      'file_path + old_string/new_string',
    )
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit names the missing argument clearly when neither spelling is given', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')

    const noOld = await runEdit(edit, { path: '/home/lucas/proj/a.txt', new: 'y' }, cwd)
    assert.match(noOld, /old text is required.*old_string/, `got: ${noOld}`)

    const noNew = await runEdit(edit, { path: '/home/lucas/proj/a.txt', old: 'x' }, cwd)
    assert.match(noNew, /replacement text is required.*new_string/, `got: ${noNew}`)

    const noPath = await runEdit(edit, { old: 'x', new: 'y' }, cwd)
    assert.match(noPath, /file path is required.*file_path/, `got: ${noPath}`)

    // Both spellings may be present; primary names win.
    const both = await runEdit(edit, { path: '/home/lucas/proj/a.txt', old: 'x', old_string: 'y' }, cwd)
    assert.match(both, /replacement text is required/, `got: ${both}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit schema declares both spellings and keeps them out of required', async () => {
  // The mechanism, pinned: an alias only works if it is declared in `properties`
  // AND its counterpart is NOT in `required` — because defineTool validates
  // against the compiled schema *before* execute runs. Putting `required: true`
  // back on old/new (or path) silently breaks the alias again.
  const { home } = makeHome()
  try {
    const tools = await loadTools(home)
    const schema = tools.get('rw_edit').parameters
    const props = schema.properties || {}
    const required = schema.required || []

    for (const key of ['path', 'old', 'new', 'old_string', 'new_string', 'file_path']) {
      assert.ok(props[key], `parameters must declare ${key}`)
    }
    // None of the aliasable names may be schema-required, or the sibling
    // spelling would be rejected before execute() could resolve it.
    for (const key of ['path', 'old', 'new', 'old_string', 'new_string', 'file_path']) {
      assert.ok(!required.includes(key),
        `${key} must not be in schema.required — it would reject the alias spelling before execute`)
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
