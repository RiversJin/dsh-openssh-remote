// Issue #46 follow-up — remote DSH deployment probe & installer.
//
// The whole point of this module is that it is DETERMINISTIC: detection and
// installation are pure functions over shell output, so they can be tested
// exhaustively without a remote machine, and a model is never needed to answer
// "why can't I connect".
//
// The verdicts below are written against the two failures MEASURED on a real
// host while building issue #46:
//   • dsh 0.1.0-rc.6 → node-pty@1.1.0 ships no linux-x64 prebuild → `dsh web`
//     cannot boot at all;
//   • the same version does not know `--no-open`.
// A probe that cannot detect those would have no reason to exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProbeCommand, parseProbe, versionAtLeast, judgeProbe,
  buildInstallPlan, resolvePrefix, stepResult,
  PTY_FIXED_VERSION, DEFAULT_PREFIX_SUFFIX,
} from '../lib/web-deploy.js'

// ── probe output parsing ────────────────────────────────────────────────────

const goodOutput = [
  'P_OS=Linux',
  'P_ARCH=x64',
  'P_HOME=/home/dev',
  'P_NODE=/usr/bin/node',
  'P_NODE_V=v22.23.1',
  'P_NPM=/usr/bin/npm',
  'P_NPM_V=12.0.2',
  'P_DSH=/usr/local/bin/dsh',
  'P_DSH_V=0.2.0-rc.2',
  'P_DSH_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh',
  'P_PTY=yes',
  'P_NOOPEN=yes',
  'P_WRITABLE=parent:yes',
].join('\n')

test('parses a healthy probe', () => {
  const f = parseProbe(goodOutput)
  assert.equal(f.platform, 'Linux')
  assert.equal(f.arch, 'x64')
  assert.equal(f.windows, false)
  assert.equal(f.node, '/usr/bin/node')
  assert.equal(f.nodeVersion, 'v22.23.1')
  assert.equal(f.dshVersion, '0.2.0-rc.2')
  assert.equal(f.ptyPrebuild, 'yes')
  assert.equal(f.noOpen, 'yes')
  assert.equal(f.home, '/home/dev')
})

test('missing keys stay empty rather than defaulting (so "absent" ≠ "unknown")', () => {
  const f = parseProbe('P_OS=Linux\nP_ARCH=x64\n')
  assert.equal(f.node, '')
  assert.equal(f.dsh, '')
  assert.equal(f.ptyPrebuild, '')
})

test('tolerates noisy output around the markers', () => {
  const f = parseProbe('bash: warning: something\nP_OS=Linux\nP_PTY=no\ntrailing noise\n')
  assert.equal(f.platform, 'Linux')
  assert.equal(f.ptyPrebuild, 'no')
})

test('recognizes Windows remotes through their emulated uname', () => {
  for (const p of ['MINGW64_NT-10.0', 'MSYS_NT-10.0-19045', 'CYGWIN_NT-10.0', 'Windows']) {
    const f = parseProbe(`P_OS=${p}\nP_ARCH=x64\n`)
    assert.equal(f.windows, true, `${p} must count as Windows`)
  }
})

test('the probe is read-only: it never installs, writes or deletes', () => {
  const cmd = buildProbeCommand({ prefix: '/home/dev/.dsh-remote/dsh' })
  // The only permitted write-ish verb is a printf into a variable we never use
  // for mutation; there must be no install/mkdir/rm/mv/curl/wget/eval.
  for (const forbidden of ['npm install', 'mkdir', 'rm ', 'mv ', 'curl', 'wget', 'git clone', 'sudo']) {
    assert.ok(!cmd.includes(forbidden), `probe must not contain ${JSON.stringify(forbidden)}`)
  }
  assert.match(cmd, /P_PTY=/, 'probe reports the native-module fact')
})

test('the probe uses newlines, not ; -joined statements (the do; hazard)', () => {
  const cmd = buildProbeCommand()
  assert.ok(cmd.includes('\n'), 'multiline form avoids the POSIX do; failure mode')
  assert.ok(!/;\s*then/.test(cmd), 'must not emit `; then`')
})

