// Unit tests for lib/backup.js — orchestration over an injected pool.
//
// A fake pool runs the REAL generated scripts through a tiny in-memory model so
// the orchestration can be tested without a network. The script text is asserted
// too, because "which script was sent" is the contract the remote sees.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createBackup, listBackups, verifyBackup, deleteBackup, restoreBackup,
  resolveRemoteHome, uniqueArchivePath, pullBackup, pushBackup,
  listLocalBackups, deleteLocalBackup, verifyLocalBackup, localBackupDirFor,
  describeCreate, transferCapExceeded,
} from '../lib/backup.js'
import { MARK, META_BEGIN_MARK, metaNameFor } from '../lib/archive.js'

/**
 * A fake SSH pool.
 *
 * `exec` records the script and replies with a canned response, so tests can
 * assert both the script that was sent and how a given reply is interpreted.
 * `sftp` exposes just the surface lib/backup.js uses.
 */
function makePool({ execReply, files = new Map(), failStat = null } = {}) {
  const calls = []
  const written = new Map()
  const sftp = {
    async stat(p) {
      if (failStat && failStat(p)) throw Object.assign(new Error('boom'), { code: 5 })
      const f = files.get(p)
      if (!f) throw Object.assign(new Error('no such file: ' + p), { code: 2 })
      return { size: f.length, mtime: 1700000000, isDirectory: () => false }
    },
    async readFile(p) {
      const f = files.get(p)
      if (!f) throw Object.assign(new Error('no such file: ' + p), { code: 2 })
      return Buffer.from(f)
    },
    async writeFile(p, buf) {
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
      files.set(p, text)
      written.set(p, text)
    },
    async fastGet(p, local) {
      if (!files.has(p)) throw Object.assign(new Error('no such file: ' + p), { code: 2 })
      writeFileSync(local, files.get(p))
    },
    async fastPut(local, p) {
      files.set(p, readFileSync(local))
      written.set(p, '<local file>')
    },
  }
  return {
    calls,
    written,
    files,
    exec: async (script) => {
      calls.push(script)
      const reply = typeof execReply === 'function' ? execReply(script, calls.length) : execReply
      return reply || { code: 0, stdout: '', stderr: '' }
    },
    sftp: async () => sftp,
  }
}

const OK_CREATE = [
  'ARCH_VERIFY=ok',
  'ARCH_FILE=/b/x.tar.gz',
  'ARCH_BYTES=2048',
  'ARCH_MEMBERS=12',
  'ARCH_SHA=deadbeef',
  'ARCH_OK=1',
].join('\n')

// ── HOME resolution ─────────────────────────────────────────────────────────

test('resolveRemoteHome reads the ARCH_HOME marker', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: `${MARK.home}=/home/dev\n`, stderr: '' } })
  assert.equal(await resolveRemoteHome(pool), '/home/dev')
  assert.match(pool.calls[0], /ARCH_H="\$HOME"/)
})

test('resolveRemoteHome returns empty for a non-absolute or missing answer', async () => {
  assert.equal(await resolveRemoteHome(makePool({ execReply: { code: 0, stdout: `${MARK.home}=relative/dir`, stderr: '' } })), '')
  assert.equal(await resolveRemoteHome(makePool({ execReply: { code: 0, stdout: '', stderr: '' } })), '')
})

test('resolveRemoteHome returns empty when exec throws (no home, no crash)', async () => {
  const pool = { exec: async () => { throw new Error('ssh down') }, sftp: async () => ({}) }
  assert.equal(await resolveRemoteHome(pool), '')
})

// ── create ──────────────────────────────────────────────────────────────────

test('createBackup sends an exclude-bearing script and records a sidecar', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: OK_CREATE, stderr: '' } })
  const r = await createBackup(pool, {
    dir: '/home/dev/proj', backupDir: '/b', label: 'manual', excludes: ['node_modules', 'src/dist'],
  })
  assert.equal(r.ok, true)
  assert.equal(r.bytes, 2048)
  assert.equal(r.members, 12)
  assert.equal(r.sha256, 'deadbeef')
  assert.equal(r.verified, true)
  const script = pool.calls[0]
  assert.match(script, /'--exclude=node_modules'/)
  assert.match(script, /'--exclude=src\/dist'/)
  // The sidecar lands next to the archive and records the workspace.
  const metaPath = `${'/b'}/${metaNameFor(r.name)}`
  const meta = JSON.parse(pool.written.get(metaPath))
  assert.equal(meta.workspace, '/home/dev/proj')
  assert.equal(meta.sha256, 'deadbeef')
  assert.equal(meta.label, 'manual')
  assert.deepEqual(meta.excludes, ['node_modules', 'src/dist'])
})

