#!/usr/bin/env node
// 发布完整性检查：确认每个已推送的 tag 都有对应的 GitHub Release，
// 且 npm 上该版本确实可下载。
//
// 为什么需要它：0.8.19 之后的多个版本只打了 tag、没建 Release，
// 一直到 #43 那轮才被发现——中间 7 个版本的 Release 页是空的。
// tag 与 Release 是两件事：用户从 Release 页判断"要不要升级"，而 npm 上的
// 版本、GitHub 上的 Release、以及代码里的 tag 三者会各自漂移。
//
// 用法（需 gh 已登录，且能访问 npm registry）：
//   node scripts/check-releases.mjs            # 只查最近 15 个 tag
//   node scripts/check-releases.mjs --all      # 查全部
//   node scripts/check-releases.mjs --json
//
// 退出码：全部齐全 0；有缺失 1（便于挂进 CI 或发布后手工跑）。

import { execFileSync } from 'node:child_process'

const REPO = 'flymysql/dsh-remote'
const PKG = 'dsh-remote'

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const all = args.includes('--all')
const LIMIT = all ? 200 : 15

/** 跑一个命令并返回 stdout（失败返回空串）。 */
function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** 语义化排序（把 v0.8.30 排在 v0.8.9 之后）。 */
function byVersionDesc(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}

async function npmHas(version) {
  const url = `https://registry.npmjs.org/${PKG}/-/${PKG}-${version}.tgz`
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) })
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  const tags = run('git', ['ls-remote', '--tags', 'origin'])
    .split('\n')
    .map((l) => (l.split('refs/tags/')[1] || '').trim())
    .filter((t) => t && !t.endsWith('^{}'))
    .sort(byVersionDesc)
    .slice(0, LIMIT)

  if (!tags.length) {
    console.error('no tags found (run from the repo, with a reachable origin)')
    process.exit(1)
  }

  const releases = new Set(
    run('gh', ['release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName', '--jq', '.[].tagName'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  )

  const rows = []
  for (const tag of tags) {
    const version = tag.replace(/^v/, '')
    rows.push({
      tag,
      release: releases.has(tag),
      npm: await npmHas(version),
    })
  }

  const missingRelease = rows.filter((r) => !r.release)
  const missingNpm = rows.filter((r) => !r.npm)

  if (wantJson) {
    console.log(JSON.stringify({ checked: rows.length, rows, missingRelease, missingNpm }, null, 2))
  } else {
    for (const r of rows) {
      const marks = `${r.release ? 'release' : 'NO-RELEASE'}  ${r.npm ? 'npm' : 'NO-NPM'}`
      console.log(`  ${r.tag.padEnd(9)} ${marks}`)
    }
    console.log(`\nchecked ${rows.length} tag(s)${all ? '' : ' (use --all for every tag)'}`)
    if (missingRelease.length) console.log(`  missing GitHub Release: ${missingRelease.map((r) => r.tag).join(', ')}`)
    if (missingNpm.length) console.log(`  not on npm:             ${missingNpm.map((r) => r.tag).join(', ')}`)
    if (!missingRelease.length && !missingNpm.length) console.log('  all tags have a Release and an npm tarball ✔')
  }

  process.exit(missingRelease.length || missingNpm.length ? 1 : 0)
}

main()
