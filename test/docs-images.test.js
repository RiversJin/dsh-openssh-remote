// README / 站点引用的配图必须真实存在、且不是占位尺寸。
//
// 为什么需要：README 改成"多用渲染图"之后，文字变少、图变成主要信息来源 ——
// 一张图挂掉（路径写错、渲染产物没提交）在 GitHub 上只显示一个破图图标，
// 没有任何提示。而这次重做配图时确实出现过：新图放进了 docs/shots/，但
// 主页与 screenshots.json 还指向已删除的旧图。
//
// 判据（只查静态事实，不需要浏览器）：
//   1) 每个相对图片引用都能在磁盘上找到；
//   2) PNG 能被解析且尺寸合理（> 200x150），排除误放的占位图；
//   3) 两版 README 各自至少引用 3 张图（防"全删了"的极端回归）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const SOURCES = ['README.md', 'README.en.md', 'docs/index.html', 'docs/stats/index.html', 'screenshots.json']

/** 抽出所有相对图片引用（跳过 http/data URI）。 */
function imageRefs(file) {
  const text = readFileSync(path.join(root, file), 'utf8')
  const out = []
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(m[1])
  for (const m of text.matchAll(/<img[^>]+src="([^"]+)"/g)) out.push(m[1])
  for (const m of text.matchAll(/"((?:docs|\.\/)[^"]+\.(?:png|svg|jpe?g))"/g)) out.push(m[1])
  return [...new Set(out)].filter((r) => !/^(https?:|data:)/.test(r))
}

/** 解析引用到实际文件：README 在仓库根，docs/*.html 在 docs/。 */
function resolveRef(file, ref) {
  const baseDir = file.includes('/') ? path.join(root, path.dirname(file)) : root
  const candidates = ref.startsWith('./')
    ? [path.join(baseDir, ref.slice(2))]
    : [path.join(root, ref), path.join(baseDir, ref)]
  return candidates.find((p) => existsSync(p))
}

/** 读 PNG 的 IHDR 尺寸（不依赖图像库）。 */
function pngSize(file) {
  const buf = readFileSync(file)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

test('every referenced image exists on disk', () => {
  const missing = []
  for (const f of SOURCES) {
    if (!existsSync(path.join(root, f))) continue
    for (const ref of imageRefs(f)) {
      if (!resolveRef(f, ref)) missing.push(`${f} -> ${ref}`)
    }
  }
  assert.deepEqual(missing, [], `referenced images not found (a broken image shows as a broken icon on GitHub):\n  ${missing.join('\n  ')}`)
})

test('every referenced PNG is a real, reasonable image', () => {
  const bad = []
  for (const f of SOURCES) {
    if (!existsSync(path.join(root, f))) continue
    for (const ref of imageRefs(f)) {
      const p = resolveRef(f, ref)
      if (!p || !p.endsWith('.png')) continue
      const size = pngSize(p)
      if (!size) { bad.push(`${f} -> ${ref}: 不是有效 PNG`); continue }
      if (size.w < 200 || size.h < 150) bad.push(`${f} -> ${ref}: 尺寸过小疑似占位 (${size.w}x${size.h})`)
      if (statSync(p).size < 3000) bad.push(`${f} -> ${ref}: 文件过小 ${statSync(p).size}B`)
    }
  }
  assert.deepEqual(bad, [], `suspicious images:\n  ${bad.join('\n  ')}`)
})

test('both READMEs carry enough images to be the primary explanation', () => {
  // 文字被刻意精简后，图是主要信息来源 —— 少于 3 张说明有人把图删了。
  for (const f of ['README.md', 'README.en.md']) {
    const n = imageRefs(f).length
    assert.ok(n >= 3, `${f} only references ${n} image(s); expected at least 3`)
  }
})

test('the capability overview image is referenced by both READMEs', () => {
  // 「功能」节现在以这张图为主，两版都必须引用它。
  for (const f of ['README.md', 'README.en.md']) {
    const refs = imageRefs(f)
    assert.ok(refs.some((r) => r.includes('features.png')), `${f} must reference the capabilities overview image`)
  }
})

test('a width= attribute never upscales the bitmap', () => {
  // 回归：图片重截后尺寸变了（settings 632x1325 -> 535x640、picker 612x308 -> 595x224），
  // 而 README 里的 width 属性还是旧值 —— GitHub 会按属性把位图放大，直接糊掉。
  // 判据：写了 width 就必须 <= 图片真实宽度。
  const offenders = []
  for (const f of ['README.md', 'README.en.md']) {
    const text = readFileSync(path.join(root, f), 'utf8')
    for (const m of text.matchAll(/<img[^>]+src="([^"]+)"[^>]*width="(\d+)"/g)) {
      const [, ref, w] = m
      const p = resolveRef(f, ref)
      if (!p || !p.endsWith('.png')) continue
      const size = pngSize(p)
      if (!size) continue
      if (Number(w) > size.w) {
        offenders.push(`${f}: ${ref} width=${w} > 实际宽度 ${size.w}（会被放大而模糊）`)
      }
    }
  }
  assert.deepEqual(offenders, [], `width attribute would upscale the bitmap:\n  ${offenders.join('\n  ')}`)
})