test('createBackup resolves the backup dir from the remote home when not given', async () => {
  const pool = makePool({
    execReply: (script) => (script.includes('ARCH_H=') && !script.includes('tar -czf')
      ? { code: 0, stdout: `${MARK.home}=/home/dev\n`, stderr: '' }
      : { code: 0, stdout: OK_CREATE, stderr: '' }),
  })
  const r = await createBackup(pool, { dir: '/home/dev/proj' })
  assert.equal(r.ok, true)
  assert.match(r.archive, /^\/home\/dev\/\.dsh-remote\/backups\//, 'default backup dir is $HOME/.dsh-remote/backups')
})

test('createBackup never lets the backup directory archive itself', async () => {
  // A backup dir INSIDE the workspace would otherwise be embedded in every run,
  // so each archive would contain the previous one.
  const pool = makePool({ execReply: { code: 0, stdout: OK_CREATE, stderr: '' } })
  await createBackup(pool, { dir: '/w', backupDir: '/w/.dsh-remote/backups' })
  const script = pool.calls[0]
  assert.match(script, /'--exclude=\.dsh-remote\/backups'/, 'the nested backup dir must be excluded')
})

test('createBackup refuses an escaping exclude instead of building the archive', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: OK_CREATE, stderr: '' } })
  const r = await createBackup(pool, { dir: '/w', backupDir: '/b', excludes: ['../secrets'] })
  assert.equal(r.ok, false)
  assert.match(r.error, /escapes the workspace/)
  assert.equal(pool.calls.length, 0, 'no script may run for a rejected exclude list')
})

test('createBackup surfaces the tar error AND stderr, not just "exit 2"', async () => {
  const pool = makePool({
    execReply: { code: 2, stdout: `${MARK.ok}=0\n${MARK.error}=tar failed with exit 2`, stderr: 'tar: /w: Cannot stat: No such file' },
  })
  const r = await createBackup(pool, { dir: '/w', backupDir: '/b' })
  assert.equal(r.ok, false)
  assert.match(r.error, /tar failed with exit 2/)
  assert.match(r.error, /Cannot stat/, "tar's own message is the actionable part")
})

test('createBackup reports a failed backup (never a half-done one) when a stat fails', async () => {
  // A transient SFTP failure while picking a free name must abort the run: the
  // archive is staged and only renamed on success, so nothing is published.
  const pool = makePool({
    execReply: { code: 0, stdout: OK_CREATE, stderr: '' },
    failStat: (p) => p.endsWith('.tar.gz'),
  })
  const r = await createBackup(pool, { dir: '/w', backupDir: '/b' })
  assert.equal(r.ok, false)
  assert.match(r.error, /cannot stat/)
  assert.equal(pool.calls.length, 0, 'nothing may be executed when the name cannot be chosen safely')
})

test('createBackup reports an unreadable sidecar write without failing the backup', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: OK_CREATE, stderr: '' } })
  const sftp = await pool.sftp()
  sftp.writeFile = async () => { throw new Error('read-only fs') }
  const r = await createBackup(pool, { dir: '/w', backupDir: '/b' })
  assert.equal(r.ok, true, 'the archive itself succeeded')
  assert.equal(r.metaWritten, false, 'and the sidecar failure is reported, not hidden')
})

// ── unique naming ───────────────────────────────────────────────────────────

test('uniqueArchivePath avoids an existing archive by suffixing -2, -3', async () => {
  const files = new Map([['/b/x.tar.gz', 'a'], ['/b/x-2.tar.gz', 'b']])
  const pool = makePool({ files })
  assert.equal(await uniqueArchivePath(pool, '/b', 'x.tar.gz'), '/b/x-3.tar.gz')
  assert.equal(await uniqueArchivePath(pool, '/b', 'fresh.tar.gz'), '/b/fresh.tar.gz')
})

// ── list ────────────────────────────────────────────────────────────────────

test('listBackups merges on-disk truth with sidecars and sorts newest first', async () => {
  const out = [
    'ARCH_EXISTS=1',
    'ARCH_ENTRY=old.tar.gz|10|1700000000',
    `${META_BEGIN_MARK}=old.tar.gz`,
    '{"workspace":"/w","members":1}',
    'ARCH_META_END',
    'ARCH_ENTRY=new.tar.gz|20|1800000000',
    `${META_BEGIN_MARK}=new.tar.gz`,
    '{"workspace":"/w","members":2,"sha256":"ff"}',
    'ARCH_META_END',
  ].join('\n')
  const { entries } = await listBackups(makePool({ execReply: { code: 0, stdout: out, stderr: '' } }), { dir: '/b' })
  assert.deepEqual(entries.map((e) => e.name), ['new.tar.gz', 'old.tar.gz'])
  assert.equal(entries[0].sha256, 'ff')
  assert.equal(entries[0].workspace, '/w')
  assert.equal(entries[0].mtime, new Date(1800000000000).toISOString())
})