// ── version comparison ──────────────────────────────────────────────────────

test('versionAtLeast compares dotted prerelease versions', () => {
  assert.equal(versionAtLeast('0.1.5-rc.2', '0.1.5-rc.2'), true)
  assert.equal(versionAtLeast('0.2.0-rc.2', '0.1.5-rc.2'), true)
  assert.equal(versionAtLeast('0.1.0-rc.6', '0.1.5-rc.2'), false)
  assert.equal(versionAtLeast('1.0.0', '0.9.9'), true)
  assert.equal(versionAtLeast('', '0.1.0'), false, 'unknown version is not "at least"')
  assert.equal(versionAtLeast('v0.2.0', '0.1.5'), true, 'leading v is tolerated')
})

// ── verdicts ────────────────────────────────────────────────────────────────

const healthy = parseProbe(goodOutput)

test('a healthy remote yields no blockers and selects the installed dsh', () => {
  const v = judgeProbe(healthy)
  assert.equal(v.ok, true)
  assert.equal(v.severity, 'ok')
  assert.equal(v.useCommand, '/usr/local/bin/dsh')
})

// The exact measured failure this feature exists for.
test('detects the node-pty gap that makes `dsh web` unbootable on Linux', () => {
  const facts = parseProbe([
    'P_OS=Linux', 'P_ARCH=x64', 'P_HOME=/root',
    'P_NODE=/usr/bin/node', 'P_NODE_V=v22.23.1',
    'P_NPM=/usr/bin/npm', 'P_NPM_V=12.0.2',
    'P_DSH=/usr/local/bin/dsh', 'P_DSH_V=0.1.0-rc.6',
    'P_PTY=no', 'P_NOOPEN=no',
  ].join('\n'))
  const v = judgeProbe(facts)
  assert.equal(v.ok, false, 'a bootable web surface is required to connect')
  const pty = v.findings.find((x) => x.code === 'PTY_MISSING')
  assert.ok(pty, 'must report the native-module blocker')
  assert.equal(pty.severity, 'blocker')
  assert.match(pty.summary, /0\.1\.0-rc\.6/, 'must name the affected version')
  assert.match(pty.fix, new RegExp(PTY_FIXED_VERSION.replace(/\./g, '\\.')), 'must name the fix version')
  assert.equal(v.useCommand, '', 'an unbootable dsh must not be chosen')
  assert.equal(v.canAutoInstall, true, 'node+npm present means we can fix it')
})

test('an old dsh flag difference is informational, not a blocker', () => {
  const facts = parseProbe([
    'P_OS=Linux', 'P_ARCH=x64', 'P_NODE=/usr/bin/node', 'P_NPM=/usr/bin/npm',
    'P_DSH=/usr/local/bin/dsh', 'P_DSH_V=0.1.0-rc.6', 'P_PTY=yes', 'P_NOOPEN=no',
  ].join('\n'))
  const v = judgeProbe(facts)
  assert.equal(v.ok, true, 'WebAttach already retries without --no-open')
  const flag = v.findings.find((x) => x.code === 'OLD_FLAG_SET')
  assert.equal(flag.severity, 'info')
  // A missing flag must NOT disqualify the dsh: WebAttach retries without it, so
  // telling the user to reinstall would be wrong.
  assert.equal(v.useCommand, '/usr/local/bin/dsh')
})

// ── a previously deployed dsh must be recognized ────────────────────────────
// Without this, a successful deployment would be invisible to the next probe,
// which would keep reporting the old broken PATH dsh.

const outputWithInstalled = (installedPty, installedWeb) => [
  'P_OS=Linux', 'P_ARCH=x64', 'P_HOME=/home/dev',
  'P_NODE=/usr/bin/node', 'P_NPM=/usr/bin/npm',
  // PATH dsh is the broken one the deployment was meant to replace.
  'P_DSH=/usr/local/bin/dsh', 'P_DSH_V=0.1.0-rc.6', 'P_PTY=no', 'P_NOOPEN=no',
  'P_INSTALLED=yes', 'P_INSTALLED_V=0.1.5-rc.2',
  `P_INSTALLED_PTY=${installedPty}`, `P_INSTALLED_WEB=${installedWeb}`,
].join('\n')

