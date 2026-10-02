// Integration: drive the REAL /dsh-remote/web-attach route against a real host.
//
// This is the layer the unit tests deliberately do not cover: the plugin's own
// wiring (machines registry -> poolForMachine -> WebAttach -> real SSH) plus the
// HTTP contract the settings UI consumes. The route handler is called exactly as
// webServer would call it.
//
// Usage:
//   node scripts/integration-route-web-attach.mjs --host <ip> --port <sshport> \
//        --user <u> --key <path> --command <remote dsh> [--dshHome <dir>]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import path from 'node:path'

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const host = arg('host')
const sshPort = Number(arg('port', '22'))
const username = arg('user', 'root')
const privateKeyPath = arg('key')
const command = arg('command', 'dsh')
const dshHome = arg('dshHome', '')
if (!host || !privateKeyPath) { console.error('need --host and --key'); process.exit(2) }

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

/** Isolated DSH_HOME with one machine registered and set current. */
const home = mkdtempSync(path.join(tmpdir(), 'route-attach-'))
const root = path.join(home, 'remote-workspaces')
mkdirSync(root, { recursive: true })
const machineId = 'm-e2e'
writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
  list: [{
    id: machineId, name: 'buildbox', host, port: sshPort, username,
    password: '', privateKeyPath, passphrase: '', workspace: args0(), useAgent: false,
    keyboardInteractive: false, hostKeyMode: 'accept-new',
  }],
  currentId: machineId,
}))
function args0() { return arg('workspace', '/home/' + username) }

process.env.DSH_HOME = home

const mod = await import(`../lib/index.js?route=${Math.random()}`)
const routes = new Map()
const ctx = {
  effect: () => {},
  inject(names, cb) { if (names.every((n) => this.get(n))) cb(this) },
  get: (k) => (k === 'webServer'
    ? { register: (r) => { routes.set(r.path, r); return () => {} } }
    : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
}
await mod.apply(ctx, {
  ...({}),
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 60000, connectTimeoutMs: 20000,
  maxOutputChars: 200000, maxFileBytes: 0, hostKeyMode: 'accept-new',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 60000,
  webAttachCommand: command, webAttachDshHome: dshHome, webAttachWaitSeconds: 60,
  webAttachPortStart: Number(arg('localPort', '30940')),
})

const route = routes.get('/dsh-remote/web-attach')
check('route /dsh-remote/web-attach is registered', !!route)

function call(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = '/dsh-remote/web-attach'
  // No HTTP headers: an in-process caller (the Desktop carrier / tests). The
  // browser fence deliberately treats that as non-browser.
  req.headers = {}
  const res = {
    statusCode: 0, payload: '',
    setHeader() {}, writeHead(c) { this.statusCode = c }, end(c) { this.payload += c == null ? '' : String(c) },
  }
  return route.handler(req, res).then(() => ({ status: res.statusCode, json: JSON.parse(res.payload || '{}') }))
}

let opened = null
try {
  const before = await call('GET')
  check('GET status starts empty', before.status === 200 && (before.attaches || []).length === 0,
    `status=${before.status} attaches=${(before.attaches || []).length}`)

  const open = await call('POST', { action: 'open', machineId })
  opened = open.json.attach
  check('POST open attaches a remote DSH web', open.status === 200 && open.json.ok === true,
    open.json.error || `local=${opened && opened.localPort} remote=${opened && opened.remotePort}`)
  if (opened) {
    check('the reported URL carries the launch token on loopback only',
      /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(opened.url), opened.url.replace(/token=.*/, 'token=***'))
    check('the session is marked managed (we started it)', opened.managed === true)
  }

  const reuse = await call('POST', { action: 'open', machineId })
  check('a second open REUSES the live tunnel instead of starting another',
    reuse.status === 200 && reuse.json.reused === true,
    `reused=${reuse.json.reused} local=${reuse.json.attach && reuse.json.attach.localPort}`)

  const status = await call('GET')
  check('GET status now reports the tunnel', (status.json.attaches || []).length === 1,
    `attaches=${(status.json.attaches || []).length}`)

  const noMachine = await call('POST', { action: 'open', machineId: 'does-not-exist' })
  check('an unknown machine is refused', noMachine.status === 404, `status=${noMachine.status}`)

  const bogus = await call('POST', { action: 'nonsense', machineId })
  check('an unknown action is refused', bogus.status === 400, `status=${bogus.status}`)

  // Close WITH stopRemote: the route must tear down both the tunnel and the
  // remote process it started.
  const close = await call('POST', { action: 'close', machineId, stopRemote: true })
  check('POST close tears the tunnel down', close.status === 200 && close.json.closed === true,
    `closed=${close.json.closed} stoppedRemote=${close.json.stoppedRemote}`)
  check('close reports that the remote process was stopped', close.json.stoppedRemote === true)
  opened = null

  const after = await call('GET')
  check('GET status is empty again', (after.json.attaches || []).length === 0)
  const again = await call('POST', { action: 'close', machineId })
  check('closing twice is a safe no-op', again.status === 200, `status=${again.status}`)
} catch (err) {
  check('route flow completed', false, String((err && err.message) || err))
} finally {
  if (opened) { try { await call('POST', { action: 'close', machineId, stopRemote: true }) } catch {} }
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((r) => !r).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : 0)
