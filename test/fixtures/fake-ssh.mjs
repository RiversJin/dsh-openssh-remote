#!/usr/bin/env node
// Test-only fake system SSH: execute the final remote command locally. It lets
// repository tests exercise argv/stdin/stdout semantics without a real host.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.DSH_FAKE_SSH_LOG) appendFileSync(process.env.DSH_FAKE_SSH_LOG, JSON.stringify(args) + '\n')
const command = args.at(-1) || ''
const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { child.kill(signal) } catch {} })
child.on('error', (err) => { console.error(err.message); process.exitCode = 127 })
child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code == null ? 1 : code)
})
