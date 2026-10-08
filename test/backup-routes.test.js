// Route tests for /dsh-remote/backup.
//
// The handler is driven through its real definition with an injected binding, so
// the guards that matter (destructive-action confirmation, filename traversal,
// staying inside the workspace) are tested against the production code path
// rather than a re-implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBackupRoutes } from '../lib/routes-backup.js'

/** A response double recording what the handler wrote. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk != null) this.payload += String(chunk) },
  }
}

/** A request double carrying a JSON body, like node:http delivers. */
function makeReq({ method = 'GET', url = '/dsh-remote/backup', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
})

/** A pool whose exec replies are keyed by what the script is doing. */
function makePool({ create = 'ARCH_VERIFY=ok\nARCH_FILE=/b/x.tar.gz\nARCH_BYTES=10\nARCH_MEMBERS=2\nARCH_SHA=aa\nARCH_OK=1', list = 'ARCH_EXISTS=0' } = {}) {
  const calls = []
  const files = new Map()
  return {
    calls,
    files,
    exec: async (script) => {
      calls.push(script)
      // The generated script reads `ARCH_H="$HOME"` (quoted), so match on the
      // assignment prefix rather than an exact form.
      if (script.includes('ARCH_H=')) return { code: 0, stdout: 'ARCH_HOME=/home/dev', stderr: '' }
      if (script.includes('tar -czf')) return { code: 0, stdout: create, stderr: '' }
      if (script.includes('ARCH_EXISTS')) return { code: 0, stdout: list, stderr: '' }
      // RESTORE first: a restore script also contains `tar -tzf` (its own
      // pre-flight verify), so a tzf-first check would answer a restore as if it
      // were a standalone verify and silently drop the action.
      if (script.includes('tar -xzf')) {
        // Mirror the mode the script was built for: reporting a fixed mode would
        // make a mode-plumbing regression invisible.
        const action = script.includes('ARCH_ACTION=merged') ? 'merged' : 'replaced'
        return { code: 0, stdout: `ARCH_ACTION=${action}\nARCH_MEMBERS=3\nARCH_OK=1`, stderr: '' }
      }
      if (script.includes('tar -tzf')) return { code: 0, stdout: 'ARCH_VERIFY=ok\nARCH_SHA=aa\nARCH_OK=1', stderr: '' }
      if (script.includes('rm -f "$ARCH_F"')) return { code: 0, stdout: 'ARCH_OK=1', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    sftp: async () => ({
      async stat() { throw Object.assign(new Error('no such file'), { code: 2 }) },
      async writeFile(p, b) { files.set(p, String(b)) },
      async readFile() { throw Object.assign(new Error('no such file'), { code: 2 }) },
      async mkdir() {},
      async fastGet() { throw new Error('no such file') },
      async fastPut() {},
    }),
  }
}

function build({ config = {}, pool = makePool(), binding, localRoot = path.join(tmpdir(), 'bk-routes-local') } = {}) {
  const audited = []
  const routes = createBackupRoutes({
    sendJson: (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) },
    readBody,
    config: {
      backupDir: '',
      backupExcludes: [],
      maxBackupTransferBytes: 0,
      ...config,
    },
    audit: (op, detail, code) => audited.push({ op, detail, code }),
    resolveRequestBinding: async () => binding || {
      pool, ws: '/home/dev/proj', host: 'h', username: 'u', port: 22, mirrorDir: '/mirror',
    },
    localRootFor: () => localRoot,
  })
  const route = routes.find((r) => r.path === '/dsh-remote/backup')
  return { route, audited, localRoot }
}

async function call(route, req) {
  const res = makeRes()
  await route.handler(req, res)
  let body = {}
  try { body = JSON.parse(res.payload) } catch { /* non-JSON */ }
  return { status: res.statusCode, body, raw: res.payload }
}

// ── method / action handling ────────────────────────────────────────────────

test('GET lists backups for the bound machine', async () => {
  const { route } = build()
  const { status, body } = await call(route, makeReq({ method: 'GET' }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  // The remote dir is resolved from the REMOTE home, never the local one.
  assert.match(body.backupDir, /^\/home\/dev\/\.dsh-remote\/backups$/)
  assert.deepEqual(body.entries, [])
  assert.equal(body.workspace, '/home/dev/proj')
})

test('an unsupported method is rejected', async () => {
  const { route } = build()
  const { status } = await call(route, makeReq({ method: 'DELETE' }))
  assert.equal(status, 405)
})

test('malformed JSON is a 400 with a readable reason, not an empty failure', async () => {
  const { route } = build()
  const req = makeReq({ method: 'POST' })
  req.push = () => {}
  const res = makeRes()
  // Feed raw invalid JSON through a stream the handler can read.
  const bad = Readable.from([Buffer.from('{not json')])
  bad.method = 'POST'
  bad.url = '/dsh-remote/backup'
  await route.handler(bad, res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.payload).error, /JSON/)
})

test('an unknown action is refused with the action named', async () => {
  const { route } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'nope' } }))
  assert.equal(status, 400)
  assert.match(body.error, /unknown action: nope/)
})

