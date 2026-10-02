// Guard: the i18n dictionaries must be duplicate-free and cover the same keys.
//
// A repeated key in an object literal is legal JS — the LAST one silently wins —
// so a copy-paste slip is invisible at runtime and only shows up as text that
// refuses to change. One was caught in review: an edit left 'settings.auditRefresh'
// declared twice in the English dictionary.
//
// The two dictionaries are bounded by their own headers (`zh: {` / `en: {`) and
// by the next top-level statement, which is far more robust than guessing at
// object shape from indentation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Normalize line endings first: the repository checks out CRLF on Windows, so a
// boundary written with a bare "\n" would silently fail to match.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Keys declared in one dictionary block, in declaration order. */
function keysOf(startMarker, endMarker) {
  const at = source.indexOf(startMarker)
  assert.ok(at > 0, `could not find ${startMarker}`)
  const end = source.indexOf(endMarker, at + startMarker.length)
  assert.ok(end > at, `could not find ${endMarker} after ${startMarker}`)
  const block = source.slice(at, end)
  return [...block.matchAll(/^\s*'([A-Za-z][\w.]*)':\s/gm)].map((m) => m[1])
}

// `zh` is bounded by `en`, and `en` by the first top-level declaration that
// follows it (`const dict = ...`), so a new key can be added to either freely.
// The indentation is read from the file rather than hardcoded, so reformatting
// the dictionaries does not silently turn this guard into a no-op.
const INDENT = ' '.repeat(/^(\s*)zh: \{/m.exec(source)?.[1].length ?? 6)
const zhKeys = () => keysOf(`${INDENT}zh: {`, `\n${INDENT}en: {`)
const enKeys = () => keysOf(`${INDENT}en: {`, `\n${INDENT}const dict =`)

test('the zh dictionary declares a plausible number of keys', () => {
  const keys = zhKeys()
  assert.ok(keys.length > 40, `zh dictionary looks truncated (${keys.length} keys)`)
})

test('no i18n key is declared twice inside the zh dictionary', () => {
  const keys = zhKeys()
  const seen = new Set()
  const dupes = []
  for (const k of keys) { if (seen.has(k)) dupes.push(k); seen.add(k) }
  assert.deepEqual(dupes, [], `declared more than once: ${dupes.join(', ')}`)
})

test('no i18n key is declared twice inside the en dictionary', () => {
  const keys = enKeys()
  const seen = new Set()
  const dupes = []
  for (const k of keys) { if (seen.has(k)) dupes.push(k); seen.add(k) }
  assert.deepEqual(dupes, [], `declared more than once: ${dupes.join(', ')}`)
})

test('the zh and en dictionaries cover the same key set', () => {
  const z = new Set(zhKeys())
  const e = new Set(enKeys())
  const missingEn = [...z].filter((k) => !e.has(k))
  const missingZh = [...e].filter((k) => !z.has(k))
  assert.deepEqual(missingEn, [], `missing from the en dictionary: ${missingEn.join(', ')}`)
  assert.deepEqual(missingZh, [], `missing from the zh dictionary: ${missingZh.join(', ')}`)
})

// The guard must actually be able to fail — a check that can never fail is worse
// than no check, because it reads as coverage.
test('the duplicate detector actually detects a duplicate', () => {
  const detect = (keys) => {
    const seen = new Set()
    const dupes = []
    for (const k of keys) { if (seen.has(k)) dupes.push(k); seen.add(k) }
    return dupes
  }
  assert.deepEqual(detect(['a', 'b', 'a']), ['a'])
  assert.deepEqual(detect(['a', 'b']), [])
})
