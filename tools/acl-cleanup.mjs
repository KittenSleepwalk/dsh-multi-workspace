/**
 * acl-cleanup.mjs — 多文件夹工作区挂载的 ACL 清理工具（卸载/排障用）
 *
 * 作用：读取 <DSH_HOME>/multi-workspace/config.json，针对每个已挂载的
 * (workspace, folder)：
 *   1) 用 workspaceWriteSid(workspace) 重新创建 revocable grant 并 dispose → 撤销能力 SID 的
 *      Allow ACE（并尽力清掉 Low 完整性标签）；
 *   2) 若挂载前快照里没有 Everyone 的 DENY，则 `icacls <folder> /remove:d *S-1-1-0` 清掉
 *      grantWrite 留下的 Everyone(CI)(DENY)(DC)；
 *   3) 回读 icacls，报告是否仍有 DENY 残留。
 *
 * 必须在**未受限**的普通 shell 里运行（DSH host 或用户终端）；工具执行链里的受限进程
 * 没有 WRITE_DAC，调用会失败。
 *
 * 用法：
 *   node acl-cleanup.mjs --install "C:\...\dependencies\dsh" [--home "%USERPROFILE%\.dsh"] [--dry-run]
 *
 * @module dsh-multi-workspace/tools/acl-cleanup
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const install = arg('--install', '')
const home = arg('--home', process.env.DSH_HOME || join(homedir(), '.dsh'))
const dryRun = process.argv.includes('--dry-run')
if (install === '') {
  console.error('usage: node acl-cleanup.mjs --install <dsh-install-dir> [--home <dsh-home>] [--dry-run]')
  process.exit(2)
}

const configFile = join(home, 'multi-workspace', 'config.json')
if (!existsSync(configFile)) {
  console.log(JSON.stringify({ ok: true, skipped: 'no config file', configFile }, null, 2))
  process.exit(0)
}

const installAnchor = join(install, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const requireFromInstall = createRequire(existsSync(installAnchor) ? installAnchor : resolve(install, 'index.js'))
let acl
try {
  acl = await import(pathToFileURL(requireFromInstall.resolve('@deepseek-ai/dsh-sandbox-windows-acl')).href)
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `cannot load dsh-sandbox-windows-acl: ${String(error?.message ?? error)}` }, null, 2))
  process.exit(1)
}

const icacls = (path) => (spawnSync('icacls', [path], { encoding: 'utf8' }).stdout ?? '')

const config = JSON.parse(readFileSync(configFile, 'utf8'))
const report = { configFile, dryRun, actions: [] }

for (const [workspace, bucket] of Object.entries(config.workspaces ?? {})) {
  const folders = Array.isArray(bucket?.folders) ? bucket.folders : []
  for (const entry of folders) {
    const folder = typeof entry === 'string' ? entry : entry?.path
    if (typeof folder !== 'string' || folder === '') continue
    const baselineHasDeny = typeof entry === 'object' && entry !== null && entry.baselineHasDeny === true
    const action = { workspace, folder, baselineHasDeny }
    try {
      const sid = acl.workspaceWriteSid(workspace)
      if (dryRun) {
        action.sid = sid
        action.skipped = 'dry-run'
      } else {
        const grant = acl.AclWriteGrant.create(sid)
        try {
          grant.add(folder, false)
        } finally {
          grant.dispose()
        }
        action.revoked = true
        // 清理 grantWrite 留下、dispose 不会撤销的 Everyone(CI)(DENY)(DC)。
        const before = icacls(folder)
        if (!baselineHasDeny && /everyone/iu.test(before) && /deny/iu.test(before)) {
          const removed = spawnSync('icacls', [folder, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' })
          action.denyCleanup = { exit: removed.status, stderr: (removed.stderr ?? '').trim() }
        }
        const after = icacls(folder)
        action.residualDeny = after.split(/\r?\n/u).some((line) => /everyone/iu.test(line) && /deny/iu.test(line))
      }
    } catch (error) {
      action.error = String(error?.message ?? error)
    }
    report.actions.push(action)
  }
}

report.ok = report.actions.every((action) => action.error === undefined)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
