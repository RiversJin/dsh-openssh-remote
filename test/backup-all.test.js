// Tests for the "all workspaces in ONE archive" capability.
//
// This is the simple two-button feature the panel exposes, so the assertions are
// about the properties that make it safe: one archive really does self-describe,
// the member list maps back to absolute paths, the default excludes are derived
// (never hand-typed), and a corrupt archive cannot touch anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  buildCreateAllCommand, buildRestoreAllCommand, parseRestoredEntries, parseStatus,
  ALL_BACKUP_EXCLUDES, ALL_BACKUP_EXCLUDE_DIRS, expandExcludeDirs,
  ALL_MANIFEST_DIR, ALL_MANIFEST_FILE,
} from '../lib/archive.js'
import { createAllBackup, restoreAllBackup, assignMembers, memberForPath, allArchiveStem } from '../lib/backup.js'

// ── exclude derivation ──────────────────────────────────────────────────────

test('the default exclude set is DERIVED, so no invisible character can sneak in', () => {
  // A hand-typed star-slash pattern once carried a zero-width space (U+200B),
  // which made it match nothing while looking correct in a diff. Deriving the
  // star form from the bare name makes that impossible — assert it stays true.
  const nonAscii = ALL_BACKUP_EXCLUDES.filter((p) => /[^\x20-\x7e]/.test(p))
  assert.deepEqual(nonAscii, [], `exclude patterns must be printable ASCII: ${JSON.stringify(nonAscii)}`)
  // Both forms exist for every directory, because a slash-bearing tar pattern is
  // anchored (bare covers the top level, star-slash covers nested ones).
  for (const d of ALL_BACKUP_EXCLUDE_DIRS) {
    assert.ok(ALL_BACKUP_EXCLUDES.includes(d), `${d} must be present bare`)
    assert.ok(ALL_BACKUP_EXCLUDES.includes(`*/${d}`), `${d} must be present as */${d}`)
  }
  assert.deepEqual(expandExcludeDirs([]), [])
})

test('node_modules and friends are excluded at the top level AND nested', () => {
  const set = new Set(ALL_BACKUP_EXCLUDES)
  for (const d of ['node_modules', '.git', 'dist', 'build', 'target']) {
    assert.ok(set.has(d), `${d} (top level)`)
    assert.ok(set.has(`*/${d}`), `${d} (nested)`)
  }
})

// ── member mapping ──────────────────────────────────────────────────────────

test('a member is the full path without its leading slash', () => {
  // It MUST be the full path: members are added with `-C /`, so a shortened
  // member makes tar look in the wrong place and every run fails.
  assert.equal(memberForPath('/tmp/allws/w1'), 'tmp/allws/w1')
  assert.equal(memberForPath('/home/dev/my proj'), 'home/dev/my proj')
  for (const bad of ['relative/dir', '', '/']) {
    assert.throws(() => memberForPath(bad), /non-absolute/, `${JSON.stringify(bad)} must be refused`)
  }
})

test('assignMembers keeps distinct paths distinct and drops duplicates', () => {
  const out = assignMembers(['/a/x/proj', '/b/x/proj', '/a/x/proj', '/', ''])
  assert.deepEqual(out.map((o) => o.path), ['/a/x/proj', '/b/x/proj'])
  assert.deepEqual(out.map((o) => o.member), ['a/x/proj', 'b/x/proj'])
})

test('the archive stem identifies the machine and is stable', () => {
  const a = allArchiveStem({ host: 'h1', username: 'u', port: 22 })
  assert.equal(a, allArchiveStem({ host: 'h1', username: 'u', port: 22 }))
  assert.notEqual(a, allArchiveStem({ host: 'h2', username: 'u', port: 22 }))
  assert.match(a, /^workspaces-/)
})

// ── create ──────────────────────────────────────────────────────────────────