test('side-by-side figures are constrained so different aspect ratios stay balanced', () => {
  // 回归：三张比例差异很大的图（0.84 / 2.66 / 1.81）曾塞进同一个三列网格，
  // 结果被压到 332px 宽、长图还把同行压成 1px 高。现在竖向排列且各自限宽。
  const home = readFileSync(path.join(root, 'docs/index.html'), 'utf8')
  const shots = home.slice(home.indexOf('.shots'), home.indexOf('.shots') + 900)
  assert.match(shots, /grid-template-columns:1fr/, 'the shots block must stack vertically')
  // 每张并排图都要有 max-width，防止位图被拉伸到容器宽度而放大
  const constrained = (home.match(/class="shots"[\s\S]*?<\/div>/)[0].match(/max-width:\d+px/g) || []).length
  assert.ok(constrained >= 2, `each stacked figure needs a max-width cap, found ${constrained}`)
})

test('no screenshot has text cut off at its edges', () => {
  // 回归（用户在评审里直接指出的问题："截的区域太窄了，有些边界的文字都被切割了"）：
  // 我两次都用"若干**选定**文字节点的并集"当裁剪框，而那些节点不是最宽的 ——
  // 设置面板真实容器是 612x746（内容 1325 高、页面不可滚动，要滚内部容器），
  // 我却裁成 535x714 且上边界差了 513px，把上半整段切掉、右边也切了字。
  //
  // 判据：面板/弹窗是深色底 + 亮色文字。若图片最外侧 6px 内出现高亮像素
  // （阈值 110，高于描边 62 与画布底色 14），就是文字被裁断。
  // 深色配图才有这个性质，浅色图跳过。
  const INK = 110
  const MARGIN = 6
  const offenders = []
  for (const rel of ['docs/shots/settings-panel.png', 'docs/shots/picker-dialog.png', 'docs/shots/features.png']) {
    const p = path.join(root, rel)
    if (!existsSync(p)) continue
    const { w, h } = pngSize(p) || {}
    if (!w || !h) continue
    // 用 PIL 做像素级检测（node 侧不便解码）；脚本已随仓库提供
    const out = execFileSync('python', [path.join(root, 'scripts/check-edge-clipping.py'), p], { encoding: 'utf8' })
    // 脚本对每条边输出「干净」或「发现 N 个高亮像素」
    const cut = [...out.matchAll(/边缘"(\w+)" 发现 (\d+)/g)].map((m) => `${m[1]}=${m[2]}`)
    if (cut.length) offenders.push(`${rel}: ${cut.join(', ')}`)
    void INK; void MARGIN
  }
  assert.deepEqual(offenders, [],
    `screenshot text is clipped at the edge:\n  ${offenders.join('\n  ')}`)
})

