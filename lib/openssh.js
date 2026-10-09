// System OpenSSH transport for ssh-config aliases whose authentication (for
// example GSSAPI/Kerberos) is not implemented by node-ssh2.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { truncate } from './paths.js'

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`

/** Empty means resolve `ssh` through PATH; callers may provide an absolute path. */
export function resolveOpenSshExecutable(config = {}) {
  return String(config.opensshPath || '').trim() || 'ssh'
}

function run(executable, alias, command, opts = {}, input) {
  if (opts.signal && opts.signal.aborted) {
    return Promise.resolve({ code: -1, signal: 'ABORTED', stdout: opts.raw ? Buffer.alloc(0) : '', stderr: '' })
  }
  const timeoutMs = Number(opts.timeoutMs) || 20000
  const maxOutputChars = Number(opts.maxOutputChars) || 200000
  const maxBytes = Number(opts.maxBytes) || Math.max(maxOutputChars * 4, 1024 * 1024)
  const args = ['-o', 'BatchMode=yes']
  if (opts.pty) args.push('-tt')
  args.push(alias, command)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    if (opts.children) opts.children.add(child)
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let overflow = false
    let settled = false
    const append = (current, chunk) => {
      if (current.length + chunk.length > maxBytes) overflow = true
      return current.length >= maxBytes ? current : Buffer.concat([current, chunk]).subarray(0, maxBytes)
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    let onAbort = null
    const finish = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(value)
    }
    const stop = (signal) => {
      try { child.kill('SIGTERM') } catch {}
      const hard = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 800)
      if (typeof hard.unref === 'function') hard.unref()
      finish({ code: -1, signal, stdout: opts.raw ? stdout : stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    }
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    if (opts.signal) {
      onAbort = () => stop('ABORTED')
      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (err) => finish(null, new Error(`OpenSSH failed (${executable}): ${err.message}`)))
    child.on('close', (code, signal) => {
      if (opts.children) opts.children.delete(child)
      if (overflow && opts.raw) return finish(null, new Error(`OpenSSH binary output exceeded ${maxBytes} bytes`))
      finish({
        code: code == null ? -1 : code,
        signal: signal || null,
        stdout: opts.raw ? stdout : truncate(stdout.toString('utf8'), maxOutputChars),
        stderr: truncate(stderr.toString('utf8'), maxOutputChars),
      })
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

const PY_STAT = String.raw`import json,os,stat,sys
p=sys.argv[1]; follow=sys.argv[2]=='1'; s=os.stat(p) if follow else os.lstat(p)
print(json.dumps({'size':s.st_size,'mtime':int(s.st_mtime),'mode':s.st_mode,'dir':stat.S_ISDIR(s.st_mode),'link':stat.S_ISLNK(s.st_mode)}))`
const PY_LIST = String.raw`import json,os,stat,sys
p=sys.argv[1]; out=[]
for n in os.listdir(p):
 s=os.lstat(os.path.join(p,n)); out.append({'filename':n,'size':s.st_size,'mtime':int(s.st_mtime),'mode':s.st_mode,'dir':stat.S_ISDIR(s.st_mode),'link':stat.S_ISLNK(s.st_mode)})
