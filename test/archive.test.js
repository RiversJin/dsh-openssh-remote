// Unit tests for lib/archive.js — the pure command builders and parsers.
//
// The generated shell is validated by test/backup-shell-syntax.test.js against a
// REAL `sh -n`; these tests cover the pure logic: exclude normalization,
// filename safety, marker parsing and result shaping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeExclude, parseExcludes, isUnsafeExclude, workspaceSlug, archiveStem,
  archiveName, isSafeArchiveName, metaNameFor, resolveBackupDir, buildHomeCommand,
  readMarker, readMarkers, excludeFlags, buildCreateCommand, parseCreateResult,
  buildListCommand, parseListResult, buildVerifyCommand, buildDeleteCommand,
  buildRestoreCommand, isReplaceMode, parseStatus, excludeRejection, formatBytes,
  backupDirUnderRoot, MARK, META_BEGIN_MARK, ARCHIVE_SUFFIX, META_SUFFIX,
  DEFAULT_BACKUP_SUFFIX,
} from '../lib/archive.js'

// ── exclude normalization ───────────────────────────────────────────────────
// This is the highest-risk piece: a leading `/` is a SILENT NO-OP in GNU tar and
// a leading `./` silently anchors the pattern, so both must be rewritten before
// they ever reach a command line (measured on GNU tar 1.35).

test('normalizeExclude strips the leading / that would silently disable the rule', () => {
  assert.equal(normalizeExclude('/build/'), 'build')
  assert.equal(normalizeExclude('/node_modules'), 'node_modules')
})

test('normalizeExclude strips a leading ./ that would silently narrow the rule', () => {
  assert.equal(normalizeExclude('./node_modules'), 'node_modules')
  assert.equal(normalizeExclude('./src/dist/'), 'src/dist')
})

test('normalizeExclude keeps globs and nested paths, strips trailing slashes', () => {
  assert.equal(normalizeExclude('*.log'), '*.log')
  assert.equal(normalizeExclude('a/b/c/'), 'a/b/c')
  assert.equal(normalizeExclude('  dist  '), 'dist')
  assert.equal(normalizeExclude('a\\b'), 'a/b')
})

test('normalizeExclude returns empty for patterns that exclude nothing', () => {
  for (const raw of ['', '   ', '/', './', '.']) {
    assert.equal(normalizeExclude(raw), '', `${JSON.stringify(raw)} should normalize to ''`)
  }
})

test('an exclude that escapes the workspace is flagged, not silently rewritten', () => {
  // Rewriting `..` away would exclude MORE than the caller asked, so it is a
  // rejection instead.
  assert.equal(isUnsafeExclude('../secrets'), true)
  assert.equal(isUnsafeExclude('a/../../b'), true)
  assert.equal(isUnsafeExclude('/etc'), true)
  assert.equal(isUnsafeExclude('C:/Windows'), true)
  assert.equal(isUnsafeExclude('src/dist'), false)
  assert.match(excludeRejection(['../x']), /escapes the workspace/)
  assert.equal(excludeRejection(['ok', 'src/dist']), '')
})

test('parseExcludes splits lines, drops comments/blanks, de-duplicates', () => {
  const r = parseExcludes('# a comment\n\n node_modules \n/build/\n/dist/\nnode_modules\n')
  assert.deepEqual(r.patterns, ['node_modules', 'build', 'dist'])
  const fromArray = parseExcludes(['a', 'a', 'b'])
  assert.deepEqual(fromArray.patterns, ['a', 'b'])
  // A root-only pattern is reported as dropped rather than vanishing silently.
  const dropped = parseExcludes(['/', 'keep'])
  assert.deepEqual(dropped.patterns, ['keep'])
  assert.deepEqual(dropped.dropped, ['/'])
})

// ── names ───────────────────────────────────────────────────────────────────

test('workspaceSlug is readable, safe, and never empty', () => {
  assert.equal(workspaceSlug('/home/dev/my proj'), 'my-proj')
  assert.equal(workspaceSlug('/'), 'workspace')
  assert.equal(workspaceSlug(''), 'workspace')
  assert.equal(workspaceSlug('D:\\Code\\x'), 'x')
  assert.ok(!workspaceSlug('/a/' + 'x'.repeat(200)).includes('/'))
})

