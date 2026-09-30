// 截图前的内容审计：先读渲染后的 DOM 文本，确认没有真实主机/IP/用户名泄漏。
// 因为当前模型不能读图，图片本身无法用眼睛检查，所以脱敏必须在**文本层**证明，
// 再截图。审计不通过就不截。
import { readFileSync, writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'

async function withPage(fn) {
  const targets = await (await fetch(CDP + '/json/list')).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no CDP page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const send = (method, params) => new Promise((res) => {
    const myId = ++id
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { ws.removeEventListener('message', h); res(m) } }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  try { return await fn(send) } finally { ws.close() }
}

const target = process.argv[2]
const token = process.argv[3]
const outFile = process.argv[4]
const w = Number(process.argv[5] || 1280)
const h = Number(process.argv[6] || 800)

// 真实的私有地址 / 常见公司域名特征——截图里出现任何一个都算泄漏
const SECRET_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  /\b21\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b9\.1\d{2}\.\d{1,3}\.\d{1,3}\b/g,
  /\b11\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /devcloud\.woa\.com/g,
  /jimmycppliu/g,
  /\.woa\.com/g,
]

await withPage(async (send) => {
  await send('Page.enable', {})
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: target })
  await new Promise((r) => setTimeout(r, 1500))
  if (token) await send('Runtime.evaluate', { expression: `localStorage.setItem('dsh-web-token', ${JSON.stringify(token)})` }).catch(() => {})
  await new Promise((r) => setTimeout(r, 9000))

  const text = await send('Runtime.evaluate', {
    expression: 'document.body.innerText',
    returnByValue: true,
  })
  const body = text.result?.result?.value || ''

  // 审计
  const leaks = []
  for (const re of SECRET_PATTERNS) {
    const m = body.match(re)
    if (m) leaks.push(...new Set(m))
  }
  // 只允许 RFC 5737 文档地址段（截图用的假数据）
  const allowedDocIPs = body.match(/203\.0\.113\.\d+/g) || []

  console.log('--- 页面文本审计 ---')
  console.log('文本长度:', body.length)
  console.log('文档保留地址 (203.0.113.x, 允许):', [...new Set(allowedDocIPs)].join(', ') || '(none)')
  if (leaks.length) {
    console.log('!! 疑似泄漏:', [...new Set(leaks)].join(', '))
  } else {
    console.log('脱敏检查: 通过（无私有/公司地址或用户名特征）')
  }

  console.log('\n--- 页面文本前 600 字（用于确认内容正确）---')
  console.log(body.slice(0, 600))

  if (leaks.length) {
    console.log('\n拒绝截图：请先清除上述内容。')
    process.exit(1)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shot.result?.data) {
    writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'))
    console.log(`\n已截图 -> ${outFile} (${w}x${h} @2x)`)
  } else {
    console.log('截图失败:', JSON.stringify(shot).slice(0, 200))
    process.exit(1)
  }
})
