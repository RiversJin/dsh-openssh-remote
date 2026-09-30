// 驱动沙箱 UI 到指定画面并截图（先审计文本，再截图）。
//
// 用法: node _shot-nav.mjs <url> <scene> <out.png>
//   scene = settings  → 打开「设置 → 远程工作区」
//   scene = picker    → 打开「添加工作区」选择器弹窗
//
// 为什么先审计文本：当前模型不能读图，截图里的内容无法用眼睛核对。
// 因此脱敏与内容正确性必须在文本层证明，审计不过就不截。
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const [, , url, scene = 'settings', outFile] = process.argv

const SECRETS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  /\b21\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b9\.1[0-9]{2}\.\d{1,3}\.\d{1,3}\b/g,
  /\b11\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\.woa\.com/gi,
  /devcloud/gi,
  /jimmycppliu/gi,
]

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
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable', {})
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(10000)

// 用 aria-label 定位并点击（不依赖易变的 hash 类名）
const clicked = await evalJs(`(() => {
  const want = ${scene === 'settings' ? "'设置'" : "'添加工作区'"};
  const el = [...document.querySelectorAll('button,[role="button"]')]
    .find(b => (b.getAttribute('aria-label') || '') === want || (b.innerText || '').trim() === want);
  if (!el) return 'NOT FOUND: ' + want;
  el.click();
  return 'clicked: ' + want;
})()`)
console.log('导航:', clicked)
await sleep(scene === 'settings' ? 3500 : 3000)

// 设置页需要再点「远程工作区（dsh-remote）」进入插件面板。
// 注意这里不能用 innerText === '远程工作区' 精确匹配：真实按钮文字是
// 「远程工作区（dsh-remote）」，精确相等永远匹配不到（第一次跑就栽在这）。
if (scene === 'settings') {
  const sub = await evalJs(`(() => {
    const cands = [...document.querySelectorAll('button,[role="button"],a,li,div')]
      .filter(e => (e.offsetWidth || e.offsetHeight));
    // 优先 aria-label / 以「远程工作区」开头且包含 dsh-remote 的那个
    let el = cands.find(e => (e.getAttribute('aria-label') || '').startsWith('远程工作区'));
    if (!el) el = cands.find(e => /^远程工作区/.test((e.innerText || '').trim()) && (e.innerText || '').includes('dsh-remote'));
    if (!el) el = cands.find(e => /^远程工作区/.test((e.innerText || '').trim()));
    if (!el) return 'PANEL BUTTON NOT FOUND';
    el.click();
    return 'clicked: ' + (el.innerText || '').trim().slice(0, 40);
  })()`)
  console.log('子页:', sub)
  await sleep(3000)
}

// 选择器默认落在「本机」tab；截图要展示「远程」tab（插件的核心能力所在）。
// 注意：「远程」这两个字在设置页里也出现，必须把查找范围限制在弹窗内，
// 否则会点到别处（先按 dialog/[role=dialog] 定位，再在内部找 tab）。
if (scene === 'picker') {
  const tab = await evalJs(`(() => {
    const dialog = document.querySelector('[role="dialog"], dialog')
      || [...document.querySelectorAll('div')].find(d => (d.innerText || '').includes('选择工作目录') && (d.innerText || '').includes('本机') && (d.innerText || '').includes('远程'));
    const scope = dialog || document.body;
    const el = [...scope.querySelectorAll('button,[role="tab"],[role="button"]')]
      .filter(e => e.offsetWidth || e.offsetHeight)
      .find(e => (e.innerText || '').trim() === '远程');
    if (!el) return 'REMOTE TAB NOT FOUND (scope=' + (dialog ? 'dialog' : 'body') + ')';
    el.click();
    return 'clicked 远程 tab';
  })()`)
  console.log('切 tab:', tab)
  await sleep(3000)
}

const body = (await evalJs('document.body.innerText')) || ''
const leaks = []
for (const re of SECRETS) { const m = body.match(re); if (m) leaks.push(...new Set(m)) }
const docIPs = [...new Set(body.match(/203\.0\.113\.\d+/g) || [])]

console.log('\n--- 文本审计 ---')
console.log('文本长度:', body.length)
console.log('保留地址(允许):', docIPs.join(', ') || '(none)')
console.log(leaks.length ? `!! 疑似泄漏: ${[...new Set(leaks)].join(', ')}` : '脱敏: 通过')
console.log('\n--- 文本片段 ---')
console.log(body.slice(0, 700))

if (leaks.length) { console.log('\n拒绝截图。'); ws.close(); process.exit(1) }

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (!shot.result?.data) { console.log('截图失败'); ws.close(); process.exit(1) }
writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'))
console.log(`\n已截图 -> ${outFile}`)
ws.close()
