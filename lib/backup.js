// dsh-remote — workspace compressed backup / restore orchestration.
//
// Sits between the pure command builders in lib/archive.js and the callers
// (rw_backup / rw_backup_list / rw_restore tools and the /dsh-remote/backup*
// routes). Everything here takes the SSH pool as an ARGUMENT rather than
// reaching for a module-level singleton, so the whole flow can be exercised
// against an in-memory SFTP double in tests.
//
// Design commitments, each with a reason:
//
//  · **A failed run never publishes a partial archive.** archive.js stages the
//    file and `mv`s it into place only after tar exits 0 and the stream verifies.
//
//  · **A restore is never destructive before the archive proves itself.** The
//    extract happens into a staging directory first; a corrupt or truncated
//    archive fails there and the target is left byte-for-byte untouched. Only
//    then is the old tree swapped aside, and it is removed last.
//
//  · **Every archive carries a sidecar.** Recording who/what/when/checksum next
//    to the bytes means a restore can say what it is about to overwrite with,
//    and a truncated transfer can be detected rather than trusted.
//
//  · **The backup directory is never inside its own archive.** When the backup
//    dir happens to live under the workspace (a user-chosen path), that subtree
//    is added to the excludes; otherwise every run would embed the previous run
//    and the archive would grow without bound.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs'
import { remoteDirname, mkdirRemoteDirs } from './paths.js'
import {
  MARK, META_BEGIN_MARK, ARCHIVE_SUFFIX, META_SUFFIX,
  buildHomeCommand, buildCreateCommand, buildListCommand, buildVerifyCommand,
  buildDeleteCommand, buildRestoreCommand, parseCreateResult, parseListResult,
  parseStatus, resolveBackupDir, archiveName, archiveStem, metaNameFor,
  isSafeArchiveName, excludeRejection, backupDirUnderRoot, formatBytes,
  buildCreateAllCommand, buildRestoreAllCommand, parseRestoredEntries,
  ALL_MANIFEST_DIR, ALL_MANIFEST_FILE, ALL_BACKUP_EXCLUDES, expandExcludeDirs,
  isUnsafeExclude,
} from './archive.js'

/** Parse one `ARCH_*` marker without importing the whole marker map. */
const marker = (out, key) => {
  const re = new RegExp(`^${key}=(.*)$`, 'gm')
  let v = ''
  let m
  while ((m = re.exec(String(out ?? ''))) !== null) v = m[1].trim()
  return v
}

/** How much of an archive we are willing to move across SFTP. The archive
 *  itself is uncapped (a backup is a backup); only the optional cross-machine
 *  copy is bounded, because that is what fills a laptop's disk. */
export function transferCapExceeded(bytes, cap) {
  const limit = Number(cap) || 0
  if (limit <= 0) return false
  return Number(bytes) > limit
}

/**
 * Resolve the remote user's home directory. Cached by the caller (the tool
 * resolves it once per call), because a backup is a single round trip anyway.
 * @returns {Promise<string>} '' when it cannot be determined.
 */
export async function resolveRemoteHome(pool, timeoutMs = 10000) {
  try {
    const res = await pool.exec(buildHomeCommand(), { timeoutMs })
    const home = marker(res && res.stdout, MARK.home)
    return home && home.startsWith('/') ? home : ''
  } catch {
    return ''
  }
}

/**
 * Stat a remote path, distinguishing "absent" from "I could not tell".
 *
 * The distinction matters for naming: treating a TRANSIENT failure as
 * "does not exist" would pick an archive name that already exists and overwrite
 * a real backup. Only a genuine not-found is reported as absent; anything else
 * propagates so the caller fails loudly instead of destroying data.
 *
 * @returns {Promise<object|null>} the stat, or null when the path genuinely
 *   does not exist.
 * @throws when the failure is anything other than not-found.
 */
async function remoteStat(pool, p) {
  let sftp
  try {
    sftp = await pool.sftp()
  } catch (err) {
    throw new Error('sftp unavailable: ' + String((err && err.message) || err))
  }
  try {
    return await sftp.stat(p)
  } catch (err) {
    const code = err && (err.code === 2 || err.code === 'ENOENT')
    const msg = String((err && err.message) || err)
    if (code || /no such file|not found|does not exist|ENOENT/i.test(msg)) return null
    throw new Error(`cannot stat ${p}: ${msg}`)
  }
}

