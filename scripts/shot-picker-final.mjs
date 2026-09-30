// 截取「选择工作目录」弹窗（深色、扁平、边界用**弹窗容器**而非选定节点并集）。
//
// 与设置面板同类问题：先前用"若干选定文字节点的并集"定边界 -> 框偏窄、边缘切字。
// 这里改为找到弹窗容器本身（有圆角/阴影的最大内层盒子），按它的边界外扩留白。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, outFile, geoOut] = process.argv
const VW = 1320, VH = 900
const PAD = 22

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
await evalJs(`[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '添加工作区')?.click()`)
await sleep(3200)
// 切「远程」tab（限定在弹窗内）
await evalJs(`(() => {
  const d = document.querySelector('[role="dialog"], dialog')
    || [...document.querySelectorAll('div')].find(x => (x.innerText||'').includes('选择工作目录'));
  const s = d || document.body;
  const el = [...s.querySelectorAll('button,[role="tab"]')].filter(e => e.offsetWidth || e.offsetHeight)
    .find(e => (e.innerText || '').trim() === '远程');
  if (el) el.click(); return !!el;
})()`)
await sleep(2800)

// 找弹窗容器：在"包含 选择工作目录 且 包含 设为远程工作区"的候选里，
// 取**面积最小**且宽高比合理、带圆角或阴影的那个（真正的弹窗卡片）。
const geom = await evalJs(`(() => {
  const cands = [...document.querySelectorAll('div,[role="dialog"],dialog')].filter(e => {
    const t = e.innerText || '';
    return t.includes('选择工作目录') && t.includes('设为远程工作区');
  });
  const scored = cands.map(e => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { e, r, radius: cs.borderRadius, shadow: cs.boxShadow !== 'none',
             area: r.width * r.height };
  }).filter(v => v.r.width > 300 && v.r.height > 150 && (v.radius !== '0px' || v.shadow))
    .sort((a, b) => a.area - b.area);
  if (!scored.length) return JSON.stringify({ error: 'dialog not found' });
  const best = scored[0];
  const r = best.r;
  // 弹窗内全部可见后代的并集（用于交叉验证容器是否覆盖全部内容）
  const rects = [];
  for (const e of best.e.querySelectorAll('*')) {
    if (!(e.offsetWidth || e.offsetHeight)) continue;
    const b = e.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) rects.push({ x: b.x, r: b.right, y: b.y, b: b.bottom });
  }
  const ux = Math.min(...rects.map(v => v.x)), ur = Math.max(...rects.map(v => v.r));
  const uy = Math.min(...rects.map(v => v.y)), ub = Math.max(...rects.map(v => v.b));
  return JSON.stringify({
    dialog: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    contentUnion: { x: Math.round(ux), right: Math.round(ur), y: Math.round(uy), bottom: Math.round(ub) },
    coversContent: ux >= r.x - 1 && ur <= r.right + 1 && uy >= r.y - 1 && ub <= r.bottom + 1,
    candidates: scored.length,
    radius: best.radius, shadow: best.shadow,
  });
})()`)
console.log('弹窗几何:', geom)
const g = JSON.parse(geom)
if (g.error) { ws.close(); process.exit(1) }
if (!g.coversContent) {
  console.log('!! 弹窗容器未覆盖全部内容，放弃')
  ws.close(); process.exit(1)
}

const body = (await evalJs('document.body.innerText')) || ''
const SECRETS = [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, /\b192\.168\.\d{1,3}\.\d{1,3}\b/g, /\.woa\.com/gi, /devcloud/gi, /jimmycppliu/gi]
const leaks = []
for (const re of SECRETS) { const m = body.match(re); if (m) leaks.push(...new Set(m)) }
console.log('脱敏:', leaks.length ? '泄漏 ' + [...leaks].join(',') : '通过')
if (leaks.length) { ws.close(); process.exit(1) }

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'))
writeFileSync(geoOut, JSON.stringify({ ...g, pad: PAD }, null, 2))
console.log(`已截 -> ${outFile}`)
ws.close()
