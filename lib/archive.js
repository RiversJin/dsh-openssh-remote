// dsh-remote — workspace archive (compressed backup / restore) primitives.
//
// Split out of lib/backup.js and lib/index.js so the whole command surface is a
// set of PURE functions (no fs, no ssh) that can be unit-tested — including
// against a real POSIX `sh -n`, which is the only thing that can prove the
// generated shell is valid (a string assertion cannot; see the `do;` incident
// documented in scripts/dev-standards.md).
//
// ── Two empirically established facts drive this module ─────────────────────
//
//  1. **`--exclude` patterns are matched against the ARCHIVE MEMBER name.** We
//     create archives with `tar -czf A -C <dir> .`, so members read `./x/y`
//     while a nested one reads `./a/x/y`. Measured on GNU tar 1.35:
//       · `--exclude=x/y`          → excludes both `./x/y` AND `./a/x/y` (any depth)
//       · `--exclude=./x/y`        → excludes ONLY `./x/y` (anchored)
//       · `--exclude=/x/y`         → excludes NOTHING (silent no-op!)
//     A leading `/` therefore looks like "anchor at the root" but actually
//     disables the rule, and a leading `./` silently narrows it. Neither is
//     allowed to reach the command line: `normalizeExclude()` strips both, and
//     `buildCreateCommand()` asserts the invariant, and a test pins it.
//
//  2. **Extraction is safe only while the tar defaults are kept.** GNU tar
//     refuses `../` members and strips leading `/` unless `-P`/`--absolute-names`
//     is passed; we never pass it. A member sequence that tries to walk through
//     a symlink is also refused ("Cannot open: Not a directory"). The archive
//     itself is untrusted input (it may come from `rw_backup_list` on a host we
//     merely administer), so `-P` must never appear anywhere in this module —
//     asserted in code and covered by a regression test.
import { shq, shortHash, relPathUnder, normalizeRemotePath } from './paths.js'

/** Directory (relative to `$HOME`) an automatic backup lands in on the remote. */
export const DEFAULT_BACKUP_SUFFIX = '.dsh-remote/backups'

/** Files an archive is paired with on disk; both are discovered during listing. */
export const ARCHIVE_SUFFIX = '.tar.gz'
export const META_SUFFIX = '.meta.json'

/** Hard ceiling on an archive we will pull to / push from the local machine.
 *  0 = unlimited. Backups themselves are never truncated — this only bounds the
 *  optional cross-machine copy, which is what can fill a laptop's disk. */
export const DEFAULT_MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024

/** Marker prefix for one archive's sidecar block; the archive name follows `=`,
 *  so a sidecar is paired by identity rather than by position (see
 *  parseListResult). */
export const META_BEGIN_MARK = 'ARCH_META_BEGIN'

/** Machine-readable markers printed by the remote scripts. Parsing never guesses. */
export const MARK = {
  ok: 'ARCH_OK',
  error: 'ARCH_ERROR',
  file: 'ARCH_FILE',
  sha: 'ARCH_SHA',
  bytes: 'ARCH_BYTES',
  members: 'ARCH_MEMBERS',
  verify: 'ARCH_VERIFY',
  excluded: 'ARCH_EXCLUDED',
  entry: 'ARCH_ENTRY',
  home: 'ARCH_HOME',
  action: 'ARCH_ACTION',
  exists: 'ARCH_EXISTS',
  tar: 'ARCH_TAR',
}

/**
 * Normalize one user- or caller-supplied exclude pattern into the ONLY form we
 * are willing to put on a command line.
 *
 * gitignore-style input is accepted (`/build/`, `./node_modules`, `build/`) but
 * every shape is rewritten to a bare relative pattern, because that is the form
 * GNU tar matches at ANY depth (fact 1 in the header): `/x` is a silent no-op
 * and `./x` silently anchors. Rewriting rather than rejecting keeps the caller's
 * evident intent (`/build/` clearly means "the build directory").
 *
 * @param {unknown} raw - one pattern, possibly with a leading `/` or `./` and a
 *   trailing `/`.
 * @returns {string} a bare, non-empty pattern, or '' when the input carries no
 *   pattern at all (`''`, `'/'`, `'./'`).
 */