print(json.dumps(out))`
const PY_READ = String.raw`import sys
p=sys.argv[1]; off=int(sys.argv[2]); size=int(sys.argv[3])
with open(p,'rb') as f:
 f.seek(off); sys.stdout.buffer.write(f.read() if size<0 else f.read(size))`
const PY_WRITE = String.raw`import os,sys
p=sys.argv[1]; os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
with open(p,'wb') as f: f.write(sys.stdin.buffer.read())`
const PY_OP = String.raw`import os,sys
op=sys.argv[1]; a=sys.argv[2]; b=sys.argv[3] if len(sys.argv)>3 else ''
if op=='mkdir': os.mkdir(a)
elif op=='rmdir': os.rmdir(a)
elif op=='unlink': os.unlink(a)
elif op=='rename': os.rename(a,b)
elif op=='realpath': print(os.path.realpath(a))`
const python = (script, ...args) => `python3 -c ${quote(script)} ${args.map(quote).join(' ')}`
const attrs = (raw) => ({
  size: Number(raw.size) || 0,
  mtime: Number(raw.mtime) || 0,
  mode: Number(raw.mode) || 0,
  isDirectory: () => !!raw.dir,
  isSymbolicLink: () => !!raw.link,
})

export class OpenSshBackend {
  constructor(alias, config) {
    if (!alias) throw new Error('OpenSSH transport requires an SSH Host token in alias mode')
    if (/^-|[\0-\x20\x7f]/.test(String(alias))) throw new Error('OpenSSH alias must be one concrete Host token without whitespace or control characters')
    this.alias = String(alias)
    this.config = config
    this.children = new Set()
  }
  get executable() { return resolveOpenSshExecutable(this.config) }
  exec(command, opts = {}) {
    const env = opts.env && typeof opts.env === 'object'
      ? Object.entries(opts.env)
          .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          .map(([key, value]) => `export ${key}=${quote(value)}; `)
          .join('')
      : ''
    return run(this.executable, this.alias, env + String(command), { ...opts, children: this.children, maxOutputChars: this.config.maxOutputChars })
  }
  async probe() {
    const result = await this.exec('true', { timeoutMs: Math.min(Number(this.config.connectTimeoutMs) || 15000, 15000) })
    if (result.code !== 0) throw new Error(`OpenSSH connection failed: ${result.stderr || `exit ${result.code}`}`)
    return result
  }
  async _json(script, ...args) {
    const result = await run(this.executable, this.alias, python(script, ...args), {
      timeoutMs: this.config.commandTimeoutMs,
      children: this.children,
      maxOutputChars: this.config.maxOutputChars,
    })
    if (result.code !== 0) throw new Error(result.stderr || `OpenSSH operation failed (exit ${result.code})`)
    return JSON.parse(String(result.stdout))
  }
  close() {
    for (const child of this.children) {
      try { child.kill('SIGTERM') } catch {}
    }
    this.children.clear()
  }
  sftpFacade() {
    const call = async (script, args, input) => {
      const result = await run(this.executable, this.alias, python(script, ...args), {
        timeoutMs: this.config.commandTimeoutMs,
        children: this.children,
        maxOutputChars: this.config.maxOutputChars,
        // Preserve Config semantics: 0 means no file-size cap. The shipped
        // default remains 50 MiB; callers that explicitly choose 0 accept the
        // memory cost of this first buffered implementation.
        maxBytes: Number(this.config.maxFileBytes) > 0 ? Number(this.config.maxFileBytes) : Number.MAX_SAFE_INTEGER,
        raw: true,
      }, input)
      if (result.code !== 0) throw new Error(result.stderr || `OpenSSH file operation failed (exit ${result.code})`)
      return result.stdout
    }
    const statOne = async (p, follow) => attrs(await this._json(PY_STAT, p, follow ? '1' : '0'))
    return {
      readdir: async (dir) => (await this._json(PY_LIST, dir)).map((entry) => ({ filename: entry.filename, attrs: attrs(entry) })),
      stat: (p) => statOne(p, true),
      lstat: (p) => statOne(p, false),
      mkdir: (dir) => call(PY_OP, ['mkdir', dir]),
      rmdir: (dir) => call(PY_OP, ['rmdir', dir]),
      unlink: (p) => call(PY_OP, ['unlink', p]),
      rename: (a, b) => call(PY_OP, ['rename', a, b]),
      realpath: async (p) => (await call(PY_OP, ['realpath', p])).toString('utf8').trim(),
      readFile: (p) => call(PY_READ, [p, '0', '-1']),
      writeFile: (p, data) => call(PY_WRITE, [p], Buffer.isBuffer(data) ? data : Buffer.from(data)),
      readPartial: (p, offset, length) => call(PY_READ, [p, String(offset), String(length)]),
      fastGet: async (p, local) => writeFile(local, await call(PY_READ, [p, '0', '-1'])),
      fastPut: async (local, p) => call(PY_WRITE, [p], await readFile(local)),
    }
  }
}
