// Settings-panel routes for workspace backup / restore.
//
// Kept in its own module (like lib/routes-fs.js) so the route surface stays
// readable and the whole thing is unit-testable with an injected binding — the
// production wiring in lib/index.js supplies the real SSH pool, audit log and
// configuration.
//
// Scope: the machine/session-scoped JSON API behind Settings → 工作区备份. The
// panel deliberately exposes only two actions (create / restore) plus
// list-verify-delete housekeeping; the model-facing equivalents are the
// rw_backup / rw_backup_list / rw_restore tools, which share lib/backup.js.
import {
  listBackups, verifyBackup, deleteBackup, pullBackup, listLocalBackups,
  deleteLocalBackup, verifyLocalBackup, resolveRemoteHome, describeCreate,
  createAllBackup, restoreAllBackup,
} from './backup.js'
import { resolveBackupDir, isSafeArchiveName, DEFAULT_MAX_TRANSFER_BYTES } from './archive.js'

/** Default cap on a cross-machine archive copy; the archive itself is uncapped. */
export { DEFAULT_MAX_TRANSFER_BYTES }

/**
 * @param {object} deps
 * @param {Function} deps.sendJson - (res, status, body)
 * @param {Function} deps.readBody - (req) => Promise<string>
 * @param {object} deps.config - the resolved plugin config
 * @param {Function} deps.audit - (op, detail, code, target)
 * @param {Function} deps.resolveRequestBinding - (req, body) => binding (see routes-fs)
 * @param {Function} deps.resolveMachineBinding - (machineId) => binding for an explicit machine
 * @param {Function} deps.localRootFor - (binding) => local directory for pulled archives
 * @param {Function} deps.workspacesFor - (binding) => string[] of REMOTE workspace paths
 * @returns {Array<object>} route definitions
 */
