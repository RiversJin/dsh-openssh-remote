// Self-update + host-half hot swap.
//
// The pieces under test are the ones that can corrupt an install or lie to the
// UI: the atomic file replace (the browser half is hot-swapped and would serve a
// torn write), the byte-identical skip, the tarball version gate, the module
// cache clear, and the loader-entry re-init that makes a landed update actually
// run. Everything runs against a temp dir + a fabricated npm tarball, so no
// network and no real install are involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  applyUpdate,
  clearSelfModuleCache,
  diskVersion,
  gtVersion,
  LOADED_VERSION,
  reloadSelf,
  scheduleSelfReload,
  selfDir,
  writeFileAtomic,
} from '../lib/update.js'

// ── fabricated npm tarball (POSIX ustar, regular files only) ──────────────

/** One 512-byte ustar header for a regular file of `size` bytes. */
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('000644 \0', 100, 8, 'ascii') // mode
  h.write('000000 \0', 108, 8, 'ascii') // uid
  h.write('000000 \0', 116, 8, 'ascii') // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii') // mtime
  h.write('        ', 148, 8, 'ascii') // checksum placeholder
  h.write('0', 156, 1, 'ascii') // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

/** Build a gzipped tar whose entries live under `package/`. */
function makeTarball(files) {
  const chunks = []
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    chunks.push(tarHeader('package/' + rel, data.length), data)
    const pad = Math.ceil(data.length / 512) * 512 - data.length
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive
  return gzipSync(Buffer.concat(chunks))
}

/** A fetch stand-in serving the registry endpoint + one tarball. */
function makeFetch({ version, tarball }) {
  return async (url) => {
    if (String(url).endsWith('/latest')) {
      return { ok: true, status: 200, json: async () => ({ version }) }
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
    }
  }
}

/** A temp install dir seeded with an older version of the package. */
function makeInstall({ index = 'OLD INDEX', client = 'OLD CLIENT', version = '0.1.0' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-update-'))
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'lib', 'index.js'), index)
  writeFileSync(path.join(dir, 'lib', 'client.js'), client)
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-remote', version }, null, 2))
  return dir
}

// The host half carries a sanity gate (>= 100 bytes) so a truncated download can
// never replace a working lib/index.js — the fixtures must clear it.
const NEW_INDEX = '// NEW INDEX\n' + 'x'.repeat(180) + '\n'
const NEW_FILES = {
  'lib/index.js': NEW_INDEX,
  'lib/client.js': '// NEW CLIENT\n' + 'y'.repeat(180) + '\n',
  'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.2.0' }, null, 2),
}

// ── applyUpdate ──────────────────────────────────────────────────────────

