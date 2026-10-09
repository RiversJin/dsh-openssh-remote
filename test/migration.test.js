import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrateLegacyData } from '../lib/index.js'

function withHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-migrate-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return fn(home) } finally {
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
}

test('first start copies upstream data into an isolated namespace and renames private files', () => withHome((home) => {
  const legacy = path.join(home, 'remote-workspaces')
  const mirror = path.join(legacy, 'host-user-22', 'project')
  mkdirSync(mirror, { recursive: true })
  writeFileSync(path.join(legacy, 'machines.json'), '{"list":[]}')
  writeFileSync(path.join(legacy, '.dsh-remote-ignore'), 'node_modules\n')
  writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), '{"remotePath":"/project"}')
  writeFileSync(path.join(mirror, '.dsh-remote-sync-state.json'), '{}')
  writeFileSync(path.join(mirror, 'README.md'), 'user file')

  migrateLegacyData()

  const target = path.join(home, 'openssh-remote-workspaces')
  assert.equal(readFileSync(path.join(target, 'machines.json'), 'utf8'), '{"list":[]}')
  assert.equal(readFileSync(path.join(target, '.dsh-openssh-remote-ignore'), 'utf8'), 'node_modules\n')
  assert.equal(readFileSync(path.join(target, 'host-user-22', 'project', '.dsh-openssh-remote-meta.json'), 'utf8'), '{"remotePath":"/project"}')
  assert.ok(existsSync(path.join(target, 'host-user-22', 'project', '.dsh-openssh-remote-sync-state.json')))
  assert.equal(readFileSync(path.join(target, 'host-user-22', 'project', 'README.md'), 'utf8'), 'user file')
  assert.ok(existsSync(path.join(target, '.migrated-from-dsh-remote')))
  assert.ok(existsSync(path.join(mirror, '.dsh-remote-meta.json')), 'legacy tree is not modified')
}))

test('migration never overwrites an existing new namespace', () => withHome((home) => {
  const legacy = path.join(home, 'remote-workspaces')
  const target = path.join(home, 'openssh-remote-workspaces')
  mkdirSync(legacy, { recursive: true }); mkdirSync(target, { recursive: true })
  writeFileSync(path.join(legacy, 'machines.json'), 'old')
  writeFileSync(path.join(target, 'machines.json'), 'new')
  migrateLegacyData()
  assert.equal(readFileSync(path.join(target, 'machines.json'), 'utf8'), 'new')
}))