export function normalizeExclude(raw) {
  let s = String(raw ?? '').trim().replace(/\\/g, '/')
  if (!s) return ''
  // A bare-root or dot-only pattern excludes nothing meaningful.
  if (s === '/' || s === '.' || s === './') return ''
  s = s.replace(/^\.\//, '')
  s = s.replace(/^\/+/, '')
  s = s.replace(/\/+$/, '')
  // `.` / `..` segments carry no meaning for tar's matcher and would only make
  // the pattern harder to reason about.
  s = s.replace(/^\.\/+/, '')
  if (!s || s === '.' || s === '..') return ''
  // A pattern that still escapes upward is refused at the call site, not
  // rewritten: silently dropping `..` would exclude MORE than the caller asked.
  return s
}

/**
 * Normalize a whole exclude list: split a textarea/newline blob, drop blanks and
 * gitignore comments, normalize each pattern, and de-duplicate (order kept so a
 * later UI edit reads the same as what ran).
 * @param {string|string[]|undefined} input
 * @returns {{patterns: string[], dropped: string[]}} `dropped` names inputs that
 *   were thrown away (comments/blank/root-only), for an honest report.
 */
export function parseExcludes(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/)
  const patterns = []
  const dropped = []
  const seen = new Set()
  for (const line of lines) {
    const trimmed = String(line ?? '').trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const norm = normalizeExclude(trimmed)
    if (!norm) {
      dropped.push(trimmed)
      continue
    }
    if (seen.has(norm)) continue
    seen.add(norm)
    patterns.push(norm)
  }
  return { patterns, dropped }
}

/** A pattern we refuse outright: one that walks out of the workspace, or that
 *  names an absolute path. Both make the exclusion set impossible to reason
 *  about, and `..` in a tar pattern is never needed for "exclude my build dir". */
export function isUnsafeExclude(pattern) {
  const s = String(pattern ?? '')
  return s.split('/').includes('..') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)
}

/** Readable slug for a remote workspace path (`/home/dev/my proj` → `my-proj`).
 *  Never empty: the hash suffix from archiveStem() keeps two same-named
 *  workspaces from colliding. */
export function workspaceSlug(remotePath) {
  const norm = normalizeRemotePath(remotePath || '/')
  const base = norm.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
  const slug = base
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'workspace'
}

/** Filename stem for an archive: `<slug>-<hash>` — the hash keys on the FULL
 *  remote path, so `/a/proj` and `/b/proj` never share a stem. */
export function archiveStem(remotePath) {
  const norm = normalizeRemotePath(remotePath || '/')
  return `${workspaceSlug(norm)}-${shortHash(norm)}`
}

/**
 * Build an archive filename with an injectable clock (deterministic in tests).
 * `2026-10-08T11-22-33` is used rather than `:` so the name is legal on Windows
 * remotes and in a URL query.
 */
