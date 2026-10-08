// POSIX syntax gate for the generated backup/restore shell.
//
// WHY THIS FILE EXISTS (and why a string assertion is not enough):
// scripts/dev-standards.md records a shipped defect where a generated script
// contained a literal `do;` — every string-level test was happy, and only a real
// shell rejected it. Node cannot parse shell, so the command builders are fed to
// a real `sh -n` here (syntax-check only: `-n` parses without executing, which
// keeps this safe even though the scripts contain `rm -rf`).
//
// TWO properties are asserted, and both need to be exercised:
//   1. every generated script is VALID shell;
//   2. the gate can actually FAIL — a broken script must be rejected. A gate
//      that can never fail reads as coverage while covering nothing.
//
// The check is skipped only when the host genuinely has no `sh`, and that skip is
// itself an explicit decision (DSH_REMOTE_ALLOW_NO_SH), never an accident that
// silently reduces this file to nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  buildCreateCommand, buildListCommand, buildVerifyCommand, buildDeleteCommand,
  buildRestoreCommand, buildHomeCommand, excludeFlags,
} from '../lib/archive.js'

/** A `sh` we can ask to syntax-check, or null when the host has none. */
function findSh() {
  for (const candidate of ['/bin/sh', 'sh', 'bash', '/bin/bash']) {
    try {
      execFileSync(candidate, ['-n'], { input: 'true', stdio: ['pipe', 'pipe', 'pipe'] })
      return candidate
    } catch { /* try the next one */ }
  }
  return null
}

const sh = findSh()

/**
 * Syntax-check a script with the real shell. Returns null when OK.
 *
 * Fed on STDIN rather than `-c`: on Windows, argv containing embedded quotes is
 * mangled on the way to bash.exe, so a valid script can report
 * `unexpected EOF while looking for matching '"'`. The sshd on a real remote
 * delivers the script as one argv element, so that is a test-harness constraint,
 * not a product one.
 */
function syntaxError(shBin, script) {
  try {
    execFileSync(shBin, ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    return String((err && (err.stderr || err.message)) || err).trim()
  }
}

/** Every script the product can generate, with adversarial inputs. */
function allScripts() {
  const scripts = [buildHomeCommand()]
  const dirs = ['/home/dev/proj', '/tmp/a b/c', "/home/o'brien/w", '/tmp/$(rm -rf /)']
  const archives = ['/home/dev/.dsh-remote/backups/x/y.tar.gz', '/tmp/a b/x y.tar.gz', '/tmp/-leading.tar.gz']
  const excludes = [[], ['node_modules'], ['a b/*.log', "qu'ote", '$(whoami)', '`id`'], ['back\\slash']]
  for (const dir of dirs) {
    for (const archive of archives) {
      for (const ex of excludes) {
        scripts.push(buildCreateCommand({ dir, archive, excludes: ex }))
      }
    }
  }
  for (const dir of ['/home/dev/.dsh-remote/backups/p', '/tmp/a b', "/home/o'b"]) {
    scripts.push(buildListCommand({ dir }))
  }
  for (const archive of archives) {
    scripts.push(buildVerifyCommand({ archive }))
    scripts.push(buildDeleteCommand({ archive, meta: archive.replace(/\.tar\.gz$/, '.meta.json') }))
    for (const mode of ['replace', 'merge']) {
      scripts.push(buildRestoreCommand({
        archive, target: '/home/dev/proj', mode,
        stage: '/home/dev/.s tage', swap: "/home/dev/sw'ap",
      }))
    }
  }
  return scripts
}

test('every generated backup script is POSIX-valid', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check remote commands')
  const scripts = allScripts()
  assert.ok(scripts.length > 20, `expected a real matrix of scripts, got ${scripts.length}`)
  for (const script of scripts) {
    const err = syntaxError(sh, script)
    assert.equal(err, null, `invalid shell:\n${err}\n--- script ---\n${script}`)
  }
})

test('the syntax gate actually rejects broken shell (negative control)', (t) => {
  // A gate that can never fail is worse than no gate. These are real defects:
  // the first is the shape of the incident recorded in scripts/dev-standards.md.
  if (!sh) return t.skip('no POSIX sh on this host')
  assert.notEqual(syntaxError(sh, 'i=0; while [ $i -lt 3 ]; do; sleep 1; done'), null, '`do;` must be rejected')
  assert.notEqual(syntaxError(sh, 'if [ -f /x ]\nthen\necho hi\n'), null, 'an unterminated if must be rejected')
  assert.notEqual(syntaxError(sh, "echo 'unterminated"), null, 'an unterminated quote must be rejected')
  assert.equal(syntaxError(sh, 'if [ -f /x ]\nthen\necho hi\nfi\n'), null, 'the valid form must be accepted')
})

test('an exclude pattern with shell metacharacters stays ONE argument', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host')
  // The pattern must survive quoting: if the generated command let the shell see
  // `*.log` or `$(whoami)` unquoted, the exclusions would silently differ from
  // what the caller asked for (or execute something). `printf` echoes exactly
  // the argument the shell produced — one per line.
  //
  // RUN VIA STDIN, never `sh -c "<script>"`: on Windows the embedded quotes are
  // mangled on the way to bash.exe, so the single quotes vanish, `$(whoami)`
  // expands and a CORRECT product looks broken. (Measured here: the first draft
  // of this test used `-c` and reported `--exclude=root` instead of
  // `--exclude=$(whoami)` — a false failure caused by the harness, not the code.)
  const patterns = ['*.log', '$(whoami)', '`id`', "qu'ote", 'a b']
  const script = `printf '%s\\n' ${excludeFlags(patterns)}`
  const err = syntaxError(sh, script)
  assert.equal(err, null, `invalid shell:\n${err}`)
  const out = execFileSync(sh, [], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const argv = out.trim().split('\n')
  assert.deepEqual(argv, patterns.map((p) => `--exclude=${p}`),
    'each pattern must survive as exactly one literal argument, unexpanded')
})

test('the shell gate did not silently disappear', (t) => {
  if (process.env.DSH_REMOTE_ALLOW_NO_SH === '1') {
    return t.skip('DSH_REMOTE_ALLOW_NO_SH=1: the caller accepted running without a shell gate')
  }
  assert.ok(sh, 'no POSIX sh was found, so the generated backup shell could not be syntax-checked. '
    + 'Install sh/bash, or set DSH_REMOTE_ALLOW_NO_SH=1 to accept that this whole class of '
    + 'defect (invalid generated shell) is unchecked on this host.')
})