test('archiveStem keys on the FULL path so same-named workspaces differ', () => {
  const a = archiveStem('/a/proj')
  const b = archiveStem('/b/proj')
  assert.notEqual(a, b, 'two different /proj workspaces must not share a stem')
  assert.ok(a.startsWith('proj-'))
})

test('archiveName is deterministic for a given clock and filesystem-safe', () => {
  const d = new Date(Date.UTC(2026, 9, 8, 11, 22, 33))
  assert.equal(archiveName(d), '2026-10-08T11-22-33.tar.gz')
  assert.equal(archiveName(d, { label: 'before refactor' }), 'before-refactor-2026-10-08T11-22-33.tar.gz')
  // No ':' — the name must be legal on a Windows remote and in a URL query.
  assert.ok(!archiveName(d).includes(':'))
})

test('isSafeArchiveName is the traversal guard for every file-taking action', () => {
  assert.equal(isSafeArchiveName('proj-ab-2026-10-08T11-22-33.tar.gz'), true)
  assert.equal(isSafeArchiveName('a.tar.gz'), true)
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b.tar.gz', 'a\\b.tar.gz', '..', '.', '.hidden.tar.gz', 'x.tar', '', 'x.tar.gz; rm -rf /', 'a b.tar.gz']) {
    assert.equal(isSafeArchiveName(bad), false, `${JSON.stringify(bad)} must be rejected`)
  }
  assert.equal(isSafeArchiveName('x'.repeat(300) + '.tar.gz'), false, 'absurdly long names are rejected')
})

test('metaNameFor derives the sidecar name from the archive name', () => {
  assert.equal(metaNameFor('a.tar.gz'), 'a.meta.json')
})

test('resolveBackupDir prefers an explicit override and needs a home otherwise', () => {
  assert.equal(resolveBackupDir('/home/dev'), `/home/dev/${DEFAULT_BACKUP_SUFFIX}`)
  assert.equal(resolveBackupDir('/home/dev/', '/mnt/bk'), '/mnt/bk')
  assert.equal(resolveBackupDir(''), '')
  assert.equal(resolveBackupDir('/home/dev', '/mnt/bk/'), '/mnt/bk')
})

test('backupDirUnderRoot detects a backup dir nested inside the workspace', () => {
  assert.equal(backupDirUnderRoot('/w/.dsh-remote/backups', '/w'), '.dsh-remote/backups')
  assert.equal(backupDirUnderRoot('/other/backups', '/w'), '')
  assert.equal(backupDirUnderRoot('/w', '/w'), '', 'the workspace root itself is not a nested dir')
})

// ── markers ─────────────────────────────────────────────────────────────────

test('readMarker takes the LAST occurrence (the scripts report failures last)', () => {
  assert.equal(readMarker('ARCH_OK=1\nARCH_ERROR=x\nARCH_OK=0', MARK.ok), '0')
  assert.equal(readMarker('nothing here', MARK.ok), '')
  assert.equal(readMarker('ARCH_BYTES=42', MARK.bytes), '42')
})

test('readMarkers collects only present, non-empty markers', () => {
  const m = readMarkers('ARCH_OK=1\nARCH_SHA=\nARCH_BYTES=7')
  assert.equal(m[MARK.ok], '1')
  assert.equal(m[MARK.bytes], '7')
  assert.equal(MARK.sha in m, false, 'an empty marker is absent, not empty-string')
})

test('excludeFlags shell-quotes each pattern as its own literal argument', () => {
  const f = excludeFlags(['node_modules', 'a b/*.log', "qu'ote"])
  // Each flag is single-quoted so no word-splitting or glob expansion can occur.
  assert.ok(f.includes("'--exclude=node_modules'"))
  assert.ok(f.includes("'--exclude=a b/*.log'"))
  assert.ok(f.includes("'--exclude=qu'\\''ote'"), 'an embedded quote is escaped for POSIX sh')
  assert.equal(excludeFlags([]), '')
})

// ── create ──────────────────────────────────────────────────────────────────

