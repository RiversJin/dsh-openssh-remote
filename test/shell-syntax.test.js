// POSIX syntax gate for the shell command builders.
//
// `buildLaunchCommand` joins statements with '; ', and the `do` keyword must be
// glued to the first command of its loop body — emitted as its own element it
// produced a literal `do;`, a POSIX syntax error. Unit tests that only assert on
// the string were perfectly happy with it; the equivalent hand-written script
// worked, so nothing looked wrong until the first real run of the feature, where
// EVERY attach failed with "syntax error near unexpected token `;'".
//
// Node cannot parse shell, so this shells out to a real POSIX `sh -n` (syntax
// check only, never executed). It is skipped with an explicit reason when no
// `sh` is available, rather than silently passing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildLaunchCommand, buildStopCommand } from '../lib/web-attach.js'

/** A `sh` we can ask to syntax-check, or null when the host has none. */
function findSh() {
  for (const candidate of ['/bin/sh', 'sh', 'bash', '/bin/bash']) {
    try {
      execFileSync(candidate, ['-n', '-c', 'true'], { stdio: 'ignore' })
      return candidate
    } catch { /* try the next one */ }
  }
  return null
}

const sh = findSh()

/** Syntax-check a command with the real shell. Returns null when OK. */
function syntaxError(shBin, command) {
  try {
    // `-n` reads but does not execute: safe for the destructive stop command.
    execFileSync(shBin, ['-n', '-c', command], { stdio: 'pipe' })
    return null
  } catch (err) {
    return String((err && (err.stderr || err.message)) || err).trim()
  }
}

test('buildLaunchCommand emits POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the remote command')
  const cases = [
    { command: 'dsh', profile: 'web', logPath: '.log-a' },
    { command: '/tmp/private prefix/dsh', profile: 'web', logPath: '.log-b', dshHome: '/tmp/home' },
    { command: 'dsh', profile: 'web', logPath: '.log-c', remotePort: 42080, waitSeconds: 5 },
    { command: 'dsh', profile: 'web', logPath: '.log-d', waitSeconds: 300 },
  ]
  for (const spec of cases) {
    const err = syntaxError(sh, buildLaunchCommand(spec))
    assert.equal(err, null, `invalid shell for ${JSON.stringify(spec)}:\n${err}`)
  }
})

test('buildStopCommand emits POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the remote command')
  for (const cmd of [buildStopCommand(1234), buildStopCommand(1234, '.dsh-remote-web-x.log'), buildStopCommand(0)]) {
    const err = syntaxError(sh, cmd)
    assert.equal(err, null, `invalid shell: ${cmd}\n${err}`)
  }
})

// The gate must be able to fail: prove it rejects the exact defect that shipped.
test('the syntax gate actually rejects the do; defect it exists for', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot prove the gate fails')
  const broken = 'i=0; while [ $i -lt 3 ]; do; sleep 1; i=$((i+1)); done'
  assert.notEqual(syntaxError(sh, broken), null, '`do;` must be reported as a syntax error')
  const fixed = 'i=0; while [ $i -lt 3 ]; do sleep 1; i=$((i+1)); done'
  assert.equal(syntaxError(sh, fixed), null, 'the glued form must be accepted')
})