/** Whether a remote path exists. See remoteStat for why this is not a plain
 *  boolean wrapper. */
async function remoteExists(pool, p) {
  return (await remoteStat(pool, p)) !== null
}

/** Read a remote JSON sidecar, or null when absent/unparsable. */
async function readRemoteMeta(pool, metaPath) {
  try {
    const sftp = await pool.sftp()
    const buf = await sftp.readFile(metaPath)
    const parsed = JSON.parse(buf.toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Write a remote JSON sidecar (best effort — a missing sidecar must not fail
 *  an otherwise successful backup; the listing renders it as "unknown"). */
async function writeRemoteMeta(pool, metaPath, meta) {
  try {
    const sftp = await pool.sftp()
    await mkdirRemoteDirs(sftp, remoteDirname(metaPath))
    await sftp.writeFile(metaPath, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'))
    return true
  } catch {
    return false
  }
}

/**
 * Pick an archive filename that does not collide with an existing one.
 *
 * The timestamp alone is not enough: two backups inside the same second (a
 * retry, or the tool and the settings button) would otherwise silently
 * overwrite the first. `-2`, `-3` … keeps both.
 */
export async function uniqueArchivePath(pool, dir, baseName) {
  let candidate = `${dir}/${baseName}`
  if (!(await remoteExists(pool, candidate))) return candidate
  const stem = baseName.endsWith(ARCHIVE_SUFFIX) ? baseName.slice(0, -ARCHIVE_SUFFIX.length) : baseName
  for (let i = 2; i <= 200; i++) {
    candidate = `${dir}/${stem}-${i}${ARCHIVE_SUFFIX}`
    if (!(await remoteExists(pool, candidate))) return candidate
  }
  throw new Error('dsh-remote: cannot find a free archive name in ' + dir)
}

/**
 * Create one backup of a remote directory.
 *
 * @param {object} pool - SSH pool (needs `exec` + `sftp`).
 * @param {object} spec
 * @param {string} spec.dir - absolute directory to back up (the workspace root).
 * @param {string} spec.backupDir - absolute remote backup directory ('' → resolve from HOME).
 * @param {string} [spec.label] - user-facing tag embedded in the filename.
 * @param {string[]} [spec.excludes] - NORMALIZED patterns (see archive.js).
 * @param {object} [spec.meta] - extra fields recorded in the sidecar.
 * @param {number} [spec.timeoutMs]
 * @returns {Promise<{ok: boolean, error: string, archive: string, name: string, metaPath: string,
 *   bytes: number, members: number, sha256: string, verified: boolean, meta: object, home: string}>}
 */
export async function createBackup(pool, spec = {}) {
  const dir = String(spec.dir || '')
  const blank = { ok: false, error: '', archive: '', name: '', metaPath: '', bytes: 0, members: 0, sha256: '', verified: false, meta: {}, home: '' }
  try {
    return await createBackupInner(pool, spec)
  } catch (err) {
    // A transient failure (a stat we could not complete, a dropped SFTP channel)
    // must surface as a failed BACKUP, never as a half-applied one: nothing was
    // published because the archive is staged and only renamed on success.
    return { ...blank, archive: '', error: String((err && err.message) || err) }
  }
}

async function createBackupInner(pool, spec = {}) {
  const dir = String(spec.dir || '')
  if (!dir || dir === '/') throw new Error('dsh-remote: a workspace directory is required')
  const timeoutMs = Number(spec.timeoutMs) || 0

  let backupDir = String(spec.backupDir || '')
  let home = ''
  if (!backupDir) {
    home = await resolveRemoteHome(pool)
    backupDir = resolveBackupDir(home, '')
    if (!backupDir) {
      return { ok: false, error: 'cannot determine the remote $HOME to place the backup in — set backupDir explicitly', archive: '', name: '', metaPath: '', bytes: 0, members: 0, sha256: '', verified: false, meta: {}, home: '' }
    }
  }

  // An exclude list that escapes the workspace is refused rather than silently
  // used: it would make the archived set impossible to describe.
  const excludes = Array.isArray(spec.excludes) ? spec.excludes.slice() : []
  const bad = excludeRejection(excludes)
  if (bad) return { ok: false, error: bad, archive: '', name: '', metaPath: '', bytes: 0, members: 0, sha256: '', verified: false, meta: {}, home }

  // Never archive a previous backup of the same tree (see the header note).
  const selfDir = backupDirUnderRoot(backupDir, dir)
  if (selfDir && !excludes.includes(selfDir)) excludes.push(selfDir)

  const baseName = `${archiveStem(dir)}-${archiveName(spec.date ? new Date(spec.date) : new Date(), { label: spec.label })}`
  const archive = await uniqueArchivePath(pool, backupDir, baseName)
  const name = archive.slice(archive.lastIndexOf('/') + 1)
  const metaPath = `${backupDir}/${metaNameFor(name)}`

  const script = buildCreateCommand({ dir, archive, excludes })
  let out
  try {
    out = await pool.exec(script, timeoutMs ? { timeoutMs } : {})
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), archive, name, metaPath, bytes: 0, members: 0, sha256: '', verified: false, meta: {}, home }
  }
  const parsed = parseCreateResult(out && out.stdout)
  const stderr = String((out && out.stderr) || '').trim()
  if (!parsed.ok) {
    // tar's own message is far more actionable than "exit 2", so surface both.
    const detail = [parsed.error, stderr].filter(Boolean).join(' — ')
    return { ok: false, error: detail || 'backup failed', archive, name, metaPath, bytes: 0, members: 0, sha256: '', verified: false, meta: {}, home }
  }

  const meta = {
    name,
    workspace: dir,
    // Recorded because it is part of the FILENAME: a listing that shows the
    // label must not have to re-parse the name to get it.
    label: String(spec.label || ''),
    excludes,
    bytes: parsed.bytes,
    members: parsed.members,
    sha256: parsed.sha256,
    verified: parsed.verified,
    createdAt: new Date().toISOString(),
    ...(spec.meta && typeof spec.meta === 'object' ? spec.meta : {}),
    tool: 'dsh-remote',
  }
  const metaWritten = await writeRemoteMeta(pool, metaPath, meta)
  return {
    ok: true,
    error: '',
    archive,
    name,
    metaPath,
    bytes: parsed.bytes,
    members: parsed.members,
    sha256: parsed.sha256,
    verified: parsed.verified,
    metaWritten,
    meta,
    home,
  }
}

/**
 * List the backups in one remote directory, newest first.
 * @returns {Promise<{exists: boolean, dir: string, entries: Array<object>}>} each
 *   entry merges the sidecar (when present) with the on-disk truth.
 */
export async function listBackups(pool, spec = {}) {
  const dir = String(spec.dir || '')
  if (!dir) return { exists: false, dir: '', entries: [] }
  let out
  try {
    out = await pool.exec(buildListCommand({ dir }), { timeoutMs: Number(spec.timeoutMs) || 15000 })
  } catch (err) {
    return { exists: false, dir, entries: [], error: String((err && err.message) || err) }
  }
  const parsed = parseListResult(out && out.stdout)
  const entries = parsed.entries
    .filter((e) => isSafeArchiveName(e.name))
    .map((e) => ({
      name: e.name,
      bytes: e.bytes,
      mtime: e.mtimeMs ? new Date(e.mtimeMs).toISOString() : '',
      // The sidecar may be missing (older archive, failed write) — say so rather
      // than inventing values the caller might trust.
      workspace: (e.meta && e.meta.workspace) || '',
      members: e.meta && Number.isFinite(e.meta.members) ? e.meta.members : null,
      sha256: (e.meta && e.meta.sha256) || '',
      verified: e.meta ? !!e.meta.verified : null,
      label: (e.meta && e.meta.label) || '',
      createdAt: (e.meta && e.meta.createdAt) || '',
      hasMeta: !!e.meta,
      rawMeta: e.meta || null,
    }))
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
  return { exists: parsed.exists, dir, entries }
}

/** Verify one remote archive's integrity + digest. */
export async function verifyBackup(pool, spec = {}) {
  const archive = String(spec.archive || '')
  const out = await pool.exec(buildVerifyCommand({ archive }), { timeoutMs: Number(spec.timeoutMs) || 60000 })
  return parseStatus(out && out.stdout)
}

/** Delete one remote archive and its sidecar. */
export async function deleteBackup(pool, spec = {}) {
  const archive = String(spec.archive || '')
  const meta = String(spec.meta || metaNameFor(archive))
  const out = await pool.exec(buildDeleteCommand({ archive, meta }), { timeoutMs: Number(spec.timeoutMs) || 20000 })
  return parseStatus(out && out.stdout)
}

/**
 * Restore an archive over a target directory.
 *
 * @param {object} pool
 * @param {object} spec
 * @param {string} spec.archive - absolute archive path (already on the remote).
 * @param {string} spec.target - absolute directory to restore into.
 * @param {string} [spec.mode] - `replace` (default, atomic swap) or `merge`.
 * @param {number} [spec.timeoutMs]
 */
export async function restoreBackup(pool, spec = {}) {
  const archive = String(spec.archive || '')
  const target = String(spec.target || '')
  if (!archive || !target || target === '/') {
    return { ok: false, error: 'an archive and a restore target are required', action: '', members: 0 }
  }
  // Sibling paths keep the swap on the SAME filesystem, which is what makes
  // `mv` atomic and therefore makes the rollback path meaningful.
  const token = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const stage = `${target}.dsh-remote-stage-${token}`
  const swap = `${target}.dsh-remote-bak-${token}`
  const script = buildRestoreCommand({ archive, target, mode: spec.mode, stage, swap })
  let out
  try {
    out = await pool.exec(script, { timeoutMs: Number(spec.timeoutMs) || 0 })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), action: '', members: 0 }
  }
  const status = parseStatus(out && out.stdout)
  const stderr = String((out && out.stderr) || '').trim()
  if (!status.ok && !status.error) {
    // A non-zero exit with no marker means the script died early (killed,
    // unwritable parent) — report the raw stderr rather than a bare failure.
    return { ok: false, error: stderr || 'restore failed before it could report a reason', action: '', members: 0, verified: status.verified }
  }
  return {
    ok: status.ok,
    error: status.error || (status.ok ? '' : stderr),
    action: status.action,
    members: status.members,
    verified: status.verified,
    mode: status.action === 'merged' ? 'merge' : 'replace',
  }
}