export function archiveName(date = new Date(), { label = '', ext = ARCHIVE_SUFFIX } = {}) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}-${p(date.getUTCMinutes())}-${p(date.getUTCSeconds())}`
  const tag = String(label || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `${tag ? tag + '-' : ''}${stamp}${ext}`
}

/**
 * Whether a caller-supplied archive name is safe to join onto a backup dir.
 *
 * This is the traversal guard for every operation that takes a `file` argument
 * (list/verify/restore/delete/download): a name like `../../etc/passwd` or an
 * absolute path must never reach `rm`/`tar` on the remote.
 * @returns {boolean} true when the name is a plain basename ending in `.tar.gz`.
 */
export function isSafeArchiveName(name) {
  const s = String(name ?? '')
  if (!s || s.length > 200) return false
  if (s.includes('/') || s.includes('\\')) return false
  if (s === '.' || s === '..') return false
  if (s.startsWith('.')) return false
  if (!s.endsWith(ARCHIVE_SUFFIX)) return false
  return /^[A-Za-z0-9._-]+$/.test(s)
}

/** The sidecar metadata path for an archive (same directory, derived name). */
export function metaNameFor(archive) {
  return String(archive).replace(/\.tar\.gz$/, META_SUFFIX)
}

/**
 * Resolve the remote backup directory from a home directory.
 * @param {string} home - the remote `$HOME` ('' when unknown).
 * @param {string} [override] - an explicit configured directory (wins).
 * @returns {string} an absolute POSIX path, or '' when it cannot be resolved.
 */
export function resolveBackupDir(home, override) {
  const explicit = String(override ?? '').trim()
  if (explicit) return normalizeRemotePath(explicit)
  const h = String(home ?? '').trim()
  if (!h) return ''
  return normalizeRemotePath(`${h.replace(/\/+$/, '')}/${DEFAULT_BACKUP_SUFFIX}`)
}

/** `$HOME` resolution script. Multiple sources on purpose: an ExecStart
 *  environment may omit HOME (systemd, some CI shells) while `~` still expands,
 *  and a Windows-Git-Bash remote reports the POSIX home from `pwd`. */
export function buildHomeCommand() {
  return [
    'ARCH_H="$HOME"',
    'if [ -z "$ARCH_H" ]',
    'then',
    '  ARCH_H=$(cd ~ 2>/dev/null && pwd)',
    'fi',
    'echo "ARCH_HOME=$ARCH_H"',
  ].join('\n')
}

/** Read one `KEY=value` marker out of script output. Last occurrence wins (the
 *  scripts print failures after progress, and a later line is the final word). */
export function readMarker(stdout, key) {
  const re = new RegExp(`^${key}=(.*)$`, 'gm')
  let value = ''
  let m
  while ((m = re.exec(String(stdout ?? ''))) !== null) value = m[1].trim()
  return value
}

/** Every `KEY=value` marker as an object (first occurrence per key). */
export function readMarkers(stdout, keys = Object.values(MARK)) {
  const out = {}
  for (const key of keys) {
    const v = readMarker(stdout, key)
    if (v !== '') out[key] = v
  }
  return out
}

/** Render `--exclude=` flags as individually shell-quoted literal arguments.
 *
 *  Inlined as literals (rather than interpolated from a single `$EXCLUDES`
 *  variable) so no shell word-splitting or glob expansion can ever reinterpret a
 *  pattern: `shq()` protects the value, and the caller's quote stops the shell
 *  from expanding `*.log` before tar sees it. */
export function excludeFlags(patterns = []) {
  return patterns.map((p) => shq(`--exclude=${p}`)).join(' ')
}

/**
 * Build the archive-creation script.
 *
 * Shape: `tar -czf <stage> -C <dir> [--exclude=…]… .` — members read `./x/y`,
 * which is what makes a bare exclude pattern match at any depth (fact 1) and
 * what makes `--strip-components=1` restore the contents exactly.
 *
 * The archive is written to a sibling staging file first and only `mv`-d into
 * place on success, so an interrupted or failing run never leaves a truncated
 * `.tar.gz` that a later `list`/`restore` would treat as a real backup.
 *
 * @param {object} spec
 * @param {string} spec.dir - absolute directory to archive.
 * @param {string} spec.archive - absolute path of the finished archive.
 * @param {string[]} [spec.excludes] - NORMALIZED patterns (see parseExcludes).
 * @param {string} [spec.verifyLabel] - marker value echoed in ARCH_VERIFY.
 * @returns {string} a POSIX shell script.
 */
export function buildCreateCommand({ dir, archive, excludes = [], }) {
  const flags = excludeFlags(excludes)
  for (const p of excludes) {
    if (isUnsafeExclude(p) || p.startsWith('./') || p.startsWith('/')) {
      throw new Error(`dsh-remote: refusing to run tar with unsafe/ineffective exclude pattern ${JSON.stringify(p)}`)
    }
  }
  return [
    'set -u',
    `ARCH_SRC=${shq(dir)}`,
    `ARCH_DST=${shq(archive)}`,
    'if [ ! -d "$ARCH_SRC" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=source is not a directory: $ARCH_SRC"`,
    '  exit 1',
    'fi',
    'ARCH_DIR=$(dirname "$ARCH_DST")',
    'mkdir -p "$ARCH_DIR"',
    'if [ ! -d "$ARCH_DIR" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=cannot create archive directory: $ARCH_DIR"`,
    '  exit 1',
    'fi',
    'ARCH_STAGE="$ARCH_DST.stage.$$"',
    'rm -f "$ARCH_STAGE"',
    // `-C` + `.` keeps member names relative (fact 1 and 2), never absolute.
    // No `-P`: member names stay sanitized on extraction.
    `tar -czf "$ARCH_STAGE" -C "$ARCH_SRC" ${flags ? flags + ' ' : ''}. 2>&1`,
    'ARCH_RC=$?',
    'if [ "$ARCH_RC" -ne 0 ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=tar failed with exit $ARCH_RC"`,
    '  rm -f "$ARCH_STAGE"',
    '  exit 1',
    'fi',
    'if [ ! -s "$ARCH_STAGE" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=tar produced an empty archive"`,
    '  rm -f "$ARCH_STAGE"',
    '  exit 1',
    'fi',
    // Verify BEFORE publishing the file: a corrupt archive must not appear in
    // the listing as restorable.
    'if tar -tzf "$ARCH_STAGE" >/dev/null 2>&1',
    'then',
    `  echo "${MARK.verify}=ok"`,
    'else',
    `  echo "${MARK.verify}=bad"`,
    'fi',
    'mv -f "$ARCH_STAGE" "$ARCH_DST"',
    'ARCH_BYTES=$(wc -c < "$ARCH_DST" | tr -d " ")',
    'ARCH_MEMBERS=$(tar -tzf "$ARCH_DST" 2>/dev/null | wc -l | tr -d " ")',
    'ARCH_SUM=""',
    'if command -v sha256sum >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(sha256sum "$ARCH_DST" | awk \'{print $1}\')',
    'elif command -v shasum >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(shasum -a 256 "$ARCH_DST" | awk \'{print $1}\')',
    'elif command -v openssl >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(openssl dgst -sha256 "$ARCH_DST" | awk \'{print $NF}\')',
    'fi',
    `echo "${MARK.file}=$ARCH_DST"`,
    `echo "${MARK.bytes}=$ARCH_BYTES"`,
    `echo "${MARK.members}=$ARCH_MEMBERS"`,
    `echo "${MARK.sha}=$ARCH_SUM"`,
    `echo "${MARK.ok}=1"`,
  ].join('\n')
}

