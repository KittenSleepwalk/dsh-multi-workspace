<div align="center">

# dsh-multi-workspace

**One project, more folders — write/edit and the shell get the same write rights in every one of them.**

A multi-folder workspace plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). A workspace keeps its primary folder and can mount one or more extra folders, and **the write/edit tools and the shell (pwsh/bash/terminal/PTC) write to those extra folders with the same rights as the main workspace**. The main workspace can never be removed.

<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-multi-workspace?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-multi-workspace?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace"><img alt="DSH >= 0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1-4d6bfe?style=flat-square"></a>
<img alt="Windows only" src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square">

**English** · [简体中文](./README.zh-CN.md)

</div>

> [!WARNING]
> **Only verified on one machine — not guaranteed to be fully safe.**
>
> - It runs fine on the author's machine, and sandbox verification through [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate) has passed too.
> - But it has **only been tried on that one single machine** — never on a second machine, and never on other DSH versions.
> - **This plugin modifies Windows ACLs and pulls extra folders into the sandbox's writable range, so the permission surface changes substantially.** **Back up `~/.dsh` before installing**, and make sure you accept that "extra folders are equally writable for write/edit and the shell".
>
> **Install [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate) first**: it runs each candidate plugin inside a throwaway sandbox copy first (boot, cold restarts, sessions, other plugins, hardware contention), and only lets it reach the host after it passes.
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🚀 Install

```bash
# 1) straight from GitHub (the repository root *is* the package root)
pnpm add github:KittenSleepwalk/dsh-multi-workspace

# 2) or from a local tarball
pnpm pack    # produces kittensleepwalk-dsh-multi-workspace-0.1.0.tgz
pnpm add ./kittensleepwalk-dsh-multi-workspace-0.1.0.tgz
```

This package ships its own `cordis.patch.yml`: after installing, just add the package name
`@kittensleepwalk/dsh-multi-workspace` to `dsh.profile.bundles` in your DSH profile — no hand-written
entry needed — and restart DSH for it to take effect.

Requirements: **Windows only** — Node.js ≥ 20, DSH ≥ 0.2.0-rc.1, with the ACL backend provided by
`@deepseek-ai/dsh-sandbox-windows-acl`. The `%USERPROFILE%` below is a placeholder — replace it with
whatever fits your environment.

---

## 🧭 Interaction