test('applyUpdate installs the tarball and marks the version', async () => {
  const dir = makeInstall()
  try {
    const res = await applyUpdate('0.2.0', {
      dir,
      fetchImpl: makeFetch({ version: '0.2.0', tarball: makeTarball(NEW_FILES) }),
    })
    assert.equal(res.ok, true)
    assert.equal(res.to, '0.2.0')
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), NEW_INDEX)
    assert.equal(readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8'), NEW_FILES['lib/client.js'])
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.2.0')
    // The marker is what tells the UI a swap is still owed.
    assert.equal(readFileSync(path.join(dir, '.dsh-remote-updated'), 'utf8'), '0.2.0')
    assert.deepEqual(res.changed.sort(), ['lib/client.js', 'lib/index.js', 'package.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate leaves no temp files and skips byte-identical files', async () => {
  const dir = makeInstall()
  const fetchImpl = makeFetch({ version: '0.2.0', tarball: makeTarball(NEW_FILES) })
  try {
    await applyUpdate('0.2.0', { dir, fetchImpl })
    const first = statSync(path.join(dir, 'lib', 'index.js')).mtimeMs

    // Re-applying the same version must be a no-op on content: churning mtimes
    // would make the client-half HMR re-hash (and the host half reload) for
    // nothing.
    const again = await applyUpdate('0.2.0', { dir, fetchImpl })
    assert.deepEqual(again.changed, [])
    assert.equal(statSync(path.join(dir, 'lib', 'index.js')).mtimeMs, first)

    const leftovers = readdirSync(path.join(dir, 'lib')).filter((n) => n.includes('dsh-tmp'))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.dsh-remote-update-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate refuses a version mismatch without touching the install', async () => {
  const dir = makeInstall()
  try {
    // Tarball claims 0.3.0 while 0.2.0 was requested.
    const wrong = makeTarball({ ...NEW_FILES, 'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.3.0' }, null, 2) })
    await assert.rejects(
      () => applyUpdate('0.2.0', { dir, fetchImpl: makeFetch({ version: '0.3.0', tarball: wrong }) }),
      /version mismatch/,
    )
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), 'OLD INDEX')
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.1.0')
    assert.equal(existsSync(path.join(dir, '.dsh-remote-updated')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate surfaces a failed download as update failed', async () => {
  const dir = makeInstall()
  try {
    await assert.rejects(
      () => applyUpdate('0.2.0', { dir, fetchImpl: async () => ({ ok: false, status: 500 }) }),
      /update failed: download failed \(HTTP 500\)/,
    )
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), 'OLD INDEX')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic replaces content and cleans up its temp file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-atomic-'))
  try {
    const dest = path.join(dir, 'client.js')
    writeFileSync(dest, 'v1')
    writeFileAtomic(dest, Buffer.from('v2'))
    assert.equal(readFileSync(dest, 'utf8'), 'v2')
    assert.deepEqual(readdirSync(dir), ['client.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── loaded vs on-disk version ────────────────────────────────────────────

test('LOADED_VERSION is the version of the code in this process', () => {
  // Import-time snapshot: readVersion() reads package.json off disk, so after an
  // update lands the two legitimately differ. `current` must never be the disk
  // value or the UI cannot tell "applied" from "active".
  assert.match(LOADED_VERSION, /^\d+\.\d+\.\d+/)
  assert.match(diskVersion(), /^\d+\.\d+\.\d+/)
})

test('gtVersion orders dotted versions', () => {
  assert.equal(gtVersion('0.8.10', '0.8.9'), true)
  assert.equal(gtVersion('0.8.9', '0.8.10'), false)
  assert.equal(gtVersion('0.8.9', '0.8.9'), false)
  assert.equal(gtVersion('1.0.0', '0.9.9'), true)
})

// ── host-half hot swap ───────────────────────────────────────────────────

/** A loader stub whose loadCache holds this package's own module URLs. */
function makeLoader() {
  const loadCache = new Map()
  for (const name of ['index.js', 'update.js']) {
    loadCache.set(pathToFileURL(path.join(selfDir(), 'lib', name)).href, { stub: true })
  }
  return { internal: { loadCache } }
}

test('clearSelfModuleCache drops this package own modules only', () => {
  const loader = makeLoader()
  const foreign = pathToFileURL(path.join(selfDir(), 'lib', 'not-a-module.js')).href
  loader.internal.loadCache.set(foreign, { stub: true })

  const cleared = clearSelfModuleCache(loader)
  assert.equal(cleared, 2)
  assert.equal(Map.prototype.has.call(loader.internal.loadCache, pathToFileURL(path.join(selfDir(), 'lib', 'index.js')).href), false)
  assert.equal(Map.prototype.has.call(loader.internal.loadCache, foreign), true)
})

test('clearSelfModuleCache tolerates a loader with no loadCache', () => {
  assert.equal(clearSelfModuleCache(undefined), 0)
  assert.equal(clearSelfModuleCache({}), 0)
})

test('clearSelfModuleCache honours an explicit package dir', () => {
  // The swap is exercised against a fixture install in the E2E script, so the
  // lib/ to evict must be overridable rather than pinned to selfDir().
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-clear-'))
  try {
    mkdirSync(path.join(dir, 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const a = 1\n')
    const url = pathToFileURL(path.join(dir, 'lib', 'index.js')).href
    const loadCache = new Map([[url, { stub: true }]])
    assert.equal(clearSelfModuleCache({ internal: { loadCache } }, dir), 1)
    assert.equal(Map.prototype.has.call(loadCache, url), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A loader stub exposing one dsh-remote entry, recording dispose/init calls. */
function makeEntryLoader(overrides = {}) {
  const calls = []
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote' },
    _dispose: async () => { calls.push('dispose') },
    init: async () => { calls.push('init') },
    ...overrides,
  }
  return { loader: { internal: { loadCache: new Map() }, entries: () => [entry] }, entry, calls }
}

test('reloadSelf disposes then re-inits our own entry', async () => {
  const { loader, calls } = makeEntryLoader()
  const res = await reloadSelf(loader)
  assert.equal(res.ok, true)
  assert.deepEqual(calls, ['dispose', 'init'])
})

test('reloadSelf reports a missing entry instead of throwing', async () => {
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [] })
  assert.equal(res.ok, false)
  assert.match(res.reason, /not found/)
})

test('reloadSelf does not init when dispose fails', async () => {
  const { loader, calls } = makeEntryLoader({
    _dispose: async () => { calls.push('dispose'); throw new Error('boom') },
  })
  const res = await reloadSelf(loader)
  assert.equal(res.ok, false)
  assert.match(res.reason, /boom/)
  assert.deepEqual(calls, ['dispose'])
})

test('reloadSelf reports a dispose-less entry', async () => {
  const { loader } = makeEntryLoader({ _dispose: undefined, dispose: undefined })
  const res = await reloadSelf(loader)
  assert.equal(res.ok, false)
  assert.match(res.reason, /dispose/)
})

test('scheduleSelfReload swaps after the grace period', async () => {
  const { loader, calls } = makeEntryLoader()
  assert.equal(scheduleSelfReload(loader, 0), true)
  assert.deepEqual(calls, []) // nothing may happen while the caller still answers
  await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(calls, ['dispose', 'init'])
})