/** Interpret buildCreateCommand() output.
 * @returns {{ok: boolean, error: string, file: string, bytes: number, members: number, sha256: string, verified: boolean}}
 */
export function parseCreateResult(stdout) {
  const m = readMarkers(stdout, [MARK.ok, MARK.error, MARK.file, MARK.bytes, MARK.members, MARK.sha, MARK.verify])
  return {
    ok: m[MARK.ok] === '1',
    error: m[MARK.error] || '',
    file: m[MARK.file] || '',
    bytes: Number(m[MARK.bytes]) || 0,
    members: Number(m[MARK.members]) || 0,
    sha256: m[MARK.sha] || '',
    verified: m[MARK.verify] === 'ok',
  }
}

/**
 * Build the listing script: glob the backup dir and emit one `ARCH_ENTRY=` line
 * per archive, then (when present) the sidecar metadata file's CONTENT between
 * delimiters. Sidecars are emitted rather than parsed in shell so the host half
 * owns one JSON parser and the listing stays a single round trip.
 *
 * Glob + `[ -e ]` rather than `find -printf` on purpose: `-printf` is a GNU
 * extension (absent on macOS/BSD), and a silently empty listing would look
 * exactly like "no backups yet".
 */
export function buildListCommand({ dir }) {
  return [
    'set -u',
    `ARCH_DIR=${shq(dir)}`,
    'if [ ! -d "$ARCH_DIR" ]',
    'then',
    `  echo "${MARK.exists}=0"`,
    '  exit 0',
    'fi',
    `echo "${MARK.exists}=1"`,
    'for ARCH_F in "$ARCH_DIR"/*.tar.gz',
    'do',
    '  if [ ! -f "$ARCH_F" ]',
    '  then',
    '    continue',
    '  fi',
    '  ARCH_N=$(basename "$ARCH_F")',
    '  ARCH_B=$(wc -c < "$ARCH_F" | tr -d " ")',
    '  ARCH_T=$(stat -c %Y "$ARCH_F" 2>/dev/null)',
    '  if [ -z "$ARCH_T" ]',
    '  then',
    '    ARCH_T=$(stat -f %m "$ARCH_F" 2>/dev/null)',
    '  fi',
    '  if [ -z "$ARCH_T" ]',
    '  then',
    '    ARCH_T=0',
    '  fi',
    `  printf '%s=%s|%s|%s\\n' "${MARK.entry}" "$ARCH_N" "$ARCH_B" "$ARCH_T"`,
    '  ARCH_M="$ARCH_DIR/${ARCH_N%.tar.gz}.meta.json"',
    '  if [ -f "$ARCH_M" ]',
    '  then',
    // The archive NAME rides on the begin marker so a sidecar is always paired
    // with the entry it belongs to. Pairing by position instead would silently
    // shift every later archive's metadata onto the wrong row the moment one
    // sidecar is missing or unreadable.
    `    printf '%s=%s\\n' "${META_BEGIN_MARK}" "$ARCH_N"`,
    '    cat "$ARCH_M"',
    `    printf '\\n%s\\n' "${'ARCH_META_END'}"`,
    '  fi',
    'done',
  ].join('\n')
}