test('buildCreateAllCommand writes both manifest files BEFORE tar runs', () => {
  const cmd = buildCreateAllCommand({
    workspaces: [{ path: '/w/a', member: 'w/a' }],
    archive: '/b/x.tar.gz',
    manifestJson: '{"a":1}',
    pathsTsv: 'w/a\t/w/a\n',
    excludes: ['node_modules'],
  })
  const tarAt = cmd.indexOf('tar -czf')
  assert.ok(tarAt > -1)
  // Both files must exist before tar reads them; writing them after the tar line
  // is what made a real run fail with "Cannot stat".
  assert.ok(cmd.indexOf(`${ALL_MANIFEST_FILE}`) < tarAt, 'manifest.json written before tar')
  assert.ok(cmd.indexOf('paths.tsv') < tarAt, 'paths.tsv written before tar')
  assert.ok(cmd.includes(`mkdir -p "$ARCH_TMP/${ALL_MANIFEST_DIR}"`), 'the manifest directory is created')
  assert.ok(cmd.includes(`-C /`), 'members are rooted at /')
  assert.ok(!/\s-P\b/.test(cmd), 'never -P')
  assert.ok(!cmd.includes('--absolute-names'), 'never --absolute-names')
})

test('buildCreateAllCommand checks the REAL path of each workspace, not the member', () => {
  // The first version checked `/member`, which is a different path, so every run
  // failed with "these workspaces do not exist".
  const cmd = buildCreateAllCommand({
    workspaces: [{ path: '/tmp/allws/w1', member: 'tmp/allws/w1' }],
    archive: '/b/x.tar.gz', manifestJson: '{}', pathsTsv: '',
  })
  assert.ok(cmd.includes("if [ ! -d '/tmp/allws/w1' ]"), 'the absolute path is what is tested')
})

test('buildCreateAllCommand refuses to archive a non-absolute or ..-bearing path', () => {
  for (const ws of [[{ path: 'relative/dir', member: 'relative/dir' }], [{ path: '/a/../etc', member: 'a/etc' }], [{ path: '/a/b', member: '../evil' }]]) {
    assert.throws(() => buildCreateAllCommand({ workspaces: ws, archive: '/b/x.tar.gz' }), /refusing/, JSON.stringify(ws))
  }
})

test('buildCreateAllCommand refuses an ineffective exclude rather than running it', () => {
  for (const bad of ['/abs', './dot', '../up']) {
    assert.throws(
      () => buildCreateAllCommand({ workspaces: [{ path: '/w', member: 'w' }], archive: '/b/x.tar.gz', excludes: [bad] }),
      /unsafe\/ineffective/,
      `${bad} must be refused`,
    )
  }
})

// ── createAllBackup (orchestration) ─────────────────────────────────────────

function fakePool(createOut, restoreOut) {
  const calls = []
  return {
    calls,
    exec: async (script) => {
      calls.push(script)
      if (script.includes('ARCH_ENTRY=')) return { code: 0, stdout: restoreOut, stderr: '' }
      return { code: 0, stdout: createOut, stderr: '' }
    },
    sftp: async () => ({
      async stat() { throw Object.assign(new Error('nf'), { code: 2 }) },
      async writeFile() {},
      async readFile() { throw new Error('nf') },
      async mkdir() {},
    }),
  }
}

const CREATE_OK = 'ARCH_VERIFY=ok\nARCH_FILE=/b/x.tar.gz\nARCH_BYTES=100\nARCH_MEMBERS=5\nARCH_SHA=abc\nARCH_OK=1'

