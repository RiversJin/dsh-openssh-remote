// Verify orw_deploy_probe actually works when invoked as a TOOL (not just that it
// is registered): drive the plugin, grab the registered tool, call execute(), and
// check the report it produces against a real machine.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const host = process.argv[2] || '9.134.186.191'
const sshPort = Number(process.argv[3] || 36000)
const username = process.argv[4] || 'jimmycppliu'
const key = process.argv[5] || (process.env.USERPROFILE + '\\.ssh\\id_rsa')

const home = mkdtempSync(path.join(tmpdir(), 'probe-tool-'))
process.env.DSH_HOME = home
mkdirSync(path.join(home, 'openssh-remote-workspaces'), { recursive: true })
// The tool resolves its target through `requireBinding`, which (correctly)
// refuses without a bound remote workspace. So construct the same on-disk state
// a real `orw_connect` + `orw_pick_workspace` leaves behind: a mirror directory
// carrying `.dsh-openssh-remote-meta.json` (that file is what resolveMirror reads).
const remoteWs = `/home/${username}`
writeFileSync(path.join(home, 'openssh-remote-workspaces', 'machines.json'), JSON.stringify({
  list: [{ id: 'm1', name: 't', host, port: sshPort, username, password: '', privateKeyPath: key,
    passphrase: '', workspace: remoteWs, useAgent: false, keyboardInteractive: false, hostKeyMode: 'accept-new' }],
  currentId: 'm1',
}))
const mirrorDir = path.join(home, 'openssh-remote-workspaces', `t-${username}-${sshPort}`, 'ws')
mkdirSync(mirrorDir, { recursive: true })
writeFileSync(path.join(mirrorDir, '.dsh-openssh-remote-meta.json'), JSON.stringify({
  host, port: sshPort, username, remotePath: remoteWs, alias: '',
}))

const mod = await import('../lib/index.js')
const tools = new Map()
const ctx = {
  effect: () => {},
  inject: () => {},
  get: () => undefined,
  tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
  systemPrompt: { section: () => {} },
}
await mod.apply(ctx, {
  host, port: sshPort, username, password: '', privateKeyPath: key, passphrase: '', workspace: remoteWs,
  shell: '', commandTimeoutMs: 60000, connectTimeoutMs: 20000, maxOutputChars: 200000, maxFileBytes: 0,
  hostKeyMode: 'accept-new', useAgent: false, keyboardInteractive: false, autoPush: false,
  auditLog: false, encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 60000,
})

/** The ToolRunContext a session bound to this mirror would supply. */
const exec = { agent: { session: { header: { cwd: mirrorDir } } } }

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  - ' + d : ''}`) }

try {
  const tool = tools.get('orw_deploy_probe')
  check('orw_deploy_probe is registered as a tool', !!tool)
  // It declares no params, but the framework fills in defaults for an empty
  // schema object, so assert the INTENT (nothing is required of the caller)
  // rather than that the object is literally empty.
  check('it requires no parameters from the caller (a pure check)',
    !tool || Object.values(tool.parameters || {}).every((p) => !p || !p.required))
  check('its description says it is read-only', !tool || /READ-ONLY/.test(tool.description))
  check('its description steers installation to the settings UI', !tool || /settings UI|never installs/.test(tool.description))

  const out = await tool.execute({}, exec)
  const text = String((out && out.text) || '')
  console.log('\n--- tool output ---\n' + text + '\n-------------------\n')
  check('it produced a report', text.length > 100)
  check('the report names the remote', text.includes(host))
  check('the report states a verdict', /verdict: (ok|warn|blocker)/.test(text))
  check('the report includes the native-module fact', /native-module/.test(text))
  check('the report includes findings', /findings:/.test(text))
  // The whole point: on this machine the probe must flag the broken dsh.
  check('it detected the real problem on this machine (node-pty / old dsh)',
    /blocker/.test(text) && /pty|native-module|无法启动/.test(text),
    text.split('\n').find((l) => l.includes('blocker')) || '')
} catch (err) {
  check('probe tool ran', false, String((err && err.message) || err))
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((r) => !r).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : 0)
