// Integration: run the real probe + install plan against a real host.
//
// Proves the deterministic deployment path outside unit doubles: the probe
// detects the actual environment, the verdict matches reality, and (optionally)
// a private-prefix install succeeds and is verified.
//
// Usage:
//   node scripts/integration-web-deploy.mjs --host <ip> --port <sshport> \
//     --user <u> --key <path> [--install] [--prefix <dir>]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import path from 'node:path'
import {
  buildProbeCommand, parseProbe, judgeProbe, buildInstallPlan, resolvePrefix, stepResult,
} from '../lib/web-deploy.js'

function arg(n, d = '') { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes('--' + n)

const host = arg('host'); const sshPort = Number(arg('port', '22'))
const username = arg('user', 'root'); const privateKeyPath = arg('key')
const doInstall = has('install'); const explicitPrefix = arg('prefix', '')
if (!host || !privateKeyPath) { console.error('need --host and --key'); process.exit(2) }

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`) }

const home = mkdtempSync(path.join(tmpdir(), 'deploy-it-'))
const root = path.join(home, 'remote-workspaces'); mkdirSync(root, { recursive: true })
writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
  list: [{ id: 'm-it', name: 'target', host, port: sshPort, username, password: '', privateKeyPath,
    passphrase: '', workspace: `/home/${username}`, useAgent: false, keyboardInteractive: false, hostKeyMode: 'accept-new' }],
  currentId: 'm-it',
}))
process.env.DSH_HOME = home

const mod = await import(`../lib/index.js?deploy=${Math.random()}`)
const routes = new Map()
const ctx = {
  effect: () => {},
  inject(names, cb) { if (names.every((n) => this.get(n))) cb(this) },
  get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
}
await mod.apply(ctx, {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '',
  shell: '', commandTimeoutMs: 60000, connectTimeoutMs: 20000, maxOutputChars: 200000, maxFileBytes: 0,
  hostKeyMode: 'accept-new', useAgent: false, keyboardInteractive: false, autoPush: false,
  auditLog: false, encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 60000,
  webInstallPrefix: explicitPrefix, webInstallVersion: '0.1.5-rc.2',
})

const route = routes.get('/dsh-remote/web-attach')
check('route is registered', !!route)

function call(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method; req.url = '/dsh-remote/web-attach'; req.headers = {}
  const res = { statusCode: 0, payload: '', setHeader() {}, writeHead(c) { this.statusCode = c }, end(c) { this.payload += c == null ? '' : String(c) } }
  return route.handler(req, res).then(() => ({ status: res.statusCode, json: JSON.parse(res.payload || '{}') }))
}

try {
  const probe = await call('POST', { action: 'probe', machineId: 'm-it' })
  check('probe answers', probe.status === 200 && probe.json.ok === true, probe.json.error || '')
  const f = probe.json.facts || {}
  console.log('  facts:', JSON.stringify({
    platform: f.platform, arch: f.arch, node: !!f.node, nodeV: f.nodeVersion,
    npm: !!f.npm, dsh: f.dsh, dshV: f.dshVersion, pty: f.ptyPrebuild, noOpen: f.noOpen, home: f.home,
  }))
  check('probe identified the platform', !!f.platform, f.platform)
  check('probe found node', !!f.node, f.nodeVersion)
  check('probe reported a pty verdict', f.ptyPrebuild === 'yes' || f.ptyPrebuild === 'no', f.ptyPrebuild)

  const v = probe.json.verdict || {}
  console.log('  verdict:', v.severity, '|', (v.findings || []).map((x) => `${x.severity}:${x.code}`).join(', '))
  check('verdict has findings for the UI', Array.isArray(v.findings) && v.findings.length > 0)

  // Ground truth comparison: does the verdict match the machine's real state?
  const ptyReal = f.ptyPrebuild
  const expectedBootable = ptyReal === 'yes'
  check('verdict agrees with the probed native-module fact',
    expectedBootable ? v.ok === true : v.ok === false,
    `pty=${ptyReal} verdict.ok=${v.ok}`)

  if (doInstall) {
    const install = await call('POST', { action: 'install', machineId: 'm-it', confirm: true })
    for (const s of (install.json.steps || [])) console.log(`  step ${s.id}: ${s.ok ? 'ok' : 'FAIL'} ${s.output ? '(' + s.output.slice(0, 120).replace(/\n/g, ' ') + ')' : ''}`)
    check('install succeeded and was verified', install.status === 200 && install.json.ok === true, install.json.error || install.json.command || '')
    if (install.json.command) console.log('  installed command:', install.json.command)
    // Re-probe: the machine record now carries the working command, so the
    // verdict must switch to healthy — this is what the user experiences.
    const again = await call('POST', { action: 'probe', machineId: 'm-it' })
    check('re-probe uses the installed command and reports usable',
      again.status === 200 && (again.json.verdict || {}).ok === true && !!again.json.command,
      `command=${again.json.command} ok=${(again.json.verdict || {}).ok}`)
  } else {
    // Dry run: show what WOULD happen, without changing the remote.
    const plan = buildInstallPlan({ facts: f, prefix: installPrefixFor(f, explicitPrefix), version: '0.1.5-rc.2' })
    console.log('  plan (not executed):')
    for (const s of plan.steps) console.log(`    ${s.id}: ${s.command.slice(0, 150)}`)
    check('an install plan was produced', plan.steps.length >= 4)
  }
} catch (err) {
  check('deploy flow completed', false, String((err && err.message) || err))
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}
function installPrefixFor(facts, explicit) { return resolvePrefix(facts, { prefix: explicit }) }

const failed = results.filter((r) => !r).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : 0)
