<div align="center">

# dsh-multi-workspace

**一个项目，多个文件夹 —— write/edit 与 shell 在每个文件夹里同权可写。**

DSH（DeepSeek Harness）「多文件夹工作区」插件：让一个项目（workspace）在原有主文件夹之外，再挂载一个或多个额外文件夹，并让 **write/edit 工具与 shell（pwsh/bash/终端/PTC）在额外文件夹里与主工作区同权可写**；主工作区永远不可移除。

<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-multi-workspace?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-multi-workspace?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-multi-workspace"><img alt="DSH >= 0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1-4d6bfe?style=flat-square"></a>
<img alt="Windows only" src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square">

[English](./README.md) · **简体中文**

</div>

> [!WARNING]
> **只在一台机器上验证过，不保证完全安全。**
>
> - 在作者本机运行一切正常；沙盒验证（[`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate)）也已通过。
> - 但**只试验了这一台机器**，没有在第二台机器、也没有在其它 DSH 版本上验证过。
> - **本插件会改 Windows ACL、把额外文件夹纳入沙盒可写范围，权限面变化较大。** **安装前务必备份** `~/.dsh`，并确认你接受「额外文件夹对 write/edit 与 shell 同权可写」。
>
> **推荐先安装 [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate)**：它会先把每个待装插件放进一次性沙盒副本里跑一遍（启动、冷重启、session、其它插件、硬件占用），过了才允许装进主机。
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🚀 安装

```bash
# 方式一：直接从 GitHub 装（仓库根就是包根）
pnpm add github:KittenSleepwalk/dsh-multi-workspace

# 方式二：本地 tarball
pnpm pack    # 产出 kittensleepwalk-dsh-multi-workspace-0.1.0.tgz
pnpm add ./kittensleepwalk-dsh-multi-workspace-0.1.0.tgz
```

本包自带 `cordis.patch.yml`，装好后把包名 `@kittensleepwalk/dsh-multi-workspace`
加进 DSH profile 的 `dsh.profile.bundles` 即可，不需要手写 entry；重启 DSH 生效。

要求：**Windows only** —— Node.js ≥ 20，DSH ≥ 0.2.0-rc.1（需要 `@deepseek-ai/dsh-sandbox-windows-acl`
提供的 ACL 后端）。下文的 `%USERPROFILE%` 是占位符，按自己的环境替换。

---

## 🧭 交互

1. **工作区（项目）行的右键菜单**，以及**行右侧三个点按钮**打开的同一份菜单，都被统一成固定六项（图标 + 文字，样式直接沿用宿主菜单行）：

   ```
   重命名
   打开文件夹        ← 一次打开主文件夹 + 全部额外文件夹
   ─────────
   置顶工作区        ← 移到工作区列表最上方
   设置工作区        ← 本插件的文件夹对话框
   ─────────
   归档工作区        ← 归档该工作区下全部会话（运行中的会话跳过）
   删除工作区
   ```

   - 其它插件给这个菜单新增的条目一律不显示（「复制工作区路径」等不在上表内的都不显示）；
   - 「重命名」「删除工作区」直接复用宿主条目，右键后走的仍是官方流程（内联重命名 / 官方确认框）；
   - 「置顶工作区」「归档工作区」宿主通常没有，由本插件补齐（走 `/menu/pin`、`/menu/archive`）；
   - 「置顶工作区」是**持久置顶**：写进插件配置（`config.pinned`），重启后仍然有效；置顶的工作区永远排在
     列表最上面，新建的工作区会插到置顶块**下方**；再点一次「置顶工作区」= 取消置顶；
   - 「打开文件夹」不是模拟 explorer：会逐个调用宿主官方的 `open-in-app` 打开路由（和原菜单项同一个
     启动器，`/open-in-app/apps` + `/open-in-app/open`），主目录与全部额外文件夹各开一次；
   - 侧边栏每个工作区有一圈**浅灰外框**，置顶的连续几个工作区共用一圈**深灰外框**；
   - 若宿主连「重命名」「删除工作区」都没有，本插件会自己补上（输入框重命名 / 确认框删除）。
2. 菜单接管策略（避免和别的插件抢 UI）：优先订阅内核 `contextMenus.active`；菜单打开后先等 DOM
   静默（别的插件改完 UI），再最多改写 3 次；3 次都失败就只追加「打开文件夹」「设置工作区」两项，
   其它条目原样保留。宿主菜单重渲染时会在剩余次数内自动修复。
   两种行结构都支持（`div.itemWrap > button` 与按钮直接挂在列表容器下的扁平结构）；每次改写后都会校验
   「6 行 + 2 条分栏线且都在菜单内」，不满足就回滚重试，**不会把菜单清空**。
3. 「设置工作区」对话框：
   - 「主工作区（不可移除）」固定在列表顶部，**没有移除按钮**（host 侧 API 也会拒绝移除主工作区）；
   - 「额外文件夹」列表：可「移除」任意一项；
   - 底部：「选择文件夹…」（系统目录选择器）→ 选中的目录会立即挂载；
   - 「重新挂载全部」、「刷新」。
4. 会话头部动作区另有一个「文件夹」按钮（备用入口，打开同一个对话框）。
5. 挂载生效后，agent 的文件/命令工具可以直接读写这些目录；模型侧的运行上下文也会列出额外文件夹。

### 已知限制

- 置顶状态存在插件自己的配置里（DSH 0.2.x 注册表没有工作区级 pin 字段）：由本插件在启动、工作区新增、
  定时兜底时把置顶块压到最上面；如果别的东西绕开本插件直接改注册表顺序，最多 15 秒会被纠正回来。
- 「归档工作区」只归档**已存在且不在运行中**的会话；运行中的会话会被跳过并在提示里给出数量。
- 菜单接管依赖内核 `contextMenus` + 官方菜单行结构；宿主大改版后若完全识别不出（3 次改写失败），
  会自动退回「只追加打开文件夹 / 设置工作区」的模式。
- 工作区外框/Sidebar 置顶标记是 DOM 注解，宿主重渲染后会自动补回；若宿主改版换了分组结构，
  外框可能落回标题行（不影响功能）。

---

## 🔐 安全模型（重要，请读）

挂载一个额外文件夹会**修改该目录的安全描述符**，与 DSH 对工作区本身所做的完全一致：

- 整棵子树被标记为 **Low 完整性**（DSH 沙盒的 Windows ACL 后端要求，否则低完整性子的子进程无法写入）；
- 目录获得一条 **Everyone 的删除限制 ACE**（`(CI)(DENY)(DC)`），以及一条指向主工作区写 SID 的
  `(OI)(CI)(W,D,DC)` Allow ACE——后者就是"额外文件夹可写"的来源；
- 这些授权是**常驻**的（跨会话、跨重启有效，和主工作区一致）；
- 移除时会撤销 Allow ACE、尽力清除 Low 标签，并用 `icacls <dir> /remove:d *S-1-1-0` 精确移除那条
  Everyone DENY；但 Windows 的安全描述符修改不是事务性的，极端情况下可能残留一条无害的 DENY ACE，
  需要在该目录的「属性 → 安全 → 高级」里手动删掉。

其他约束：

- 只接受**本地固定卷上的 NTFS/ReFS 目录**；UNC 网络路径 / 映射网络盘会被拒绝
  （SMB 服务端的访问检查不看 restricting SID，写限制在网络路径上不生效）。
- 不能是：主工作区本身、主工作区的子目录（已可写，冗余）、主工作区的上级目录、盘符根目录、
  DSH 数据目录（`$DSH_HOME`）、DSH 安装目录。
- 目录必须由当前用户拥有且授予 `WRITE_OWNER`（通常"完全控制"即可）；否则挂载会失败并给出原因。
- 首次挂载大树（几十万文件）可能耗时数十秒到数分钟（可继承 ACE 需要向全树传播），期间 UI 显示忙碌。
- 注意：Low 标签会让**同一用户下的其它 Low 完整性进程**也能写该目录树。只挂载你信任的普通项目目录。

---

## 🧩 实现方式（为什么不会拖垮 DSH）

- **不改本体任何文件**：纯 profile 插件（`lib/index.js` host 半 + `lib/client.js` 浏览器半），
  不静态 import 任何 `@deepseek-ai/dsh-*`；唯一的运行时依赖 `@deepseek-ai/dsh-sandbox-windows-acl`
  用 `try/catch` 动态 import（失败就降级为「只有 write/edit 多根」）。
- **shell 多根**：在额外目录上，用主工作区**同一个** `workspaceWriteSid` 打一套
  `AclWriteGrant`；runner 的 `--workspace` 只指向主根，argv 完全不变。
  （Windows ACL 下写入权限只由「令牌 restricting SID × 目标 DACL ACE × Low 标签」决定，与路径声明无关。）
- **write/edit 多根**：在 `ctx.fs.writeText/editText` 上做运行时包装，把当次 `policy.workspaceRoot`
  替换成命中的额外根——围栏本身（`writableRoots`）一行没抄。
- 两处包装都带特征探测、幂等标记、服务替换后自愈（监听 `internal/service`）、以及彻底 try/catch；
  任何一步失败只降级本插件能力，不影响 harness 启动。
- `GET /dsh-multi-workspace/health` 可看 aclAvailable / patches / 挂载表（仅回环可访问）。
- 工作区菜单动作的 host 路由（POST、仅回环）：`/menu/pin`（切换置顶并重排）、`/menu/archive`（归档该工作区会话）、
  `/menu/rename`、`/menu/delete`（后两个只在宿主缺少对应条目时使用）；`GET /menu/pinned` 返回置顶路径与
  工作区摘要，供侧边栏画外框/标记用。`/menu/open-all` 仅作为官方 open-in-app 路由不可用时的兜底。
- 打开文件夹走宿主官方 `open-in-app` 路由（`GET /open-in-app/apps`、`POST /open-in-app/open`），和原菜单项的启动器一致。

---

## ⚙️ 配置与数据

- 挂载清单：`<DSH_HOME>/multi-workspace/config.json`（键是 canonical 主工作区路径）。
  结构：`{ version: 1, pinned: ["<置顶工作区绝对路径>", ...], workspaces: { "<主工作区绝对路径>": { folders: [{ path, addedAt, mountedAt, sid, baselineHasDeny }] } } }`
  `pinned` 按最近置顶在前排序；删掉这个文件会同时清空挂载清单与置顶状态。
- 插件自身没有数据库；删掉这个文件等于清空挂载清单（不会撤销已生成的 ACL，请先通过界面移除）。

### 允许受保护路径（例如 `%USERPROFILE%\.dsh` 及其子目录）

默认**拒绝**把以下位置挂载为额外文件夹（防止 agent 改坏 harness 自己的配置）：

- `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`，含 profiles / sessions / plugins 等）；
- DSH 安装目录（`...\dsh-tauri\dependencies\dsh`）；
- 盘符根目录；主工作区本身或其子目录（这些本来就可写）。

路径里带 `.` 本身不是问题（`D:\proj\.config` 这类正常目录可以直接添加）。被拦下的是上面这些
**受保护根**。如果你确实要挂载配置文件目录，需要在 **profile 的 `cordis.patch.yml`** 里给
`multi-workspace` 这一行做配置放行：

```yaml
# <profile>/cordis.patch.yml
- id: multi-workspace
  name: 'dsh-multi-workspace'   # 名称只是断言，可省略
  config:
    allowProtectedRoots:
      - '%USERPROFILE%\.dsh'            # 允许整个 DSH home（谨慎）
      # - '%USERPROFILE%\.dsh\configs'  # 或者只允许某个子目录（推荐）
    # allowDshHome: true   # 等价于把整个 $DSH_HOME 加进 allowProtectedRoots
```

说明：

- `allowProtectedRoots` 里的路径可以写绝对路径，也支持 `~/...`（展开到系统用户目录）；
  命中这些前缀的路径会跳过“受保护根”与“不能选上级目录”的拦截，其它检查（本地 NTFS/ReFS、
  目录所有者/权限、主工作区本身不可添加、越界 ACL 等）仍然生效。
- 该配置只放行，不会自动挂载任何目录；仍然需要在界面里添加。
- 修改 `cordis.patch.yml` 会触发热加载，但本插件 host 半是模块级代码，**最稳妥是重启 DSH/GUI**。
- 如果插件是用 `dsh plugin add` 安装成 bundle 的，同样可以在 profile 的 `cordis.patch.yml`
  里追加上面这条 `- id: multi-workspace / config: ...` 覆盖层（patch 层对同一 id 的 config 是覆盖语义）。
- 也可以手动编辑挂载清单 `config.json`，在对应工作区的 `folders` 里加
  `{ "path": "%USERPROFILE%\\.dsh\\configs" }`，下一次工具调用前会自动挂载（如果已放行）。
- **风险提示**：允许并挂载 `.dsh` 整个目录意味着 agent 可以写 profiles/sessions/plugins 等配置，
  可能影响 harness 自身；建议只放行真正需要的子目录，并保留安装时生成的回滚包。

---

## 🧪 兼容性

- 依赖的公开接缝：`ctx.fs.writeText/editText`、`ctx.sandbox.confine`、`ctx.systemPrompt.context`、
  `ctx.webServer.register`、客户端 slot `conversation.session.header.actions`、可选
  `dsh.rightclick-menu.extensions` 注册表。
- `peerDependencies` 只声明 `@deepseek-ai/dsh-sandbox-windows-acl: ">=0.2.0-rc.2"`，不锁上层版本。
- 升级 harness 时：插件行若被版本策略禁用，只是本插件失效，harness 照常启动（见 `../tests` 的升级测试）。

---

## 📁 目录

```
dsh-multi-workspace/
├─ package.json          # dsh.bundle.patch + dsh.client 声明
├─ cordis.patch.yml      # bundle patch：插入 multi-workspace 行
├─ lib/index.js          # host 半：HTTP 路由、ACL 授权、fs/sandbox 包装、运行时上下文
├─ lib/client.js         # 浏览器半：右键菜单/弹窗/头部按钮（手写 __ModuleLoader__ 工厂）
├─ tools/acl-cleanup.mjs # 独立 ACL 清理（卸载/排障）
├─ README.md
└─ README.zh-CN.md
```

---

## 📄 License

[MIT](./LICENSE) © 2026 KittenSleepwalk
