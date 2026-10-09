// Persistent SSH/SFTP connection pool (one identity → one live client).
import ssh2 from 'ssh2'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { toSftpPath, truncate } from './paths.js'
import { createHostKeyGuard } from './hostkey.js'
import { OpenSshBackend } from './openssh.js'

const { Client } = ssh2

export class SshPool {
  constructor(config, opts = {}) {
    this.config = config
    this._knownHostsFile = opts.knownHostsFile
    this.client = null
    this.connecting = null
    this.proxyPool = null
    // Generational token: bumped on every target change / close so a stale
    // in-flight connect can never hand this pool a connection to an old host.
    this.epoch = 0
    /** Auto-detected remote platform: unknown | windows | posix (per target). */
    this.platform = 'unknown'
    /** Resolved Git Bash bash.exe path on Windows remotes ('' when none). */
    this.gitBashPath = ''
    /** Resolved terminal strategy: native | git-bash. */
    this.shellMode = 'native'
    /** In-flight platform detection promise (cached). */
    this._detecting = null
    /** Optional async resolver for a machine-stored (keychain) password. */
    this.passwordResolver = null
    /** Optional hook called with the live client after a successful connect. */
    this.onReady = null
    /** Optional hook called when the pool closes. */
    this.onCloseHook = null
    /** System OpenSSH owns the complete SSH-config/GSSAPI connection path. */
    this.openSsh = this._makeOpenSshBackend()
  }