test('createAllBackup archives every workspace into ONE file and records the manifest', async () => {
  const pool = fakePool(CREATE_OK)
  const r = await createAllBackup(pool, {
    workspaces: ['/w/a', '/w/b'], backupDir: '/b', machine: { host: 'h', username: 'u', port: 22 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.workspaces.length, 2)
  assert.equal(r.sha256, 'abc')
  assert.equal(r.verified, true)
  // One tar invocation, one file.
  const tars = pool.calls.filter((c) => c.includes('tar -czf'))
  assert.equal(tars.length, 1, 'exactly one archive is produced')
  assert.match(r.name, /\.tar\.gz$/)
  assert.equal(r.meta.kind, 'dsh-remote/workspaces')
  assert.deepEqual(r.meta.workspaces.map((w) => w.path), ['/w/a', '/w/b'])
})

test('createAllBackup reports a failure (never a partial archive) with the reason', async () => {
  const pool = fakePool('ARCH_OK=0\nARCH_ERROR=tar failed with exit 2')
  const r = await createAllBackup(pool, { workspaces: ['/w/a'], backupDir: '/b' })
  assert.equal(r.ok, false)
  assert.match(r.error, /tar failed with exit 2/)
})

test('createAllBackup refuses an empty workspace list instead of making a junk archive', async () => {
  const pool = fakePool(CREATE_OK)
  const r = await createAllBackup(pool, { workspaces: [], backupDir: '/b' })
  assert.equal(r.ok, false)
  assert.equal(pool.calls.length, 0, 'nothing runs')
})

test('createAllBackup never lets the backup dir archive itself', async () => {
  const pool = fakePool(CREATE_OK)
  await createAllBackup(pool, { workspaces: ['/w'], backupDir: '/w/.dsh-remote/backups' })
  assert.ok(pool.calls[0].includes("'--exclude=.dsh-remote/backups'"), 'a nested backup dir is excluded')
})

// ── restore ─────────────────────────────────────────────────────────────────

test('buildRestoreAllCommand verifies BEFORE extracting, and never uses -P', () => {
  const cmd = buildRestoreAllCommand({ archive: '/b/x.tar.gz', fallbackRoot: '/tmp' })
  const verifyAt = cmd.indexOf('ARCH_VERIFY=bad')
  const extractAt = cmd.indexOf('tar -xzf')
  assert.ok(verifyAt > -1 && extractAt > -1)
  assert.ok(verifyAt < extractAt, 'the corrupt-archive guard runs first')
  assert.ok(!/\s-P\b/.test(cmd), 'never -P')
  // Relocation: move the old tree aside, install the new one, and only THEN drop
  // the old copy. Assert on the exact statements (a bare `rm -rf "$ARCH_SWAP"`
  // also appears as the pre-clean, so an indexOf compare would match the wrong
  // one).
  const moveAsideAt = cmd.indexOf('if ! mv "$ARCH_TARGET" "$ARCH_SWAP"')
  const installAt = cmd.indexOf('if mv "$ARCH_SRC" "$ARCH_TARGET"')
  assert.ok(moveAsideAt > -1 && installAt > moveAsideAt, 'the target is moved aside before the new tree is installed')
  const afterInstall = cmd.slice(installAt)
  assert.ok(afterInstall.includes('rm -rf "$ARCH_SWAP"'), 'the old copy is dropped only after the install')
  assert.ok(afterInstall.includes('mv "$ARCH_SWAP" "$ARCH_TARGET"'), 'a failed install restores the original')
  assert.ok(cmd.includes('ARCH_LIST'), 'the member↔path list drives the loop')
})

test('buildRestoreAllCommand falls back when the original path cannot be created', () => {
  const cmd = buildRestoreAllCommand({ archive: '/b/x.tar.gz', fallbackRoot: '/fallback' })
  assert.ok(cmd.includes("ARCH_TARGET=\"$ARCH_FALLBACK/$(basename \"$ARCH_TARGET\")\""), 'falls back to the fallback root')
})

test('restoreAllBackup reports every relocated workspace', async () => {
  const pool = fakePool(CREATE_OK, 'ARCH_VERIFY=ok\nARCH_ENTRY=/w/a\nARCH_ENTRY=/w/b\nARCH_MEMBERS=2\nARCH_OK=1')
  const r = await restoreAllBackup(pool, { archive: '/b/x.tar.gz' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.entries, ['/w/a', '/w/b'])
  assert.equal(r.members, 2)
  assert.equal(r.verified, true)
})

test('restoreAllBackup surfaces a corrupt archive as a refusal', async () => {
  const pool = fakePool(CREATE_OK, 'ARCH_VERIFY=bad\nARCH_OK=0\nARCH_ERROR=archive is corrupt or truncated; nothing was written')
  const r = await restoreAllBackup(pool, { archive: '/b/x.tar.gz' })
  assert.equal(r.ok, false)
  assert.match(r.error, /corrupt or truncated/)
  assert.equal(r.verified, false)
})

test('restoreAllBackup reports a PARTIAL restore honestly (ok + what failed)', async () => {
  const pool = fakePool(CREATE_OK, 'ARCH_VERIFY=ok\nARCH_ENTRY=/w/a\nARCH_MEMBERS=1\nARCH_ERROR=could not restore: /w/b\nARCH_OK=1')
  const r = await restoreAllBackup(pool, { archive: '/b/x.tar.gz' })
  assert.equal(r.ok, true, 'the workspaces that moved did move')
  assert.deepEqual(r.entries, ['/w/a'])
  assert.match(r.error, /could not restore/, 'and the failure is still reported')
})

test('restoreAllBackup refuses an empty archive path', async () => {
  const pool = fakePool(CREATE_OK, '')
  const r = await restoreAllBackup(pool, { archive: '' })
  assert.equal(r.ok, false)
  assert.equal(pool.calls.length, 0)
})

test('parseRestoredEntries collects every ARCH_ENTRY line', () => {
  assert.deepEqual(parseRestoredEntries('ARCH_ENTRY=/a\nARCH_OK=1\nARCH_ENTRY=/b'), ['/a', '/b'])
  assert.deepEqual(parseRestoredEntries('ARCH_OK=1'), [])
})

test('parseStatus reads the restore-all tail', () => {
  const s = parseStatus('ARCH_VERIFY=ok\nARCH_MEMBERS=3\nARCH_OK=1')
  assert.equal(s.ok, true)
  assert.equal(s.members, 3)
  assert.equal(s.verified, true)
})

// ── the generated shell is real shell ───────────────────────────────────────

function findSh() {
  for (const c of ['/bin/sh', 'sh', 'bash', '/bin/bash']) {
    try { execFileSync(c, ['-n'], { input: 'true', stdio: ['pipe', 'pipe', 'pipe'] }); return c } catch { /* next */ }
  }
  return null
}
const sh = findSh()

test('every all-workspaces script is POSIX-valid', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host')
  const scripts = []
  for (const dirs of [['/w/a'], ['/w/a', '/w/b'], ['/tmp/a b/c', "/home/o'brien/w"], ['/tmp/$(rm -rf /)']]) {
    scripts.push(buildCreateAllCommand({
      workspaces: assignMembers(dirs),
      archive: '/b/a b/x y.tar.gz',
      manifestJson: JSON.stringify({ paths: dirs }),
      pathsTsv: assignMembers(dirs).map((a) => `${a.member}\t${a.path}`).join('\n'),
      excludes: ALL_BACKUP_EXCLUDES,
    }))
  }
  scripts.push(buildRestoreAllCommand({ archive: '/b/a b/x y.tar.gz', fallbackRoot: '/tmp/f b' }))
  for (const s of scripts) {
    let err = null
    try { execFileSync(sh, ['-n'], { input: s, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { err = String((e && (e.stderr || e.message)) || e) }
    assert.equal(err, null, `invalid shell:\n${err}\n---\n${s}`)
  }
})

test('the all-workspaces shell gate can actually fail (negative control)', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host')
  let err = null
  try { execFileSync(sh, ['-n'], { input: 'while read a b\ndo\necho x\n', stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { err = String((e && e.stderr) || e) }
  assert.notEqual(err, null, 'an unterminated while must be rejected')
})
