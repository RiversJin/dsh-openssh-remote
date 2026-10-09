// End-to-end proof of the host-half hot swap, against the REAL cordis loader.
//
// This is the step the unit tests cannot cover: whether disposing and re-init'ing
// a loader entry actually re-imports the plugin from disk (Node caches ESM
// modules by URL, so a naive reload silently hands back the old module). This
// script mounts a plugin module from a temp dir, rewrites that module on disk,
// runs the exact swap the plugin performs (clearSelfModuleCache → _dispose →
// init), and asserts the running code changed.
//
// It also re-asserts the "plain restart path already works" baseline, so a
// failure here cannot be blamed on the harness.
//
// Run: node scripts/hotswap-e2e.mjs
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { clearSelfModuleCache } from '../lib/update.js'

// The loader is a peer of the Harness, not a dependency of this plugin, so it is
// resolved the way the real process resolves it: first from the profile that has
// this plugin installed, then from the global dsh installation.
const require_ = createRequire(import.meta.url)
const LOADER_ROOTS = [
  path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'profiles', 'web'),
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
]

async function importLoader() {
  for (const root of LOADER_ROOTS) {
    if (!root) continue
    try {
      const resolved = require_.resolve('@deepseek-ai/cordis-plugin-loader', { paths: [root] })
      return await import(pathToFileURL(resolved).href)
    } catch {
      // try the next anchor
    }
  }
  throw new Error(`cannot resolve @deepseek-ai/cordis-plugin-loader from: ${LOADER_ROOTS.join(' | ')}`)
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The plugin body we mount; `TAG` is what we rewrite to prove a re-import.
 *  Observable state lives on globalThis because the loader hands the plugin host
 *  the `apply` function itself (the module namespace is not reachable from the
 *  fiber), and a module-level variable would be re-created per import anyway. */
const pluginBody = (tag) => `// fixture plugin, tag=${tag}
globalThis.__FX = globalThis.__FX || { applied: 0, disposed: 0, tags: [] }
globalThis.__FX.tags.push(${JSON.stringify(tag)})
export const name = 'fixture-plugin'
export function apply(ctx) {
  globalThis.__FX.applied += 1
  ctx.effect(() => () => { globalThis.__FX.disposed += 1 }, 'fixture.dispose')
}
`

async function main() {
  const { Loader } = await importLoader()

  // ── fixture "install" on disk ──────────────────────────────────────────
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-remote-e2e-'))
  const libDir = path.join(dir, 'lib')
  mkdirSync(libDir, { recursive: true })
  const indexPath = path.join(libDir, 'index.js')
  const clientPath = path.join(libDir, 'client.js')
  writeFileSync(indexPath, pluginBody('v1'))
  writeFileSync(clientPath, 'client-v1')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-openssh-remote', version: '0.1.0' }, null, 2))

  try {
    // Mount it exactly the way a profile does: by absolute path specifier.
    const specifier = pathToFileURL(indexPath).href
    const ctx = new Context()
    // Same boot shape as dsh-app-boot: the Loader is a Service, so it creates its
    // own context and is reached through ctx.get('loader'). Its root tree is
    // in-memory (write() is a no-op), so nothing here touches a config file.
    ctx.baseUrl = pathToFileURL(dir + path.sep).href
    await ctx.plugin(Loader)
    const loader = ctx.get('loader')

    const entry = await loader.create({ name: specifier, id: 'dsh-openssh-remote' })
    await loader.await()

    const loaded = loader.resolve('dsh-openssh-remote')
    const fx = () => globalThis.__FX
    check('entry mounts and apply() runs', fx()?.tags?.join(',') === 'v1' && fx()?.applied === 1,
      `tags=[${fx()?.tags}] applied=${fx()?.applied}`)

    // ── baseline: the ordinary restart path ─────────────────────────────
    // A fresh process would import the new bytes. Prove the fixture actually
    // changes when the module is imported anew, so a later failure is the swap's
    // fault and not the fixture's.
    writeFileSync(indexPath, pluginBody('v2'))
    const freshTag = (await import(`${specifier}?probe=${Date.now()}`)) && globalThis.__FX.tags.at(-1)
    check('rewriting the module changes what a fresh import sees', freshTag === 'v2', `tag=${freshTag}`)

    // ── the swap under test: clear caches, dispose, re-init ──────────────
    const cleared = clearSelfModuleCache(loader, dir)
    check('clearSelfModuleCache drops this package own modules', cleared >= 1, `cleared=${cleared}`)

    const appliedBefore = fx().applied
    const disposedBefore = fx().disposed
    await loaded._dispose()
    await loaded.init()
    await loader.await()

    check('the running module is now the new code (not a cached module)', fx().tags.at(-1) === 'v2', `tags=[${fx().tags}]`)
    check('the new code was actually applied', fx().applied === appliedBefore + 1, `applied ${appliedBefore} → ${fx().applied}`)
    check('the old fiber was disposed (effects released)', fx().disposed === disposedBefore + 1, `disposed ${disposedBefore} → ${fx().disposed}`)
    check('the loader entry survived the swap', loader.resolve('dsh-openssh-remote') === loaded)

    // ── negative control: without clearing the cache the swap is a no-op ──
    // This is the whole reason clearSelfModuleCache exists. ESM caches modules by
    // URL, so dispose+init alone re-imports the SAME cached module and the plugin
    // keeps running the old code while reporting a successful reload. If this
    // control ever starts "passing" (picking up v3 unaided), the cache clear has
    // become redundant — and if it fails to hold v2, the clear is not the reason
    // the swap works and something else is.
    writeFileSync(indexPath, pluginBody('v3'))
    {
      const appliedBefore = fx().applied
      await loaded._dispose()
      await loaded.init()
      await loader.await()
      check('WITHOUT clearing the cache the old code still runs (control)', fx().tags.at(-1) === 'v2',
        `tags=[${fx().tags}] applied ${appliedBefore} → ${fx().applied}`)
    }
    // …and clearing it is what actually moves the code forward.
    clearSelfModuleCache(loader, dir)
    await loaded._dispose()
    await loaded.init()
    await loader.await()
    check('clearing the cache is what advances the running code to v3', fx().tags.at(-1) === 'v3', `tags=[${fx().tags}]`)

    // ── failure mode: a broken on-disk module must be reported, not fatal ─
    writeFileSync(indexPath, 'export const name = ; // syntax error\n')
    clearSelfModuleCache(loader, dir)
    await loaded._dispose()
    let swapError = null
    try {
      await loaded.init()
    } catch (err) {
      swapError = err
    }
    check('a corrupt on-disk module fails the swap loudly', swapError !== null, String(swapError && swapError.message).slice(0, 60))

    // The process itself must still be alive and usable.
    check('the process is still usable after a failed swap', typeof loader.entries === 'function')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(2)
})