/** Parse buildListCommand() output.
 * @returns {{exists: boolean, entries: Array<{name: string, bytes: number, mtimeMs: number, meta: object|null}>}}
 */
export function parseListResult(stdout) {
  const text = String(stdout ?? '')
  const exists = readMarker(text, MARK.exists) === '1'
  const entries = []
  const re = new RegExp(`^${MARK.entry}=([^|]+)\\|(\\d+)\\|(\\d+)$`, 'gm')
  let m
  while ((m = re.exec(text)) !== null) {
    entries.push({
      name: m[1].trim(),
      bytes: Number(m[2]) || 0,
      mtimeMs: (Number(m[3]) || 0) * 1000,
      meta: null,
    })
  }
  // Sidecars are paired BY NAME (the name rides on ARCH_META_BEGIN=), not by
  // position: a missing or unreadable sidecar for one archive must not shift
  // every later archive's metadata onto the wrong row.
  const byName = new Map()
  const blockRe = new RegExp(`^${META_BEGIN_MARK}=(.*)\\r?\\n([\\s\\S]*?)\\r?\\nARCH_META_END$`, 'gm')
  let b
  while ((b = blockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(b[2])
      if (parsed && typeof parsed === 'object') byName.set(b[1].trim(), parsed)
    } catch { /* a corrupt sidecar must not hide its archive */ }
  }
  for (const entry of entries) {
    if (byName.has(entry.name)) entry.meta = byName.get(entry.name)
  }
  return { exists, entries }
}

/** Build the verification script for one existing archive: integrity of the
 *  gzip/tar stream plus a fresh sha256, so a caller can compare it with the
 *  recorded digest (bit rot / truncated transfer). */