test('listBackups drops entries whose names are unsafe', async () => {
  // The remote is not trusted to hand back a benign filename: anything that is
  // not a plain *.tar.gz basename is filtered before the UI can act on it.
  const out = [
    'ARCH_EXISTS=1',
    'ARCH_ENTRY=ok.tar.gz|10|1700000000',
    'ARCH_ENTRY=../../etc/passwd.tar.gz|10|1700000000',
    'ARCH_ENTRY=evil.sh|10|1700000000',
  ].join('\n')
  const { entries } = await listBackups(makePool({ execReply: { code: 0, stdout: out, stderr: '' } }), { dir: '/b' })
  assert.deepEqual(entries.map((e) => e.name), ['ok.tar.gz'])
})

test('listBackups reports a missing directory as not existing rather than failing', async () => {
  const r = await listBackups(makePool({ execReply: { code: 0, stdout: 'ARCH_EXISTS=0', stderr: '' } }), { dir: '/b' })
  assert.equal(r.exists, false)
  assert.deepEqual(r.entries, [])
})

// ── verify / delete ─────────────────────────────────────────────────────────

test('verifyBackup reports integrity and the digest', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_VERIFY=ok\nARCH_SHA=aa\nARCH_BYTES=5\nARCH_OK=1', stderr: '' } })
  const r = await verifyBackup(pool, { archive: '/b/x.tar.gz' })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.sha256, 'aa')
  assert.match(pool.calls[0], /tar -tzf/)
})

test('deleteBackup removes the archive and its sidecar', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_OK=1', stderr: '' } })
  const r = await deleteBackup(pool, { archive: '/b/x.tar.gz' })
  assert.equal(r.ok, true)
  // The script removes the two paths it was given; assert on the assignments
  // (the literal path) and on the rm targets (the variables it guards).
  const script = pool.calls[0]
  assert.match(script, /ARCH_F='\/b\/x\.tar\.gz'/)
  assert.match(script, /ARCH_M='\/b\/x\.meta\.json'/)
  assert.match(script, /rm -f "\$ARCH_F"/)
  assert.match(script, /rm -f "\$ARCH_M"/)
})

// ── restore ─────────────────────────────────────────────────────────────────

test('restoreBackup reports the mode actually applied', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_VERIFY=ok\nARCH_ACTION=replaced\nARCH_MEMBERS=7\nARCH_OK=1', stderr: '' } })
  const r = await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/w', mode: 'replace' })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'replace')
  assert.equal(r.members, 7)
  assert.equal(r.verified, true)
})

test('restoreBackup normalizes a non-merge mode to replace', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_ACTION=merged\nARCH_OK=1', stderr: '' } })
  const r = await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/w', mode: 'MERGE' })
  assert.equal(r.mode, 'merge')
})

test('restoreBackup refuses to restore onto the filesystem root', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_OK=1', stderr: '' } })
  const r = await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/' })
  assert.equal(r.ok, false)
  assert.equal(pool.calls.length, 0, 'no destructive script may run against /')
})

test('restoreBackup surfaces the reason a corrupt archive was refused', async () => {
  const pool = makePool({
    execReply: { code: 1, stdout: `ARCH_VERIFY=bad\n${MARK.ok}=0\n${MARK.error}=archive is corrupt or truncated; nothing was written`, stderr: '' },
  })
  const r = await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/w' })
  assert.equal(r.ok, false)
  assert.match(r.error, /corrupt or truncated/)
  assert.equal(r.verified, false)
})

test('restoreBackup reports raw stderr when the script dies without a marker', async () => {
  // e.g. the run was killed, or the parent directory is unwritable.
  const pool = makePool({ execReply: { code: 137, stdout: '', stderr: 'Killed' } })
  const r = await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/w' })
  assert.equal(r.ok, false)
  assert.match(r.error, /Killed/)
})

test('restoreBackup uses sibling staging/swap paths (same filesystem, atomic mv)', async () => {
  const pool = makePool({ execReply: { code: 0, stdout: 'ARCH_OK=1\nARCH_ACTION=replaced', stderr: '' } })
  await restoreBackup(pool, { archive: '/b/x.tar.gz', target: '/w/proj' })
  const script = pool.calls[0]
  const stage = /ARCH_STAGE='([^']+)'/.exec(script)[1]
  const swap = /ARCH_SWAP='([^']+)'/.exec(script)[1]
  assert.ok(stage.startsWith('/w/proj.'), `stage must be a sibling of the target, got ${stage}`)
  assert.ok(swap.startsWith('/w/proj.'), `swap must be a sibling of the target, got ${swap}`)
  assert.notEqual(stage, swap)
})

