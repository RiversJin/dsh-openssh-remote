import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenSshBackend, resolveOpenSshExecutable } from '../lib/openssh.js'
import { SshPool } from '../lib/pool.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const fake = path.join(root, 'fixtures', 'fake-ssh.mjs')
chmodSync(fake, 0o755)
const config = (extra = {}) => ({ commandTimeoutMs: 3000, connectTimeoutMs: 3000, maxOutputChars: 200000, maxFileBytes: 1024 * 1024, ...extra })

test('OpenSSH executable is configurable and defaults to ssh from PATH', () => {
  assert.equal(resolveOpenSshExecutable({}), 'ssh')
  assert.equal(resolveOpenSshExecutable({ opensshPath: ' /custom/bin/ssh ' }), '/custom/bin/ssh')
})

test('OpenSSH alias validation rejects option injection and whitespace', () => {
  assert.throws(() => new OpenSshBackend('-Fbad', config()), /one concrete Host token/)
  assert.throws(() => new OpenSshBackend('two hosts', config()), /one concrete Host token/)
  assert.doesNotThrow(() => new OpenSshBackend('build-box', config()))
})

test('configured executable receives the untouched alias as one argv token', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-argv-'))
  const log = path.join(dir, 'argv.jsonl')
  const old = process.env.DSH_FAKE_SSH_LOG
  process.env.DSH_FAKE_SSH_LOG = log
  try {
    const backend = new OpenSshBackend('company-alias', config({ opensshPath: fake }))
    const result = await backend.exec('printf ok')
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'ok')
    const argv = JSON.parse(readFileSync(log, 'utf8').trim())
    assert.deepEqual(argv.slice(0, 3), ['-o', 'BatchMode=yes', 'company-alias'])
  } finally {
    if (old === undefined) delete process.env.DSH_FAKE_SSH_LOG; else process.env.DSH_FAKE_SSH_LOG = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenSSH facade preserves binary bytes and filesystem metadata', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-fs-'))
  const remote = path.join(dir, 'remote')
  const local = path.join(dir, 'local.bin')
  const downloaded = path.join(dir, 'downloaded.bin')
  const data = Buffer.from([0, 1, 2, 10, 13, 255, ...Buffer.from('中文')])
  try {
    const backend = new OpenSshBackend('fake-host', config({ opensshPath: fake }))
    const fs = backend.sftpFacade()
    await fs.mkdir(remote)
    await fs.writeFile(path.join(remote, 'a.bin'), data)
    const entries = await fs.readdir(remote)
    assert.deepEqual(entries.map((e) => e.filename), ['a.bin'])
    assert.equal(entries[0].attrs.size, data.length)
    assert.equal(entries[0].attrs.isDirectory(), false)
    assert.deepEqual(await fs.readFile(path.join(remote, 'a.bin')), data)
    assert.deepEqual(await fs.readPartial(path.join(remote, 'a.bin'), 2, 4), data.subarray(2, 6))
    writeFileSync(local, data)
    await fs.fastPut(local, path.join(remote, 'b.bin'))
    await fs.fastGet(path.join(remote, 'b.bin'), downloaded)
    assert.deepEqual(readFileSync(downloaded), data)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stat follows symlinks while lstat reports the link itself', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-link-'))
  const target = path.join(dir, 'target')
  const link = path.join(dir, 'link')
  writeFileSync(target, 'x')
  symlinkSync(target, link)
  try {
    const fs = new OpenSshBackend('fake-host', config({ opensshPath: fake })).sftpFacade()
    assert.equal((await fs.stat(link)).isSymbolicLink(), false)
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an already-aborted request does not spawn the SSH executable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-abort-'))
  const log = path.join(dir, 'argv.jsonl')
  const old = process.env.DSH_FAKE_SSH_LOG
  process.env.DSH_FAKE_SSH_LOG = log
  try {
    const controller = new AbortController(); controller.abort()
    const result = await new OpenSshBackend('fake-host', config({ opensshPath: fake })).exec('printf bad', { signal: controller.signal })
    assert.equal(result.signal, 'ABORTED')
    assert.throws(() => readFileSync(log), /ENOENT/)
  } finally {
    if (old === undefined) delete process.env.DSH_FAKE_SSH_LOG; else process.env.DSH_FAKE_SSH_LOG = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxFileBytes=0 keeps the documented unlimited behavior', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-unlimited-'))
  const large = path.join(dir, 'large.bin')
  const data = Buffer.alloc(1024 * 1024 + 1, 9)
  writeFileSync(large, data)
  try {
    const fs = new OpenSshBackend('fake-host', config({ opensshPath: fake, maxFileBytes: 0 })).sftpFacade()
    assert.deepEqual(await fs.readFile(large), data)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenSSH binary reads fail instead of silently truncating over the configured cap', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-cap-'))
  const large = path.join(dir, 'large.bin')
  writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 7))
  try {
    const fs = new OpenSshBackend('fake-host', config({ opensshPath: fake, maxFileBytes: 1 })).sftpFacade()
    await assert.rejects(() => fs.readFile(large), /binary output exceeded/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SshPool coalesces concurrent OpenSSH connect probes', async () => {
  const pool = new SshPool(config({ transport: 'openssh', sshAlias: 'fake-host', opensshPath: fake, host: 'ignored', port: 22, username: 'ignored' }))
  let probes = 0
  pool.openSsh.probe = async () => { probes++; await new Promise((resolve) => setTimeout(resolve, 20)) }
  try {
    const [a, b] = await Promise.all([pool.connect(), pool.connect()])
    assert.equal(probes, 1)
    assert.equal(a, b)
  } finally { pool.close() }
})

test('SshPool dispatches exec/sftp to OpenSSH and reports timeout', async () => {
  const pool = new SshPool(config({ transport: 'openssh', sshAlias: 'fake-host', opensshPath: fake, host: 'ignored', port: 22, username: 'ignored' }))
  try {
    await pool.connect()
    const ok = await pool.exec('printf %s "$VALUE"', { env: { VALUE: 'yes' } })
    assert.equal(ok.stdout, 'yes')
    const timeout = await pool.exec('sleep 2', { timeoutMs: 100 })
    assert.equal(timeout.code, -1)
    assert.equal(timeout.signal, 'TIMEOUT')
    assert.ok((await pool.sftp()).readFile)
    assert.equal(pool.client.systemOpenSsh, true)
  } finally {
    pool.close()
  }
})
