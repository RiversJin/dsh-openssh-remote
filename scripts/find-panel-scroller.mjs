// 查清面板内容的滚动容器：页面本身不可滚动（docH == vh），
// 但面板内容 1301px 高于视口 —— 必然在某个内部容器里滚动。
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
await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 1820, deviceScaleFactor: 2, mobile: false })
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

// 列出所有可滚动元素（scrollHeight > clientHeight）
const out = await evalJs(`(() => {
  const rows = [];
  for (const e of document.querySelectorAll('*')) {
    if (e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 50) {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      rows.push({
        tag: e.tagName.toLowerCase(), cls: String(e.className||'').slice(0,30),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        scrollH: e.scrollHeight, clientH: e.clientHeight,
        overflowY: cs.overflowY,
        hasUpdateMode: (e.innerText||'').includes('更新模式'),
        hasPortFwd: (e.innerText||'').includes('端口转发'),
      });
    }
  }
  return JSON.stringify({ count: rows.length, rows: rows.slice(0, 8), docScroll: document.documentElement.scrollHeight, vh: innerHeight }, null, 1);
})()`)
console.log(out)
ws.close()
