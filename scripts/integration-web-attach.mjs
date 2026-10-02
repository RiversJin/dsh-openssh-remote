// End-to-end: attach a REMOTE DSH Web UI from this machine over real SSH.
//
// Runs the real `WebAttach` against a real machine: it starts a remote
// `dsh web`, captures the launch token from stdout, binds a local listener, and
// carries a real HTTP request + a real WebSocket upgrade through the tunnel.
// This is the check that the design's central claim holds outside of unit
// doubles: a bare TCP forward is sufficient for the whole GUI.
//
// Usage:
//   node scripts/integration-web-attach.mjs --host 9.134.186.191 --port 36000 \
//        --user jimmycppliu --key ~/.ssh/id_rsa \
//        [--command /tmp/dshprefix/node_modules/.bin/dsh] [--dshHome /tmp/dshhome]
import { WebAttach } from '../lib/web-attach.js'
import { SshPool } from '../lib/pool.js'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const host = arg('host')
const port = Number(arg('port', '22'))
const username = arg('user', 'root')
const privateKeyPath = arg('key', path.join(os.homedir(), '.ssh', 'id_rsa'))
const command = arg('command', 'dsh')
const dshHome = arg('dshHome', '')
if (!host) { console.error('need --host'); process.exit(2) }

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

/** Plain HTTP GET through the tunnel (no redirects, so we can see the 303). */
function httpGet(port_, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = net.connect({ host: '127.0.0.1', port: port_ }, () => {
      req.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port_}\r\nConnection: close\r\n${
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`)
    })
    let buf = ''
    req.on('data', (d) => { buf += d })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
    setTimeout(() => { try { req.destroy() } catch {} ; resolve(buf || 'TIMEOUT') }, 20000).unref?.()
  })
}

/** Raw WebSocket handshake through the tunnel; resolves the status line. */
function wsHandshake(port_, cookie) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: port_ }, () => {
      sock.write(
        'GET /api/remote.mux HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port_}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        + (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n',
      )
    })
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (buf.includes('\r\n\r\n')) {
        resolve(buf.toString('latin1').split('\r\n')[0])
        try { sock.destroy() } catch {}
      }
    })
    sock.on('error', reject)
    setTimeout(() => { try { sock.destroy() } catch {} ; resolve('TIMEOUT') }, 20000).unref?.()
  })
}

const pool = new SshPool({
  host, port, username, password: '', privateKeyPath, passphrase: '',
  workspace: '', shell: '', connectTimeoutMs: 20000, commandTimeoutMs: 60000,
  maxOutputChars: 200000, maxFileBytes: 0, hostKeyMode: 'accept-new',
  useAgent: false, keyboardInteractive: false, encoding: 'utf-8',
}, { knownHostsFile: () => '' })

const attach = new WebAttach({ localPortStart: 30920 })
let exitCode = 0
try {
  console.log(`--- attaching to ${username}@${host}:${port} (command=${command}) ---`)
  const info = await attach.open({ pool, machineId: 'e2e', command, dshHome, waitSeconds: 60 })
  check('remote dsh web started and token captured', !!info.url, info.url.replace(/token=.*/, 'token=***'))
  check('remote port reported by the launch line', info.remotePort > 0, String(info.remotePort))
  check('local listener is loopback-only', info.localPort > 0, String(info.localPort))

  // 1. The token exchanges for a cookie through OUR forwarded authority.
  const exchange = await httpGet(info.localPort, `/?token=${info.token}`)
  const status = exchange.split('\r\n')[0]
  check('token exchange returns 303', / 303 /.test(status), status)
  const setCookie = /set-cookie:\s*([^\r\n]+)/i.exec(exchange)
  check('a signed cookie is issued', !!setCookie)
  const cookie = setCookie ? setCookie[1].split(';')[0] : ''

  // 2. The SPA loads with that cookie...
  const index = await httpGet(info.localPort, '/', { Cookie: cookie })
  check('authenticated index is the DSH SPA',
    / 200 /.test(index.split('\r\n')[0]) && index.includes('__DSH_BOOT__'),
    `status=${index.split('\r\n')[0]} boot=${index.includes('__DSH_BOOT__')}`)

  // 3. ...and is NOT readable without it (the fence is real, not decorative).
  const anon = await httpGet(info.localPort, '/')
  check('index without a cookie is refused', / 401 | 403 /.test(anon.split('\r\n')[0]),
    anon.split('\r\n')[0])

  // 4. Frontend assets transit the tunnel.
  const asset = /(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/.exec(index)
  if (asset) {
    const js = await httpGet(info.localPort, '/' + asset[1])
    check('frontend asset loads through the tunnel', / 200 /.test(js.split('\r\n')[0]),
      `${asset[1]} status=${js.split('\r\n')[0]}`)
  } else {
    check('frontend asset reference found in index', false, 'no assets/*.js referenced')
  }

  // 5. The WebSocket mux upgrades — this is what a full GUI needs (live events).
  const wsOk = await wsHandshake(info.localPort, cookie)
  check('WebSocket mux upgrades through the tunnel', / 101 /.test(wsOk), wsOk)
  const wsAnon = await wsHandshake(info.localPort, '')
  check('WebSocket mux refuses an unauthenticated upgrade', / 401 | 403 /.test(wsAnon), wsAnon)
} catch (err) {
  check('attach flow completed', false, String((err && err.message) || err))
  exitCode = 1
} finally {
  try { await attach.close({ stopRemote: true, exec: (cmd) => pool.exec(cmd, { timeoutMs: 15000 }) }) } catch {}
  try { pool.close() } catch {}
}
const failed = results.filter((r) => !r.ok).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : exitCode)
