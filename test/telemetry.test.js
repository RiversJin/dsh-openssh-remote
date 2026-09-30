// 安装级心跳（日活统计）的行为契约。
//
// 这些断言守的是"统计口径正确"与"隐私边界没被破坏"两件事：
// 身份必须跨插件重装稳定（否则 1 个人被算成 N 个）、原始 id 不得出现在
// 请求体里（只有 HMAC 伪名）、心跳失败绝不影响宿主（永不打穿调用方）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetForTest,
  hasPersistedId,
  heartbeatEnabled,
  heartbeatUrl,
  installId,
  installIdPath,
  pseudonym,
  sendHeartbeat,
} from '../lib/telemetry.js'

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-remote-tel-'))
}

test('installId creates a stable UUID inside DSH_HOME (not the plugin dir)', () => {
  const home = tempHome()
  try {
    const first = installId(home)
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    // 同一进程重复调用必须同值
    assert.equal(installId(home), first)
    // ★ 关键：身份必须落在 DSH_HOME 而不是插件目录——插件目录每次 pnpm
    //   重装都会被覆盖，放那里会让同一台机器每次升级都换身份，把 1 个用户
    //   算成 N 个，日活统计直接失真。
    assert.ok(existsSync(installIdPath(home)))
    assert.ok(installIdPath(home).startsWith(home))
    assert.ok(!installIdPath(home).includes('node_modules'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installId is re-read from disk across processes (survives reinstall)', () => {
  const home = tempHome()
  try {
    const a = installId(home)
    _resetForTest() // 模拟进程重启
    const b = installId(home)
    assert.equal(a, b, 'a fresh process must reuse the persisted id')
    assert.equal(hasPersistedId(home), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installId ignores a corrupt id file and mints a fresh one', () => {
  const home = tempHome()
  try {
    writeFileSync(path.join(home, '.dsh-remote-install-id'), 'not-a-uuid\n', 'utf8')
    const id = installId(home)
    assert.match(id, /^[0-9a-f]{8}-/i)
    assert.notEqual(id, 'not-a-uuid')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pseudonym is a stable 32-hex HMAC of the install id', () => {
  const home = tempHome()
  try {
    const id = installId(home)
    const p = pseudonym(home)
    assert.match(p, /^[0-9a-f]{32}$/)
    assert.equal(p, pseudonym(home), 'must be stable within an install')
    // 与服务端实现一致：HMAC-SHA256(salt, id) 截断 32 hex
    assert.equal(p, createHmac('sha256', 'dsh-remote/telemetry/v1').update(id).digest('hex').slice(0, 32))
    // ★ 隐私：伪名不得等于原始 id（否则服务端可跨插件关联）
    assert.notEqual(p, id)
    assert.ok(!p.includes(id.slice(0, 8)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('two installs get different pseudonyms (dedupe is meaningful)', () => {
  const h1 = tempHome()
  const h2 = tempHome()
  try {
    assert.notEqual(installId(h1), installId(h2))
    assert.notEqual(pseudonym(h1), pseudonym(h2))
  } finally {
    rmSync(h1, { recursive: true, force: true })
    rmSync(h2, { recursive: true, force: true })
  }
})

test('sendHeartbeat posts only the whitelisted minimal fields', async () => {
  const home = tempHome()
  const realFetch = globalThis.fetch
  let captured = null
  try {
    globalThis.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body), method: opts.method }
      return { ok: true, status: 200 }
    }
    _resetForTest()
    const sent = await sendHeartbeat(home, '0.8.25', { delayMs: 0 })
    assert.equal(sent, true)
    assert.equal(captured.method, 'POST')
    assert.match(captured.url, /^https:\/\/.+\/heartbeat$/)
    // 字段白名单：多一个都不行（本插件能拿到 SSH 主机/路径，必须留在本地）
    assert.deepEqual(
      Object.keys(captured.body).sort(),
      ['arch', 'idHash', 'node', 'platform', 'version'],
    )
    assert.equal(captured.body.version, '0.8.25')
    assert.equal(captured.body.idHash, pseudonym(home))
    assert.match(captured.body.platform, /^(win32|darwin|linux|freebsd|other)$/)
    // ★ 隐私：请求体里不能出现原始 install id
    assert.ok(!JSON.stringify(captured.body).includes(installId(home)))
  } finally {
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('sendHeartbeat swallows a network failure and allows a retry', async () => {
  const home = tempHome()
  const realFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async () => { calls += 1; throw new Error('ENOTFOUND') }
    _resetForTest()
    // 心跳是旁路：失败必须静默，绝不能打穿到插件加载路径。
    await assert.doesNotReject(() => sendHeartbeat(home, '0.8.25', { delayMs: 0 }))
    assert.equal(await sendHeartbeat(home, '0.8.25', { delayMs: 0 }), false)
    // ★ 失败必须回滚节流，否则一次网络抖动会让这个身份静默 6 小时不再上报，
    //   把"网络不可达"错误地记成"用户当天没来"。
    assert.equal(calls, 2, 'a failed send must not consume the throttle window')
  } finally {
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('sendHeartbeat throttles repeated calls within the window', async () => {
  const home = tempHome()
  const realFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async () => { calls += 1; return { ok: true } }
    _resetForTest()
    assert.equal(await sendHeartbeat(home, '0.8.25', { delayMs: 0 }), true)
    assert.equal(await sendHeartbeat(home, '0.8.25', { delayMs: 0 }), false, 'second call inside the window is skipped')
    assert.equal(calls, 1, 'only one request must leave the machine')
  } finally {
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('sendHeartbeat defers the first send away from startup', async () => {
  const home = tempHome()
  const realFetch = globalThis.fetch
  let at = null
  try {
    globalThis.fetch = async () => { at = Date.now(); return { ok: true } }
    _resetForTest()
    const started = Date.now()
    // 默认延迟存在的原因：DSH 启动瞬间的并发初始化会把首帧 fetch 饿死
    // （实测 5s 超时下稳定 abort），错过它等于丢掉当天最早的那批用户。
    await sendHeartbeat(home, '0.8.25', { delayMs: 40 })
    assert.ok(at !== null, 'must still send after the delay')
    assert.ok(at - started >= 30, `expected a startup delay, got ${at - started}ms`)
  } finally {
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('heartbeat endpoint is https and self-describing', () => {
  assert.equal(heartbeatEnabled(), true)
  assert.match(heartbeatUrl(), /^https:\/\//)
})
