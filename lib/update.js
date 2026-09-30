// dsh-remote — self-update support.
//
// dsh-remote is a zero-build plugin: the host half (lib/index.js) is loaded
// straight from the installed package, so "updating" = replacing the package
// files with the newer npm tarball. This module owns the version check and the
// tarball apply:
//
//   • checkLatestVersion() — query the npm registry for the `latest` dist-tag;
//   • applyUpdate() — download the tarball, extract package/{lib,package.json,
//     cordis.patch.yml} with a minimal tar reader, verify the version, then
//     replace the installed files atomically (temp file + rename, never a
//     half-written lib/*.js). A `.dsh-remote-updated` marker records the version
//     that landed; the host half removes it once that version is the code it is
//     actually running (see LOADED_VERSION), so the marker means "restart still
//     required" rather than "an update once happened".
//   • reloadSelf() — swap the RUNNING host half to the code now on disk: drop
//     Node's module caches for this package's own files, then dispose + re-init
//     the loader entry so apply() runs again from the fresh module. Without it
//     an update only takes effect on the next process start, which is what left
//     the served client half newer than the loaded host half.
//
// Every failure aborts without touching the installed files (a bad download or
// a version mismatch must never break the running plugin).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NPM_PACKAGE = 'dsh-remote'
const REGISTRY_URL = 'https://registry.npmjs.org/' + NPM_PACKAGE + '/latest'

/** Absolute directory holding this plugin's installed files (lib/ + package.json). */
export function selfDir() {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  } catch {
    return path.dirname(path.dirname(process.argv[1] || ''))
  }
}

/** Read the installed package.json version; "0.0.0" when unreadable. */
export function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(selfDir(), 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** Version of the code this process actually loaded (snapshot at import time).
 *  `readVersion()` reads package.json from disk, so after an update lands it
 *  reports the NEW version while the running module is still the old one —
 *  comparing the two is the only way to tell "applied" from "active". */
export const LOADED_VERSION = readVersion()

/** Package version currently on disk (may be newer than {@link LOADED_VERSION}). */
export function diskVersion() {
  return readVersion()
}

/** Compare dotted versions; returns true when a > b. */
export function gtVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da > db
  }
  return false
}

/** Query the npm registry for the latest release; resolves null on any failure. */
export async function fetchLatestVersion(timeoutMs = 8000) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(REGISTRY_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return null
      const data = await res.json()
      return typeof data?.version === 'string' && data.version ? data.version : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** Minimal POSIX ustar reader (regular files only) — npm tarballs are gzipped tar. */
function parseTar(buf) {
  const files = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    off += 512
    const data = type === '48' || type === '0' ? Buffer.from(buf.subarray(off, off + size)) : null
    if (data) files.push({ name, data })
    off += Math.ceil(size / 512) * 512
  }
  return files
}

/**
 * Download the given version's tarball and atomically replace the installed
 * package files (lib/*.js, cordis.patch.yml, package.json). On success writes
 * `.dsh-remote-updated` in the install dir; throws on any failure (leaves the
 * installed files untouched).
 * @param targetVersion - exact npm version to install (e.g. "0.8.0").
 */
