// Regression: the legacy `/dsh-openssh-remote/*` routes are registered directly on
// `webServer`, which applies NO Host/Origin fence and NO browser authentication
// (DSH's `requestRejection` is wired only to `/api` and the `/api/remote.mux`
// upgrade). That made every mutating route reachable cross-site as a "simple
// request": a `text/plain` POST needs no CORS preflight, so any page the user
// happened to visit could define a port forward, rewrite the machine registry,
// or trigger `update-apply` (install a package + reload the plugin).
//
// Measured before the fix (dsh 0.1.5-rc.2, live 127.0.0.1:3080):
//   POST /dsh-openssh-remote/forwards  Origin: https://evil.example.com  ->  200, and
//   the definition really landed in forwards.json.
//   GET  /dsh-openssh-remote/machines  Host: evil.com                    ->  200, leaking
//   host/user/port/workspace (DNS rebinding needs no Origin at all).
// For contrast the same requests against DSH's own `/api` returned 403.
//
// These tests drive the REAL handler through the REAL `guardRoute` wrapper, so
// the production path is what is under test — not a re-implementation of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { guardRoute } from '../lib/http-transport.js'

/** A response double that records only what the handler observable wrote. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(k, v) { this.headers[k] = v },
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
    end(chunk) { if (chunk != null) this.payload += String(chunk) },
  }
}

/** A request double carrying real headers, like node:http delivers. */
function makeReq({ method = 'GET', url = '/dsh-openssh-remote/status', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

const LOOPBACK = { host: '127.0.0.1:3080' }

/** Build a route as `lib/index.js` declares them, wrapped by the real guard. */
function route(connection) {
  let calls = 0
  const inner = {
    kind: 'exact',
    path: '/dsh-openssh-remote/forwards',
    handler: async (_req, res) => {
      calls++
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    },
  }
  return { guarded: guardRoute(inner, () => connection), calls: () => calls }
}

// ── the three browser attack vectors must all be rejected ───────────────────

test('cross-site simple request is rejected (no preflight needed to reach us)', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({
    method: 'POST',
    headers: { ...LOOPBACK, origin: 'https://evil.example.com', 'content-type': 'text/plain' },
    body: { action: 'define', listenPort: 3399 },
  }), res)
  assert.equal(res.statusCode, 403, 'a cross-origin page must not reach the handler')
  assert.equal(calls(), 0, 'the handler must never run')
})

test('sec-fetch-site: cross-site is rejected even with no Origin header', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(calls(), 0)
})

test('a forged non-loopback Host is rejected (DNS rebinding)', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { host: 'evil.com' } }), res)
  assert.equal(res.statusCode, 403, 'an attacker-controlled name resolving to 127.0.0.1 must not pass')
  assert.equal(calls(), 0)
})

test('Origin that disagrees with Host is rejected', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({
    headers: { ...LOOPBACK, origin: 'http://127.0.0.1:9999' },
  }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(calls(), 0)
})

// ── legitimate callers must keep working ────────────────────────────────────

test('same-origin browser request passes', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({
    headers: { ...LOOPBACK, origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
  }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(calls(), 1)
})

test('a non-browser caller (curl/script) passes: loopback Host, no Origin', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { ...LOOPBACK, 'user-agent': 'curl/8.0' } }), res)
  assert.equal(res.statusCode, 200, 'scripted callers carry no browser markers')
  assert.equal(calls(), 1)
})

test('an in-process caller with no HTTP headers is not treated as a browser', async () => {
  const { guarded, calls } = route(undefined)
  const res = makeRes()
  await guarded.handler(makeReq(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(calls(), 1)
})

// ── the authoritative fence wins when Connection is present ─────────────────

test('Connection.requestRejection is preferred over the fallback', async () => {
  // DSH owns browser authentication (signed cookie); our fallback cannot know
  // about it, so when the service exists its verdict must be the one applied.
  let asked = 0
  const connection = {
    requestRejection() { asked++; return 401 },
  }
  const { guarded, calls } = route(connection)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { ...LOOPBACK, origin: 'http://127.0.0.1:3080' } }), res)
  assert.equal(asked, 1, 'the authoritative fence must be consulted')
  assert.equal(res.statusCode, 401, 'connection verdict must be honoured')
  assert.equal(res.payload, 'unauthorized')
  assert.equal(calls(), 0)
})

test('Connection allowing the request lets it through', async () => {
  const connection = { requestRejection() { return undefined } }
  const { guarded, calls } = route(connection)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { ...LOOPBACK } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(calls(), 1)
})

test('a Connection without requestRejection falls back rather than opening up', async () => {
  // Desktop-style carriers authenticate on the IPC path and may expose only
  // part of the service; absence must never mean "no fence".
  const connection = {}
  const { guarded, calls } = route(connection)
  const res = makeRes()
  await guarded.handler(makeReq({ headers: { host: 'evil.com' } }), res)
  assert.equal(res.statusCode, 403, 'an unusable Connection must not disable the fence')
  assert.equal(calls(), 0)
})

test('the fence is resolved per request, so a late Connection still protects', async () => {
  let connection
  const { guarded, calls } = route(undefined)
  const late = guardRoute(
    { kind: 'exact', path: '/x', handler: async (_r, res) => { res.writeHead(200); res.end('ok') } },
    () => connection,
  )
  const before = makeRes()
  await late.handler(makeReq({ headers: { host: 'evil.com' } }), before)
  assert.equal(before.statusCode, 403, 'no authenticator yet -> fallback fences')
  connection = { requestRejection: () => undefined }
  const after = makeRes()
  await late.handler(makeReq({ headers: { host: 'evil.com' } }), after)
  assert.equal(after.statusCode, 200, 'once Connection exists its verdict is used')
  assert.equal(calls(), 0)
})

test('guardRoute preserves the route declaration (kind/path/methods)', () => {
  const inner = { kind: 'exact', path: '/dsh-openssh-remote/status', methods: ['GET'], handler: async () => {} }
  const guarded = guardRoute(inner, () => undefined)
  assert.equal(guarded.kind, 'exact')
  assert.equal(guarded.path, '/dsh-openssh-remote/status')
  assert.deepEqual(guarded.methods, ['GET'])
})