// ── create ──────────────────────────────────────────────────────────────────

test('create archives the bound workspace and reports the result', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create', excludes: 'node_modules\n/build/' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  // The name comes from the generated archive path (workspace slug + timestamp),
  // which is what lets rw_backup_list/restore address it by name.
  assert.match(body.created.name, /^proj-[a-z0-9]+-manual-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz$/)
  assert.equal(body.created.sha256, 'aa')
  assert.equal(body.created.members, 2)
  assert.match(body.summary, /created proj-/)
  assert.ok(audited.some((a) => a.op === 'backup' && a.code === 0), 'audited')
})

test('create refuses a path outside the workspace', async () => {
  // Otherwise "backup" could archive an unrelated directory (e.g. the whole home).
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create', path: '/etc' } }))
  assert.equal(status, 400)
  assert.match(body.error, /只允许备份当前工作区/)
  assert.ok(!audited.some((a) => a.code === 0), 'nothing was archived')
})

test('create accepts a proper subdirectory of the workspace', async () => {
  const { route } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create', path: '/home/dev/proj/src' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
})

test('create with no workspace is refused rather than guessing a directory', async () => {
  const { route } = build({ binding: { pool: makePool(), ws: '', host: 'h', username: 'u', port: 22 } })
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  assert.equal(status, 400)
  assert.match(body.error, /没有远程工作区可备份/)
})

test('create reports ignores (dropped patterns) instead of silently dropping them', async () => {
  const { route } = build()
  const { body } = await call(route, makeReq({ method: 'POST', body: { action: 'create', excludes: '/\nnode_modules' } }))
  assert.deepEqual(body.droppedExcludes, ['/'])
})

test('a failed create is a 500 that carries the reason', async () => {
  const pool = makePool({ create: 'ARCH_OK=0\nARCH_ERROR=tar failed with exit 2' })
  const { route } = build({ pool })
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error, /tar failed with exit 2/)
})

// ── restore (the destructive one) ───────────────────────────────────────────

test('restore requires an explicit confirmation', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz' } }))
  assert.equal(status, 400)
  assert.match(body.error, /confirm: true/)
  assert.equal(audited.length, 0, 'nothing ran')
})

test('restore rejects a traversing filename', async () => {
  const { route } = build()
  for (const file of ['../../etc/passwd', '/etc/passwd', 'a/b.tar.gz', 'x.tar.gz; rm -rf /']) {
    const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file, confirm: true } }))
    assert.equal(status, 400, `${file} must be refused`)
    assert.match(body.error, /无效的备份文件名/)
  }
})

test('restore runs, reports the mode and member count, and is audited', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true, mode: 'merge' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.restored.mode, 'merge')
  assert.equal(body.restored.from, 'remote')
  assert.ok(audited.some((a) => a.op === 'restore' && a.code === 0))
})

