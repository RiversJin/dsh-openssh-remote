// GitHub Pages 站点的中文优先与事实一致性闸门。
//
// 为什么需要：
//   1) 需求是"Pages 优先显示中文"。这件事必须在**页面骨架**里成立（无脚本、
//      无 localStorage 时首屏就是中文），而不是靠脚本注入——否则会闪英文。
//      我实现时踩过一个真缺陷：applyLang 对含子 data-zh 的容器也整体写 innerHTML，
//      把子 span 连属性一起抹掉，表现为"切一次语言后标题永久卡住"。
//   2) 站点是面向用户的文档，等于第二份"产品说明"，会和代码漂移。实测已经漂移过：
//      工具名写了 4 个不存在的（rw_workspace/rw_list/rw_read/rw_write），
//      auditLog 的默认值写成 false（真源是 true）。这些正是用户照着做的内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

const PAGES = ['docs/index.html', 'docs/stats/index.html']

/** 去掉 <script>/<style>，只留页面骨架（脚本注入的内容不算"骨架是中文"）。 */
const skeleton = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')

/** 取所有 data-zh="..." 的值。 */
const zhAttrs = (html) => [...html.matchAll(/data-zh="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
const enAttrs = (html) => [...html.matchAll(/data-en="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])

test('every page declares Chinese as its document language', () => {
  for (const p of PAGES) {
    const html = read(p)
    assert.match(html, /<html lang="zh-CN">/, `${p} must declare lang="zh-CN" (Chinese is the priority)`)
  }
})

test('the page skeleton is already Chinese, not injected by script', () => {
  // 关键的"优先中文"判据：把 <script> 全部去掉后，骨架里必须有足量中文。
  // 如果中文只存在于 data-zh 属性里、正文是英文，那么禁用 JS 或首帧就会闪英文。
  for (const p of PAGES) {
    const body = skeleton(read(p))
    const zh = (body.match(/[\u4e00-\u9fa5]/g) || []).length
    assert.ok(zh > 300, `${p}: skeleton should already be Chinese (found ${zh} CJK chars)`)
  }
})

test('every data-zh has a matching data-en and vice versa', () => {
  for (const p of PAGES) {
    const html = read(p)
    const zh = zhAttrs(html)
    const en = enAttrs(html)
    assert.equal(zh.length, en.length, `${p}: ${zh.length} data-zh vs ${en.length} data-en`)
    // 顺序也必须一一对应，否则切换语言会把句子配错
    const zhSeq = [...html.matchAll(/data-(zh|en)="/g)].map((m) => m[1])
    for (let i = 0; i < zhSeq.length; i += 2) {
      assert.equal(zhSeq[i], 'zh', `${p}: expected data-zh at pair ${i / 2}, got ${zhSeq[i]}`)
      assert.equal(zhSeq[i + 1], 'en', `${p}: expected data-en at pair ${i / 2}, got ${zhSeq[i + 1]}`)
    }
  }
})

test('the language switcher only rewrites leaf nodes', () => {
  // 回归：容器（内部还含 data-zh 子元素）若被整体写 innerHTML，会连子元素与其
  // data-* 属性一起抹掉 —— 实测表现为"点一次 EN 后标题永久卡在英文"。
  for (const p of PAGES) {
    const html = read(p)
    const fn = html.slice(html.indexOf('function applyLang'), html.indexOf('let LANG'))
    assert.match(fn, /if \(el\.querySelector\('\[data-zh\]\[data-en\]'\)\) continue/,
      `${p}: applyLang must skip containers that hold their own data-zh children`)
  }
})

test('Chinese is the default when there is no stored preference', () => {
  for (const p of PAGES) {
    const html = read(p)
    // 默认值必须是 'zh'：只有显式存过 'en' 才用英文
    assert.match(html, /let LANG = 'zh'/, `${p}: the default language variable must be 'zh'`)
    assert.match(html, /=== 'en' \? 'en' : 'zh'/, `${p}: only an explicit stored 'en' may switch to English`)
  }
})

test('documented rw_* tool names all exist in the plugin', () => {
  // 实测漂移过：站点列了 rw_workspace / rw_list / rw_read / rw_write（都不存在，
  // 真名是 rw_pick_workspace / rw_list_dir / rw_read_file / rw_write_file）。
  const indexSrc = read('lib/index.js')
  const real = new Set([...indexSrc.matchAll(/name:\s*'(rw_[a-z_]+)'/g)].map((m) => m[1]))
  assert.equal(real.size, 20, `expected 20 rw_* tools in the plugin, found ${real.size}`)

  const documented = new Set()
  for (const p of PAGES) {
    for (const m of read(p).matchAll(/<code>(rw_[a-z_]+)<\/code>/g)) documented.add(m[1])
  }
  const ghosts = [...documented].filter((n) => !real.has(n))
  assert.deepEqual(ghosts, [], `pages document rw_* tools that do not exist: ${ghosts.join(', ')}`)
})

test('the DAU figure never silently skips a day that has data', () => {
  // 回归（同类问题犯了两次，主页修了看板漏了）：两页都曾把 DAU 固定取
  // "最近一个完整日"，于是当所有心跳都在今天时显示 0，与同屏的累计装机
  // 自相矛盾（实测：DAU 0 / installs 53）。
  //
  // 判据要精确到"把 day!==todayKey 当作**唯一**取值来源"这个坏模式。
  // 只写 /day !== todayKey/ 会误伤正确实现 —— 新逻辑里它作为**从属**判断
  // （取最近有数据的日；若它就是今天就标注"进行中"）仍在出现，实测假红过一次。
  for (const p of PAGES) {
    const html = read(p)
    // 坏模式：用 slice(0,-1).reverse().find(... !== todayKey) 之类把"今天"整个剔除
    assert.doesNotMatch(html, /slice\(0,\s*-1\)[\s\S]{0,80}!==\s*todayKey/,
      `${p}: must not exclude today wholesale when picking the DAU value`)
    // 正确模式：必须存在"最近一个**有数据**的日"的取法
    assert.match(html, /find\(d\s*=>\s*\(d\.dau\s*\|\|\s*0\)\s*>\s*0\)/,
      `${p}: must pick the most recent day that actually has data`)
  }
  // 两页都要有"进行中"的标注能力，否则今天的数据会被当成终值
  assert.match(read('docs/stats/index.html'), /进行中/, 'dashboard must label an in-progress day')
})

test('the homepage reads live numbers from the snapshot first', () => {
  // registry.npmjs.org 在浏览器里可能被拦（实测 Failed to fetch，版本号显示 "—"）。
  // 因此同源快照必须是主路径，直连只能是兜底。
  const home = read('docs/index.html')
  const fn = home.slice(home.indexOf('async function loadNumbers'))

  // ★ 断言前先剥掉注释行：注释里也会出现 registry.npmjs.org（我解释为何改），
  // 用它定位会得出错误结论 —— 实测踩过两次：
  //   ① 未剥注释时 firstRegAt 落在注释里 ⇒ 假红；
  //   ② 用 /\/\/[^\n]*/ 粗暴剥离会把 "https://..." 的 // 也当注释删掉，
  //      把真实 URL 截断成 "https:" ⇒ 又假红。所以只按"行首可选的空白 + //"剥。
  const code = fn.replace(/^[ \t]*\/\/.*$/gm, '')

  const snapAt = code.indexOf("'./data/stats.json'")
  const fallbackAt = code.indexOf('const missing =')
  const regAt = code.indexOf('registry.npmjs.org')

  assert.ok(snapAt > -1, 'homepage must read the same-origin snapshot')
  assert.ok(fallbackAt > -1, 'homepage should keep a fallback path for missing fields')
  assert.ok(regAt > -1, 'homepage should keep a direct-registry fallback')
  assert.ok(snapAt < fallbackAt, 'the snapshot read must come before the fallback block')
  assert.ok(regAt > fallbackAt,
    'a direct registry fetch may only appear inside the fallback block, after the snapshot')
})

test('the snapshot generator records npm.latest', () => {
  // 页面依赖这个字段把版本徽章填上；脚本不写它，兜底分支就永远不会生效。
  const gen = read('scripts/snapshot-stats.mjs')
  assert.match(gen, /out\.latest\s*=/, 'snapshot must record npm.latest for the pages to read')
})

test('config defaults shown on the site match the schema', () => {
  // 站点上的默认值是用户照着配的依据，必须与 lib/index.js 的 Config schema 一致。
  // 实测漂移过：auditLog 写成 false（真源 true）。
  const schema = read('lib/index.js')
  const block = schema.slice(schema.indexOf('export const Config'), schema.indexOf('\n})', schema.indexOf('export const Config')))
  const declared = {}
  for (const m of block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\.[\s\S]*?\.default\(([^)]*)\)/gm)) {
    declared[m[1]] = m[2].trim()
  }

  const home = read('docs/index.html')
  const rows = [...home.matchAll(/<tr><td><code>([a-zA-Z][a-zA-Z0-9]*)<\/code><\/td><td><code>([^<]*)<\/code><\/td>/g)]
    .map((m) => [m[1], m[2]])

  assert.ok(rows.length >= 5, `expected the homepage config table to have rows, found ${rows.length}`)

  // 有些默认值是常量引用（updateMode → DEFAULT_UPDATE_MODE），要解析到真实值，
  // 否则测试会误报"文档写了 auto 而 schema 是 DEFAULT_UPDATE_MODE"。
  const consts = {}
  for (const m of schema.matchAll(/export const ([A-Z_]+) = '([^']*)'/g)) consts[m[1]] = m[2]

  for (const [key, shown] of rows) {
    if (!(key in declared)) continue // 只校验确实存在于 schema 的键
    const norm = (s) => String(s).replace(/['"]/g, '').trim()
    const raw = norm(declared[key])
    const resolved = consts[raw] ?? raw
    // 站点对 6h / 200000 这类做了人类可读化，允许这两种等价写法
    const equivalents = { '6 * 3600 * 1000': '6h', '200000': '200000' }
    const expected = equivalents[resolved] ?? resolved
    assert.equal(norm(shown), expected,
      `docs/index.html shows ${key}=${shown} but the schema default resolves to ${expected}`)
  }
})
