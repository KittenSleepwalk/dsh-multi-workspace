/**
 * dsh-multi-workspace — 多文件夹工作区插件 · Host 半侧
 *
 * 目标：让一个项目（一个 workspace / 会话 cwd）额外挂载多个文件夹，且这些文件夹在
 * DSH 沙盒里与"当前工作区"同权可写：
 *   - write / edit 工具：把当次调用的 sandbox policy.workspaceRoot 临时替换成命中的额外根
 *     （dsh-fs-sandbox 的围栏是纯函数 writableRoots(policy)，替换根即可放行）；
 *   - bash / pwsh / 终端 / PTC：在额外根上，用**主根同一个** workspaceWriteSid 打一套
 *     AclWriteGrant 授权（Windows ACL 后端下，写入权限只由 restricting SID × DACL ACE ×
 *     Low 完整性标签决定，与 --workspace 声明无关）。runner 的 argv 完全不变。
 *
 * 设计约束（来自实测，见 _mw/notes/research-sandbox-multiroot.md）：
 *   1. 授权/撤销必须发生在 host 进程（本插件就是 host 插件；受限工具进程无 WRITE_DAC）。
 *   2. SID 必须由 canonical 路径派生：本插件一切 key 都先 realpathSync.native。
 *   3. grantWrite 会额外加一条 Everyone(CI)(DENY)(DC)；AclWriteGrant.dispose 不撤它。
 *      卸载时用 `icacls <root> /remove:d *S-1-1-0` 精确清掉（实测可恢复到原 ACL），
 *      但仅当挂载前快照里没有 Everyone 的 DENY 时才执行，避免误删用户自己的拒绝项。
 *   4. 只对本地固定 NTFS/ReFS 卷挂载；UNC / 映射网络盘在服务端不看 restricting SID，
 *      写限制会失效，必须拒绝。
 *
 * 升级安全：本文件不静态 import 任何 @deepseek-ai/dsh-*；唯一运行时依赖
 * （dsh-sandbox-windows-acl）用 try/catch 动态 import，失败即降级为"只读扩展"，绝不让
 * harness 启动失败。所有异步/定时/监听器都包 try/catch，避免触发 installFailLoud。
 *
 * @module dsh-multi-workspace
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'multi-workspace'

const ROUTE_PREFIX = '/dsh-multi-workspace'
const CONFIG_VERSION = 1
const PATCH_MARK = Symbol.for('dsh-multi-workspace.patched')
const PATCH_MARK_CONFINE = Symbol.for('dsh-multi-workspace.patched-confine')
const HOME_PATCH_MARK = Symbol.for('dsh-multi-workspace.patched-policy')
const MAX_BODY_BYTES = 64 * 1024
const MAX_VOLUME_PROBE_MS = 8000

/* ------------------------------------------------------------------ utils -- */