test('buildCreateCommand uses -C + . and never passes -P', () => {
  const c = buildCreateCommand({ dir: '/home/dev/proj', archive: '/b/x.tar.gz', excludes: ['node_modules'] })
  assert.match(c, /tar -czf "\$ARCH_STAGE" -C "\$ARCH_SRC" '--exclude=node_modules' \./)
  // `-P` / `--absolute-names` would let a hostile archive write outside the
  // target on restore; it must never appear anywhere in this module.
  assert.ok(!/\s-P\b/.test(c), 'must not pass -P')
  assert.ok(!/--absolute-names/.test(c), 'must not pass --absolute-names')
  // Staging + mv: an interrupted run must not publish a truncated archive.
  assert.match(c, /ARCH_STAGE="\$ARCH_DST\.stage\.\$\$"/)
  assert.match(c, /mv -f "\$ARCH_STAGE" "\$ARCH_DST"/)
  // Verify BEFORE publishing.
  assert.ok(c.indexOf('ARCH_VERIFY') < c.indexOf('mv -f "$ARCH_STAGE"'), 'verification precedes publication')
})

test('buildCreateCommand REFUSES an unsafe or ineffective exclude rather than running it', () => {
  // The invariant is asserted in code so a future caller cannot reintroduce the
  // silent no-op (`/x`) or the silent narrowing (`./x`).
  for (const bad of ['../x', '/etc', './node_modules']) {
    assert.throws(
      () => buildCreateCommand({ dir: '/a', archive: '/b/x.tar.gz', excludes: [bad] }),
      /unsafe\/ineffective exclude/,
      `${bad} must be refused`,
    )
  }
})

test('buildCreateCommand reports a missing source instead of creating a junk archive', () => {
  const c = buildCreateCommand({ dir: '/nope', archive: '/b/x.tar.gz' })
  assert.match(c, /if \[ ! -d "\$ARCH_SRC" \]/)
  assert.match(c, new RegExp(`${MARK.ok}=0`))
})

test('buildCreateCommand falls back across sha256sum/shasum/openssl', () => {
  const c = buildCreateCommand({ dir: '/a', archive: '/b/x.tar.gz' })
  assert.match(c, /command -v sha256sum/)
  assert.match(c, /command -v shasum/)
  assert.match(c, /command -v openssl/)
})

test('parseCreateResult reads the success tail', () => {
  const r = parseCreateResult([
    'ARCH_VERIFY=ok',
    'ARCH_FILE=/b/x.tar.gz',
    'ARCH_BYTES=12345',
    'ARCH_MEMBERS=67',
    'ARCH_SHA=abc',
    'ARCH_OK=1',
  ].join('\n'))
  assert.deepEqual(r, { ok: true, error: '', file: '/b/x.tar.gz', bytes: 12345, members: 67, sha256: 'abc', verified: true })
})

test('parseCreateResult surfaces the failure reason and defaults the rest', () => {
  const r = parseCreateResult('ARCH_OK=0\nARCH_ERROR=tar failed with exit 2')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'tar failed with exit 2')
  assert.equal(r.bytes, 0)
  assert.equal(r.verified, false)
})

// ── list ────────────────────────────────────────────────────────────────────

test('buildListCommand globs instead of using find -printf (not on macOS/BSD)', () => {
  const c = buildListCommand({ dir: '/b' })
  assert.ok(!/find\b/.test(c), 'must not depend on GNU find')
  assert.ok(!/-printf/.test(c), '-printf is a GNU extension')
  // mtime: GNU `stat -c` with a `stat -f` fallback.
  assert.match(c, /stat -c %Y/)
  assert.match(c, /stat -f %m/)
})

test('parseListResult pairs sidecars BY NAME, not by position', () => {
  // The decisive case: b has no sidecar. Pairing by position would hand b's
  // neighbour's metadata to c.
  const out = [
    'ARCH_EXISTS=1',
    'ARCH_ENTRY=a.tar.gz|100|1700000000',
    `${META_BEGIN_MARK}=a.tar.gz`,
    '{"workspace":"/w/a","members":3}',
    'ARCH_META_END',
    'ARCH_ENTRY=b.tar.gz|200|1700000100',
    'ARCH_ENTRY=c.tar.gz|300|1700000200',
    `${META_BEGIN_MARK}=c.tar.gz`,
    '{"workspace":"/w/c","members":9}',
    'ARCH_META_END',
  ].join('\n')
  const r = parseListResult(out)
  assert.equal(r.exists, true)
  assert.equal(r.entries.length, 3)
  assert.equal(r.entries[0].meta.workspace, '/w/a')
  assert.equal(r.entries[1].name, 'b.tar.gz')
  assert.equal(r.entries[1].meta, null, 'a missing sidecar stays null')
  assert.equal(r.entries[2].meta.workspace, '/w/c', 'c keeps ITS OWN metadata despite the gap')
})

