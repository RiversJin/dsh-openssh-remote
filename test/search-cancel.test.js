// Issue #44: `rw_search` over a large tree must be interruptible and bounded.
//
// The reported failure: a search over a whole home directory never returned, the
// turn stayed `running` forever, and cancel/steer had no effect because DSH tool
// cancellation is *cooperative* — the tool must observe `exec.signal`. The walk
// accepted no signal, so nothing could stop it. A second defect compounded it:
// after the SFTP channel died, every operation waited out the full
// commandTimeoutMs instead of failing fast (N entries × 2 ops × timeout ≈ days).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { searchTree, searchViaShell, searchRemote } from '../lib/search.js'
import { SshPool } from '../lib/pool.js'
import { compileIgnore, DEFAULT_IGNORE, DEFAULT_SEARCH_IGNORE } from '../lib/ignore.js'

/** A wide, deep, deliberately slow fake remote tree. */
function makeSftp(counters, delayMs = 1) {
  const tick = () => new Promise((r) => setTimeout(r, delayMs))
  return {
    async readdir(dir) {
      counters.readdir++
      const out = []
      for (let i = 0; i < 50; i++) {
        out.push({ filename: `f${i}.txt`, attrs: { isDirectory: () => false, size: 100 } })
      }
      out.push({ filename: 'sub', attrs: { isDirectory: () => true, size: 0 } })
      return out
    },
    async stat() { counters.stat++; await tick(); return { size: 100 } },
    async readFile() { counters.readFile++; await tick(); return Buffer.from('nothing matches here\n') },
  }
}

test('searchTree stops at maxDurationMs instead of running forever', async () => {
  // Regression: there was no wall-clock budget at all.
  const counters = { readdir: 0, stat: 0, readFile: 0 }
  const t0 = Date.now()
  const r = await searchTree(makeSftp(counters), '/home/u', {
    regex: /zzz-absent-zzz/,
    maxFiles: 1e9,          // force the duration budget to be the binding limit
    maxDurationMs: 300,
    isIgnored: () => false,
  })
  const dt = Date.now() - t0
  assert.ok(dt < 3000, `must return promptly, took ${dt}ms`)
  assert.equal(r.truncated, true, 'a budget stop must be reported as truncated')
  assert.ok(r.scanned > 0, 'partial results are still returned')
})

test('searchTree returns partial results when the signal aborts', async () => {
  const counters = { readdir: 0, stat: 0, readFile: 0 }
  const ac = new AbortController()
  const sftp = makeSftp(counters)
  const origStat = sftp.stat
  sftp.stat = async (...a) => {
    if (counters.stat >= 100) ac.abort()
    return origStat(...a)
  }
  const baseline = await (async () => {
    const c2 = { readdir: 0, stat: 0, readFile: 0 }
    const t = Date.now()
    await searchTree(makeSftp(c2), '/home/u', {
      regex: /zzz-absent-zzz/, maxFiles: 400, maxDurationMs: 0, isIgnored: () => false,
    })
    return Date.now() - t
  })()

  const t0 = Date.now()
  const r = await searchTree(sftp, '/home/u', {
    regex: /zzz-absent-zzz/,
    maxFiles: 1e9, maxDurationMs: 0, signal: ac.signal, isIgnored: () => false,
  })
  const dt = Date.now() - t0
  // Compare against the equivalent uncancelled workload rather than a magic
  // millisecond count, which would drift with machine speed.
  assert.equal(r.cancelled, true, 'abort must be reported')
  assert.ok(dt < baseline * 1.5, `abort must cut the walk short (${dt}ms vs baseline ${baseline}ms)`)
})

test('searchTree does no IO when the signal is already aborted', async () => {
  const counters = { readdir: 0, stat: 0, readFile: 0 }
  const ac = new AbortController()
  ac.abort()
  const r = await searchTree(makeSftp(counters), '/home/u', {
    regex: /x/, signal: ac.signal, isIgnored: () => false,
  })
  assert.equal(r.cancelled, true)
  assert.equal(counters.readdir, 0, 'an aborted search must not touch the remote')
})