export function createBackupRoutes({
  sendJson, readBody, config, audit, resolveRequestBinding, resolveMachineBinding, localRootFor,
  workspacesFor,
}) {
  const maxTransfer = Number(config.maxBackupTransferBytes) > 0
    ? Number(config.maxBackupTransferBytes)
    : DEFAULT_MAX_TRANSFER_BYTES

  /** The remote backup directory for a binding (config override → $HOME/.dsh-remote/backups). */
  const backupDirFor = async (b) => {
    const override = String(config.backupDir || '').trim()
    if (override) return resolveBackupDir('', override)
    // Resolved remotely so a Windows/posix home is reported by the host that
    // actually owns it, never guessed from the local machine.
    const home = await resolveRemoteHome(b.pool)
    return resolveBackupDir(home, '')
  }

  const bindOrReply = async (req, res, body = {}) => {
    try {
      // An explicit machineId targets that machine (the settings page lets the
      // operator act on a machine that is not the current one); otherwise the
      // session-scoped binding applies, with the active machine as the documented
      // fallback for the machine-scoped settings view.
      if (body && body.machineId && typeof resolveMachineBinding === 'function') {
        return await resolveMachineBinding(String(body.machineId))
      }
      return await resolveRequestBinding(req, body)
    } catch (err) {
      sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
      return null
    }
  }

  /** Everything the panel needs to render: remote archives + local copies. */
  const collect = async (b) => {
    let dir = ''
    let remote = { exists: false, dir: '', entries: [], error: '' }
    try {
      dir = await backupDirFor(b)
      if (dir) remote = await listBackups(b.pool, { dir })
    } catch (err) {
      remote = { exists: false, dir, entries: [], error: String((err && err.message) || err) }
    }
    const localDir = localRootFor(b)
    const local = listLocalBackups(localDir)
    // Which remote workspaces this backup WOULD include — shown before the user
    // clicks, so "back up all my workspaces" is never a surprise.
    let covers = []
    try {
      covers = typeof workspacesFor === 'function' ? (workspacesFor(b) || []) : (b.ws ? [b.ws] : [])
    } catch { covers = b.ws ? [b.ws] : [] }
    return {
      workspace: b.ws || '',
      covers,
      host: b.host,
      username: b.username,
      port: b.port,
      backupDir: dir,
      exists: !!remote.exists,
      error: remote.error || '',
      entries: (remote.entries || []).map((e) => ({ ...e, source: 'remote' })),
      local: {
        dir: localDir,
        exists: !!local.exists,
        entries: local.entries.map((e) => ({
          ...e,
          source: 'local',
          // The local digest is recomputed lazily on verify; reporting the
          // recorded one here would look like verification that never ran.
        })),
      },
      maxTransferBytes: maxTransfer,
    }
  }

  return [
    {
      kind: 'exact',
      path: '/dsh-remote/backup',
      handler: async (req, res) => {
        // ── list ────────────────────────────────────────────────────────────
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const hint = {
            sessionId: q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : '',
            local: q.get('local') ? decodeURIComponent(q.get('local')) : '',
            machineId: q.get('machineId') ? decodeURIComponent(q.get('machineId')) : '',
          }
          const b = await bindOrReply(req, res, hint)
          if (!b) return
          try {
            return sendJson(res, 200, { ok: true, ...(await collect(b)) })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

        // ── actions ─────────────────────────────────────────────────────────
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
        const action = String(body.action || '')
        const b = await bindOrReply(req, res, body)
        if (!b) return

        try {
          if (action === 'create') {
            // ONE button: archive every remote workspace the sidebar knows about
            // for this machine. There is no per-workspace choice, no exclude box
            // and no destination picker on purpose — the default exclude set
            // (dependency/build trees) is the only thing worth deciding, and it
            // lives in code where it is reviewable.
            const backupDir = await backupDirFor(b)
            if (!backupDir) return sendJson(res, 400, { ok: false, error: '无法确定远端 $HOME，请配置 backupDir' })
            let covers = []
            try { covers = (typeof workspacesFor === 'function' ? workspacesFor(b) : []) || [] } catch { covers = [] }
            if (!covers.length && b.ws) covers = [b.ws]
            if (!covers.length) {
              return sendJson(res, 400, { ok: false, error: '没有可备份的远程工作区——先在侧边栏里选一个远程工作区' })
            }
            const result = await createAllBackup(b.pool, {
              workspaces: covers,
              backupDir,
              machine: { host: b.host, username: b.username, port: b.port },
              label: 'all',
            })
            if (!result.ok) {
              audit('backup', `backup ${covers.length} workspace(s) failed: ${result.error}`, 1, b)
              return sendJson(res, 500, { ok: false, error: result.error })
            }
            audit('backup', `backup ${covers.length} workspace(s) → ${result.archive}`, 0, b)
            return sendJson(res, 200, {
              ok: true,
              created: {
                name: result.name,
                archive: result.archive,
                bytes: result.bytes,
                members: result.members,
                sha256: result.sha256,
                verified: result.verified,
                workspaces: covers,
              },
              summary: describeCreate(result, { dest: 'remote' }),
              ...(await collect(b)),
            })
          }

          if (action === 'restore') {
            // Restoring is destructive by nature, so the UI must confirm it and
            // the route enforces that the confirmation is explicit.
            if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: '恢复需要显式确认（confirm: true）' })
            const file = String(body.file || '')
            if (!isSafeArchiveName(file)) return sendJson(res, 400, { ok: false, error: '无效的备份文件名' })
            const dir = await backupDirFor(b)
            if (!dir) return sendJson(res, 400, { ok: false, error: '无法确定远端备份目录' })
            const archive = `${dir.replace(/\/+$/, '')}/${file}`
            const r = await restoreAllBackup(b.pool, { archive, fallbackRoot: '/tmp' })
            audit('restore', `restore ${file} (${r.members} workspace(s))`, r.ok ? 0 : 1, b)
            if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            return sendJson(res, 200, {
              ok: true,
              restored: { file, targets: r.entries, count: r.members },
              text: `已恢复 ${r.members} 个工作区：${(r.entries || []).join('、')}`,
              // A partial restore reports what moved AND what failed.
              warning: r.error || '',
              ...(await collect(b)),
            })
          }

          if (action === 'delete') {
            const file = String(body.file || '')
            if (!isSafeArchiveName(file)) return sendJson(res, 400, { ok: false, error: '无效的备份文件名' })
            const where = body.where === 'local' ? 'local' : 'remote'
            let result
            if (where === 'local') {
              result = deleteLocalBackup(localRootFor(b), file)
            } else {
              result = await deleteBackup(b.pool, { archive: `${(await backupDirFor(b)).replace(/\/+$/, '')}/${file}` })
            }
            audit('backup-delete', `delete ${where} backup ${file}`, result.ok ? 0 : 1, b)
            if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error })
            return sendJson(res, 200, { ok: true, ...(await collect(b)) })
          }

          if (action === 'verify') {
            const file = String(body.file || '')
            if (!isSafeArchiveName(file)) return sendJson(res, 400, { ok: false, error: '无效的备份文件名' })
            const where = body.where === 'local' ? 'local' : 'remote'
            const result = where === 'local'
              ? verifyLocalBackup(localRootFor(b), file)
              : await verifyBackup(b.pool, { archive: `${(await backupDirFor(b)).replace(/\/+$/, '')}/${file}` })
            return sendJson(res, 200, {
              ok: !!result.ok,
              verified: where === 'local' ? result.matches !== false : !!result.verified,
              bytes: result.bytes,
              sha256: result.sha256,
              members: result.members,
              expectedSha256: result.expectedSha256,
              matches: result.matches ?? null,
              error: result.error || '',
            })
          }

          if (action === 'download') {
            const file = String(body.file || '')
            if (!isSafeArchiveName(file)) return sendJson(res, 400, { ok: false, error: '无效的备份文件名' })
            const pulled = await pullBackup(b.pool, {
              archive: `${(await backupDirFor(b)).replace(/\/+$/, '')}/${file}`,
              localDir: localRootFor(b),
              maxTransferBytes: maxTransfer,
            })
            if (!pulled.ok) return sendJson(res, 500, { ok: false, error: pulled.error })
            audit('backup-download', `pull ${file} → ${pulled.localPath}`, 0, b)
            return sendJson(res, 200, {
              ok: true,
              localPath: pulled.localPath,
              bytes: pulled.bytes,
              text: `已下载到本机：${pulled.localPath}（${formatBytes(pulled.bytes)}）`,
              ...(await collect(b)),
            })
          }

          if (action === 'upload') {
            // Push a locally held archive back to the remote (the inverse of
            // download), which is the prerequisite for restoring a local copy
            // on a fresh machine.
            const file = String(body.file || '')
            if (!isSafeArchiveName(file)) return sendJson(res, 400, { ok: false, error: '无效的备份文件名' })
            const localDir = localRootFor(b)
            const dir = await backupDirFor(b)
            if (!dir) return sendJson(res, 400, { ok: false, error: '无法确定远端备份目录' })
            const up = await pushBackup(b.pool, { localPath: `${localDir.replace(/\/+$/, '')}/${file}`, remoteDir: dir, maxTransferBytes: maxTransfer })
            if (!up.ok) return sendJson(res, 500, { ok: false, error: up.error })
            audit('backup-upload', `push ${file} → ${up.remotePath}`, 0, b)
            return sendJson(res, 200, { ok: true, remotePath: up.remotePath, bytes: up.bytes, ...(await collect(b)) })
          }

          return sendJson(res, 400, { ok: false, error: `unknown action: ${action || '(none)'}` })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
