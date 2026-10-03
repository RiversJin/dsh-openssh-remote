// Extract one release's CHANGELOG section, for use as GitHub Release notes.
//
// Why a script: the section is hand-written prose with `###` sub-headings, and
// hand-copying it into `gh release create --notes-file` reliably drops or
// duplicates a line. Extract by heading range so the Release always matches the
// CHANGELOG exactly (that parity is the whole point of PUBLISH.md §3).
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) { console.error('usage: node extract-release-notes.mjs <version> [changelog]'); process.exit(2) }
const file = process.argv[3] || 'CHANGELOG.md'
const lines = readFileSync(file, 'utf8').split('\n')

const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|—|$)`).test(l))
if (start < 0) { console.error(`no "## ${version}" section in ${file}`); process.exit(1) }

// Stop at the next "## " that is not itself a sub-heading ("### ").
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) { end = i; break }
}

// Drop the heading itself (the Release title carries the version) and trim blank
// edges so the notes start at the prose.
const body = lines.slice(start + 1, end).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
process.stdout.write(body + '\n')