export async function applyUpdate(targetVersion, options = {}) {
  const tarballUrl = `https://registry.npmjs.org/${NPM_PACKAGE}/-/${NPM_PACKAGE}-${targetVersion}.tgz`
  const dir = options.dir || selfDir()
  const doFetch = options.fetchImpl || fetch
  const tmpRoot = path.join(dir, `.dsh-remote-update-${Date.now()}`)
  const tmpPkg = path.join(tmpRoot, 'package')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    let res
    try {
      res = await doFetch(tarballUrl, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    // npm tarballs are gzipped tar; extract the package/ directory.
    const { gunzipSync } = await import('node:zlib')
    const tar = gunzipSync(buf)
    const files = parseTar(tar)
    mkdirSync(tmpPkg, { recursive: true })
    let extracted = 0
    for (const f of files) {
      const rel = f.name.replace(/^package\//, '')
      if (!rel || rel === 'package/' || rel.endsWith('/')) continue
      if (rel !== 'package.json' && rel !== 'cordis.patch.yml' && !rel.startsWith('lib/')) continue
      const dest = path.join(tmpPkg, rel)
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, f.data)
      extracted++
    }
    if (extracted === 0) throw new Error('tarball contained no package files')
    // Verify the downloaded package.json matches the requested version.
    const newPkg = JSON.parse(readFileSync(path.join(tmpPkg, 'package.json'), 'utf8'))
    if (newPkg.version !== targetVersion) throw new Error(`tarball version mismatch: ${newPkg.version}`)
    // Sanity: the new host half must at least parse (a corrupt index.js would
    // break the next boot — check the file size and that it is not empty).
    const newIndex = path.join(tmpPkg, 'lib', 'index.js')
    if (!existsSync(newIndex) || statSize(newIndex) < 100) throw new Error('tarball missing lib/index.js')
    // Swap the installed files one at a time: atomic, and idempotent.
    //
    // Atomicity (temp file + rename) is not cosmetic here — since the browser
    // half is hot-swapped by dsh-client-hmr, which stat-polls lib/client.js
    // every 500 ms, a torn write would be re-hashed and served mid-copy.
    // Skipping byte-identical files keeps a re-apply of the same version from
    // churning mtimes (and the host half from reloading for nothing).
    const installLib = path.join(dir, 'lib')
    const tmpLib = path.join(tmpPkg, 'lib')
    const changed = []
    const install = (src, dest) => {
      const bytes = readFileSync(src)
      if (sameFileContent(dest, bytes)) return
      try { mkdirSync(path.dirname(dest), { recursive: true }) } catch {}
      writeFileAtomic(dest, bytes)
      changed.push(path.relative(dir, dest).split(path.sep).join('/'))
    }
    for (const name of readdirSafe(tmpLib)) {
      if (!name.endsWith('.js')) continue
      const src = path.join(tmpLib, name)
      if (existsSync(src)) install(src, path.join(installLib, name))
    }
    for (const rel of ['package.json', 'cordis.patch.yml']) {
      const src = path.join(tmpPkg, rel)
      if (existsSync(src)) install(src, path.join(dir, rel))
    }
    writeFileSync(path.join(dir, '.dsh-remote-updated'), String(targetVersion))
    return { ok: true, to: targetVersion, changed }
  } catch (err) {
    throw new Error('update failed: ' + ((err && err.message) || err))
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

/** File size helper (missing/unreadable → 0). */
function statSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** readdir helper that returns [] on failure. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Write `data` to `dest` atomically: the bytes land in a sibling temp file and
 * are then renamed over the target, so a concurrent reader (the client-half HMR
 * poll, or the next boot) never observes a truncated file. Falls back to an
 * in-place copy if the platform refuses the replace, and never leaves the temp
 * file behind.
 * @param dest - absolute destination path.
 * @param data - bytes to write.
 */
export function writeFileAtomic(dest, data) {
  const tmp = `${dest}.dsh-tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, dest)
    return
  } catch {
    try {
      copyFileSync(tmp, dest)
    } finally {
      try { rmSync(tmp, { force: true }) } catch {}
    }
  }
}

/** Whether the file at `p` already holds exactly `bytes` (missing/short → false). */
function sameFileContent(p, bytes) {
  try {
    return readFileSync(p).equals(bytes)
  } catch {
    return false
  }
}

// ── hot swap of the running host half ─────────────────────────────────────

/** Loader entry ids this package can own. */
const SELF_ENTRY_NAMES = ['dsh-remote']

/**
 * Find our own loader entry (by id, then by module specifier). Returns undefined
 * when the tree does not contain us (e.g. a test loader, or a renamed row).
 * @param loader - the cordis Loader service (`ctx.loader`).
 */
function findSelfEntry(loader) {
  let entries = []
  try {
    entries = [...(loader?.entries?.() ?? [])]
  } catch {
    return undefined
  }
  for (const want of SELF_ENTRY_NAMES) {
    const byId = entries.find((entry) => entry?.options?.id === want)
    if (byId) return byId
  }
  for (const want of SELF_ENTRY_NAMES) {
    const byName = entries.find((entry) => entry?.options?.name === want)
    if (byName) return byName
  }
  return undefined
}

/**
 * Drop Node's module caches for this package's own files, so the next import of
 * the plugin actually re-reads disk instead of handing back the cached module.
 * Both caches matter: the ESM `loadCache` (a plain Map on Node 22/23, a
 * `LoadCache extends Map` on Node 24 — hence the explicit `Map.prototype` calls)
 * and, for CJS modules pulled in through `import()`, `require.cache`.
 * @param loader - the cordis Loader service.
 * @param dir - package directory whose `lib/` to evict (defaults to this
 *   package's own install dir; overridable so the swap can be exercised against
 *   a fixture install).
 * @returns how many ESM entries were dropped.
 */
export function clearSelfModuleCache(loader, dir = selfDir()) {
  const libDir = path.join(dir, 'lib')
  const loadCache = loader?.internal?.loadCache
  const req = (() => {
    try { return createRequire(import.meta.url) } catch { return undefined }
  })()
  let cleared = 0
  for (const name of readdirSafe(libDir)) {
    if (!name.endsWith('.js')) continue
    const url = pathToFileURL(path.join(libDir, name)).href
    try {
      if (loadCache && Map.prototype.has.call(loadCache, url)) {
        Map.prototype.delete.call(loadCache, url)
        cleared += 1
      }
    } catch {}
    try {
      const file = fileURLToPath(url)
      if (req?.cache && req.cache[file]) delete req.cache[file]
    } catch {}
  }
  return cleared
}

/**
 * Swap the RUNNING host half to the code now on disk: clear the module caches
 * for our own files, dispose our loader entry (tools, JSON routes, SSH pools and
 * every `ctx.effect` disposer go with the fiber), then re-init it so `apply()`
 * runs again from the freshly imported module.
 *
 * Callers must not depend on this plugin after a successful reload — the fiber
 * that served the current request is gone. Schedule it (see
 * {@link scheduleSelfReload}) rather than awaiting it from a request handler.
 * @param loader - the cordis Loader service (`ctx.loader`).
 * @returns a small result object; never throws.
 */
export async function reloadSelf(loader) {
  const entry = findSelfEntry(loader)
  if (!entry) return { ok: false, reason: 'own loader entry not found' }
  try {
    const cleared = clearSelfModuleCache(loader)
    if (typeof entry._dispose === 'function') await entry._dispose()
    else if (typeof entry.dispose === 'function') await entry.dispose()
    else return { ok: false, reason: 'entry exposes no dispose hook' }
    await entry.init()
    return { ok: true, cleared }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

/**
 * Fire-and-forget {@link reloadSelf} after a short delay, so the caller can
 * finish answering an HTTP request (or an update check) before its own module is
 * torn down. Failures are swallowed: a failed swap leaves the running code in
 * place, which is the pre-hot-update behaviour, not a crash.
 * @param loader - the cordis Loader service.
 * @param delayMs - grace period before the swap (default 300 ms).
 * @returns true when the swap was scheduled.
 */
export function scheduleSelfReload(loader, delayMs = 300) {
  const timer = setTimeout(() => { void reloadSelf(loader).catch(() => {}) }, Math.max(0, delayMs))
  if (typeof timer.unref === 'function') timer.unref()
  return true
}

/** Write the persisted update-mode override (settings UI). */
export function persistUpdateMode(mode) {
  if (!['manual', 'auto', 'off'].includes(mode)) return false
  try {
    writeFileSync(path.join(selfDir(), 'update-mode'), mode)
    return true
  } catch {
    return false
  }
}

/** Read a persisted update-mode override, or null when absent/invalid. */
export function readUpdateMode() {
  try {
    const m = readFileSync(path.join(selfDir(), 'update-mode'), 'utf8').trim()
    return ['manual', 'auto', 'off'].includes(m) ? m : null
  } catch {
    return null
  }
}
