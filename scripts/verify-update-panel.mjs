// 验证修复后面板上「更新」区域的实际文案。
// 要证明两件事：
//   1) 不再笼统说"无法连接 npm registry"，而是说明是限流；
//   2) 不再停在「版本信息加载中…」——本地版本/模式应照常显示。
// 用 DOM 文本读取（我读不了图，只能读文本）。
const CDP = 'http://127.0.0.1:9222'
const url = process.argv[2]

const targets = await (await fetch(CDP + '/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const send = (m, p) => new Promise((res) => {
  const my = ++id
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id === my) { ws.removeEventListener('message', h); res(x) } }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id: my, method: m, params: p }))
})
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable', {})
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await send('Page.navigate', { url })
await sleep(11000)
await evalJs(`[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '设置')?.click()`)
await sleep(3500)
await evalJs(`(() => {
  const c = [...document.querySelectorAll('button,[role="button"],a,li,div')].filter(e => e.offsetWidth || e.offsetHeight);
  const el = c.find(e => /^远程工作区/.test((e.innerText || '').trim()));
  if (el) el.click(); return !!el;
})()`)
await sleep(4000)

// 滚到「更新」区域
await evalJs(`(() => {
  const el = [...document.querySelectorAll('*')].find(e => (e.innerText||'').trim().startsWith('更新模式：'));
  if (el) el.scrollIntoView({block:'center'});
  return !!el;
})()`)
await sleep(1500)

const body = await evalJs('document.body.innerText')
const lines = body.split('\n').map((s) => s.trim()).filter(Boolean)
const start = lines.findIndex((l) => l.startsWith('更新') || l.includes('版本'))
console.log('--- 「更新」区域附近文本 ---')
console.log(lines.slice(Math.max(0, start - 2), start + 14).join('\n'))

console.log('\n--- 判据 ---')
const checks = [
  ['不再笼统说"无法连接"', !body.includes('无法连接 npm registry')],
  ['说明了是限流', /限流|429/.test(body)],
  ['不再卡在"加载中"', !body.includes('版本信息加载中')],
  ['显示了当前版本', /0\.8\.\d+/.test(body)],
  ['显示了更新模式', /更新模式|自动|手动/.test(body)],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) ok = false
}
ws.close()
process.exit(ok ? 0 : 1)
