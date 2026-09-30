// 用 CDP 的 Fetch 拦截，把 /dsh-remote/update-check 的响应替换成"正常查到新版本"，
// 从而截到一张**正常状态**的面板图 —— 而不是我限流期间拍到的错误态。
//
// 为什么必须这么做：README/站点里的配图是产品门面，若带着
// 「npm registry 限流（HTTP 429）」这种与用户无关的错误提示，会误导读者
// 以为插件坏了。限流是我本机出口 IP 的问题，不该出现在文档里。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, outPrefix] = process.argv
const VW = 1320, VH = 1820

const targets = await (await fetch(CDP + '/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const send = (m, p) => new Promise((res) => {
  const my = ++id
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id === my) { ws.removeEventListener('message', h); res(x) } }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id: my, method: m, params: p }))
})
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 拦截并伪造 update-check：模拟"已是最新"的正常状态
ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params
    if (request.url.includes('/dsh-remote/update-check')) {
      const body = JSON.stringify({
        ok: true, current: '0.8.34', loaded: '0.8.34', disk: '0.8.34',
        pendingReload: false, updateMode: 'auto', updatedMarker: false,
        selfUpdateAllowed: true, latest: '0.8.34', updateAvailable: false,
      })
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(body).toString('base64'),
      })
      console.log('  [拦截] 已伪造 update-check -> 正常状态')
    } else {
      await send('Fetch.continueRequest', { requestId })
    }
  }
})

await send('Page.enable', {})
await send('Fetch.enable', { patterns: [{ urlPattern: '*update-check*' }] })
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

// 找滚动容器并置顶
const info = await evalJs(`(() => {
  const sc = [...document.querySelectorAll('*')].find(e =>
    e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200 && (e.innerText||'').includes('更新模式'));
  if (!sc) return JSON.stringify({ error: 'scroller not found' });
  window.__sc = sc; sc.scrollTop = 0;
  const r = sc.getBoundingClientRect();
  return JSON.stringify({ scrollH: sc.scrollHeight, clientH: sc.clientHeight,
    container: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
})()`)
console.log('滚动容器:', info)
const g = JSON.parse(info)
if (g.error) { ws.close(); process.exit(1) }

const body = (await evalJs('document.body.innerText')) || ''
console.log('面板文本是否仍含错误提示:', /限流|429|无法连接/.test(body) ? '是（拦截未生效）' : '否（干净）')

const maxScroll = g.scrollH - g.clientH
const step = g.clientH - 40
const positions = []
for (let t = 0; t <= maxScroll; t += step) positions.push(t)
if (positions[positions.length - 1] !== maxScroll) positions.push(maxScroll)

for (let i = 0; i < positions.length; i++) {
  await evalJs(`window.__sc.scrollTop = ${positions[i]}; true`)
  await sleep(1100)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outPrefix}-s${i}.png`, Buffer.from(shot.result.data, 'base64'))
  console.log(`  段${i}: scrollTop=${positions[i]}`)
}
writeFileSync(`${outPrefix}-meta.json`, JSON.stringify({ ...g, positions, maxScroll, contentTop: g.container.y }, null, 2))
console.log('元数据:', `${outPrefix}-meta.json`)
ws.close()