function logOf(ctx) {
  return {
    info: (...args) => {
      try {
        ctx.logger?.info?.(...args)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
    warn: (...args) => {
      try {
        ctx.logger?.warn?.(...args)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
  }
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

function homeOf(ctx) {
  try {
    const home = ctx.get('profileContext')?.home
    if (typeof home === 'string' && home !== '') return home
  } catch {
    /* profileContext 可能缺失 */
  }
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/** Canonical spelling, matching dsh-sandbox's canonicalPath (realpathSync.native). */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolvePath(path)
  }
}

function comparable(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Whether `candidate` is `root` itself or below it (both canonical). */
function isUnder(candidate, root) {
  const c = comparable(candidate)
  const r = comparable(root)
  if (c === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return c.startsWith(prefix)
}

function isAbsoluteDirectory(path) {
  try {
    return isAbsolute(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isUncPath(path) {
  return path.startsWith('\\\\') || path.startsWith('//')
}

function driveOf(path) {
  return process.platform === 'win32' ? path.slice(0, 2).toUpperCase() : ''
}

function execP(command, args, timeoutMs = MAX_VOLUME_PROBE_MS) {
  return new Promise((resolvePromise) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolvePromise({ ok: error === null, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (error) {
      resolvePromise({ ok: false, code: -1, stdout: '', stderr: messageOf(error) })
    }
  })
}

/* ------------------------------------------------------------------ store -- */

/**
 * 持久化结构（<home>/multi-workspace/config.json）：
 * {
 *   version: 1,
 *   workspaces: {
 *     "<canonical workspace path>": {
 *       title?: string,
 *       folders: [{ path, addedAt, mountedAt?, sid?, baselineHasDeny? }]
 *     }
 *   }
 * }
 * `baselineHasDeny` 是挂载前该目录是否已有 Everyone 的 DENY ACE（决定卸载时能否安全清理）。
 */
function configPathOf(ctx) {
  return join(homeOf(ctx), 'multi-workspace', 'config.json')
}

function emptyConfig() {
  return { version: CONFIG_VERSION, workspaces: {}, pinned: [] }
}

function normalizeConfig(raw) {
  const config = emptyConfig()
  if (raw === null || typeof raw !== 'object') return config
  const workspaces = raw.workspaces
  if (workspaces === null || typeof workspaces !== 'object') {
    config.pinned = normalizePinned(raw.pinned)
    return config
  }
  for (const [key, value] of Object.entries(workspaces)) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.folders)) continue
    const folders = []
    const seen = new Set()
    for (const entry of value.folders) {
      const path = typeof entry === 'string' ? entry : entry?.path
      if (typeof path !== 'string' || path === '' || !isAbsolute(path)) continue
      const canonicalPath = canonical(path)
      if (seen.has(comparable(canonicalPath))) continue
      seen.add(comparable(canonicalPath))
      folders.push({
        path: canonicalPath,
        addedAt: typeof entry?.addedAt === 'string' ? entry.addedAt : new Date().toISOString(),
        mountedAt: typeof entry?.mountedAt === 'string' ? entry.mountedAt : undefined,
        sid: typeof entry?.sid === 'string' ? entry.sid : undefined,
        baselineHasDeny: entry?.baselineHasDeny === true,
      })
    }
    config.workspaces[key] = { title: typeof value.title === 'string' ? value.title : undefined, folders }
  }
  config.pinned = normalizePinned(raw.pinned)
  return config
}

/** Pinned workspace paths, in pin order (most recently pinned first), de-duplicated. */
function normalizePinned(raw) {
  const pinned = []
  if (!Array.isArray(raw)) return pinned
  const seen = new Set()
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry === '' || !isAbsolute(entry)) continue
    const canonicalPath = canonical(entry)
    const key = comparable(canonicalPath)
    if (seen.has(key)) continue
    seen.add(key)
    pinned.push(canonicalPath)
  }
  return pinned
}

function loadConfigSync(ctx) {
  try {
    const file = configPathOf(ctx)
    if (!existsSync(file)) return emptyConfig()
    return normalizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logOf(ctx).warn(`multi-workspace: config read failed (${messageOf(error)}); starting empty`)
    return emptyConfig()
  }
}

/* --------------------------------------------------------- acl capability -- */

/** Lazily resolve the Windows ACL helper package from the running installation. */
function createAclLoader(ctx) {
  let promise
  return function aclModule() {
    if (promise !== undefined) return promise
    promise = (async () => {
      if (process.platform !== 'win32') return null
      const attempts = []
      // 1) bare specifier: dsh-app-boot installs a runtime resolver table for plugin code.
      try {
        return await import('@deepseek-ai/dsh-sandbox-windows-acl')
      } catch (error) {
        attempts.push(`bare import: ${messageOf(error)}`)
      }
      // 2) fallback: resolve from the installation anchor (createRequire).
      try {
        const anchor = ctx.get('profileContext')?.installAnchor
        if (typeof anchor === 'string' && anchor !== '') {
          const requireFromInstall = createRequire(anchor)
          const resolved = requireFromInstall.resolve('@deepseek-ai/dsh-sandbox-windows-acl')
          return await import(pathToFileURL(resolved).href)
        }
        attempts.push('installAnchor unavailable')
      } catch (error) {
        attempts.push(`installAnchor resolve: ${messageOf(error)}`)
      }
      logOf(ctx).warn(`multi-workspace: Windows ACL capability unavailable (${attempts.join(' | ')})`)
      return null
    })()
    return promise
  }
}

/* ------------------------------------------------------------- validation -- */

/** Expand `~/...` against the OS home (docs recommend absolute paths). */
function expandProtectedRoot(raw) {
  const value = String(raw).trim()
  if (value === '') return ''
  if (value === '~') return canonical(homedir())
  if (value.startsWith('~/') || value.startsWith('~\\')) return canonical(join(homedir(), value.slice(2)))
  return canonical(value)
}

/**
 * Read the opt-in allowlist for otherwise-protected paths (e.g. DSH home / install root).
 *
 * Source of truth is the plugin config in `<profile>/cordis.patch.yml`:
 *
 *   - id: multi-workspace
 *     name: 'dsh-multi-workspace'
 *     config:
 *       allowProtectedRoots:
 *         - '%USERPROFILE%\.dsh'
 *       # allowDshHome: true   # convenience: the whole $DSH_HOME
 *
 * Config needs no schema (`resolveConfig` passes raw config through when the
 * plugin has no `Config`), so we validate defensively here.
 *
 * @param ctx - plugin context (for DSH home resolution).
 * @param config - raw entry config from the loader.
 * @returns canonical allowlisted roots (deduplicated).
 */
function normalizeAllowRoots(ctx, config) {
  const roots = []
  try {
    if (config !== null && typeof config === 'object' && config.allowDshHome === true) roots.push(canonical(homeOf(ctx)))
    const list = config !== null && typeof config === 'object' && Array.isArray(config.allowProtectedRoots) ? config.allowProtectedRoots : []
    for (const entry of list) {
      if (typeof entry !== 'string') continue
      const expanded = expandProtectedRoot(entry)
      if (expanded !== '') roots.push(expanded)
    }
  } catch {
    /* 配置异常时退化为“不放行任何受保护路径” */
  }
  return [...new Set(roots)]
}

/** Whether a canonical path is covered by an explicit allowlist entry. */
function isProtectionBypassed(candidate, allowRoots) {
  return allowRoots.some((root) => isUnder(candidate, root))
}

const PROTECTED_HINT = '如确需允许，请在 profile 的 cordis.patch.yml 里给 multi-workspace 行加 config.allowProtectedRoots（见插件 README「允许受保护路径」）。'

function describeRejection(ctx, path, allowRoots = []) {
  const home = canonical(homeOf(ctx))
  const canonicalPath = canonical(path)
  if (!isAbsolute(path)) return '必须是绝对路径'
  if (!isAbsoluteDirectory(canonicalPath)) return '目录不存在或不是文件夹'
  if (isUncPath(path)) return '不支持 UNC 网络路径'
  if (process.platform === 'win32') {
    const drive = driveOf(canonicalPath)
    if (drive === '') return '无法识别盘符'
    if (drive === 'A:' || drive === 'B:') return '不支持软驱盘符'
  }
  const bypass = isProtectionBypassed(canonicalPath, allowRoots)
  if (!bypass && isUnder(canonicalPath, home)) {
    return `不能选择 DSH 自己的用户数据目录（$DSH_HOME）${PROTECTED_HINT}`
  }
  const installAnchor = ctx.get('profileContext')?.installAnchor
  if (typeof installAnchor === 'string' && installAnchor !== '') {
    const installRoot = canonical(dirname(dirname(dirname(dirname(installAnchor)))))
    if (!bypass && isUnder(canonicalPath, installRoot)) return `不能选择 DSH 安装目录${PROTECTED_HINT}`
  }
  if (process.platform === 'win32' && /^[a-z]:\\$/iu.test(canonicalPath)) return '不能选择盘符根目录'
  return undefined
}

/** Volume preflight: local fixed NTFS/ReFS only (SMB ignores restricting SIDs). */
async function checkVolume(ctx, path) {
  if (process.platform !== 'win32') return { ok: true, format: 'n/a', type: 'n/a' }
  const drive = driveOf(canonical(path))
  if (drive === '') return { ok: false, reason: '无法识别盘符' }
  const letter = drive.slice(0, 1)
  const r = await execP('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$d=[System.IO.DriveInfo]::new('${letter}'); Write-Output ($d.DriveType); Write-Output ($d.DriveFormat)`,
  ])
  if (!r.ok) return { ok: true, unknown: true, reason: `卷信息探测失败：${r.stderr.trim() || 'unknown'}` }
  const lines = r.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
  const type = lines[0] ?? ''
  const format = lines[1] ?? ''
  if (/network/iu.test(type) || /no root directory/iu.test(type)) return { ok: false, reason: `不支持网络盘（DriveType=${type}）` }
  if (/cdrom|no root/iu.test(type)) return { ok: false, reason: `不支持该卷类型（${type}）` }
  if (format !== '' && !/^(ntfs|refs)$/iu.test(format)) return { ok: false, reason: `只支持 NTFS/ReFS，当前为 ${format}` }
  return { ok: true, format, type }
}

/**
 * Whether the directory already carries an EXPLICIT Everyone DENY ACE before we grant.
 * Inherited ACEs (icacls `(I)`) are not ours and must not change the cleanup decision.
 */
async function snapshotDeny(ctx, path) {
  const r = await execP('icacls', [path])
  const lines = r.stdout.split(/\r?\n/u)
  const hasExplicitDeny = lines.some((line) => /everyone/iu.test(line) && /deny/iu.test(line) && !line.includes('(I)'))
  const hasAnyDeny = lines.some((line) => /everyone/iu.test(line) && /deny/iu.test(line))
  return { ok: r.ok, hasDeny: hasExplicitDeny, hasAnyDeny, raw: r.stdout.slice(0, 2000) }
}

/** Remove the EXPLICIT Everyone DENY ACE grantWrite added; inherited DENYs are not ours. */
async function removeAmbientDeny(ctx, path) {
  const r = await execP('icacls', [path, '/remove:d', '*S-1-1-0'])
  if (!r.ok) return { ok: false, message: r.stderr.trim() || r.stdout.trim() }
  const after = await execP('icacls', [path])
  const stillExplicit = after.stdout.split(/\r?\n/u).some((line) => /everyone/iu.test(line) && /deny/iu.test(line) && !line.includes('(I)'))
  return { ok: !stillExplicit, message: stillExplicit ? '显式 Everyone DENY 仍然存在' : undefined }
}

/* --------------------------------------------------------------- plugin -- */

export function apply(ctx, entryConfig) {
  const log = logOf(ctx)
  const aclModule = createAclLoader(ctx)
  const configFile = configPathOf(ctx)
  /** Opt-in allowlist for otherwise-protected roots (DSH home / install root). */
  const allowRoots = normalizeAllowRoots(ctx, entryConfig)

  /** In-memory config; loaded synchronously once so prompt providers are sync. */
  let config = loadConfigSync(ctx)
  let configWriteChain = Promise.resolve()

  /**
   * Mount state per canonical workspace:
   * workspace -> { folders: Map<canonicalFolder, { grant, state, error }> }
   */
  const mounts = new Map()
  const mountChain = new Map()

  const folderEntriesOf = (workspace) => config.workspaces[canonical(workspace)]?.folders ?? []
  const hasFolders = (workspace) => {
    const entries = config.workspaces[canonical(workspace)]
    return entries !== undefined && entries.folders.length > 0
  }

  function persist() {
    const snapshot = JSON.stringify(config, null, 2)
    configWriteChain = configWriteChain
      .then(async () => {
        await mkdir(dirname(configFile), { recursive: true })
        const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, configFile)
      })
      .catch((error) => {
        log.warn(`multi-workspace: config write failed (${messageOf(error)})`)
      })
    return configWriteChain
  }

  /* ------------------------------------------------------ mount lifecycle -- */

  function mountState(workspace) {
    const ws = canonical(workspace)
    let mounted = mounts.get(ws)
    if (mounted === undefined) {
      mounted = { folders: new Map() }
      mounts.set(ws, mounted)
    }
    return mounted
  }

  function mountEntry(workspace, folder) {
    return mountState(workspace).folders.get(comparable(canonical(folder)))
  }

  /**
   * Materialize (or verify) the write grant for one configured folder.
   * Idempotent: the module's exact-ACE skip makes a re-grant O(1).
   * @returns {Promise<{ok: boolean, state: string, error?: string}>}
   */
  async function mountOne(workspace, folder, options = {}) {
    const ws = canonical(workspace)
    const root = canonical(folder)
    const acl = await aclModule()
    if (acl === null) return { ok: false, state: 'unsupported', error: 'Windows ACL 授权能力不可用（当前平台或运行时缺少 dsh-sandbox-windows-acl）' }
    const state = mountState(ws)
    const key = comparable(root)
    const existing = state.folders.get(key)
    if (existing !== undefined && existing.grant !== null && existing.state === 'mounted' && options.force !== true) {
      return { ok: true, state: 'mounted' }
    }
    if (!isAbsoluteDirectory(root)) return { ok: false, state: 'missing', error: '目录不存在或不是文件夹' }
    const rejection = describeRejection(ctx, root, allowRoots)
    if (rejection !== undefined) return { ok: false, state: 'rejected', error: rejection }
    if (isUnder(root, ws)) return { ok: false, state: 'redundant', error: '该目录已在当前工作区内，无需挂载' }
    const bypass = isProtectionBypassed(root, allowRoots)
    if (isUnder(ws, root) && !bypass) return { ok: false, state: 'rejected', error: `不能选择当前工作区的上级目录；${PROTECTED_HINT}` }

    const volume = await checkVolume(ctx, root)
    if (!volume.ok) {
      state.folders.set(key, { grant: null, state: 'rejected', error: volume.reason })
      return { ok: false, state: 'rejected', error: volume.reason }
    }

    const denysnapshot = await snapshotDeny(ctx, root)
    const entry = entriesOf(ws).find((candidate) => comparable(canonical(candidate.path)) === key)
    if (entry !== undefined && denysnapshot.ok) entry.baselineHasDeny = denysnapshot.hasDeny

    let sid
    let grant = null
    try {
      sid = acl.workspaceWriteSid(ws)
      grant = acl.AclWriteGrant.create(sid)
      grant.add(root, false) // revocable：保留实例，卸载时可撤销
    } catch (error) {
      try {
        grant?.dispose?.()
      } catch {
        /* 清理失败忽略 */
      }
      const message = messageOf(error)
      const friendly = /access is denied|win32 5/iu.test(message)
        ? `无法修改该目录的安全设置：需要目录所有者权限（WRITE_OWNER/FULL CONTROL）。原始错误：${message}`
        : message
      state.folders.set(key, { grant: null, state: 'failed', error: friendly })
      return { ok: false, state: 'failed', error: friendly }
    }

    state.folders.set(key, { grant, state: 'mounted', error: undefined })
    if (entry !== undefined) {
      entry.mountedAt = new Date().toISOString()
      entry.sid = sid
      if (denysnapshot.ok) entry.baselineHasDeny = denysnapshot.hasDeny
    }
    void persist()
    log.info(`multi-workspace: mounted ${root} into ${ws} (sid ${sid})`)
    return { ok: true, state: 'mounted' }
  }

  /** Ensure every configured folder of this workspace is granted (lazy, before a confined call). */
  function ensureMounted(workspace) {
    const ws = canonical(workspace)
    if (!hasFolders(ws)) return Promise.resolve()
    const previous = mountChain.get(ws) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        for (const entry of folderEntriesOf(ws)) {
          try {
            const result = await mountOne(ws, entry.path)
            if (result.ok !== true) log.warn(`multi-workspace: mount ${entry.path} failed: ${result.error ?? result.state}`)
          } catch (error) {
            log.warn(`multi-workspace: mount ${entry.path} threw: ${messageOf(error)}`)
          }
        }
      })
      .catch((error) => {
        log.warn(`multi-workspace: ensureMounted failed: ${messageOf(error)}`)
      })
    mountChain.set(ws, next)
    return next
  }

  /** Revoke one folder's grant and best-effort restore the directory ACL. */
  async function unmountOne(workspace, folder) {
    const ws = canonical(workspace)
    const root = canonical(folder)
    const state = mountState(ws)
    const key = comparable(root)
    const existing = state.folders.get(key)
    const entry = entriesOf(ws).find((candidate) => comparable(canonical(candidate.path)) === key)
    const failures = []
    const diagnostics = { hadGrant: existing !== undefined && existing.grant !== null, disposeError: undefined, beforeAcl: '', afterDisposeAcl: '', afterCleanupAcl: '' }
    try {
      diagnostics.beforeAcl = (await execP('icacls', [root])).stdout
    } catch {
      /* 诊断失败忽略 */
    }
    try {
      existing?.grant?.dispose?.()
    } catch (error) {
      diagnostics.disposeError = messageOf(error)
      failures.push(`撤销 ACE 失败：${diagnostics.disposeError}`)
    }
    try {
      diagnostics.afterDisposeAcl = (await execP('icacls', [root])).stdout
    } catch {
      /* 诊断失败忽略 */
    }
    if (entry !== undefined && entry.baselineHasDeny !== true) {
      const cleaned = await removeAmbientDeny(ctx, root)
      if (!cleaned.ok) failures.push(`清理 Everyone DENY 失败：${cleaned.message ?? 'unknown'}`)
    }
    try {
      diagnostics.afterCleanupAcl = (await execP('icacls', [root])).stdout
    } catch {
      /* 诊断失败忽略 */
    }
    state.folders.delete(key)
    log.info(`multi-workspace: unmounted ${root} from ${ws}${failures.length > 0 ? ` with ${failures.length} failure(s)` : ''}`)
    return { ok: failures.length === 0, failures, diagnostics }
  }

  function entriesOf(workspace) {
    return config.workspaces[canonical(workspace)]?.folders ?? []
  }

  /* ---------------------------------------------------------- fs patches -- */

  /**
   * Map a write/edit call's policy to the matched extra root.
   * The fs fence is pure over writableRoots(policy) = [canonical(workspaceRoot), tmp...], so
   * substituting the workspace root is sufficient; no fence code is copied.
   */
  async function mapPolicyForTarget(fsService, target, policy) {
    if (policy === null || policy === undefined || policy.mode !== 'workspace-write') return policy
    const ws = canonical(policy.workspaceRoot)
    if (!hasFolders(ws)) return policy
    const extras = entriesOf(ws).map((entry) => canonical(entry.path))
    if (extras.length === 0) return policy
    let key = target?.targetKey
    let display = target?.displayPath
    if (typeof display !== 'string') return policy
    // Cheap prefilter on the display path before a realpath round-trip.
    if (!extras.some((root) => isUnder(comparable(resolvePath(display)), comparable(root)))) return policy
    if (typeof key !== 'string' || key === '') {
      try {
        const resolved = await fsService.resolve(display)
        key = resolved.targetKey
      } catch {
        return policy
      }
    }
    for (const root of extras) {
      if (isUnder(key, root)) return { ...policy, workspaceRoot: root }
    }
    return policy
  }

  function patchFs(fsService) {
    if (fsService === null || fsService === undefined) return
    if (fsService[PATCH_MARK] === true) return
    const originalWrite = fsService.writeText
    const originalEdit = fsService.editText
    if (typeof originalWrite !== 'function' || typeof originalEdit !== 'function') {
      log.warn('multi-workspace: ctx.fs has no writeText/editText; multi-root write extension disabled')
      return
    }
    try {
      Object.defineProperty(fsService, PATCH_MARK, { value: true, configurable: true })
      fsService.writeText = async function patchedWriteText(target, content, expected, signal, policy) {
        let mapped = policy
        try {
          mapped = await mapPolicyForTarget(fsService, target, policy)
        } catch (error) {
          log.warn(`multi-workspace: write policy map failed: ${messageOf(error)}`)
        }
        return originalWrite.call(this, target, content, expected, signal, mapped)
      }
      fsService.editText = async function patchedEditText(target, edit, expected, signal, policy) {
        let mapped = policy
        try {
          mapped = await mapPolicyForTarget(fsService, target, policy)
        } catch (error) {
          log.warn(`multi-workspace: edit policy map failed: ${messageOf(error)}`)
        }
        return originalEdit.call(this, target, edit, expected, signal, mapped)
      }
      ctx.effect(() => () => {
        try {
          if (fsService.writeText?.name === 'patchedWriteText') fsService.writeText = originalWrite
          if (fsService.editText?.name === 'patchedEditText') fsService.editText = originalEdit
          delete fsService[PATCH_MARK]
        } catch {
          /* 恢复失败不影响运行 */
        }
      }, 'multi-workspace: fs patch cleanup')
    } catch (error) {
      log.warn(`multi-workspace: fs patch failed: ${messageOf(error)}`)
    }
  }

  /* ----------------------------------------------------- confine patches -- */

  function patchSandbox(provider) {
    if (provider === null || provider === undefined) return
    if (provider[PATCH_MARK_CONFINE] === true) return
    const originalConfine = provider.confine
    if (typeof originalConfine !== 'function') {
      log.warn('multi-workspace: ctx.sandbox has no confine; shell multi-root extension disabled')
      return
    }
    try {
      Object.defineProperty(provider, PATCH_MARK_CONFINE, { value: true, configurable: true })
      provider.confine = async function patchedConfine(argv, policy, signal) {
        try {
          if (policy !== null && policy !== undefined && policy.mode === 'workspace-write' && typeof policy.workspaceRoot === 'string') {
            await ensureMounted(policy.workspaceRoot)
          }
        } catch (error) {
          log.warn(`multi-workspace: confine pre-grant failed: ${messageOf(error)}`)
        }
        return originalConfine.call(this, argv, policy, signal)
      }
      ctx.effect(() => () => {
        try {
          if (provider.confine?.name === 'patchedConfine') provider.confine = originalConfine
          delete provider[PATCH_MARK_CONFINE]
        } catch {
          /* 恢复失败不影响运行 */
        }
      }, 'multi-workspace: sandbox patch cleanup')
    } catch (error) {
      log.warn(`multi-workspace: sandbox patch failed: ${messageOf(error)}`)
    }
  }

  function ensurePatches() {
    try {
      patchFs(ctx.get('fs'))
    } catch (error) {
      log.warn(`multi-workspace: ensurePatches(fs) failed: ${messageOf(error)}`)
    }
    try {
      patchSandbox(ctx.get('sandbox'))
    } catch (error) {
      log.warn(`multi-workspace: ensurePatches(sandbox) failed: ${messageOf(error)}`)
    }
  }

  ctx.effect(() => ensurePatches(), 'multi-workspace: initial patches')
  ctx.effect(
    () =>
      ctx.on('internal/service', () => {
        try {
          ensurePatches()
        } catch {
          /* 自愈失败忽略 */
        }
      }),
    'multi-workspace: service watch',
  )
  ctx.inject(['fs'], () => ensurePatches())
  ctx.inject(['sandbox'], () => ensurePatches())

  /* -------------------------------------------------------- prompt fact -- */

  ctx.inject(['systemPrompt'], (inner) => {
    try {
      let order = 111
      try {
        order = inner.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1
      } catch {
        /* 取不到就用量附近值 */
      }
      inner.systemPrompt.context({
        name: 'multi-workspace:roots',
        order,
        text: (assembly) => {
          try {
            const session = assembly?.agent?.session
            const cwd = session?.header?.cwd
            if (typeof cwd !== 'string' || cwd === '') return ''
            const ws = canonical(cwd)
            const entries = entriesOf(ws)
            if (entries.length === 0) return ''
            const lines = entries.map((entry) => `- ${entry.path}`)
            return [
              'Additional workspace folders for this project (same workspace-write boundary as the session workspace):',
              ...lines,
              'Files under these folders are readable and writable by the available file and shell tools.',
            ].join('\n')
          } catch {
            return ''
          }
        },
      })
    } catch (error) {
      log.warn(`multi-workspace: prompt context registration failed: ${messageOf(error)}`)
    }
  })

  /* ---------------------------------------------------------- http api -- */

  const json = (res, status, body) => {
    const payload = JSON.stringify(body)
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    } catch {
      /* 连接可能已断开 */
    }
  }

  const isLoopback = (req) => {
    const address = req?.socket?.remoteAddress
    if (typeof address !== 'string' || address === '') return false
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  const readBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) return null
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  }

  /** Resolve the calling workspace: live session cwd first, then the explicit path. */
  function resolveWorkspace(ctx2, sessionId, requested) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        const agents = ctx2.get('agents')
        const session = agents?.get?.(sessionId)?.session
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return canonical(cwd)
      } catch {
        /* 无 live agent 时回退 */
      }
      try {
        const sessions = ctx2.get('sessions')
        const found = sessions?.get?.(sessionId) ?? sessions?.store?.get?.(sessionId)
        const cwd = found?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return canonical(cwd)
      } catch {
        /* 会话存储形态可能不同 */
      }
    }
    if (typeof requested === 'string' && requested !== '' && isAbsolute(requested)) return canonical(requested)
    return undefined
  }

  function stateOf(workspace) {
    const ws = canonical(workspace)
    const entries = entriesOf(ws)
    const mounted = mounts.get(ws)?.folders
    const folders = entries.map((entry) => {
      const live = mounted?.get(comparable(canonical(entry.path)))
      return {
        path: entry.path,
        mounted: live?.state === 'mounted',
        state: live?.state ?? 'configured',
        error: live?.error ?? undefined,
        baselineHasDeny: entry.baselineHasDeny === true,
        addedAt: entry.addedAt,
        mountedAt: entry.mountedAt,
      }
    })
    return {
      ok: true,
      workspace: ws,
      configPath: configFile,
      platform: process.platform,
      sandboxExtension: process.platform === 'win32' ? 'windows-acl' : 'unsupported',
      allowProtectedRoots: allowRoots,
      folders,
      pinned: pinnedPaths(),
      workspaces: workspaceSummaries(),
    }
  }

  function route(ctx2, path, handler) {
    return ctx2.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + path,
      handler: async (req, res) => {
        try {
          ensurePatches()
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: 'forbidden', message: 'multi-workspace routes accept loopback requests only' })
            return
          }
          const result = await handler(req)
          if (res.writableEnded !== true) json(res, 200, result)
        } catch (error) {
          if (res.writableEnded === true) return
          const status = Number.isInteger(error?.status) ? error.status : 500
          json(res, status, { ok: false, error: error?.error ?? 'internal', message: messageOf(error) })
        }
      },
    })
  }

  const badRequest = (message, code = 'bad-request') => Object.assign(new Error(message), { status: 400, error: code })

  function addFolder(workspace, folder, options = {}) {
    const ws = canonical(workspace)
    const root = canonical(folder)
    if (comparable(root) === comparable(ws)) {
      return Promise.resolve({ ok: false, state: 'primary', error: '主工作区始终可用，不能作为「额外文件夹」添加' })
    }
    const rejection = describeRejection(ctx, root, allowRoots)
    if (rejection !== undefined) {
      // 已在工作区内属于"冗余"而非错误：明确返回，不落盘。
      if (isUnder(root, ws)) return Promise.resolve({ ok: false, state: 'redundant', error: '该目录已在当前工作区内，无需挂载' })
      throw badRequest(rejection)
    }
    const bypass = isProtectionBypassed(root, allowRoots)
    if (isUnder(ws, root) && !bypass) throw badRequest(`不能选择当前工作区的上级目录；${PROTECTED_HINT}`)
    const bucket = (config.workspaces[ws] ??= { folders: [] })
    if (bucket.folders.some((entry) => comparable(canonical(entry.path)) === comparable(root))) {
      return Promise.resolve({ ok: true, state: 'already-configured' })
    }
    bucket.folders.push({ path: root, addedAt: new Date().toISOString() })
    void persist()
    return mountOne(ws, root, options).then((result) => ({ ...result, workspace: ws, folder: root }))
  }

  async function removeFolder(workspace, folder) {
    const ws = canonical(workspace)
    const root = canonical(folder)
    if (comparable(root) === comparable(ws)) {
      throw Object.assign(new Error('不能移除当前主工作区文件夹'), { status: 400, error: 'primary-folder' })
    }
    const bucket = config.workspaces[ws]
    if (bucket === undefined) throw Object.assign(new Error('该工作区没有挂载记录'), { status: 404, error: 'not-found' })
    const index = bucket.folders.findIndex((entry) => comparable(canonical(entry.path)) === comparable(root))
    if (index < 0) throw Object.assign(new Error('该文件夹不在挂载列表中'), { status: 404, error: 'not-found' })
    const unmount = await unmountOne(ws, root)
    bucket.folders.splice(index, 1)
    void persist()
    return { ok: true, workspace: ws, folder: root, cleanupFailures: unmount.failures, diagnostics: unmount.diagnostics }
  }

  /* ------------------------------------------------------- workspace menu -- */

  const workspaceRegistryOf = () => {
    try {
      return ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  }

  /** Registry entity for a workspace path or id (undefined while the registry is unavailable). */
  function workspaceEntityOf(workspace, workspaceId) {
    const registry = workspaceRegistryOf()
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return undefined
    try {
      const entities = registry.list()
      if (typeof workspaceId === 'string' && workspaceId !== '') {
        const byId = entities.find((entity) => String(entity.id) === workspaceId)
        if (byId !== undefined) return byId
      }
      if (typeof workspace === 'string' && workspace !== '') {
        const target = comparable(canonical(workspace))
        return entities.find((entity) => comparable(canonical(entity.path)) === target)
      }
    } catch {
      /* registry 尚未就绪 */
    }
    return undefined
  }

  /** Resolve a menu request body to { path, id, title, entity } using id first, then path. */
  function resolveMenuWorkspace(inner, body) {
    const entity = workspaceEntityOf(body?.workspace, body?.workspaceId)
    if (entity !== undefined) {
      const path = canonical(entity.path)
      return { entity, path, id: String(entity.id), title: entity.title }
    }
    const path = resolveWorkspace(inner, body?.sessionId, body?.workspace)
    if (path === undefined) return undefined
    const byPath = workspaceEntityOf(path, '')
    return { entity: byPath, path, id: byPath === undefined ? '' : String(byPath.id), title: byPath === undefined ? '' : byPath.title }
  }

  /* -------------------------------------------------------- pinned order -- */

  const pinnedPaths = () => (Array.isArray(config.pinned) ? config.pinned : [])

  /** Registry order with pinned workspaces first (pin order), the rest in their current order. */
  function desiredWorkspaceOrder() {
    const registry = workspaceRegistryOf()
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return undefined
    let entities
    try {
      entities = registry.list()
    } catch {
      return undefined
    }
    const byPath = new Map(entities.map((entity) => [comparable(canonical(entity.path)), entity]))
    const ordered = []
    const used = new Set()
    for (const path of pinnedPaths()) {
      const entity = byPath.get(comparable(canonical(path)))
      if (entity === undefined) continue
      const id = String(entity.id)
      if (used.has(id)) continue
      used.add(id)
      ordered.push(id)
    }
    for (const entity of entities) {
      const id = String(entity.id)
      if (!used.has(id)) ordered.push(id)
    }
    return ordered
  }

  let pinChain = Promise.resolve()
  let pinTimer = null

  /** Move every pinned workspace above the rest, so a newly created workspace lands below the pinned block. */
  function enforcePinOrder(reason) {
    const registry = workspaceRegistryOf()
    const ordered = desiredWorkspaceOrder()
    if (registry === null || registry === undefined || ordered === undefined || ordered.length === 0) return Promise.resolve()
    let current
    try {
      current = registry.list().map((entity) => String(entity.id))
    } catch {
      return Promise.resolve()
    }
    if (current.join('|') === ordered.join('|')) return Promise.resolve()
    pinChain = pinChain
      .then(async () => {
        let live
        try {
          live = registry.list().map((entity) => String(entity.id))
        } catch {
          return
        }
        if (live.join('|') === ordered.join('|')) return
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
          await registry.insertBefore(ordered[index], index + 1 < ordered.length ? ordered[index + 1] : undefined)
        }
        log.info(`multi-workspace: pinned order enforced (${reason ?? 'manual'})`)
      })
      .catch((error) => log.warn(`multi-workspace: pinned order failed: ${messageOf(error)}`))
    return pinChain
  }

  function schedulePinOrder(reason) {
    if (pinTimer !== null) clearTimeout(pinTimer)
    pinTimer = setTimeout(() => {
      pinTimer = null
      void enforcePinOrder(reason)
    }, 250)
  }

  /** Workspace projections for the client's sidebar annotation (order = registry order). */
  function workspaceSummaries() {
    const registry = workspaceRegistryOf()
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return []
    const pinned = new Set(pinnedPaths().map((path) => comparable(canonical(path))))
    try {
      return registry.list().map((entity) => {
        const path = canonical(entity.path)
        return { id: String(entity.id), path, title: entity.title, pinned: pinned.has(comparable(path)) }
      })
    } catch {
      return []
    }
  }

  /** Hand one directory to the platform file manager. */
  function launchPath(target) {
    try {
      if (process.platform === 'win32') {
        const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true })
        child.on('error', () => {})
        child.unref()
        return true
      }
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    } catch {
      return false
    }
  }

  ctx.inject(['webServer'], (inner) => {
    const disposers = []
    disposers.push(
      route(inner, '/state', async (req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const workspace = resolveWorkspace(inner, url.searchParams.get('sessionId') ?? '', url.searchParams.get('workspace') ?? '')
        if (workspace === undefined) throw badRequest('无法确定当前工作区（缺少可解析的 sessionId 或 workspace）')
        return stateOf(workspace)
      }),
    )
    disposers.push(
      route(inner, '/add', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const workspace = resolveWorkspace(inner, body.sessionId, body.workspace)
        if (workspace === undefined) throw badRequest('缺少可解析的 workspace')
        const folder = typeof body.folder === 'string' ? body.folder : ''
        if (folder === '') throw badRequest('folder is required')
        const added = await addFolder(workspace, folder)
        if (added.ok !== true) {
          const error = Object.assign(new Error(added.error ?? '挂载失败'), { status: 409, error: added.state ?? 'mount-failed' })
          throw error
        }
        return { ...stateOf(workspace), action: added }
      }),
    )
    disposers.push(
      route(inner, '/remove', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const workspace = resolveWorkspace(inner, body.sessionId, body.workspace)
        if (workspace === undefined) throw badRequest('缺少可解析的 workspace')
        const folder = typeof body.folder === 'string' ? body.folder : ''
        if (folder === '') throw badRequest('folder is required')
        const removed = await removeFolder(workspace, folder)
        return { ...stateOf(workspace), action: removed }
      }),
    )
    disposers.push(
      route(inner, '/remount', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const workspace = resolveWorkspace(inner, body.sessionId, body.workspace)
        if (workspace === undefined) throw badRequest('缺少可解析的 workspace')
        for (const entry of entriesOf(workspace)) await mountOne(workspace, entry.path, { force: true })
        return stateOf(workspace)
      }),
    )
    disposers.push(
      route(inner, '/menu/open-all', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const resolved = resolveMenuWorkspace(inner, body)
        if (resolved === undefined) throw badRequest('缺少可解析的 workspace')
        const paths = []
        const add = (candidate) => {
          if (typeof candidate !== 'string' || candidate === '') return
          const root = canonical(candidate)
          if (paths.some((existing) => comparable(existing) === comparable(root))) return
          try {
            if (!statSync(root).isDirectory()) return
          } catch {
            return
          }
          paths.push(root)
        }
        add(resolved.path)
        for (const entry of entriesOf(resolved.path)) add(entry.path)
        const opened = []
        for (const target of paths) if (launchPath(target)) opened.push(target)
        return { ok: true, workspace: resolved.path, opened, count: opened.length }
      }),
    )
    disposers.push(
      route(inner, '/menu/pin', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const registry = workspaceRegistryOf()
        if (registry === null || registry === undefined || typeof registry.insertBefore !== 'function') {
          throw Object.assign(new Error('工作区注册表不可用'), { status: 409, error: 'registry-unavailable' })
        }
        const resolved = resolveMenuWorkspace(inner, body)
        if (resolved?.entity === undefined) throw badRequest('该工作区不在注册表中', 'workspace-unknown')
        const target = canonical(resolved.path)
        const key = comparable(target)
        const list = pinnedPaths().slice()
        const at = list.findIndex((path) => comparable(canonical(path)) === key)
        const pinned = at < 0
        if (pinned) list.unshift(target)
        else list.splice(at, 1)
        config.pinned = list
        void persist()
        await enforcePinOrder(pinned ? 'pin' : 'unpin')
        return { ok: true, pinned, workspace: target, pinnedWorkspaces: list, workspaces: workspaceSummaries() }
      }),
    )
    disposers.push(
      route(inner, '/menu/pinned', async () => {
        void enforcePinOrder('pinned query')
        return { ok: true, pinned: pinnedPaths(), workspaces: workspaceSummaries() }
      }),
    )
    disposers.push(
      route(inner, '/menu/archive', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const registry = workspaceRegistryOf()
        if (registry === null || registry === undefined || typeof registry.archiveSession !== 'function') {
          throw Object.assign(new Error('工作区注册表不可用'), { status: 409, error: 'registry-unavailable' })
        }
        const resolved = resolveMenuWorkspace(inner, body)
        if (resolved?.entity === undefined) throw badRequest('该工作区不在注册表中', 'workspace-unknown')
        const archivedSet = new Set(registry.archivedSessionIds.map(String))
        const sessionIds = [...resolved.entity.sessionIds].map(String)
        let archived = 0
        const skipped = []
        for (const sessionId of sessionIds) {
          if (archivedSet.has(sessionId)) continue
          try {
            await registry.archiveSession(sessionId)
            archived += 1
          } catch (error) {
            skipped.push({ sessionId, message: messageOf(error) })
          }
        }
        return { ok: true, workspace: resolved.path, archived, skipped, total: sessionIds.length }
      }),
    )
    disposers.push(
      route(inner, '/menu/rename', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') throw badRequest('工作区名称不能为空')
        const resolved = resolveMenuWorkspace(inner, body)
        if (resolved?.entity === undefined) throw badRequest('该工作区不在注册表中', 'workspace-unknown')
        if (resolved.entity.title !== title) {
          const registry = workspaceRegistryOf()
          const conflict =
            registry !== null &&
            registry !== undefined &&
            registry.list().some((candidate) => String(candidate.id) !== String(resolved.entity.id) && candidate.title === title)
          if (conflict) throw Object.assign(new Error(`已存在名为“${title}”的工作区`), { status: 409, error: 'name-conflict' })
          await resolved.entity.setTitle(title)
        }
        return { ok: true, workspace: resolved.path, title }
      }),
    )
    disposers.push(
      route(inner, '/menu/delete', async (req) => {
        const body = await readBody(req)
        if (body === null) throw badRequest('invalid JSON body')
        const registry = workspaceRegistryOf()
        if (registry === null || registry === undefined || typeof registry.delete !== 'function') {
          throw Object.assign(new Error('工作区注册表不可用'), { status: 409, error: 'registry-unavailable' })
        }
        const resolved = resolveMenuWorkspace(inner, body)
        if (resolved?.entity === undefined) throw badRequest('该工作区不在注册表中', 'workspace-unknown')
        const deleted = await registry.delete(String(resolved.entity.id))
        if (deleted !== true) throw Object.assign(new Error('删除工作区失败'), { status: 409, error: 'delete-failed' })
        return { ok: true, workspace: resolved.path }
      }),
    )
    disposers.push(
      route(inner, '/health', async () => {
        const acl = await aclModule()
        const mountSummary = []
        for (const [workspace, mounted] of mounts) {
          mountSummary.push({
            workspace,
            folders: [...mounted.folders.entries()].map(([key, value]) => ({ key, state: value.state, grantPaths: value.grant?.paths ?? [] })),
          })
        }
        return {
          ok: true,
          platform: process.platform,
          aclAvailable: acl !== null,
          configPath: configFile,
          home: homeOf(ctx),
          workspaces: Object.keys(config.workspaces).length,
          allowProtectedRoots: allowRoots,
          mounts: mountSummary,
          patches: {
            fs: ctx.get('fs')?.[PATCH_MARK] === true,
            sandbox: ctx.get('sandbox')?.[PATCH_MARK_CONFINE] === true,
          },
        }
      }),
    )
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 幂等卸载 */
          }
        }
      },
      'multi-workspace: routes cleanup',
    )
  })

  // 置顶是持久的：启动时、工作区列表变化时（尤其新建工作区）重新压到最上面。
  try {
    ctx.on('domain/changed', (change) => {
      if (change === null || typeof change !== 'object') return
      if (change.domain !== 'workspace') return
      if (change.table !== 'workspaces') return
      schedulePinOrder('workspace change')
    })
  } catch {
    /* 旧宿主没有该事件；下面的轮询仍会兜底 */
  }
  if (pinnedPaths().length > 0) schedulePinOrder('startup')
  const pinInterval = setInterval(() => {
    if (pinnedPaths().length > 0) void enforcePinOrder('interval')
  }, 15000)
  try {
    pinInterval.unref?.()
  } catch {
    /* ignore */
  }
  ctx.effect(
    () => () => {
      clearInterval(pinInterval)
      if (pinTimer !== null) {
        clearTimeout(pinTimer)
        pinTimer = null
      }
    },
    'multi-workspace: pinned order watcher',
  )

  log.info(
    `multi-workspace: ready (home=${homeOf(ctx)}, config=${configFile}, platform=${process.platform}, allowProtectedRoots=${allowRoots.length === 0 ? 'none' : allowRoots.join(' | ')})`,
  )
}