export function buildVerifyCommand({ archive }) {
  return [
    'set -u',
    `ARCH_F=${shq(archive)}`,
    'if [ ! -f "$ARCH_F" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=archive not found: $ARCH_F"`,
    '  exit 1',
    'fi',
    'if tar -tzf "$ARCH_F" >/dev/null 2>&1',
    'then',
    `  echo "${MARK.verify}=ok"`,
    'else',
    `  echo "${MARK.verify}=bad"`,
    'fi',
    'ARCH_BYTES=$(wc -c < "$ARCH_F" | tr -d " ")',
    'ARCH_MEMBERS=$(tar -tzf "$ARCH_F" 2>/dev/null | wc -l | tr -d " ")',
    'ARCH_SUM=""',
    'if command -v sha256sum >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(sha256sum "$ARCH_F" | awk \'{print $1}\')',
    'elif command -v shasum >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(shasum -a 256 "$ARCH_F" | awk \'{print $1}\')',
    'elif command -v openssl >/dev/null 2>&1',
    'then',
    '  ARCH_SUM=$(openssl dgst -sha256 "$ARCH_F" | awk \'{print $NF}\')',
    'fi',
    `echo "${MARK.bytes}=$ARCH_BYTES"`,
    `echo "${MARK.members}=$ARCH_MEMBERS"`,
    `echo "${MARK.sha}=$ARCH_SUM"`,
    `echo "${MARK.ok}=1"`,
  ].join('\n')
}

/** Build the delete script for one archive plus its sidecar. */
export function buildDeleteCommand({ archive, meta }) {
  return [
    'set -u',
    `ARCH_F=${shq(archive)}`,
    `ARCH_M=${shq(meta)}`,
    'if [ ! -f "$ARCH_F" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=archive not found: $ARCH_F"`,
    '  exit 1',
    'fi',
    'rm -f "$ARCH_F"',
    'rm -f "$ARCH_M"',
    'if [ -f "$ARCH_F" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=could not remove: $ARCH_F"`,
    '  exit 1',
    'fi',
    `echo "${MARK.ok}=1"`,
  ].join('\n')
}

/** Whether a restore mode means "the target's previous contents are replaced". */
export function isReplaceMode(mode) {
  return String(mode || 'replace').toLowerCase() !== 'merge'
}

/**
 * Build the restore script.
 *
 * `replace` is implemented as stage → swap → drop-old so the operation is
 * recoverable at every step: the archive is extracted into a staging dir FIRST
 * (a corrupt archive fails there, leaving the target byte-for-byte untouched),
 * then the target is moved aside and the staging dir takes its place, and only
 * then is the old copy removed. This is what makes "restore a bad backup"
 * non-destructive, which is the whole point of having a backup.
 *
 * `merge` extracts over the existing tree and never deletes anything.
 *
 * @param {object} spec
 * @param {string} spec.archive - absolute archive path.
 * @param {string} spec.target - absolute destination directory.
 * @param {string} [spec.mode] - `replace` (default) or `merge`.
 * @param {string} [spec.stage] - staging directory (a sibling of `target`).
 * @param {string} [spec.swap] - where the old target is parked during the swap.
 */
