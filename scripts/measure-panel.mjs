// 精确量测设置面板在截图里的**像素边界**（而不是凭 DOM 的 CSS 盒子）。
//
// 为什么不能用 DOM 盒子：DOM 的 getBoundingClientRect 给的是布局盒子，
// 面板外围还可能有 padding / 圆角 / 外层白色背景，直接按它裁会带进白边
// （实测左缘整列 255 纯白）或切进阴影。所以按像素找"内容真正开始/结束"的位置。
//
// 输出：建议的裁剪框（逻辑像素，相对 1280x800 视口）。
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(11000)

// 打开设置（分步验证，失败时报出实际状态，避免"title not found"这种模糊结论）
const s1 = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '设置');
  if (!b) return 'NO_SETTINGS_BUTTON';
  b.click(); return 'clicked';
})()`)
console.log('打开设置:', s1)
await sleep(3500)

const s2 = await evalJs(`(() => {
  const c = [...document.querySelectorAll('button,[role="button"],a,li,div')].filter(e => e.offsetWidth || e.offsetHeight);
  const el = c.find(e => /^远程工作区/.test((e.innerText || '').trim()));
  if (!el) {
    const sample = c.map(e => (e.innerText||'').trim()).filter(t => t && t.length < 24).slice(0, 14);
    return 'PANEL_BTN_NOT_FOUND; visible texts: ' + JSON.stringify(sample);
  }
  el.click(); return 'clicked: ' + (el.innerText||'').trim().slice(0, 30);
})()`)
console.log('进入插件面板:', s2)
await sleep(3500)

// 取面板内**有可见背景**的最外层容器。
// 定位锚点用「端口转发」等面板内独有的文案：标题实际是「远程工作区（dsh-remote）」，
// 用 === '远程工作区' 精确匹配永远找不到（已经栽过一次）。
const box = await evalJs(`(() => {
  const PAGE_BG = getComputedStyle(document.body).backgroundColor;
  const anchors = ['端口转发', '测试连接', '检查更新'];
  let anchorEl = null;
  for (const a of anchors) {
    anchorEl = [...document.querySelectorAll('*')].find(e => (e.innerText||'').includes(a) && !e.children.length);
    if (anchorEl) break;
  }
  if (!anchorEl) return JSON.stringify({ error: 'anchor text not found' });

  let el = anchorEl, card = null;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const transparent = !bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
    const r = el.getBoundingClientRect();
    if (!transparent && r.width > 380 && r.height > 300) card = el;
    el = el.parentElement;
  }
  const target = card || anchorEl.parentElement;
  const r = target.getBoundingClientRect();
  const cs = getComputedStyle(target);
  return JSON.stringify({
    found: !!card,
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    bg: cs.backgroundColor,
    borderRadius: cs.borderRadius,
    boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 70),
    pageBg: PAGE_BG,
    viewport: { w: innerWidth, h: innerHeight },
  }, null, 1);
})()`)
console.log(box)
ws.close()
