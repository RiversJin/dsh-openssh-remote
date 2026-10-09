// 对 **npm 装出来的那份代码** 跑真实行为验证（不是 grep 字符串，也不是跑我的工作树）。
//
// 目的：确认发布产物里 issue #44 的修复真的生效。这是"发布并验证"的最后一环 ——
// 前面 npm install 只证明包装上了，这里证明装出来的代码**行为正确**。
const PKG = process.argv[2]  // node_modules/dsh-openssh-remote 的绝对路径
if (!PKG) { console.error('usage: node verify-published.mjs <path/to/node_modules/dsh-openssh-remote>'); process.exit(2) }

const { pathToFileURL } = await import('node:url')
const path = await import('node:path')
const { EventEmitter } = await import('node:events')

const load = (rel) => import(pathToFileURL(path.join(PKG, rel)).href)

const { searchTree, searchViaShell } = await load('lib/search.js')
const { SshPool } = await load('lib/pool.js')
const { compileIgnore, DEFAULT_IGNORE, DEFAULT_SEARCH_IGNORE } = await load('lib/ignore.js')
const idx = await load('lib/index.js')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

/** 慢速假树：让时间预算真正成为约束。 */
function makeSftp(counters, delayMs = 1) {
  const tick = () => new Promise((r) => setTimeout(r, delayMs))
  return {
    async readdir() {
      counters.readdir++
      const out = []
      for (let i = 0; i < 50; i++) out.push({ filename: `f${i}.txt`, attrs: { isDirectory: () => false, size: 100 } })
      out.push({ filename: 'sub', attrs: { isDirectory: () => true, size: 0 } })
      return out
    },
    async stat() { counters.stat++; await tick(); return { size: 100 } },
    async readFile() { counters.readFile++; await tick(); return Buffer.from('no match here\n') },
  }
}

console.log(`验证已发布产物: ${PKG}\n`)

console.log('--- issue #44 修复 1：搜索有时间预算（可中断）---')
{
  const c = { readdir: 0, stat: 0, readFile: 0 }
  const t0 = Date.now()
  const r = await searchTree(makeSftp(c), '/home/u', {
    regex: /zzz-absent-zzz/, maxFiles: 1e9, maxDurationMs: 300, isIgnored: () => false,
  })
  const dt = Date.now() - t0
  check('时间预算生效并返回部分结果', dt < 3000 && r.truncated === true, `${dt}ms, scanned=${r.scanned}`)
}

console.log('\n--- 修复 1b：abort 能被响应（这才是取消的关键）---')
{
  const c = { readdir: 0, stat: 0, readFile: 0 }
  const ac = new AbortController()
  const sftp = makeSftp(c)
  const orig = sftp.stat
  sftp.stat = async (...a) => { if (c.stat >= 100) ac.abort(); return orig(...a) }
  const r = await searchTree(sftp, '/home/u', {
    regex: /zzz-absent-zzz/, maxFiles: 1e9, maxDurationMs: 0, signal: ac.signal, isIgnored: () => false,
  })
  check('收到 abort 后停止并标记 cancelled', r.cancelled === true, `scanned=${r.scanned}`)
}

console.log('\n--- 修复 2：SFTP 通道死了要立即失败（不再等满超时）---')
{
  const sftpObj = new EventEmitter()
  for (const m of ['readdir', 'stat', 'readFile', 'open', 'close']) sftpObj[m] = () => {}
  const pool = new SshPool({ host: 'x', port: 22, username: 'u', commandTimeoutMs: 1000 })
  pool.connect = async () => ({ sftp: (cb) => cb(null, sftpObj), end: () => {} })
  const sftp = await pool.sftp()
  sftpObj.emit('end')
  const t0 = Date.now()
  let msg = ''
  try { await sftp.stat('/x') } catch (e) { msg = e.message }
  const dt = Date.now() - t0
  check('死通道立即报错（远小于 1000ms 超时）', dt < 250 && /channel closed/.test(msg), `${dt}ms, "${msg}"`)
  pool.close()
}

console.log('\n--- 修复 2b：打开子通道有超时 ---')
{
  const pool = new SshPool({ host: 'x', port: 22, username: 'u', commandTimeoutMs: 400 })
  pool.connect = async () => ({ sftp: () => {}, end: () => {} })
  // 池里的打开超时是 unref 的（真实 DSH 进程里有 HTTP server 撑着事件循环，
  // node:test 里有 test runner 撑着），所以在这个裸脚本里必须自己挂一个
  // 未 unref 的看门狗，否则 Node 会在定时器触发前就退出，表现为"挂住"。
  // 这是测试装置问题，不是产物缺陷。
  const keepAlive = setTimeout(() => {}, 3000)
  const t0 = Date.now()
  let msg = ''
  try { await pool.sftp() } catch (e) { msg = e.message }
  clearTimeout(keepAlive)
  const dt = Date.now() - t0
  check('无响应的远端会超时而非永久挂起', dt < 2500 && /timed out/.test(msg), `${dt}ms, "${msg}"`)
  pool.close()
}

console.log('\n--- 修复 3：搜索忽略缓存树，但同步不忽略（防丢数据）---')
{
  const s = compileIgnore(DEFAULT_SEARCH_IGNORE)
  const sync = compileIgnore(DEFAULT_IGNORE)
  check('搜索跳过 .npm/.cache/.cargo', ['.npm', '.cache', '.cargo'].every((d) => s(d, true) === true))
  check('搜索不跳过普通目录', ['src', 'lib'].every((d) => s(d, true) === false))
  check('镜像同步**不**跳过 .npm（避免静默漏同步）', sync('.npm', true) === false)
}

console.log('\n--- 修复 4：orw_search 声明了 timeoutMs 与预算参数 ---')
{
  const resolved = typeof idx.Config === 'function' ? new idx.Config({}) : idx.Config
  const tools = new Map()
  await idx.apply({
    effect: () => {}, inject: () => {}, get: () => undefined,
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }, resolved)
  const search = tools.get('orw_search')
  check('orw_search 存在且 timeoutMs 为正数', !!search && Number.isFinite(search.timeoutMs) && search.timeoutMs > 0, `timeoutMs=${search?.timeoutMs}`)
  check('接受 maxEntries / maxDurationMs 参数',
    !!search?.parameters?.properties?.maxEntries && !!search?.parameters?.properties?.maxDurationMs)
}

console.log('\n--- PR #45：orw_edit 别名 ---')
{
  const resolved = typeof idx.Config === 'function' ? new idx.Config({}) : idx.Config
  const tools = new Map()
  await idx.apply({
    effect: () => {}, inject: () => {}, get: () => undefined,
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }, resolved)
  const edit = tools.get('orw_edit')
  const props = edit?.parameters?.properties || {}
  const required = edit?.parameters?.required || []
  check('声明 old_string / new_string / file_path',
    ['old_string', 'new_string', 'file_path'].every((k) => !!props[k]))
  check('三者都不在 schema.required（否则别名会被前置校验拒掉）',
    !['path', 'old', 'new', 'old_string', 'new_string', 'file_path'].some((k) => required.includes(k)),
    `required=${JSON.stringify(required)}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