export function buildRestoreCommand({ archive, target, mode = 'replace', stage, swap }) {
  const replace = isReplaceMode(mode)
  const lines = [
    'set -u',
    `ARCH_F=${shq(archive)}`,
    `ARCH_T=${shq(target)}`,
    'if [ ! -f "$ARCH_F" ]',
    'then',
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=archive not found: $ARCH_F"`,
    '  exit 1',
    'fi',
    'ARCH_P=$(dirname "$ARCH_T")',
    'mkdir -p "$ARCH_P"',
    // Never extract with -P / --absolute-names: the tar defaults refuse `../`
    // members and strip leading `/`, which is what keeps a hostile archive
    // inside the target (fact 2 in the header).
    'if tar -tzf "$ARCH_F" >/dev/null 2>&1',
    'then',
    `  echo "${MARK.verify}=ok"`,
    'else',
    `  echo "${MARK.verify}=bad"`,
    `  echo "${MARK.ok}=0"`,
    `  echo "${MARK.error}=archive is corrupt or truncated; nothing was written"`,
    '  exit 1',
    'fi',
  ]
  if (replace) {
    lines.push(
      `ARCH_STAGE=${shq(stage)}`,
      `ARCH_SWAP=${shq(swap)}`,
      'rm -rf "$ARCH_STAGE"',
      'mkdir -p "$ARCH_STAGE"',
      'if tar -xzf "$ARCH_F" -C "$ARCH_STAGE" --strip-components=1 2>&1',
      'then',
      '  :',
      'else',
      '  rm -rf "$ARCH_STAGE"',
      `  echo "${MARK.ok}=0"`,
      `  echo "${MARK.error}=extraction failed; target left unchanged"`,
      '  exit 1',
      'fi',
      'ARCH_HAD=0',
      'if [ -e "$ARCH_T" ]',
      'then',
      '  ARCH_HAD=1',
      '  rm -rf "$ARCH_SWAP"',
      '  if mv "$ARCH_T" "$ARCH_SWAP"',
      '  then',
      '    :',
      '  else',
      '    rm -rf "$ARCH_STAGE"',
      `    echo "${MARK.ok}=0"`,
      `    echo "${MARK.error}=could not move the existing target aside; nothing changed"`,
      '    exit 1',
      '  fi',
      'fi',
      'if mv "$ARCH_STAGE" "$ARCH_T"',
      'then',
      '  :',
      'else',
      '  if [ "$ARCH_HAD" = "1" ]',
      '  then',
      // Roll back: put the original back so a failed swap is not a data loss.
      '    mv "$ARCH_SWAP" "$ARCH_T"',
      '  fi',
      '  rm -rf "$ARCH_STAGE"',
      `  echo "${MARK.ok}=0"`,
      `  echo "${MARK.error}=could not move the restored tree into place; original restored"`,
      '  exit 1',
      'fi',
      'if [ "$ARCH_HAD" = "1" ]',
      'then',
      '  rm -rf "$ARCH_SWAP"',
      'fi',
      `echo "${MARK.action}=replaced"`,
    )
  } else {
    lines.push(
      'mkdir -p "$ARCH_T"',
      'if tar -xzf "$ARCH_F" -C "$ARCH_T" --strip-components=1 2>&1',
      'then',
      '  :',
      'else',
      `  echo "${MARK.ok}=0"`,
      `  echo "${MARK.error}=extraction failed (target may be partially updated — use replace mode for an atomic restore)"`,
      '  exit 1',
      'fi',
      `echo "${MARK.action}=merged"`,
    )
  }
  lines.push(
    'ARCH_FILES=$(find "$ARCH_T" -type f 2>/dev/null | wc -l | tr -d " ")',
    `echo "${MARK.members}=$ARCH_FILES"`,
    `echo "${MARK.ok}=1"`,
  )
  return lines.join('\n')
}

/** Parse the shared ok/error tail of a script's output. */
export function parseStatus(stdout) {
  const m = readMarkers(stdout, [MARK.ok, MARK.error, MARK.verify, MARK.action, MARK.bytes, MARK.members, MARK.sha, MARK.exists])
  return {
    ok: m[MARK.ok] === '1',
    error: m[MARK.error] || '',
    verified: m[MARK.verify] === 'ok',
    action: m[MARK.action] || '',
    bytes: Number(m[MARK.bytes]) || 0,
    members: Number(m[MARK.members]) || 0,
    sha256: m[MARK.sha] || '',
    exists: m[MARK.exists] === '1',
  }
}

/**
 * Reject an exclude that would escape the workspace. Kept separate so the tool
 * can return a precise, actionable message instead of a generic failure, and so
 * the same rule is applied on the UI route and the model tool.
 * @returns {string} '' when acceptable, else the reason.
 */
export function excludeRejection(patterns = []) {
  for (const p of patterns) {
    if (isUnsafeExclude(p)) {
      return `exclude pattern ${JSON.stringify(p)} escapes the workspace — backup excludes must be relative paths inside it`
    }
  }
  return ''
}

/** Human-readable byte size for tool/UI text (1024-based, one decimal). */
export function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${units[i]}`
}

/**
 * The relative path of a backup directory inside an archived workspace, or ''
 * when it sits outside (the default). Used to guarantee an archive never
 * contains a previous backup of itself, which would grow it every run.
 */
export function backupDirUnderRoot(backupDir, root) {
  if (!backupDir || !root) return ''
  const rel = relPathUnder(root, backupDir)
  return rel === null || rel === '' ? '' : rel.replace(/^\/+/, '')
}