const INSTALLED_CMD = '/home/dev/.dsh-remote/dsh/node_modules/.bin/dsh'

test('a verified deployment is chosen and clears the PATH dsh blocker', () => {
  const facts = parseProbe(outputWithInstalled('yes', 'yes'))
  const v = judgeProbe(facts, { installedCommand: INSTALLED_CMD })
  assert.equal(v.ok, true, 'the user can connect now, so the old dsh is not a blocker')
  assert.equal(v.useCommand, INSTALLED_CMD, 'the deployed build wins over the broken PATH one')
  assert.ok(v.findings.some((x) => x.code === 'INSTALLED_OK' && x.severity === 'ok'))
})

test('a deployment that no longer verifies does not clear the blocker', () => {
  for (const [pty, web] of [['no', 'yes'], ['yes', 'no'], ['no', 'no']]) {
    const facts = parseProbe(outputWithInstalled(pty, web))
    const v = judgeProbe(facts, { installedCommand: INSTALLED_CMD })
    assert.equal(v.ok, false, `pty=${pty} web=${web} must stay blocked`)
    assert.equal(v.useCommand, '', 'an unusable build must not be selected')
    assert.ok(v.findings.some((x) => x.code === 'INSTALLED_UNUSABLE' && x.severity === 'warn'))
  }
})

test('a deployment that vanished is reported as such, not as a failure', () => {
  const facts = parseProbe(outputWithInstalled('no', 'no').replace('P_INSTALLED=yes', 'P_INSTALLED=no'))
  const v = judgeProbe(facts, { installedCommand: INSTALLED_CMD })
  assert.ok(v.findings.some((x) => x.code === 'INSTALLED_MISSING' && x.severity === 'info'))
})

test('with no recorded deployment the PATH dsh is used as before', () => {
  const v = judgeProbe(healthy)
  assert.equal(v.useCommand, '/usr/local/bin/dsh')
  assert.equal(v.findings.some((x) => x.code.startsWith('INSTALLED_')), false)
})

test('missing node/npm blocks auto-install and says why', () => {
  const facts = parseProbe('P_OS=Linux\nP_ARCH=x64\nP_HOME=/root\nP_DSH=\nP_NPM=\n')
  const v = judgeProbe(facts)
  assert.equal(v.canAutoInstall, false)
  assert.ok(v.findings.some((x) => x.code === 'NO_NODE' && x.severity === 'blocker'))
  assert.ok(v.findings.some((x) => x.code === 'NO_NPM' && x.severity === 'blocker'))
})

test('no dsh at all is informational: it can be installed', () => {
  const facts = parseProbe('P_OS=Linux\nP_ARCH=x64\nP_NODE=/usr/bin/node\nP_NPM=/usr/bin/npm\nP_DSH=\n')
  const v = judgeProbe(facts)
  assert.equal(v.ok, true)
  assert.equal(v.canAutoInstall, true)
  assert.equal(v.useCommand, '')
  assert.ok(v.findings.some((x) => x.code === 'NO_DSH' && x.severity === 'info'))
})

test('a Windows remote is a warning and is not auto-installed', () => {
  const facts = parseProbe('P_OS=MINGW64_NT-10.0\nP_ARCH=x64\nP_NODE=/c/node\nP_NPM=/c/npm\nP_PTY=no\n')
  const v = judgeProbe(facts)
  assert.equal(facts.windows, true)
  // pty=no must NOT be reported as the Linux node-pty blocker on Windows.
  assert.equal(v.findings.some((x) => x.code === 'PTY_MISSING'), false)
  assert.ok(v.findings.some((x) => x.code === 'WINDOWS_REMOTE' && x.severity === 'warn'))
  assert.equal(v.canAutoInstall, false, 'the install plan targets a POSIX shell')
})

