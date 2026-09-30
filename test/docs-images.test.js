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
