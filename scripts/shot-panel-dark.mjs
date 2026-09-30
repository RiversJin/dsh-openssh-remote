// 截取设置面板（深色主题，用于 README / 站点配图）。
//
// 前几版踩过的坑，逐条记下来避免重犯：
//   1) 页面默认浅色 → 裁出来左缘纯白、右缘灰阴影，左右不对称（"右边一堆阴影"的由来）。
//      修法：Emulation.setEmulatedMedia 强制 prefers-color-scheme: dark。
//   2) 按"有背景色的最外层容器"找面板 → 会一路拿到 body，量出整屏 1280x800。
//      修法：取面板内若干已知控件的**并集**求边界。
//   3) 面板比视口高 → 单屏截不全（这点已用 DOM 几何证实）。
//      修法：滚动分段截 + 按 scrollTop 差值拼接。
//
// 输出：<prefix>-seg<i>.png（@2x）与 <prefix>-geo.json（含边界与分段信息）。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, outPrefix] = process.argv

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
await sleep(3500)

// 面板内控件的并集 -> 内容边界（在**页面坐标**下，随滚动不变）
const geom = await evalJs(`(() => {
  const KEYS = ['端口转发（SSH 隧道）', '测试连接', '检查更新', '最近执行的远程命令（审计日志）', '更新模式：', '机器', '端口', '用户', '保存'];
  const rects = [];
  for (const k of KEYS) {
    for (const e of [...document.querySelectorAll('*')]) {
      const t = (e.innerText || e.textContent || '').trim();
      if (!(t === k || t.startsWith(k))) continue;
      if (!(e.offsetWidth || e.offsetHeight)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y + scrollY, r: r.right, b: r.bottom + scrollY });
    }
  }
  if (!rects.length) return JSON.stringify({ error: 'no controls' });
  const PAD = 18;
  const x = Math.min(...rects.map(v => v.x)) - PAD;
  const top = Math.min(...rects.map(v => v.y)) - PAD;
  const right = Math.max(...rects.map(v => v.r)) + PAD;
  const bottom = Math.max(...rects.map(v => v.b)) + PAD;
  return JSON.stringify({
    x: Math.round(x), top: Math.round(top), w: Math.round(right - x), h: Math.round(bottom - top),
    pageH: document.documentElement.scrollHeight, vh: innerHeight,
  });
})()`)
console.log('面板内容边界(页面坐标):', geom)
const g = JSON.parse(geom)
if (g.error) { console.log('量测失败'); ws.close(); process.exit(1) }

// 脱敏审计
const body = (await evalJs('document.body.innerText')) || ''
const SECRETS = [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, /\b192\.168\.\d{1,3}\.\d{1,3}\b/g, /\.woa\.com/gi, /devcloud/gi, /jimmycppliu/gi]
const leaks = []
for (const re of SECRETS) { const m = body.match(re); if (m) leaks.push(...new Set(m)) }
console.log('脱敏:', leaks.length ? '泄漏 ' + [...leaks].join(',') : '通过')
if (leaks.length) { ws.close(); process.exit(1) }

// 页面级滚动分段：让 g.top..g.top+g.h 全部进入过视口
const vh = g.vh
const segs = []
let y = 0
const maxY = Math.max(0, g.top + g.h - vh)
while (true) {
  segs.push(y)
  if (y >= maxY) break
  y = Math.min(y + vh - 60, maxY)   // 留 60px 重叠，拼接时按 scrollTop 去重
}
console.log(`内容高 ${g.h}，视口 ${vh}，分 ${segs.length} 段`)

for (let i = 0; i < segs.length; i++) {
  await evalJs(`window.scrollTo(0, ${segs[i]}); true`)
  await sleep(1300)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outPrefix}-seg${i}.png`, Buffer.from(shot.result.data, 'base64'))
  console.log(`  段${i}: scrollY=${segs[i]} -> ${outPrefix}-seg${i}.png`)
}

writeFileSync(`${outPrefix}-geo.json`, JSON.stringify({ ...g, segs }, null, 2))
console.log('几何已保存:', `${outPrefix}-geo.json`)
ws.close()