test('restore of the LOCAL copy uploads it first, then restores', async () => {
  const { route, localRoot } = build()
  // A local copy must actually exist: the route uploads it before restoring, so
  // a missing file is a legitimate 500 and would make this test prove nothing.
  mkdirSync(localRoot, { recursive: true })
  const localFile = path.join(localRoot, 'x.tar.gz')
  writeFileSync(localFile, 'LOCAL-ARCHIVE')
  try {
    const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true, where: 'local' } }))
    assert.equal(status, 200)
    assert.equal(body.restored.from, 'local')
    assert.match(body.uploaded, /x\.tar\.gz$/)
  } finally {
    rmSync(localRoot, { recursive: true, force: true })
  }
})

test('a refused (corrupt) restore is a 500 carrying the safety reason', async () => {
  const pool = makePool()
  pool.exec = async (script) => {
    if (script.includes('tar -tzf')) return { code: 1, stdout: 'ARCH_VERIFY=bad\nARCH_OK=0\nARCH_ERROR=archive is corrupt or truncated; nothing was written', stderr: '' }
    if (script.includes('ARCH_H=$HOME')) return { code: 0, stdout: 'ARCH_HOME=/home/dev', stderr: '' }
    if (script.includes('ARCH_EXISTS')) return { code: 0, stdout: 'ARCH_EXISTS=0', stderr: '' }
    if (script.includes('tar -xzf')) return { code: 1, stdout: 'ARCH_VERIFY=bad\nARCH_OK=0\nARCH_ERROR=archive is corrupt or truncated; nothing was written', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const { route, audited } = build({ pool })
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true } }))
  assert.equal(status, 500)
  assert.match(body.error, /corrupt or truncated/)
  assert.ok(audited.some((a) => a.op === 'restore' && a.code === 1), 'the refusal is audited')
})

// ── delete / verify ─────────────────────────────────────────────────────────

test('delete refuses a traversing filename', async () => {
  const { route } = build()
  const { status } = await call(route, makeReq({ method: 'POST', body: { action: 'delete', file: '../x.tar.gz' } }))
  assert.equal(status, 400)
})

test('delete of a remote archive succeeds', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'delete', file: 'x.tar.gz' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(audited.some((a) => a.op === 'backup-delete'))
})

test('verify checks the remote archive and reports the digest', async () => {
  const { route } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'verify', file: 'x.tar.gz' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.verified, true)
  assert.equal(body.sha256, 'aa')
})

// ── machine targeting ───────────────────────────────────────────────────────

test('an explicit machineId is honored over the session binding', async () => {
  // The settings page may act on a machine that is not the current one; acting
  // on whichever is active would hit the wrong host.
  const other = makePool()
  let asked = ''
  const routes = createBackupRoutes({
    sendJson: (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) },
    readBody,
    config: { backupDir: '/mnt/bk', backupExcludes: [], maxBackupTransferBytes: 0 },
    audit: () => {},
    resolveRequestBinding: async () => { throw new Error('should not be used') },
    resolveMachineBinding: async (id) => {
      asked = id
      return { pool: other, ws: '/other/ws', host: 'other', username: 'u', port: 22 }
    },
    localRootFor: () => '/tmp/local',
  })
  const route = routes.find((r) => r.path === '/dsh-remote/backup')
  const { status, body } = await call(route, makeReq({ method: 'GET', url: '/dsh-remote/backup?machineId=m-1' }))
  assert.equal(status, 200)
  assert.equal(asked, 'm-1')
  assert.equal(body.host, 'other')
  assert.equal(body.backupDir, '/mnt/bk', 'the configured override is used verbatim')
})

test('a failed binding answers with its own status (403 for a local session)', async () => {
  const routes = createBackupRoutes({
    sendJson: (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) },
    readBody,
    config: { backupDir: '', backupExcludes: [], maxBackupTransferBytes: 0 },
    audit: () => {},
    resolveRequestBinding: async () => {
      const err = new Error('this session is LOCAL')
      err.httpStatus = 403
      throw err
    },
    localRootFor: () => '/tmp/local',
  })
  const route = routes.find((r) => r.path === '/dsh-remote/backup')
  const { status, body } = await call(route, makeReq({ method: 'GET' }))
  assert.equal(status, 403)
  assert.match(body.error, /LOCAL/)
})
