#!/usr/bin/env node
// 把 docs/*.html 渲染成 PNG（文档配图的既定管线）。
//
// 为什么需要脚本而不是每次手敲 chrome 命令：promote.md 里记的做法要求
// 「先 @2x 渲染、再降采样到目标尺寸」，还要手工确认高度 —— 一条命令里做错
// 一个数字就会产出尺寸不对的图（而尺寸错在 GitHub 上表现为模糊或被拉伸）。
// 这里把量测、渲染、降采样串起来，并在写文件前做布局自检。
//
// 用法：
//   node scripts/render-doc-image.mjs docs/features.html docs/shots/features.png
//   node scripts/render-doc-image.mjs docs/cover.html docs/cover.png --fixed 1280x640
//
// 选项：
//   --fixed WxH   固定画布尺寸（封面就是 1280x640）。省略时按内容自适应高度。
//   --width N     自适应模式下的画布宽度（默认 1280）。
//   --pad N       自适应模式下内容底部额外留白（默认 0）。
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'

const args = process.argv.slice(2)
const src = args[0]
const dst = args[1]
const fixedArg = args.includes('--fixed') ? args[args.indexOf('--fixed') + 1] : null
const width = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 1280
const pad = args.includes('--pad') ? Number(args[args.indexOf('--pad') + 1]) : 0

if (!src || !dst) {
  console.error('usage: node scripts/render-doc-image.mjs <src.html> <out.png> [--fixed WxH] [--width N] [--pad N]')
  process.exit(2)
}
if (!existsSync(src)) { console.error(`source not found: ${src}`); process.exit(2) }

const [fw, fh] = fixedArg ? fixedArg.split('x').map(Number) : [null, null]

async function connect() {
  const targets = await (await fetch(CDP + '/json/list')).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no CDP page (is Chrome running with --remote-debugging-port=9222?)')
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
  return { ws, send, evalJs }
}

const { ws, send, evalJs } = await connect()
await send('Page.enable', {})
const url = pathToFileURL(path.resolve(src)).href

// 第一遍：先按一个足够大的画布量测内容自然高度
const probeH = fh || 2400
await send('Emulation.setDeviceMetricsOverride', { width: fw || width, height: probeH, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 2200))

const measured = await evalJs(`(() => {
  const el = document.body.firstElementChild || document.body;
  const r = el.getBoundingClientRect();
  const imgs = [...document.images].map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 }));
  return JSON.stringify({
    contentH: Math.ceil(r.height),
    contentW: Math.ceil(r.width),
    scrollH: document.documentElement.scrollHeight,
    scrollW: document.documentElement.scrollWidth,
    imgs,
  });
})()`)
const m = JSON.parse(measured)
console.log('量测:', JSON.stringify(m))

const badImgs = m.imgs.filter((i) => !i.ok)
if (badImgs.length) {
  console.error('以下图片未加载成功（相对路径可能写错）:', badImgs.map((i) => i.src).join(', '))
  ws.close()
  process.exit(1)
}

const canvasW = fw || width
const canvasH = fh || (m.contentH + pad)

// 第二遍：按最终画布渲染
await send('Emulation.setDeviceMetricsOverride', { width: canvasW, height: canvasH, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 2200))

// 布局自检（溢出会被画布裁掉，必须在写文件前发现）
const chk = await evalJs(`(() => {
  const d = document.documentElement;
  return JSON.stringify({ scrollH: d.scrollHeight, scrollW: d.scrollWidth, canvasH: innerHeight, canvasW: innerWidth });
})()`)
const c = JSON.parse(chk)
const problems = []
if (c.scrollW > canvasW + 1) problems.push(`内容宽 ${c.scrollW} 超出画布 ${canvasW}`)
if (c.scrollH > canvasH + 1) problems.push(`内容高 ${c.scrollH} 超出画布 ${canvasH}`)
if (problems.length) {
  console.error('布局自检失败:', problems.join('; '))
  console.error('（固定尺寸时请调大 --fixed，或检查 HTML 是否过宽）')
  ws.close()
  process.exit(1)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (!shot.result?.data) { console.error('截图失败'); ws.close(); process.exit(1) }
const tmp2x = dst.replace(/\.png$/, '@2x.png')
writeFileSync(tmp2x, Buffer.from(shot.result.data, 'base64'))
console.log(`@2x 渲染 -> ${tmp2x} (${statSync(tmp2x).size} bytes, ${canvasW * 2}x${canvasH * 2})`)
ws.close()

// 降采样到目标尺寸（promote.md 的做法：2x 渲染 + LANCZOS 缩小保持字体锐利）
execFileSync('python', ['-c', `
from PIL import Image
im = Image.open(r'${tmp2x}').convert('RGB')
out = im.resize((${canvasW}, ${canvasH}), Image.LANCZOS)
out.save(r'${dst}', optimize=True)
print('${dst}', out.size)
`], { stdio: 'inherit' })

console.log(`\n完成 -> ${dst}`)
