// 最终版：截取「远程工作区」设置面板整块。
//
// 关键事实（逐个量出来的，之前全是猜）：
//   · 面板的滚动容器是 div.VOzbGW_options —— x=448, y=564, w=612, h=746，
//     scrollHeight=1325。页面本身 docH==vh 不可滚动，必须滚这个容器。
//   · 面板真实宽度 **612**，而我先前用"选定文字节点并集"算出 535/556 ——
//     偏窄约 60-77px，所以右边文字被切，上边也切了 513px。
//
// 做法：滚这个容器到 0 和到底，各截一屏，之后按 scrollTop 差值拼接。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, outPrefix] = process.argv
const VW = 1320
const VH = 1820

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
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await send('Page.navigate', { url })
await sleep(12000)
await evalJs(`[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '设置')?.click()`)
await sleep(3500)
await evalJs(`(() => {
  const c = [...document.querySelectorAll('button,[role="button"],a,li,div')].filter(e => e.offsetWidth || e.offsetHeight);
  const el = c.find(e => /^远程工作区/.test((e.innerText || '').trim()));
  if (el) el.click(); return !!el;
})()`)
await sleep(4500)

// 定位滚动容器并置顶
const info = await evalJs(`(() => {
  const sc = [...document.querySelectorAll('*')].find(e =>
    e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200 && (e.innerText||'').includes('更新模式'));
  if (!sc) return JSON.stringify({ error: 'scroller not found' });
  window.__sc = sc;
  sc.scrollTop = 0;
  const r = sc.getBoundingClientRect();
  // 同时取该容器内所有可见后代的并集（这才是"面板内容"的真实宽度）
  const rects = [];
  for (const e of sc.querySelectorAll('*')) {
    if (!(e.offsetWidth || e.offsetHeight)) continue;
    const b = e.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) rects.push({ x: b.x, r: b.right, y: b.y, b: b.bottom });
  }
  const x = Math.min(...rects.map(v => v.x)), right = Math.max(...rects.map(v => v.r));
  return JSON.stringify({
    scrollH: sc.scrollHeight, clientH: sc.clientHeight,
    container: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    contentUnion: { x: Math.round(x), right: Math.round(right), w: Math.round(right - x) },
    contentTop: Math.round(Math.min(...rects.map(v => v.y))),
    contentBottomInScroll: sc.scrollHeight,
  });
})()`)
console.log('滚动容器:', info)
const g = JSON.parse(info)
if (g.error) { ws.close(); process.exit(1) }

const maxScroll = g.scrollH - g.clientH
const step = g.clientH - 40      // 40px 重叠
const positions = []
for (let t = 0; t <= maxScroll; t += step) positions.push(t)
if (positions[positions.length - 1] !== maxScroll) positions.push(maxScroll)
console.log(`内容 ${g.scrollH}, 可视 ${g.clientH}, maxScroll=${maxScroll}, ${positions.length} 段`)

const body = (await evalJs('document.body.innerText')) || ''
const SECRETS = [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, /\b192\.168\.\d{1,3}\.\d{1,3}\b/g, /\.woa\.com/gi, /devcloud/gi, /jimmycppliu/gi]
const leaks = []
for (const re of SECRETS) { const m = body.match(re); if (m) leaks.push(...new Set(m)) }
console.log('脱敏:', leaks.length ? '泄漏 ' + [...leaks].join(',') : '通过')
if (leaks.length) { ws.close(); process.exit(1) }

for (let i = 0; i < positions.length; i++) {
  await evalJs(`window.__sc.scrollTop = ${positions[i]}; true`)
  await sleep(1100)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outPrefix}-s${i}.png`, Buffer.from(shot.result.data, 'base64'))
  console.log(`  段${i}: scrollTop=${positions[i]} -> ${outPrefix}-s${i}.png`)
}

writeFileSync(`${outPrefix}-meta.json`, JSON.stringify({ ...g, positions, maxScroll }, null, 2))
console.log('元数据 ->', `${outPrefix}-meta.json`)
ws.close()
