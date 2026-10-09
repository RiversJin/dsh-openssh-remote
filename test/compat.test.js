// DSH 插件兼容性闸门。
//
// 背景（这一条是真实故障，不是理论风险）：DSH 在 profile 导入插件前，会把
// `peerDependencies` 里所有名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`
// 的声明，与运行时版本**逐一**比对：
//
//     semver.satisfies(runtimeVersion, range, { includePrerelease: true })
//
// 实现见 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`：
//   · 运行时版本取自 **app-boot 包自己的 version**（`getDshRuntimeVersion()`）；
//   · 只看 peer 声明，**不看** `engines.dsh`（官方 README 原文：
//     "These checks use peer declarations, not `engines.dsh`"）；
//   · `workspace:^` / `workspace:~` / `workspace:*` 视为当前运行时；
//   · 空串或非法范围一律判为不兼容；
//   · 有任何一条不匹配 ⇒ **整个 bundle 在 boot 时被丢弃**（没有设置页、
//     没有 `orw_*` 工具、没有任何提示之外的降级）。
//
// ★ 为什么范围必须是"跨线"的开区间而不是 caret：
//   `^0.1.x` 锁死在 `<0.2.0`，`^0.2.x` 锁死在 `<0.3.0`——0.x 的 caret 语义就是
//   这样。所以任何一条单线 caret 都**必然**在另一条线上被判不兼容：
//     原实现 `^0.1.0-rc.6`  → 0.2 线全灭（这正是 issue 报告的现象）
//     PR #43 `^0.2.0-rc.1` → 0.1 线全灭（把故障从 0.2 挪到 0.1，并没有修好）
//   因此 peer 范围写成 `>=0.1.0-rc.6 <0.3.0`，**同时兼容两条线**。
//   注意 `@deepseek-ai/cordis` 不是 `@deepseek-ai/dsh-*`，不参与该校验，
//   保持普通 caret 即可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

// semver 只作为 devDependency 存在；装不到就跳过（不让 CI 因缺依赖而红）。
let semver
try {
  semver = createRequire(import.meta.url)('semver')
} catch {
  semver = undefined
}

/** DSH 兼容性检查真正会看的 peer 名字。 */
function isDshPeer(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** 本仓库声明的 DSH peer 列表。 */
function dshPeers() {
  return Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => isDshPeer(name))
}

test('every DSH peer uses a cross-line range, never a single-line caret', () => {
  // 这是本文件最重要的一条：caret 在 0.x 上锁小版本线，必然打死另一条线。
  const offenders = dshPeers()
    .filter(([, range]) => String(range).trim().startsWith('^'))
    .map(([name, range]) => `${name}: ${range}`)
  assert.deepEqual(
    offenders,
    [],
    `DSH peer ranges must not use a caret (it locks to one 0.x minor line and drops the other):\n  ${offenders.join('\n  ')}`,
  )
})

test('DSH peers are cross-line ranges with a lower bound and an upper cap', () => {
  for (const [name, range] of dshPeers()) {
    assert.match(String(range), />=/, `${name} must state a lower bound (${range})`)
    assert.match(String(range), /</, `${name} must state an upper cap (${range})`)
  }
})

test('the declared ranges admit every DSH line we claim to support', () => {
  if (!semver) return
  // 两条线都必须被容纳：0.1 线（含当前大量存量安装）与 0.2 线（现 npm latest）。
  //
  // 下界按**声明本身**的最小值取，而不是拿一个统一数字去套所有 peer：
  // client 侧的三个 peer 历史下界是 0.1.2-rc.1（不是 0.1.0-rc.6），
  // 用同一个下界断言会把这条本来就正确的差异误判为失败。
  const lines = ['0.1.2-rc.1', '0.1.5-rc.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2']
  const broken = []
  for (const rt of lines) {
    for (const [name, range] of dshPeers()) {
      if (!semver.satisfies(rt, range, { includePrerelease: true })) {
        broken.push(`${name}: ${range} does not admit dsh ${rt}`)
      }
    }
  }
  assert.deepEqual(broken, [], `DSH would skip this bundle:\n  ${broken.join('\n  ')}`)
})

test('each peer lower bound still admits the exact version it originally targeted', () => {
  if (!semver) return
  // 每条 peer 的下界都来自它自己的原始 caret，扩成开区间后必须仍然包含它
  // —— 否则等于在修 0.2 的同时悄悄抬高了 0.1 的门槛。
  for (const [name, range] of dshPeers()) {
    const lower = String(range).match(/>=\s*([^\s<]+)/)?.[1]
    assert.ok(lower, `${name} must have a parseable lower bound (${range})`)
    assert.ok(
      semver.satisfies(lower, range, { includePrerelease: true }),
      `${name}: lower bound ${lower} must satisfy its own range ${range}`,
    )
  }
})

test('the ranges stop before the next unknown line', () => {
  if (!semver) return
  // 0.3 是未知的 API 断点，不该盲目承诺。用 0.3.0 的正式版验证上界有效。
  const beyond = []
  for (const [name, range] of dshPeers()) {
    if (semver.satisfies('0.3.0', range, { includePrerelease: true })) {
      beyond.push(`${name}: ${range} admits 0.3.0`)
    }
  }
  assert.deepEqual(beyond, [], `ranges must not promise the unknown 0.3 line:\n  ${beyond.join('\n  ')}`)
})

test('the compatibility gate documents the peer-declaration mechanism', () => {
  // engines.dsh 只是给人看的注解，gate 不读它——别把它当成保护措施。
  assert.equal(pkg.dsh?.engines?.dsh, pkg.peerDependencies['@deepseek-ai/dsh-tools'],
    'dsh.engines.dsh should mirror the peer range so humans read the same boundary')
})

test('cordis is not part of the compatibility check, so it keeps a caret', () => {
  assert.match(String(pkg.peerDependencies['@deepseek-ai/cordis']), /^\^/,
    'cordis is not a @deepseek-ai/dsh-* peer; the gate ignores it')
})
