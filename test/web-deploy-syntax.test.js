// POSIX syntax gate for the deploy probe/installer shell fragments.
//
// The launch builder once shipped a `do;` syntax error that every string-level
// unit test accepted and only a real run caught. Node cannot parse shell, so
// this shells out to a real `sh -n` (syntax check only, never executed).
// Skips with an explicit reason when no sh exists rather than silently passing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildProbeCommand, buildInstallPlan } from '../lib/web-deploy.js'

function findSh() {
  for (const c of ['/bin/sh', 'sh', 'bash', '/bin/bash']) {
    try { execFileSync(c, ['-n'], { input: 'true', stdio: ['pipe', 'pipe', 'pipe'] }); return c } catch { /* next */ }
  }
  return null
}
const sh = findSh()

/**
 * Syntax-check a script with a real shell, feeding it on STDIN.
 *
 * NOT via `-c`: on Windows, argv containing embedded double quotes is mangled
 * on the way to bash.exe, so a perfectly valid script reports
 * `unexpected EOF while looking for matching '"'`. Measured — the same script is
 * accepted through stdin, while both controls (an unterminated quote, and the
 * original `do;` defect) still fail through stdin. So stdin is faithful AND
 * still able to catch real errors, which `-c` on Windows is not.
 *
 * On a real POSIX remote sshd delivers the script as a single argv element
 * without mangling, so this is a test-harness concern, not a remote one.
 */
function syntaxError(shBin, script) {
  try {
    // `-n` parses without executing: safe even for the installer commands.
    execFileSync(shBin, ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    return String((err && (err.stderr || err.message)) || err).trim()
  }
}

test('the environment probe is POSIX-valid', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check remote commands')
  for (const spec of [{}, { prefix: '/home/dev/.dsh-remote/dsh' }, { prefix: '/tmp/a b/c' }]) {
    const err = syntaxError(sh, buildProbeCommand(spec))
    assert.equal(err, null, `invalid shell for ${JSON.stringify(spec)}:\n${err}`)
  }
})

test('every install step is POSIX-valid', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check remote commands')
  const facts = { platform: 'Linux', arch: 'x64', npm: 'npm' }
  for (const spec of [
    { facts, prefix: '/home/dev/.dsh-remote/dsh' },
    { facts, prefix: '/tmp/prefix with space' },
    { facts, prefix: '/p', version: '9.9.9', registry: 'https://npm.example.com/' },
  ]) {
    for (const step of buildInstallPlan(spec).steps) {
      const err = syntaxError(sh, step.command)
      assert.equal(err, null, `step ${step.id} invalid for ${JSON.stringify(spec)}:\n${err}`)
    }
  }
})

test('the syntax gate actually rejects a broken loop (proves it can fail)', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host')
  assert.notEqual(syntaxError(sh, 'i=0; while [ $i -lt 3 ]; do; sleep 1; done'), null)
  assert.equal(syntaxError(sh, 'i=0; while [ $i -lt 3 ]; do sleep 1; i=$((i+1)); done'), null)
})
