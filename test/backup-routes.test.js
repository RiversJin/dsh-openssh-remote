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
      //
      // The restore-all script relocates one workspace per `ARCH_ENTRY=` line, so
      // the reply must carry them — a reply with only a count would let a
      // "reports every workspace" assertion pass vacuously.
      if (script.includes('tar -xzf')) {
        return { code: 0, stdout: 'ARCH_VERIFY=ok\nARCH_ENTRY=/w/a\nARCH_ENTRY=/w/b\nARCH_MEMBERS=2\nARCH_OK=1', stderr: '' }
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

function build({ config = {}, pool = makePool(), binding, localRoot = path.join(tmpdir(), 'bk-routes-local'), workspaces } = {}) {
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
    // Default to two workspaces so "all workspaces" is actually exercised.
    workspacesFor: () => (workspaces !== undefined ? workspaces : ['/home/dev/proj', '/home/dev/other']),
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

// ── create: ONE archive holding EVERY sidebar workspace ─────────────────────

test('create archives ALL of the sidebar workspaces in a single archive', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  // One archive, both workspaces: the whole point of the simplified panel.
  assert.equal(body.created.workspaces.length, 2)
  assert.equal(body.created.sha256, 'aa')
  assert.equal(body.created.members, 2)
  assert.match(body.created.name, /^workspaces-.*\.tar\.gz$/)
  assert.ok(audited.some((a) => a.op === 'backup' && a.code === 0), 'audited')
})

test('create passes every workspace to the archive command, with the default excludes', async () => {
  const pool = makePool()
  const { route } = build({ pool, workspaces: ['/w/alpha', '/w/beta', '/w/gamma'] })
  await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  const script = pool.calls.join('\n')
  for (const w of ['w/alpha', 'w/beta', 'w/gamma']) {
    assert.ok(script.includes(w), `${w} must be in the tar member list`)
  }
  // The defaults are what makes the archive usable (no node_modules, etc).
  assert.ok(script.includes("'--exclude=node_modules'"), 'top-level node_modules excluded')
  assert.ok(script.includes("'--exclude=*/node_modules'"), 'NESTED node_modules excluded')
  assert.ok(script.includes('paths.tsv'), 'the member↔path map ships in the archive')
  assert.ok(!/\s-P\b/.test(script), 'no -P (absolute names) is ever passed')
})

test('create refuses when there is nothing to back up', async () => {
  const { route, audited } = build({ binding: { pool: makePool(), ws: '', host: 'h', username: 'u', port: 22 }, workspaces: [] })
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  assert.equal(status, 400)
  assert.match(body.error, /没有可备份的远程工作区/)
  assert.ok(!audited.some((a) => a.code === 0), 'nothing was archived')
})

test('create falls back to the bound workspace when the collector finds none', async () => {
  // A session bound to a workspace must still be backable even if the sidebar
  // registry has no record of it.
  const pool = makePool()
  const { route } = build({ pool, workspaces: [] })
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'create' } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(pool.calls.join('\n').includes('home/dev/proj'), 'the bound workspace is archived')
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

test('restore reports every restored workspace and is audited', async () => {
  const { route, audited } = build()
  const { status, body } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true } }))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.restored.file, 'x.tar.gz')
  assert.deepEqual(body.restored.targets, ['/w/a', '/w/b'])
  assert.equal(body.restored.count, 2)
  assert.ok(audited.some((a) => a.op === 'restore' && a.code === 0))
})

test('restore has no mode option any more (the panel lost that choice)', async () => {
  // `mode=merge` used to be a UI choice. The simplified panel always replaces,
  // and the route must ignore a stray mode rather than silently honouring it.
  const pool = makePool()
  const { route } = build({ pool })
  await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true, mode: 'merge' } }))
  const script = pool.calls.join('\n')
  assert.ok(!script.includes('ARCH_ACTION=merged'), 'a stray mode must not change the restore script')
  assert.ok(script.includes('paths.tsv'), 'the member↔path map drives the restore')
})

test('the local-copy upload/restore pathway is gone from the panel contract', async () => {
  // `where: 'local'` used to upload then restore. The simplified design keeps
  // archives on the remote only, so a stray `where` must not change behaviour —
  // it restores from the remote backup directory.
  const pool = makePool()
  const { route } = build({ pool })
  const { status } = await call(route, makeReq({ method: 'POST', body: { action: 'restore', file: 'x.tar.gz', confirm: true, where: 'local' } }))
  assert.equal(status, 200)
  const script = pool.calls.join('\n')
  assert.ok(script.includes('/home/dev/.dsh-remote/backups/x.tar.gz'), 'restores from the remote backup dir')
  assert.ok(!script.includes('fastPut'), 'no upload step in the restore path')
})

test('a refused (corrupt) restore is a 500 carrying the safety reason', async () => {
  const pool = makePool()
  pool.exec = async (script) => {
    if (script.includes('ARCH_H=')) return { code: 0, stdout: 'ARCH_HOME=/home/dev', stderr: '' }
    if (script.includes('ARCH_EXISTS')) return { code: 0, stdout: 'ARCH_EXISTS=0', stderr: '' }
    // The restore script's own pre-flight verify reports the corruption.
    return { code: 1, stdout: 'ARCH_VERIFY=bad\nARCH_OK=0\nARCH_ERROR=archive is corrupt or truncated; nothing was written', stderr: '' }
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