test('searchViaShell refuses to start when already aborted', async () => {
  let execCalls = 0
  const pool = { platform: 'linux', exec: async () => { execCalls++; return { code: 0, stdout: '', stderr: '' } } }
  const ac = new AbortController()
  ac.abort()
  const r = await searchViaShell(pool, '/home/u', { pattern: 'x', signal: ac.signal })
  assert.equal(r.cancelled, true)
  assert.equal(execCalls, 0, 'must not spawn a remote grep for an aborted call')
})

test('searchRemote does not fall back to the slow walk after an abort', async () => {
  // The shell path throwing must not turn a cancelled search into an SFTP walk —
  // that is precisely the unbounded path the caller asked to stop.
  const ac = new AbortController()
  ac.abort()
  const pool = {
    platform: 'linux',
    exec: async () => { throw new Error('killed') },
    sftp: async () => { throw new Error('must not be reached') },
  }
  const r = await searchRemote(pool, '/home/u', { pattern: 'x', signal: ac.signal })
  assert.equal(r.cancelled, true)
})

test('a dead sftp channel fails fast instead of waiting out the timeout', async () => {
  // Regression: after channel EOF, ssh2 only cleans up the requests pending at
  // that moment; later requests are registered and never answered. Each call then
  // waited the full commandTimeoutMs, so N entries cost N × 2 × timeout.
  const sftpObj = new EventEmitter()
  for (const m of ['readdir', 'stat', 'readFile', 'open', 'close']) sftpObj[m] = () => {}

  const pool = new SshPool({ host: 'x', port: 22, username: 'u', commandTimeoutMs: 1000 })
  pool.connect = async () => ({ sftp: (cb) => cb(null, sftpObj), end: () => {} })
  const sftp = await pool.sftp()

  sftpObj.emit('end')   // the channel dies

  const t0 = Date.now()
  await assert.rejects(() => sftp.stat('/x'), /channel closed/)
  const dt = Date.now() - t0
  assert.ok(dt < 250, `must fail immediately, took ${dt}ms (timeout is 1000ms)`)
  pool.close()
})

test('sftp() bounds the subchannel open itself', async () => {
  // Regression: `c.sftp(cb)` had no timeout, so an unresponsive remote parked forever.
  const pool = new SshPool({ host: 'x', port: 22, username: 'u', commandTimeoutMs: 400 })
  pool.connect = async () => ({ sftp: () => {}, end: () => {} })
  const t0 = Date.now()
  await assert.rejects(() => pool.sftp(), /timed out/)
  const dt = Date.now() - t0
  assert.ok(dt < 2500, `open must time out, took ${dt}ms`)
  pool.close()
})

