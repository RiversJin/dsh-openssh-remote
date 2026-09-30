// 截取「选择工作目录」弹窗（深色主题，扁平化配图）。
//
// 与旧的 picker-dialog.png 相比的修正：旧图是**浅色主题**下截的，弹窗四周
// 留了一圈深色页面底（最外 5 列亮度 96-102，随后突跳到 255 的弹窗体），
// 左右虽对称但视觉上"脏"。这里统一深色主题并裁到弹窗本体。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, outFile] = process.argv

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

await evalJs(`[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '添加工作区')?.click()`)
await sleep(3200)
// 切到「远程」tab（在弹窗范围内找，避免点到设置页的同名文字）
const tab = await evalJs(`(() => {
  const d = document.querySelector('[role="dialog"], dialog')
    || [...document.querySelectorAll('div')].find(x => (x.innerText||'').includes('选择工作目录'));
  const s = d || document.body;
  const el = [...s.querySelectorAll('button,[role="tab"]')].filter(e => e.offsetWidth || e.offsetHeight)
    .find(e => (e.innerText || '').trim() === '远程');
  if (el) el.click(); return !!el;
})()`)
console.log('切到远程 tab:', tab)
await sleep(2600)

// 用弹窗内控件的并集求边界（同面板截图的做法）
const geom = await evalJs(`(() => {
  const KEYS = ['远程机器：', '最近：', '浏览…', '设为远程工作区', '关闭'];
  const rects = [];
  for (const k of KEYS) {
    for (const e of [...document.querySelectorAll('*')]) {
      const t = (e.innerText || e.textContent || '').trim();
      if (!(t === k || t.startsWith(k))) continue;
      if (!(e.offsetWidth || e.offsetHeight)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, r: r.right, b: r.bottom });
    }
  }
  if (!rects.length) return JSON.stringify({ error: 'no controls' });
  const PAD = 20;
  const x = Math.min(...rects.map(v => v.x)) - PAD;
  const y = Math.min(...rects.map(v => v.y)) - PAD;
  const right = Math.max(...rects.map(v => v.r)) + PAD;
  const bottom = Math.max(...rects.map(v => v.b)) + PAD;
  return JSON.stringify({ x: Math.round(x), y: Math.round(y), w: Math.round(right - x), h: Math.round(bottom - y), rectCount: rects.length });
})()`)
console.log('弹窗边界:', geom)
const g = JSON.parse(geom)
if (g.error) { console.log('量测失败'); ws.close(); process.exit(1) }

const body = (await evalJs('document.body.innerText')) || ''
const SECRETS = [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, /\b192\.168\.\d{1,3}\.\d{1,3}\b/g, /\.woa\.com/gi, /devcloud/gi, /jimmycppliu/gi]
const leaks = []
for (const re of SECRETS) { const m = body.match(re); if (m) leaks.push(...new Set(m)) }
console.log('脱敏:', leaks.length ? '泄漏 ' + [...leaks].join(',') : '通过')
if (leaks.length) { ws.close(); process.exit(1) }

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'))
writeFileSync(outFile.replace(/\.png$/, '-geo.json'), JSON.stringify(g, null, 2))
console.log(`已截 -> ${outFile} （边界 ${g.w}x${g.h} 逻辑像素）`)
ws.close()
