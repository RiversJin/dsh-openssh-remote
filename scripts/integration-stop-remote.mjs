// Deterministic leak test: start an attach against a real host, close it with
// stopRemote, then check the REMOTE for a surviving process.
//
// This is the check that matters: the earlier `stopRemote` bug (pkill on a log
// path that never appears in argv) was invisible to unit tests and only showed up
// as a process still listening afterwards.
//
// Usage: node scripts/integration-stop-remote.mjs --host <ip> --port <p> --user <u> --key <path> --command <remote dsh>
import { WebAttach } from '../lib/web-attach.js'
import { SshPool } from '../lib/pool.js'

function arg(n, d = '') { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const host = arg('host'); const sshPort = Number(arg('port', '22'))
const username = arg('user', 'root'); const privateKeyPath = arg('key')
const command = arg('command', 'dsh'); const dshHome = arg('dshHome', '')
if (!host || !privateKeyPath) { console.error('need --host and --key'); process.exit(2) }

const pool = new SshPool({
  host, port: sshPort, username, password: '', privateKeyPath, passphrase: '', workspace: '',
  shell: '', connectTimeoutMs: 20000, commandTimeoutMs: 30000, maxOutputChars: 200000,
  maxFileBytes: 0, hostKeyMode: 'accept-new', useAgent: false, keyboardInteractive: false, encoding: 'utf-8',
}, { knownHostsFile: () => '' })

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  - ' + d : ''}`) }

/** Count our dsh processes on the remote, ignoring the checker's own shell. */
async function remoteCount() {
  const marker = 'LEAKCOUNT:'
  const script = [
    'C=0',
    'for pid in $(pgrep -x node 2>/dev/null)',
    'do',
    `  CMD=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)`,
    `  case "$CMD" in *dshprefix*|*dsh-openssh-remote*|*"--profile web"*) C=$((C+1));; esac`,
    'done',
    `echo "${marker}$C"`,
  ].join('\n')
  const res = await pool.exec(script, { timeoutMs: 30000 })
  const m = new RegExp(marker + '(\\d+)').exec(String(res && res.stdout))
  return m ? Number(m[1]) : -1
}

let attach
try {
  const before = await remoteCount()
  check('baseline counted', before >= 0, `before=${before}`)

  attach = new WebAttach({ localPortStart: 30970 })
  const info = await attach.open({ pool, machineId: 'leak', command, dshHome, waitSeconds: 60 })
  check('attach opened', !!info.url)
  check('the launch reported a PID (the only reliable handle)', attach.remotePid > 0, `pid=${attach.remotePid}`)
  const during = await remoteCount()
  check('the remote process exists while attached', during === before + 1, `during=${during} before=${before}`)

  await attach.close({ stopRemote: true, exec: (c) => pool.exec(c, { timeoutMs: 20000 }) })
  // The kill is asynchronous on the remote; give init a moment to reap it.
  await new Promise((r) => setTimeout(r, 3000))
  const after = await remoteCount()
  check('stopRemote actually terminated the remote process', after === before,
    `after=${after} before=${before} (leaked=${after - before})`)

  // Assert THIS session's log is gone, not that no logs exist: a machine may
  // carry stale logs from an earlier run (as this one did), and "zero logs" would
  // then fail for a reason that has nothing to do with this session.
  const thisLog = attach.logPath
  check('the session recorded its log path', /^\.dsh-openssh-remote-web-.+\.log$/.test(thisLog), thisLog)
  const gone = await pool.exec(`test -f "$HOME/${thisLog}" && echo PRESENT || echo GONE`, { timeoutMs: 20000 })
  check('this session\'s log was removed by stopRemote',
    String((gone && gone.stdout) || '').trim() === 'GONE',
    `result=${String((gone && gone.stdout) || '').trim()}`)
} catch (err) {
  check('leak flow completed', false, String((err && err.message) || err))
} finally {
  try { if (attach) await attach.close({ stopRemote: true, exec: (c) => pool.exec(c, { timeoutMs: 20000 }) }) } catch {}
  try { pool.close() } catch {}
}
const failed = results.filter((r) => !r).length
console.log(`--- ${results.length - failed}/${results.length} checks passed ---`)
process.exit(failed ? 1 : 0)