  _makeOpenSshBackend() {
    if (this.config.transport !== 'openssh') return null
    const alias = String(this.config.sshAlias || '').trim()
    return new OpenSshBackend(alias, this.config)
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace, useAgent, keyboardInteractive, proxy, hostKeyMode, transport, sshAlias, opensshPath }, previous) {
    // Collect the requested changes first: an UNCHANGED target is a no-op. The
    // old behavior closed the live connection and re-ran platform detection
    // even for an identical target, so every picker keystroke
    // (POST /current → applyActiveMachine → setTarget) paid a full SSH
    // reconnect + re-detect — the "slow remote path autocomplete" bug.
    //
    // `previous` is the diff BASELINE. Callers whose shared config was already
    // mutated BEFORE this call (applyActiveMachine: applyMachine rewrites the
    // live config IN PLACE, and pool.config IS that config object) pass a
    // pre-mutation snapshot — otherwise the comparison runs the new values
    // against themselves, is always equal and never closes even for a machine
    // switch (the wrong-host hazard of issue #25). Defaults to the current
    // config for callers that pass fresh values read independently of it.
    const base = previous || this.config
    const wanted = []
    if (host !== undefined) wanted.push(['host', String(host)])
    if (port !== undefined && Number(port)) wanted.push(['port', Number(port)])
    if (username !== undefined) wanted.push(['username', String(username)])
    if (password !== undefined && password !== null) wanted.push(['password', String(password)])
    if (privateKeyPath !== undefined) wanted.push(['privateKeyPath', String(privateKeyPath)])
    if (passphrase !== undefined) wanted.push(['passphrase', String(passphrase)])
    if (workspace !== undefined) wanted.push(['workspace', String(workspace)])
    if (useAgent !== undefined) wanted.push(['useAgent', !!useAgent])
    if (keyboardInteractive !== undefined) wanted.push(['keyboardInteractive', !!keyboardInteractive])
    if (proxy !== undefined) wanted.push(['proxy', proxy])
    if (hostKeyMode !== undefined) wanted.push(['hostKeyMode', String(hostKeyMode)])
    if (transport !== undefined) wanted.push(['transport', String(transport)])
    if (sshAlias !== undefined) wanted.push(['sshAlias', String(sshAlias)])
    if (opensshPath !== undefined) wanted.push(['opensshPath', String(opensshPath)])
    const differs = ([k, v]) => (k === 'proxy'
      ? JSON.stringify(base[k] ?? null) !== JSON.stringify(v ?? null)
      : base[k] !== v)
    // Something actually changed → apply it and force a fresh connection.
    // (A caller that WANTS a reconnect for an identical target uses
    // invalidate(); setTarget semantics stay "re-point when moved".)
    if (wanted.some(differs)) {
      for (const [k, v] of wanted) this.config[k] = v
      // the new target may be a different OS — re-detect on the next command
      this.platform = 'unknown'
      this.gitBashPath = ''
      this.shellMode = 'native'
      this._detecting = null
      this.close()
      this.openSsh = this._makeOpenSshBackend()
    }
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const pending = this.openSsh
      ? this.openSsh.probe().then(() => {
          if (this.epoch !== epoch) throw new Error('ssh target changed during OpenSSH connect')
          this.client = { systemOpenSsh: true, alias: this.config.sshAlias, executable: this.openSsh.executable }
          return this.client
        })
      : this._doConnect(epoch)
    this.connecting = pending
    const clear = () => {
      if (this.epoch === epoch && this.connecting === pending) this.connecting = null
    }
    pending.then(clear, clear)
    return pending
  }

  async _doConnect(epoch) {
    const isCurrent = () => this.epoch === epoch
    const knownHostsFile = typeof this._knownHostsFile === 'function' ? this._knownHostsFile() : this._knownHostsFile
    const guard = createHostKeyGuard(this.config, knownHostsFile)
    const client = new Client()
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      if (isCurrent() && this.client === client) this.client = null
      throw guard.lastError ? new Error(guard.lastError) : err
    }

    // Proxy jump: SSH to the bastion first, then tunnel to the target through it.
    let sock = null
    const proxyCfg = this.config.proxy
    if (proxyCfg && proxyCfg.host) {
      try {
        this.proxyPool = new SshPool({
          ...this.config,
          host: proxyCfg.host,
          port: Number(proxyCfg.port) || 22,
          username: proxyCfg.username || this.config.username || 'root',
          password: proxyCfg.password || '',
          privateKeyPath: proxyCfg.privateKeyPath || '',
          passphrase: proxyCfg.passphrase || '',
          proxy: undefined,
        }, { knownHostsFile: this._knownHostsFile })
        const pclient = await this.proxyPool.connect()
        if (!isCurrent()) throw new Error('ssh target changed during proxy connect')
        sock = await new Promise((res, rej) => {
          pclient.forwardOut('127.0.0.1', 0, this.config.host, this.config.port, (e, ch) => (e ? rej(new Error('proxy forward to target failed: ' + ((e && e.message) || e))) : res(ch)))
        })
      } catch (err) {
        return fail(err)
      }
    }

    return new Promise((resolve, reject) => {
      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        if (isCurrent() && this.client === client) this.client = null
        reject(guard.lastError ? new Error(guard.lastError) : new Error(`ssh connect to ${this.config.host}:${this.config.port} failed: ${((err && err.message) || err)}`))
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          try { client.end() } catch {}
          reject(new Error('ssh target changed during connect'))
          return
        }
        this.client = client
        resolve(client)
        if (this.onReady) { try { this.onReady(client) } catch {} }
      })
      client.on('error', (e) => rejectOnce(e))
      client.on('close', () => {
        if (isCurrent() && this.client === client) this.client = null
        rejectOnce(new Error('ssh connection closed'))
      })

      const buildOpts = async () => {
        const opts = {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          readyTimeout: this.config.connectTimeoutMs,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => guard.verifier(key),
        }
        if (sock) opts.sock = sock
        if (this.config.useAgent) {
          const sockPath = process.env.SSH_AUTH_SOCK
          if (sockPath) opts.agent = sockPath
        }
        let password = this.config.password || ''
        if (!password && this.passwordResolver) {
          try { password = (await this.passwordResolver()) || '' } catch {}
        }
        if (password) {
          opts.password = password
          opts.tryKeyboard = true
        } else if (this.config.keyboardInteractive && !this.config.privateKeyPath) {
          opts.tryKeyboard = true
        }
        if (this.config.privateKeyPath) {
          const keyPath = this.resolveKeyPath()
          if (!keyPath) {
            throw new Error('no credentials: set a password or a privateKeyPath to connect')
          }
          let key
          try {
            key = readFileSync(keyPath)
          } catch (err) {
            throw new Error(`cannot read private key "${keyPath}": ${err && err.message}`)
          }
          opts.privateKey = key
          opts.passphrase = this.config.passphrase || undefined
        } else if (!password && !opts.agent) {
          throw new Error('no credentials: set a password, a privateKeyPath, or enable useAgent to connect')
        }
        return opts
      }

      buildOpts().then(
        (opts) => {
          if (opts.tryKeyboard) {
            client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
              finish(prompts.map(() => this.config.password || ''))
            })
          }
          // ssh2 parses the private key SYNCHRONOUSLY inside connect() and
          // throws on an unparseable key (the classic case: an encrypted
          // OpenSSH key without a passphrase). Left uncaught, that throw
          // rejects this orphaned .then chain — an unhandled rejection that
          // crashes the whole host process (issue #48: "dsh: fatal load
          // failure" on every boot, because boot-restore re-dials the bad
          // machine). It also leaves the outer promise pending forever.
          // Convert it into a normal rejection so every caller's try/catch —
          // boot restore, test-connect, rw_connect — sees a regular failure.
          try {
            client.connect(opts)
          } catch (err) {
            rejectOnce(err)
          }
        },
        (err) => rejectOnce(err),
      )
    })
  }

  /** Detect the remote platform + locate Git Bash once; cached per target. */
  detect() {
    if (this.platform !== 'unknown') return Promise.resolve()
    if (this._detecting) return this._detecting
    this._detecting = this._detect().finally(() => {
      this._detecting = null
    })
    return this._detecting
  }

  async _detect() {
    if (this.openSsh) {
      const res = await this.openSsh.exec('uname -s', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
      if (res.code !== 0) throw new Error(res.stderr || 'OpenSSH platform detection failed')
      if (/mingw|msys|cygwin|windows/i.test(String(res.stdout || ''))) {
        throw new Error('OpenSSH transport currently supports POSIX remote hosts only')
      }
      this.platform = 'posix'
      this.shellMode = 'native'
      this.gitBashPath = ''
      return
    }
    let res
    try {
      // `cmd /c ver` works under cmd.exe, PowerShell AND Git Bash (all print
      // "Microsoft Windows …"); on POSIX hosts `cmd` simply doesn't exist.
      res = await this._execRaw('cmd /c ver', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
    } catch (err) {
      this.platform = 'unknown'
      this.shellMode = 'native'
      return
    }
    const out = String(res.stdout || '') + '\n' + String(res.stderr || '')
    if (res.code === 0 && /microsoft windows/i.test(out)) {
      this.platform = 'windows'
      await this._resolveGitBash()
      return
    }
    // inconclusive — probe for a Git-Bash/MSYS remote (uname prints MINGW64_NT…)
    try {
      const u = await this._execRaw('uname -s', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
      if (/mingw|msys|cygwin/i.test(String(u.stdout || ''))) {
        this.platform = 'windows'
        await this._resolveGitBash()
        return
      }
    } catch {}
    this.platform = 'posix'
    this.shellMode = 'native'
    this.gitBashPath = ''
  }

  /** On a Windows remote, locate Git Bash (config path → PATH → common installs). */
  async _resolveGitBash() {
    const cfg = String(this.config.shell || '').trim()
    if (cfg && cfg !== 'git-bash' && cfg !== 'native') {
      if (await this._cmdExists(cfg)) {
        this.gitBashPath = cfg
        this.shellMode = 'git-bash'
        return
      }
    }
    if (cfg === 'native') {
      this.shellMode = 'native'
      this.gitBashPath = ''
      return
    }
    try {
      const r = await this._execRaw('cmd /c where bash', { timeoutMs: 8000 })
      const first = String(r.stdout || '').trim().split(/\r?\n/)[0].trim()
      if (first) {
        this.gitBashPath = first
        this.shellMode = 'git-bash'
        return
      }
    } catch {}
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA + '\\Programs\\Git\\bin\\bash.exe'] : []),
      '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe',
    ]
    for (const c of candidates) {
      if (await this._cmdExists(c)) {
        this.gitBashPath = c
        this.shellMode = 'git-bash'
        return
      }
    }
    this.shellMode = 'git-bash' // wanted but not found — commands fall back to raw
    this.gitBashPath = ''
  }

  async _cmdExists(p) {
    try {
      const r = await this._execRaw(`cmd /c if exist "${p}" (echo Y) else (echo N)`, { timeoutMs: 8000 })
      return /Y/.test(String(r.stdout || ''))
    } catch {
      return false
    }
  }

  /** Run one remote command; resolves { code, signal, stdout, stderr }.
   * On Windows remotes with Git Bash the script is piped to `bash -s` over the
   * exec-channel stdin — no shell quoting round-trip, so any content (quotes,
   * backslashes, newlines) survives verbatim. */
  exec(command, timeoutMsOrOpts) {
    const opts = timeoutMsOrOpts && typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : { timeoutMs: timeoutMsOrOpts }
    if (this.openSsh) return this.detect().then(() => this.openSsh.exec(command, { ...opts, timeoutMs: opts.timeoutMs || this.config.commandTimeoutMs }))
    return this.detect().then(() => {
      if (this.platform === 'windows' && this.gitBashPath) {
        const script = String(command)
        return this._execRaw(`"${this.gitBashPath}" -s`, { ...opts, timeoutMs: opts.timeoutMs || this.config.commandTimeoutMs }, (stream) => {
          try { stream.end(script) } catch {}
        })
      }
      return this._execRaw(command, opts)
    })
  }

  /** Raw exec (no detection / no wrapper). Optional stdinWriter(stream) feeds
   * the remote process stdin (used by the Git Bash `-s` mode). */
  _execRaw(command, opts, stdinWriter) {
    const timeoutMs = (opts && opts.timeoutMs) || this.config.commandTimeoutMs
    const signal = opts && opts.signal
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          // Caller cancellation (issue #44): a tool that hands us exec.signal
          // expects the remote command to stop when the turn is cancelled.
          // Resolve the same shape as a timeout so callers need no new branch.
          let onAbort = null
          const cleanupAbort = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort) }
          const runOn = (c) => {
            const execOpts = {}
            if (opts && opts.pty) execOpts.pty = true
            if (opts && opts.env && typeof opts.env === 'object') execOpts.env = opts.env
            c.exec(command, execOpts, (err, stream) => {
              if (err) {
                // Channel-open failure — or a session termination — usually
                // means the pooled connection died server-side (idle timeout /
                // network reset) while keepalive hadn't noticed. Drop it and
                // retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed|unexpected .* session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh exec failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
              }
              let stdout = ''
              let stderr = ''
              let settled = false
              let exitCode = null
              let exitSignal = null
              const hardCap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
              const settle = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                cleanupAbort()
                resolve({
                  code: exitCode,
                  signal: exitSignal,
                  stdout: truncate(stdout, this.config.maxOutputChars),
                  stderr: truncate(stderr, this.config.maxOutputChars),
                })
              }
              const timer = setTimeout(() => {
                if (settled) return
                exitCode = -1
                exitSignal = 'TIMEOUT'
                // Kill the remote command (SIGTERM) rather than just dropping the
                // channel, so a runaway process cannot keep running and holding
                // the SSH connection after we've given up on its output.
                try {
                  if (typeof stream.signal === 'function') stream.signal('SIGTERM')
                } catch {}
                const hardClose = setTimeout(() => {
                  try { stream.close() } catch {}
                }, 800)
                if (typeof hardClose.unref === 'function') hardClose.unref()
                settle()
              }, timeoutMs)
              if (signal) {
                if (signal.aborted) {
                  try { if (typeof stream.signal === 'function') stream.signal('SIGTERM') } catch {}
                  try { stream.close() } catch {}
                  exitCode = -1
                  exitSignal = 'ABORTED'
                  return settle()
                }
                onAbort = () => {
                  if (settled) return
                  exitCode = -1
                  exitSignal = 'ABORTED'
                  try { if (typeof stream.signal === 'function') stream.signal('SIGTERM') } catch {}
                  const hardClose = setTimeout(() => { try { stream.close() } catch {} }, 500)
                  if (typeof hardClose.unref === 'function') hardClose.unref()
                  settle()
                }
                signal.addEventListener('abort', onAbort, { once: true })
              }
              stream.on('close', (code, sigName) => {
                if (settled) return
                exitCode = code
                // `sigName` is the signal NAME that killed the remote process
                // (e.g. 'SIGTERM'), not the caller's AbortSignal. The rename
                // matters: `signal` in this scope is the AbortSignal, and
                // assigning it here would leak an object into the result.
                exitSignal = sigName
                settle()
              })
              stream.on('data', (d) => {
                if (stdout.length < hardCap) stdout += d
              })
              stream.stderr.on('data', (d) => {
                if (stderr.length < hardCap) stderr += d
              })
              stream.on('error', (e) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                cleanupAbort()
                reject(new Error('ssh stream error: ' + ((e && e.message) || e)))
              })
              if (stdinWriter) {
                try { stdinWriter(stream) } catch {}
              }
            })
          }
          runOn(client)
        }),
    )
  }

  /** Resolve a promisified SFTP client. All paths normalized via toSftpPath(). */
  sftp() {
    if (this.openSsh) return this.connect().then(() => this.openSsh.sftpFacade())
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            // Bound the subchannel open itself, per attempt. Without this, a
            // remote whose sftp subsystem is unresponsive (overloaded sshd,
            // exceeded MaxSessions, half-open TCP) leaves `c.sftp(cb)` parked
            // forever with no callback — issue #44 point 3. ssh2 only calls back
            // on success or on a channel error, and a wedged peer produces
            // neither.
            //
            // The timer must be created per attempt, not once outside: the
            // callback clears it, so a single outer timer would leave the retry
            // (below) with no timeout at all.
            let timedOut = false
            const attemptTimer = setTimeout(() => {
              timedOut = true
              reject(new Error(`ssh sftp open timed out after ${this.config.commandTimeoutMs}ms`))
            }, this.config.commandTimeoutMs)
            // ★ 这里**不能 unref**。
            //
            // 这个定时器是"本次 await 的 sftp 打开"的**唯一结算者**：要么它超时 reject，
            // 要么 ssh2 回调 resolve。若把它 unref，而进程此刻没有别的 pending 句柄，
            // Node 会认为无事可做而**直接退出**，调用方永远等不到结果。
            // 实测症状：CI 上该用例之后的 4 个用例被标记 `cancelledByParent`
            // （同文件子进程提前退出），而本地因运行器恰好持着句柄而侥幸通过。
            // 注意与上面 exec() 的超时定时器保持一致 —— 那个本来就没有 unref。
            // 下面的 hardClose 仍然 unref，因为它只做清理、不负责结算。
            const clearAttempt = () => { clearTimeout(attemptTimer) }
            try {
              c.sftp((err, sftp) => {
                clearAttempt()
                if (timedOut) return
                if (err) {
                  // Same dead-connection recovery as exec(): a channel open
                  // failure — or a session termination (remote closed the
                  // SFTP subchannel, e.g. transient network blip / sshd idle
                  // drop) — means the pooled connection is stale: drop it and
                  // retry ONCE on a fresh connection.
                  if (!retried && /channel open failure|open failed|unexpected sftp session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                    retried = true
                    this.invalidate()
                    return this.connect().then(
                      (fresh) => runOn(fresh),
                      (e2) => reject(new Error('ssh sftp failed (reconnect): ' + ((e2 && e2.message) || e2))),
                    )
                  }
                  return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
                }
                // A dead channel must fail fast. ssh2's own EOF handling only
                // rejects the requests that were pending at that moment
                // (SFTP.js cleanupRequests); every request issued afterwards is
                // registered in `_requests` and never answered. Without the flag
                // below each such call waits out the full commandTimeoutMs — so a
                // tree walk over N entries costs N × 2 × timeout, i.e. days on a
                // large directory (issue #44). Mark the channel dead on EOF/close
                // and reject immediately from then on.
                let dead = false
                const markDead = () => { dead = true }
                if (typeof sftp.on === 'function') {
                  sftp.on('end', markDead)
                  sftp.on('close', markDead)
                  sftp.on('error', markDead)
                }
                const withTimeout = (fn) => (...args) =>
                  new Promise((r2, j2) => {
                    if (dead) return j2(new Error('sftp channel closed'))
                    const timer = setTimeout(() => j2(new Error('sftp operation timed out')), this.config.commandTimeoutMs)
                    const finish = (e, v) => {
                      clearTimeout(timer)
                      e ? j2(e) : r2(v)
                    }
                    try { fn(...args, finish) } catch (e) { clearTimeout(timer); j2(e) }
                  })
                const P = (p) => toSftpPath(p)
                resolve({
                  readdir: (dir) => withTimeout((d, cb) => sftp.readdir(d, cb))(P(dir)),
                  stat: (p) => withTimeout((d, cb) => sftp.stat(d, cb))(P(p)),
                  lstat: (p) => withTimeout((d, cb) => sftp.lstat(d, cb))(P(p)),
                  mkdir: (dir) => withTimeout((d, cb) => sftp.mkdir(d, cb))(P(dir)),
                  rmdir: (dir) => withTimeout((d, cb) => sftp.rmdir(d, cb))(P(dir)),
                  unlink: (p) => withTimeout((d, cb) => sftp.unlink(d, cb))(P(p)),
                  rename: (p, d) => withTimeout((a, b, cb) => sftp.rename(a, b, cb))(P(p), P(d)),
                  realpath: (p) => withTimeout((d, cb) => sftp.realpath(d, cb))(P(p)),
                  readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
                  writeFile: (p, data) => withTimeout((d, data2, cb) => sftp.writeFile(d, data2, cb))(P(p), data),
                  fastGet: (p, lp) => withTimeout((d, l, cb) => sftp.fastGet(d, l, cb))(P(p), lp),
                  fastPut: (lp, p) => withTimeout((l, d, cb) => sftp.fastPut(l, d, cb))(lp, P(p)),
                  // Range read for oversized previews: never downloads the whole file.
                  readPartial: (p, offset, length) => withTimeout((d, off, len, cb) => {
                    sftp.open(d, 'r', (e, handle) => {
                      if (e) return cb(e)
                      const buf = Buffer.alloc(len)
                      sftp.read(handle, buf, 0, len, off, (e2, bytesRead, data) => {
                        sftp.close(handle, () => {})
                        if (e2) return cb(e2)
                        cb(null, Buffer.isBuffer(data) ? data.subarray(0, bytesRead) : buf.subarray(0, bytesRead))
                      })
                    })
                  })(P(p), offset, length),
                })
              })
            } catch (e) {
              clearAttempt()
              reject(new Error('ssh sftp failed: ' + ((e && e.message) || e)))
            }
          }
          runOn(client)
        }),
    )
  }

  /**
   * Drop the cached client and force a fresh connection on the next call.
   * Called when a channel open fails (e.g. "Channel open failure: open
   * failed") — the pooled SSH connection is usually dead server-side while
   * keepalive has not yet noticed, and reusing it keeps failing. The epoch
   * bump orphans any in-flight connect; the client is ended so ssh2 frees
   * its sockets.
   */
  invalidate() {
    this.epoch++
    if (this.openSsh) this.openSsh.close()
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try { client.end() } catch {}
    }
    // Same teardown as close(): the forwards manager must detach from the
    // dying client, or its stale `close -> stopAll()` listener later tears
    // down forwards that were re-attached to the NEW client (onReady does
    // the re-attach on the next successful connect).
    if (this.onCloseHook) {
      try { this.onCloseHook() } catch {}
    }
  }

  close() {
    this.epoch++
    if (this.openSsh) this.openSsh.close()
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try {
        client.end()
      } catch {}
    }
    if (this.onCloseHook) {
      try { this.onCloseHook() } catch {}
    }
  }
}