1. **The workspace (project) row's right-click menu** — and the very same menu opened by the three-dot
   button on the right of the row — are both normalized into the same fixed **six entries** (icon + text,
   styled with the host's own menu-row styles):

   ```
   Rename
   Open folders        ← opens the main folder + all extra folders at once
   ─────────
   Pin workspace       ← moves it to the top of the workspace list
   Workspace settings  ← this plugin's folder dialog
   ─────────
   Archive workspace   ← archives every session under that workspace (running sessions are skipped)
   Delete workspace
   ```

   _Menu labels follow the host UI language; in a Chinese UI these six read 重命名 / 打开文件夹 /
   置顶工作区 / 设置工作区 / 归档工作区 / 删除工作区._

   - Entries other plugins add to this menu are never shown (anything not in the table above — such as
     "copy workspace path" — is not displayed);
   - "Rename" and "Delete workspace" reuse the host entries directly, so after right-clicking you still go
     through the official flow (inline rename / official confirm dialog);
   - "Pin workspace" and "Archive workspace" usually do not exist in the host; this plugin supplies them
     (via `/menu/pin`, `/menu/archive`);
   - "Pin workspace" is a **persistent pin**: it is written into the plugin config (`config.pinned`) and
     still in effect after a restart; pinned workspaces always sit at the very top of the list, and newly
     created workspaces are inserted **below** the pinned block; clicking "Pin workspace" again unpins it;
   - "Open folders" does not simulate explorer: it calls the host's official `open-in-app` open route once
     per folder (the same launcher as the original menu entry, `/open-in-app/apps` + `/open-in-app/open`),
     once for the main folder and once for each extra folder;
   - every workspace in the sidebar has a **light-gray outline**, and consecutive pinned workspaces share a
     **dark-gray outline**;
   - if the host lacks even "Rename" / "Delete workspace", this plugin supplies them itself (rename via an
     input box / delete via a confirm dialog).
2. Menu takeover strategy (to avoid fighting other plugins over the UI): prefer subscribing to the kernel's
   `contextMenus.active`; after the menu opens, first wait for the DOM to go quiet (other plugins finish
   mutating the UI), then rewrite at most 3 times; if all 3 attempts fail, only append "Open folders" and
   "Workspace settings" and leave every other entry as it was. When the host re-renders the menu, it
   repairs itself within the remaining attempts.
   Both row structures are supported (`div.itemWrap > button` and the flat structure where the buttons hang
   directly under the list container); after every rewrite it verifies "6 rows + 2 separators, all inside
   the menu", and rolls back and retries when that fails — **it never empties the menu**.
3. The "Workspace settings" dialog:
   - "Main workspace (not removable)" is fixed at the top of the list and **has no remove button** (the
     host-side API also refuses to remove the main workspace);
   - the "Extra folders" list allows "Remove" on any entry;
   - at the bottom: "Choose folder…" (the system directory picker) → the selected directory is mounted
     immediately;
   - "Remount all", "Refresh".
4. The session header action area has one more "folder" button (a backup entry point that opens the same
   dialog).
5. Once a mount takes effect, the agent's file/command tools can read and write those directories directly,
   and the model-side runtime context also lists the extra folders.

### Known limitations

- Pin state lives in the plugin's own config (the DSH 0.2.x registry has no workspace-level pin field): this
  plugin pushes the pinned block to the top on startup, when a workspace is added, and on a periodic
  backstop; if something else reorders the registry behind this plugin's back, it is corrected within
  15 seconds at most.
- "Archive workspace" only archives sessions that **already exist and are not running**; running sessions
  are skipped and their count is reported in the toast.
- Menu takeover depends on the kernel `contextMenus` plus the official menu row structure; after a major
  host redesign, if it cannot recognize the menu at all (3 rewrites fail), it falls back automatically to
  the "append Open folders / Workspace settings only" mode.
- The workspace outline and the sidebar pin marker are DOM annotations and are added back after the host
  re-renders; if a host release changes the grouping structure, the outline may fall back to the title row
  (functionality unaffected).

---

## 🔐 Security model (important, please read)

Mounting an extra folder **modifies that directory's security descriptor**, exactly as DSH already does for
the workspace itself:

- the whole subtree is marked **Low integrity** (required by the DSH sandbox's Windows ACL backend,
  otherwise low-integrity child processes could not write to it);
- the directory gets an **Everyone delete-restriction ACE** (`(CI)(DENY)(DC)`), plus an
  `(OI)(CI)(W,D,DC)` Allow ACE pointing at the main workspace's write SID — that second one is exactly
  where "the extra folder is writable" comes from;
- these grants are **persistent** (they survive sessions and restarts, just like the main workspace);
- on removal the Allow ACE is revoked, the Low label is cleared as far as possible, and that Everyone DENY
  is removed precisely with `icacls <dir> /remove:d *S-1-1-0`; but Windows security-descriptor changes are
  not transactional, so in extreme cases a harmless leftover DENY ACE may remain and has to be deleted by
  hand under the directory's Properties → Security → Advanced.

Other constraints:

- only **NTFS/ReFS directories on local fixed volumes** are accepted; UNC network paths / mapped network
  drives are rejected (the SMB server's access check does not look at the restricting SID, so the write
  restriction does not take effect on network paths);
- it must not be: the main workspace itself, a subdirectory of the main workspace (already writable,
  redundant), a parent directory of the main workspace, a drive root, the DSH data directory
  (`$DSH_HOME`), or the DSH install directory;
- the directory must be owned by the current user and grant `WRITE_OWNER` (usually "Full control" is
  enough); otherwise mounting fails and reports the reason;
- mounting a large tree (hundreds of thousands of files) for the first time can take from tens of seconds
  to several minutes (inheritable ACEs have to propagate through the whole tree); the UI shows busy while
  it runs;
- note: the Low label also lets **other low-integrity processes under the same user** write that directory
  tree. Only mount ordinary project directories you trust.

---

## 🧩 How it works (why it won't drag DSH down)

- **It changes no file of DSH itself**: a pure profile plugin (`lib/index.js` host half + `lib/client.js`
  browser half) that statically imports no `@deepseek-ai/dsh-*`; the only runtime dependency,
  `@deepseek-ai/dsh-sandbox-windows-acl`, is dynamically imported inside a `try/catch` (and on failure it
  degrades to "write/edit multiple roots only").
- **Shell multiple roots**: on the extra directory it applies a set of `AclWriteGrant`s using the **same**
  `workspaceWriteSid` as the main workspace; the runner's `--workspace` still points at the main root only,
  and argv is completely unchanged.
  (Under Windows ACL, write permission is decided solely by "token restricting SID × target DACL ACE × Low
  label", independent of the declared path.)
- **write/edit multiple roots**: a runtime wrapper around `ctx.fs.writeText/editText` replaces the current
  `policy.workspaceRoot` with the matching extra root — the fence itself (`writableRoots`) is not copied by
  a single line.
- Both wrappers come with feature detection, idempotency markers, self-healing after the service is
  replaced (by listening on `internal/service`), and thorough `try/catch`; any failure only degrades this
  plugin's own capabilities and never affects harness startup.
- `GET /dsh-multi-workspace/health` shows aclAvailable / patches / the mount table (reachable from loopback
  only).
- Host routes for the workspace menu actions (POST, loopback only): `/menu/pin` (toggle pin and reorder),
  `/menu/archive` (archive that workspace's sessions), `/menu/rename`, `/menu/delete` (the last two are only
  used when the host lacks the corresponding entry); `GET /menu/pinned` returns the pinned paths and a
  workspace summary, which the sidebar uses to draw outlines/markers. `/menu/open-all` is only a fallback
  for when the official open-in-app route is unavailable.
- "Open folders" goes through the host's official `open-in-app` routes (`GET /open-in-app/apps`,
  `POST /open-in-app/open`), the same launcher as the original menu entry.

---

## ⚙️ Configuration & data

- Mount list: `<DSH_HOME>/multi-workspace/config.json` (keys are canonical main-workspace paths).
  Structure: `{ version: 1, pinned: ["<absolute path of a pinned workspace>", ...], workspaces: { "<absolute main workspace path>": { folders: [{ path, addedAt, mountedAt, sid, baselineHasDeny }] } } }`
  `pinned` is ordered most-recently-pinned first; deleting this file clears both the mount list and the pin
  state.
- The plugin keeps no database of its own; deleting this file is equivalent to clearing the mount list (it
  does not revoke ACLs already created — remove them through the UI first).

### Allowing protected paths (e.g. `%USERPROFILE%\.dsh` and its subdirectories)

By default the following locations are **refused** as extra folders (to keep the agent from breaking the
harness's own configuration):

- `$DSH_HOME` (default `%USERPROFILE%\.dsh`, containing profiles / sessions / plugins and so on);
- the DSH install directory (`...\dsh-tauri\dependencies\dsh`);
- drive roots; the main workspace itself or its subdirectories (those are already writable).

A `.` in the path is not a problem by itself (an ordinary directory such as `D:\proj\.config` can be added
directly). What gets blocked are the **protected roots** listed above. If you really do want to mount a
configuration directory, allow it on the `multi-workspace` line of the **profile's `cordis.patch.yml`**:

```yaml
# <profile>/cordis.patch.yml
- id: multi-workspace
  name: 'dsh-multi-workspace'   # the name is only an assertion; it can be omitted
  config:
    allowProtectedRoots:
      - '%USERPROFILE%\.dsh'            # allow the whole DSH home (careful)
      # - '%USERPROFILE%\.dsh\configs'  # or allow just one subdirectory (recommended)
    # allowDshHome: true   # equivalent to adding all of $DSH_HOME to allowProtectedRoots
```

Notes:

- paths in `allowProtectedRoots` may be absolute or use `~/...` (expanded to the system user directory);
  paths matching these prefixes skip the "protected root" and "parent directory not allowed" blocks, while
  every other check (local NTFS/ReFS, directory owner/permissions, the main workspace itself not being
  addable, out-of-bounds ACLs, etc.) still applies;
- this config only grants permission; it never mounts anything by itself — you still have to add folders
  through the UI;
- editing `cordis.patch.yml` triggers hot reload, but this plugin's host half is module-level code, so the
  **most reliable option is to restart DSH/GUI**;
- if the plugin was installed as a bundle with `dsh plugin add`, you can likewise append the same
  `- id: multi-workspace / config: ...` overlay to the profile's `cordis.patch.yml` (the patch layer treats
  config for the same id as an override);
- you can also edit the mount list `config.json` by hand and add
  `{ "path": "%USERPROFILE%\\.dsh\\configs" }` to the relevant workspace's `folders`; it is mounted
  automatically before the next tool call (if it has been allowed);
- **risk warning**: allowing and mounting the entire `.dsh` directory means the agent can write
  profiles/sessions/plugins and other configuration, which may affect the harness itself; allow only the
  subdirectories you actually need, and keep the rollback package generated at install time.

---

## 🧪 Compatibility

- Public seams it relies on: `ctx.fs.writeText/editText`, `ctx.sandbox.confine`, `ctx.systemPrompt.context`,
  `ctx.webServer.register`, the client slot `conversation.session.header.actions`, and the optional
  `dsh.rightclick-menu.extensions` registry.
- `peerDependencies` only declares `@deepseek-ai/dsh-sandbox-windows-acl: ">=0.2.0-rc.2"`; the upper-layer
  version is not pinned.
- When upgrading the harness: if the plugin row is disabled by a version policy, only this plugin stops
  working and the harness still boots normally (see the upgrade tests in `../tests`).

---

## 📁 Layout

```
dsh-multi-workspace/
├─ package.json          # dsh.bundle.patch + dsh.client declarations
├─ cordis.patch.yml      # bundle patch: inserts the multi-workspace row
├─ lib/index.js          # host half: HTTP routes, ACL grants, fs/sandbox wrappers, runtime context
├─ lib/client.js         # browser half: context menu / dialog / header button (hand-written __ModuleLoader__ factory)
├─ tools/acl-cleanup.mjs # standalone ACL cleanup (uninstall / troubleshooting)
├─ README.md
└─ README.zh-CN.md
```

---

## 📄 License

[MIT](./LICENSE) © 2026 KittenSleepwalk
