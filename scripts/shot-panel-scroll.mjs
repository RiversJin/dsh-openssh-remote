// 对设置面板做「滚动分段截图」——面板内容 1325px 高、可视区只有 698px，
// 单屏截不全（已用 DOM 几何验证：测试连接/保存/检查更新都在框外）。
// 因此滚动到各段分别截图，再由 PIL 纵向拼接成一张长图。
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(10000)
await evalJs(`[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'')==='设置')?.click()`)
await sleep(3000)
await evalJs(`(() => { const c=[...document.querySelectorAll('button,[role="button"],a,li,div')].filter(e=>e.offsetWidth||e.offsetHeight); const el=c.find(e=>/^远程工作区/.test((e.innerText||'').trim())); if(el) el.click(); return !!el })()`)
await sleep(3000)

// 找到可滚动的面板容器
const info = await evalJs(`(() => {
  const marker = [...document.querySelectorAll('*')].filter(e => (e.innerText||'').includes('端口转发（SSH 隧道）'));
  const deepest = marker[marker.length - 1];
  let el = deepest;
  while (el && el.parentElement) { const r = el.getBoundingClientRect(); if (r.width > 500 && r.height > 300) break; el = el.parentElement; }
  let n = el;
  while (n && n !== document.body) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) {
      window.__panel = n;
      const r = n.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight });
    }
    n = n.parentElement;
  }
  return JSON.stringify({ ok: false });
})()`)
console.log('面板:', info)
const g = JSON.parse(info)
if (!g.ok) { console.log('找不到可滚动面板'); ws.close(); process.exit(1) }

const maxScroll = g.scrollHeight - g.clientHeight
const steps = Math.ceil(g.scrollHeight / g.clientHeight)
console.log(`内容高 ${g.scrollHeight}, 可视 ${g.clientHeight}, 需 ${steps} 屏 (maxScroll=${maxScroll})`)

for (let i = 0; i < steps; i++) {
  const top = Math.min(i * g.clientHeight, maxScroll)
  await evalJs(`window.__panel.scrollTop = ${top}; true`)
  await sleep(1200)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (!shot.result?.data) { console.log(`第 ${i} 屏截图失败`); break }
  const f = `${outPrefix}-${i}.png`
  writeFileSync(f, Buffer.from(shot.result.data, 'base64'))
  console.log(`第 ${i} 屏 (scrollTop=${top}) -> ${f}`)
}
ws.close()