test('an installed command is only trusted once its facts verify it', () => {
  const cmd = '/home/dev/.dsh-remote/dsh/node_modules/.bin/dsh'
  // Recorded but NOT probed as usable: the healthy PATH dsh is used instead.
  const v1 = judgeProbe(healthy, { installedCommand: cmd })
  assert.equal(v1.useCommand, '/usr/local/bin/dsh',
    'a recorded path alone is not proof: the build must verify')
  // Recorded AND verified: it wins.
  const v2 = judgeProbe(parseProbe(outputWithInstalled('yes', 'yes')), { installedCommand: cmd })
  assert.equal(v2.useCommand, cmd)
})

test('an unreadable platform is reported instead of assumed', () => {
  const v = judgeProbe(parseProbe('P_OS=unknown\nP_PTY=\n'))
  assert.ok(v.findings.some((x) => x.code === 'PLATFORM_UNKNOWN'))
})

// ── install plan ────────────────────────────────────────────────────────────

test('resolvePrefix prefers explicit > $HOME > /tmp', () => {
  assert.equal(resolvePrefix({ home: '/home/dev' }, { prefix: '/opt/x' }), '/opt/x')
  assert.equal(resolvePrefix({ home: '/home/dev' }), `/home/dev/${DEFAULT_PREFIX_SUFFIX}`)
  assert.equal(resolvePrefix({ home: '/home/dev/' }), `/home/dev/${DEFAULT_PREFIX_SUFFIX}`, 'no double slash')
  assert.equal(resolvePrefix({}), `/tmp/${DEFAULT_PREFIX_SUFFIX}`)
})

test('the install plan is private-prefix based and never global', () => {
  const { steps, command } = buildInstallPlan({ facts: healthy, prefix: '/home/dev/.dsh-remote/dsh' })
  const all = steps.map((s) => s.command).join('\n')
  assert.ok(!/\s-g\s|\s--global\s/.test(all), 'a global install would touch the user PATH and system prefix')
  assert.ok(!all.includes('sudo'), 'never escalate privileges on the user\'s behalf')
  assert.match(all, /--prefix/, 'must install into the private prefix')
  assert.equal(command, '/home/dev/.dsh-remote/dsh/node_modules/.bin/dsh')
  assert.deepEqual(steps.map((s) => s.id), ['prepare', 'install', 'verify-binary', 'verify-pty', 'verify-web'])
})

test('the plan pins a version that actually ships the Linux prebuild', () => {
  const { steps } = buildInstallPlan({ facts: healthy, prefix: '/p' })
  const install = steps.find((s) => s.id === 'install')
  assert.match(install.command, new RegExp(PTY_FIXED_VERSION.replace(/\./g, '\\.')))
  assert.equal(install.timeoutMs >= 300000, true, 'a cold npm cache needs a generous timeout')
})

test('a custom registry and version are honoured', () => {
  const { steps } = buildInstallPlan({
    facts: healthy, prefix: '/p', version: '9.9.9', registry: 'https://npm.example.com/',
  })
  const install = steps.find((s) => s.id === 'install')
  assert.match(install.command, /9\.9\.9/)
  assert.match(install.command, /--registry 'https:\/\/npm\.example\.com\/'/)
})

test('the plan writes a private package.json so npm cannot adopt a parent project', () => {
  const prepare = buildInstallPlan({ facts: healthy, prefix: '/p' }).steps[0]
  assert.match(prepare.command, /private/)
  assert.match(prepare.command, /package\.json/)
})

test('the native-module step is skipped on Windows', () => {
  const win = parseProbe('P_OS=MINGW64_NT-10.0\nP_ARCH=x64\n')
  const ids = buildInstallPlan({ facts: win, prefix: '/p' }).steps.map((s) => s.id)
  assert.ok(!ids.includes('verify-pty'))
})

test('stepResult reports success and keeps a bounded diagnostic tail', () => {
  const step = { id: 'install', title: '安装' }
  assert.equal(stepResult(step, { code: 0, stdout: 'ok' }).ok, true)
  const big = stepResult(step, { code: 1, stdout: 'x'.repeat(5000), stderr: 'boom' })
  assert.equal(big.ok, false)
  assert.ok(big.output.length <= 1300, 'output must be bounded for the UI')
  assert.match(big.output, /boom/, 'stderr must be included: it is where npm reports failure')
})