/** Local directory holding pulled archives for one machine. */
export function localBackupDirFor(hostRoot) {
  return path.join(hostRoot, 'backups')
}

/** Download one remote archive into a local directory (SFTP). */
export async function pullBackup(pool, spec = {}) {
  const archive = String(spec.archive || '')
  const localDir = String(spec.localDir || '')
  const cap = Number(spec.maxTransferBytes) || 0
  if (!archive || !localDir) return { ok: false, error: 'archive and localDir are required' }
  const st = await remoteStat(pool, archive)
  if (!st) return { ok: false, error: `archive not found on the remote: ${archive}` }
  if (transferCapExceeded(st.size, cap)) {
    return { ok: false, error: `archive is ${formatBytes(st.size)}, over the ${formatBytes(cap)} transfer cap — raise maxBackupTransferBytes to allow it` }
  }
  const name = archive.slice(archive.lastIndexOf('/') + 1)
  mkdirSync(localDir, { recursive: true })
  const localPath = path.join(localDir, name)
  try {
    const sftp = await pool.sftp()
    await sftp.fastGet(archive, localPath)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  // Pull the sidecar too, so the local copy lists with the same metadata.
  let metaPulled = false
  const metaRemote = metaNameFor(archive)
  try {
    const sftp = await pool.sftp()
    await sftp.fastGet(metaRemote, path.join(localDir, metaNameFor(name)))
    metaPulled = true
  } catch { /* sidecar is optional */ }
  const bytes = existsSync(localPath) ? statSync(localPath).size : 0
  return { ok: true, error: '', localPath, name, bytes, metaPulled }
}

/** Upload a local archive to a remote directory (SFTP), for restore-from-local. */
export async function pushBackup(pool, spec = {}) {
  const localPath = String(spec.localPath || '')
  const remoteDir = String(spec.remoteDir || '')
  const cap = Number(spec.maxTransferBytes) || 0
  if (!localPath || !remoteDir) return { ok: false, error: 'localPath and remoteDir are required' }
  if (!existsSync(localPath)) return { ok: false, error: `local archive not found: ${localPath}` }
  const st = statSync(localPath)
  if (transferCapExceeded(st.size, cap)) {
    return { ok: false, error: `archive is ${formatBytes(st.size)}, over the ${formatBytes(cap)} transfer cap — raise maxBackupTransferBytes to allow it` }
  }
  const name = path.basename(localPath)
  if (!isSafeArchiveName(name)) return { ok: false, error: `refusing to upload a suspicious archive name: ${name}` }
  const remotePath = `${remoteDir.replace(/\/+$/, '')}/${name}`
  try {
    const sftp = await pool.sftp()
    await mkdirRemoteDirs(sftp, remoteDir)
    await sftp.fastPut(localPath, remotePath)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  return { ok: true, error: '', remotePath, name, bytes: st.size }
}

/** Read a local JSON sidecar, or null. */
function readLocalMeta(localDir, name) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(localDir, metaNameFor(name)), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Write a local JSON sidecar (best effort). */
function writeLocalMeta(localDir, name, meta) {
  try {
    mkdirSync(localDir, { recursive: true })
    writeFileSync(path.join(localDir, metaNameFor(name)), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** List locally pulled archives, newest first (same shape as listBackups). */
export function listLocalBackups(localDir) {
  const entries = []
  if (!localDir || !existsSync(localDir)) return { exists: false, dir: localDir || '', entries }
  let names = []
  try {
    names = readdirSync(localDir)
  } catch {
    return { exists: false, dir: localDir, entries }
  }
  for (const name of names) {
    if (!name.endsWith(ARCHIVE_SUFFIX) || !isSafeArchiveName(name)) continue
    let st = null
    try { st = statSync(path.join(localDir, name)) } catch { continue }
    const meta = readLocalMeta(localDir, name)
    entries.push({
      name,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      workspace: (meta && meta.workspace) || '',
      members: meta && Number.isFinite(meta.members) ? meta.members : null,
      sha256: (meta && meta.sha256) || '',
      verified: meta ? !!meta.verified : null,
      label: (meta && meta.label) || '',
      createdAt: (meta && meta.createdAt) || '',
      hasMeta: !!meta,
      rawMeta: meta || null,
      localPath: path.join(localDir, name),
    })
  }
  entries.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
  return { exists: true, dir: localDir, entries }
}

/** Delete one local archive + sidecar. */
export function deleteLocalBackup(localDir, name) {
  if (!isSafeArchiveName(name)) return { ok: false, error: `refusing to delete a suspicious name: ${name}` }
  const archive = path.join(localDir, name)
  const meta = path.join(localDir, metaNameFor(name))
  let removed = false
  try {
    if (existsSync(archive)) { rmSync(archive, { force: true }); removed = true }
    if (existsSync(meta)) rmSync(meta, { force: true })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  return removed ? { ok: true, error: '' } : { ok: false, error: `local archive not found: ${name}` }
}

/** Re-verify a LOCAL archive: recompute its digest and compare with the digest
 *  recorded when the backup was created. That comparison is the transfer-
 *  fidelity question — a truncated or corrupted pull is exactly what it catches,
 *  and the local half deliberately has no `tar` dependency to do it. */
export function verifyLocalBackup(localDir, name) {
  if (!isSafeArchiveName(name)) return { ok: false, error: `refusing to inspect a suspicious name: ${name}` }
  const p = path.join(localDir, name)
  if (!existsSync(p)) return { ok: false, error: `local archive not found: ${name}` }
  const st = statSync(p)
  let sha256 = ''
  try {
    const h = createHash('sha256')
    h.update(readFileSync(p))
    sha256 = h.digest('hex')
  } catch { sha256 = '' }
  const meta = readLocalMeta(localDir, name)
  const expected = (meta && meta.sha256) || ''
  // `null` (rather than false) when there is nothing to compare against: an
  // archive with no sidecar is unverified, which is different from corrupt.
  const matches = !expected || !sha256 ? null : expected === sha256
  return { ok: true, error: '', bytes: st.size, sha256, expectedSha256: expected, matches, meta }
}

/** Human summary of a create result (shared by the tool and the route). */
export function describeCreate(result, { dest = 'remote' } = {}) {
  if (!result || !result.ok) return `backup failed: ${(result && result.error) || 'unknown error'}`
  const where = dest === 'local' ? 'on the local machine'
    : dest === 'both' ? 'on both the remote and the local machine'
      : 'on the remote'
  const bits = [
    `created ${result.name} (${formatBytes(result.bytes)}${result.members ? `, ${result.members} entries` : ''}) — stored ${where}`,
  ]
  if (result.verified) bits.push('verified readable')
  if (result.sha256) bits.push(`sha256 ${result.sha256.slice(0, 16)}…`)
  return bits.join('; ')
}

/** Marker used by tests to assert the sidecar name derivation. */
export { META_SUFFIX, ARCHIVE_SUFFIX, META_BEGIN_MARK }

// ── "all workspaces" backup: ONE archive, ONE restore ───────────────────────
//
// The panel offers exactly two buttons, so this is the whole feature. Everything
// the single-workspace flow learned still applies (stage-then-publish, verify
// before writing, manifest for self-description); what changes is that the
// archive holds MANY unrelated absolute directories and describes itself, so a
// restore does not need the caller to remember which workspace it was for.

/** Filename stem for an all-workspaces archive: the machine identity plus a
 *  hash, so archives from different machines never share a stem. */
export function allArchiveStem(machine = {}) {
  const who = `${machine.username || 'user'}-${machine.host || 'host'}`
  const slug = who.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine'
  return `workspaces-${slug}-${shortHashLocal(`${machine.username || ''}@${machine.host || ''}:${machine.port || 22}`)}`
}

/** Local 32-bit base36 hash (kept here so this module has no extra import). */
function shortHashLocal(s) {
  let h = 0
  for (let i = 0; i < String(s).length; i++) h = ((h << 5) - h + String(s).charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * The archive member for an absolute path: the path with its leading slash
 * stripped, because members are added with `-C /`.
 *
 * It MUST be the full path, not a shortened display form. `-C /` resolves the
 * member against the filesystem root, so a shortened member (`allws/w1`) makes
 * tar look in `/allws/w1` while the real directory is `/tmp/allws/w1` — every
 * run fails with "Cannot stat". (Measured on a real host; the shortening looked
 * tidier and was simply wrong.)
 */
export function memberForPath(absPath) {
  const p = String(absPath || '')
  if (!p.startsWith('/') || p === '/') {
    throw new Error(`dsh-remote: cannot archive a non-absolute path ${JSON.stringify(absPath)}`)
  }
  return p.replace(/^\/+/, '')
}

/** Attach the archive member to each distinct path. Members are unique whenever
 *  the paths are, which is why no suffixing is needed (and why two different
 *  `/a/x/proj` and `/b/x/proj` stay distinct: their full paths differ). */
export function assignMembers(paths = []) {
  const used = new Set()
  const out = []
  for (const p of paths) {
    const path = String(p || '')
    if (!path || path === '/' || used.has(path)) continue
    used.add(path)
    out.push({ path, member: memberForPath(path) })
  }
  return out
}

/**
 * Create ONE archive containing every given workspace.
 *
 * @param {object} pool
 * @param {object} spec
 * @param {string[]} spec.workspaces - absolute remote directories.
 * @param {string} spec.backupDir - absolute remote directory for the archive.
 * @param {object} [spec.machine] - {host, username, port} recorded in the manifest.
 * @param {string[]} [spec.extraExcludes] - added to the default exclude set.
 * @param {string} [spec.label]
 * @param {Date}   [spec.date]
 * @returns {Promise<object>} the create result plus `workspaces` (the manifest).
 */
export async function createAllBackup(pool, spec = {}) {
  const dirs = [...new Set((spec.workspaces || []).map((p) => String(p || '')).filter((p) => p && p !== '/'))]
  if (!dirs.length) {
    return { ok: false, error: 'no workspaces to back up — pick a remote workspace first', archive: '', name: '', bytes: 0, members: 0, sha256: '', verified: false, workspaces: [] }
  }
  const backupDir = String(spec.backupDir || '')
  if (!backupDir) {
    return { ok: false, error: 'cannot determine the remote backup directory — set backupDir', archive: '', name: '', bytes: 0, members: 0, sha256: '', verified: false, workspaces: [] }
  }
  const assigned = assignMembers(dirs)
  const excludes = [...new Set([...ALL_BACKUP_EXCLUDES, ...expandExcludeDirs([]), ...(spec.extraExcludes || [])])]
  // Never archive a previous backup of the same machine.
  for (const d of dirs) {
    const nested = backupDirUnderRoot(backupDir, d)
    if (nested) excludes.push(nested)
  }
  for (const p of excludes) {
    const bad = isUnsafeExclude(p) || p.startsWith('./') || p.startsWith('/')
    if (bad) return { ok: false, error: `invalid exclude pattern: ${JSON.stringify(p)}`, archive: '', name: '', bytes: 0, members: 0, sha256: '', verified: false, workspaces: [] }
  }

  const baseName = `${allArchiveStem(spec.machine || {})}-${archiveName(spec.date ? new Date(spec.date) : new Date(), { label: spec.label || 'all' })}`
  const archive = await uniqueArchivePath(pool, backupDir, baseName)
  const name = archive.slice(archive.lastIndexOf('/') + 1)
  const metaPath = `${backupDir}/${metaNameFor(name)}`

  const manifest = {
    kind: 'dsh-remote/workspaces',
    version: 1,
    createdAt: new Date().toISOString(),
    machine: {
      host: String((spec.machine && spec.machine.host) || ''),
      username: String((spec.machine && spec.machine.username) || ''),
      port: Number((spec.machine && spec.machine.port) || 22),
    },
    excludes,
    workspaces: assigned.map((a) => ({ path: a.path, member: a.member })),
  }
  // The remote has no JSON parser we can rely on, so the manifest ships BOTH the
  // human/JSON form and a TAB-separated member↔path list the restore loop reads.
  // Both are passed to the builder, which writes them BEFORE tar runs.
  const pathsTsv = assigned.map((a) => `${a.member}\t${a.path}`).join('\n') + '\n'
  const withTsv = buildCreateAllCommand({
    workspaces: assigned,
    archive,
    manifestJson: JSON.stringify(manifest, null, 2),
    pathsTsv,
    excludes,
  })

  let out
  try {
    out = await pool.exec(withTsv, spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {})
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), archive, name, bytes: 0, members: 0, sha256: '', verified: false, workspaces: assigned }
  }
  const parsed = parseCreateResult(out && out.stdout)
  const stderr = String((out && out.stderr) || '').trim()
  if (!parsed.ok) {
    const detail = [parsed.error, stderr].filter(Boolean).join(' — ')
    return { ok: false, error: detail || 'backup failed', archive, name, bytes: 0, members: 0, sha256: '', verified: false, workspaces: assigned }
  }
  const meta = { name, kind: 'workspaces', ...manifest, bytes: parsed.bytes, members: parsed.members, sha256: parsed.sha256, verified: parsed.verified, tool: 'dsh-remote' }
  const metaWritten = await writeRemoteMeta(pool, metaPath, meta)
  return {
    ok: true,
    error: '',
    archive,
    name,
    metaPath,
    bytes: parsed.bytes,
    members: parsed.members,
    sha256: parsed.sha256,
    verified: parsed.verified,
    metaWritten,
    meta,
    workspaces: assigned,
  }
}

/** POSIX single-quote (local copy; keeps this module's imports minimal). */
function shqLocal(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Restore every workspace from an all-workspaces archive.
 * @param {object} pool
 * @param {object} spec
 * @param {string} spec.archive - absolute archive path on the remote.
 * @param {string} [spec.fallbackRoot] - where a workspace lands when its original
 *   absolute path cannot be created (e.g. restoring another machine's archive).
 */
export async function restoreAllBackup(pool, spec = {}) {
  const archive = String(spec.archive || '')
  if (!archive) return { ok: false, error: 'an archive is required', verified: false, entries: [], members: 0 }
  const script = buildRestoreAllCommand({ archive, fallbackRoot: String(spec.fallbackRoot || '/tmp') })
  let out
  try {
    out = await pool.exec(script, { timeoutMs: Number(spec.timeoutMs) || 0 })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), verified: false, entries: [], members: 0 }
  }
  const status = parseStatus(out && out.stdout)
  const entries = parseRestoredEntries(out && out.stdout)
  const stderr = String((out && out.stderr) || '').trim()
  if (!status.ok && !status.error) {
    return { ok: false, error: stderr || 'restore failed before it could report a reason', verified: status.verified, entries, members: 0 }
  }
  return {
    ok: status.ok,
    // A partial restore still reports success for what moved, so the error text
    // must survive alongside `ok` for the caller to show honestly.
    error: status.error || (status.ok ? '' : stderr),
    verified: status.verified,
    entries,
    members: status.members || entries.length,
  }
}