test('the sftp open watchdog keeps the process alive until it settles', () => {
  // ★ 回归：这个看门狗定时器曾被 unref()，而它是"本次 await 的 sftp 打开"的
  //   **唯一结算者**。一旦 unref，且进程此刻没有其它 pending 句柄，Node 会直接
  //   退出 —— 调用方永远等不到结果。实测症状：CI 上同文件后续 4 个用例被标记
  //   `cancelledByParent`（子进程提前退出），而本地因运行器恰好持着句柄而侥幸全绿。
  //
  //   这里用源码断言而非时序断言，是因为该缺陷只在"事件循环恰好空闲"时显形，
  //   用挂钟时间测会得出"本地通过"的假安全感（这正是它躲过一轮的原因）。
  const src = readFileSync(new URL('../lib/pool.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('const attemptTimer = setTimeout'))
  const timerBody = block.slice(0, block.indexOf('const clearAttempt'))

  assert.match(timerBody, /reject\(new Error\(`ssh sftp open timed out/, 'sanity: this is the open watchdog')
  assert.doesNotMatch(timerBody, /\.unref\(\)/,
    'the sftp open watchdog is the sole settler of an awaited promise and must not be unref-ed')

  // 对照：真正只做清理的定时器**应当**保持 unref，否则一个卡住的 socket 会拖住进程。
  // （把两类混淆正是最初出错的原因，所以两个方向都钉住。）
  const hardCloses = [...src.matchAll(/const hardClose = setTimeout[\s\S]{0,120}?\n\s*if \(typeof hardClose\.unref/g)]
  assert.ok(hardCloses.length >= 2, 'cleanup-only timers should still be unref-ed')
})

test('search ignores machine-local cache trees without changing mirror sync', async () => {
  // Rationale: ~/.npm etc. are huge, essentially never the target of a search,
  // and the reported cause of the hang. Mirror sync keeps its own (narrower)
  // default so nothing silently stops syncing.
  const search = compileIgnore(DEFAULT_SEARCH_IGNORE)
  for (const dir of ['.npm', '.cache', '.cargo', '.local', 'node_modules', '.git']) {
    assert.equal(search(dir, true), true, `${dir} should be skipped by search`)
  }
  for (const dir of ['src', 'lib', '_cacache', 'project']) {
    assert.equal(search(dir, true), false, `${dir} must not be skipped by search`)
  }
  const sync = compileIgnore(DEFAULT_IGNORE)
  assert.equal(sync('.npm', true), false, 'mirror sync must NOT silently skip .npm')
  assert.equal(sync('.cache', true), false, 'mirror sync must NOT silently skip .cache')
})

test('searchViaShell reports cancellation instead of throwing (so no slow fallback runs)', async () => {
  // An abort arriving *during* the remote grep must come back as cancelled. If it
  // threw, searchRemote would treat it as "rg/grep unavailable" and start the
  // unbounded SFTP walk — the exact thing the caller asked to stop.
  const pool = {
    platform: 'linux',
    exec: async () => ({ code: -1, signal: 'ABORTED', stdout: '/a/b.ts:3:partial hit\n', stderr: '' }),
  }
  const r = await searchViaShell(pool, '/home/u', { pattern: 'x' })
  assert.equal(r.cancelled, true, 'an aborted shell search must be marked cancelled')
  assert.equal(r.matches.length, 1, 'partial remote output is still returned')
})

test('rw_search declares a usable timeoutMs and the budget arguments', async () => {
  // The tool-call-timeout-policy only protects tools that declare a positive
  // `timeoutMs` (it validates it), and the declaration is what turns exec.signal
  // into a real timeout. Config must therefore come from the plugin's own schema
  // — a bare `{}` leaves searchTimeoutMs undefined and the tool silently loses
  // its timeout, so this test resolves the schema defaults the way DSH does.
  const mod = await import('../lib/index.js?budget=1')
  const resolved = typeof mod.Config === 'function' ? new mod.Config({}) : mod.Config
  assert.ok(Number.isFinite(resolved.searchTimeoutMs) && resolved.searchTimeoutMs > 0,
    `schema default for searchTimeoutMs must be a positive number, got ${resolved.searchTimeoutMs}`)
  assert.ok(Number.isFinite(resolved.searchMaxEntries) && resolved.searchMaxEntries > 0,
    `schema default for searchMaxEntries must be a positive number, got ${resolved.searchMaxEntries}`)

  const tools = new Map()
  await mod.apply({
    effect: () => {}, inject: () => {}, get: () => undefined,
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }, resolved)

  const search = tools.get('rw_search')
  assert.ok(search, 'rw_search must be registered')
  assert.ok(Number.isFinite(search.timeoutMs) && search.timeoutMs > 0,
    `rw_search.timeoutMs must be a positive number (the policy validates it), got ${search.timeoutMs}`)
  for (const key of ['maxEntries', 'maxDurationMs']) {
    assert.ok(search.parameters.properties[key], `rw_search must accept ${key}`)
  }
})