// ── transfer cap ────────────────────────────────────────────────────────────

test('transferCapExceeded treats 0 as unlimited', () => {
  assert.equal(transferCapExceeded(10 ** 12, 0), false)
  assert.equal(transferCapExceeded(10, 5), true)
  assert.equal(transferCapExceeded(5, 5), false)
})

test('pullBackup refuses an archive over the transfer cap', async () => {
  const files = new Map([['/b/big.tar.gz', 'x'.repeat(100)]])
  const r = await pullBackup(makePool({ files }), { archive: '/b/big.tar.gz', localDir: '/tmp/none', maxTransferBytes: 10 })
  assert.equal(r.ok, false)
  assert.match(r.error, /transfer cap/)
})

test('pushBackup refuses a suspicious local name', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-push-'))
  try {
    const p = path.join(dir, 'weird name.tar.gz')
    writeFileSync(p, 'x')
    const r = await pushBackup(makePool({}), { localPath: p, remoteDir: '/b' })
    assert.equal(r.ok, false)
    assert.match(r.error, /suspicious archive name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── local side ──────────────────────────────────────────────────────────────

test('local round trip: pull, list, verify, delete', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-local-'))
  try {
    const files = new Map([
      ['/b/x.tar.gz', 'ARCHIVE-BYTES'],
      ['/b/x.meta.json', JSON.stringify({ workspace: '/w', sha256: 'PLACEHOLDER', members: 4 })],
    ])
    const pool = makePool({ files })
    const pulled = await pullBackup(pool, { archive: '/b/x.tar.gz', localDir: dir, maxTransferBytes: 0 })
    assert.equal(pulled.ok, true)
    assert.equal(pulled.metaPulled, true, 'the sidecar is pulled alongside the archive')

    const listed = listLocalBackups(dir)
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].workspace, '/w')

    // The recorded digest is deliberately wrong here, so a verify that claims
    // "matches" without recomputing would be caught.
    const v = verifyLocalBackup(dir, 'x.tar.gz')
    assert.equal(v.matches, false, 'a stale/incorrect recorded digest must be reported as a mismatch')
    assert.ok(v.sha256 && v.sha256 !== 'PLACEHOLDER', 'the digest is recomputed from the local bytes')

    const del = deleteLocalBackup(dir, 'x.tar.gz')
    assert.equal(del.ok, true)
    assert.equal(existsSync(path.join(dir, 'x.tar.gz')), false)
    assert.equal(existsSync(path.join(dir, 'x.meta.json')), false, 'the sidecar goes too')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyLocalBackup reports null (unverified) rather than false when there is no sidecar', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-nometa-'))
  try {
    writeFileSync(path.join(dir, 'x.tar.gz'), 'bytes')
    const v = verifyLocalBackup(dir, 'x.tar.gz')
    assert.equal(v.ok, true)
    assert.equal(v.matches, null, 'no recorded digest means "unverified", not "corrupt"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local listing and delete both refuse an unsafe name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-safe-'))
  try {
    assert.equal(deleteLocalBackup(dir, '../../etc/passwd').ok, false)
    assert.equal(verifyLocalBackup(dir, '../x.tar.gz').ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listLocalBackups on a missing directory is empty, not an error', () => {
  const r = listLocalBackups(path.join(tmpdir(), 'definitely-missing-' + Date.now()))
  assert.equal(r.exists, false)
  assert.deepEqual(r.entries, [])
})

test('localBackupDirFor nests pulled archives under the machine root', () => {
  assert.equal(localBackupDirFor('/root/host-tag'), path.join('/root/host-tag', 'backups'))
})

// ── presentation ────────────────────────────────────────────────────────────

test('describeCreate names the destination and never claims success on failure', () => {
  assert.match(describeCreate({ ok: false, error: 'boom' }), /^backup failed: boom/)
  assert.match(describeCreate({ ok: true, name: 'x.tar.gz', bytes: 2048, members: 3, verified: true, sha256: 'abcdef' }), /created x\.tar\.gz/)
  assert.match(describeCreate({ ok: true, name: 'x.tar.gz', bytes: 10 }, { dest: 'both' }), /both the remote and the local/)
  assert.match(describeCreate({ ok: true, name: 'x.tar.gz', bytes: 10 }, { dest: 'local' }), /local machine/)
})