test('parseListResult tolerates a corrupt sidecar without hiding the archive', () => {
  const out = [
    'ARCH_EXISTS=1',
    'ARCH_ENTRY=a.tar.gz|100|1700000000',
    `${META_BEGIN_MARK}=a.tar.gz`,
    '{not json',
    'ARCH_META_END',
  ].join('\n')
  const r = parseListResult(out)
  assert.equal(r.entries.length, 1, 'the archive is still listed')
  assert.equal(r.entries[0].meta, null, 'a corrupt sidecar yields no metadata')
})

test('parseListResult reports a missing directory as not existing', () => {
  const r = parseListResult('ARCH_EXISTS=0')
  assert.equal(r.exists, false)
  assert.deepEqual(r.entries, [])
})

// ── restore / verify / delete ───────────────────────────────────────────────

test('buildRestoreCommand verifies BEFORE extracting anything', () => {
  const c = buildRestoreCommand({ archive: '/b/x.tar.gz', target: '/w', mode: 'replace', stage: '/w.stage', swap: '/w.bak' })
  const verifyAt = c.indexOf('ARCH_VERIFY=bad')
  const extractAt = c.indexOf('tar -xzf')
  assert.ok(verifyAt > -1 && extractAt > -1)
  assert.ok(verifyAt < extractAt, 'the corrupt-archive guard must run before any extraction')
  assert.ok(!/\s-P\b/.test(c), 'restore must not pass -P')
})

test('buildRestoreCommand stages, then swaps, and rolls back on a failed swap', () => {
  const c = buildRestoreCommand({ archive: '/b/x.tar.gz', target: '/w', mode: 'replace', stage: '/w.stage', swap: '/w.bak' })
  assert.ok(c.indexOf('tar -xzf "$ARCH_F" -C "$ARCH_STAGE"') < c.indexOf('mv "$ARCH_T" "$ARCH_SWAP"'),
    'extraction into staging must precede moving the target aside')
  // The target is only removed after the staging tree is in place.
  assert.match(c, /mv "\$ARCH_STAGE" "\$ARCH_T"/)
  // A failed final swap restores the original.
  assert.match(c, /mv "\$ARCH_SWAP" "\$ARCH_T"/)
  assert.match(c, /ARCH_HAD/)
})

test('replace mode removes stale files; merge mode never deletes', () => {
  const replace = buildRestoreCommand({ archive: '/b/x.tar.gz', target: '/w', mode: 'replace', stage: '/s', swap: '/k' })
  const merge = buildRestoreCommand({ archive: '/b/x.tar.gz', target: '/w', mode: 'merge' })
  assert.match(replace, /rm -rf "\$ARCH_SWAP"/)
  assert.ok(!/rm -rf "\$ARCH_T"/.test(merge), 'merge must not remove the target')
  assert.match(merge, /mkdir -p "\$ARCH_T"/)
  assert.equal(isReplaceMode('replace'), true)
  assert.equal(isReplaceMode('merge'), false)
  assert.equal(isReplaceMode(undefined), true, 'replace is the default')
})

test('buildHomeCommand falls back when HOME is unset (systemd/CI shells)', () => {
  const c = buildHomeCommand()
  assert.match(c, /ARCH_H="\$HOME"/)
  assert.match(c, /cd ~ 2>\/dev\/null && pwd/)
})

test('parseStatus reads the shared ok/error tail', () => {
  const s = parseStatus('ARCH_VERIFY=ok\nARCH_ACTION=replaced\nARCH_MEMBERS=5\nARCH_OK=1')
  assert.equal(s.ok, true)
  assert.equal(s.action, 'replaced')
  assert.equal(s.members, 5)
  assert.equal(s.verified, true)
  const f = parseStatus('ARCH_OK=0\nARCH_ERROR=boom')
  assert.equal(f.ok, false)
  assert.equal(f.error, 'boom')
})

test('verify and delete scripts refuse a missing archive explicitly', () => {
  for (const c of [buildVerifyCommand({ archive: '/b/x.tar.gz' }), buildDeleteCommand({ archive: '/b/x.tar.gz', meta: '/b/x.meta.json' })]) {
    assert.match(c, /if \[ ! -f "\$ARCH_F" \]/)
    assert.match(c, new RegExp(`${MARK.ok}=0`))
  }
})

test('formatBytes is human readable and monotonic', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB')
})
