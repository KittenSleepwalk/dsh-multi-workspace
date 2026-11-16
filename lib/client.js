/**
 * dsh-multi-workspace — 多文件夹工作区插件 · 浏览器半侧
 *
 * 交互（按用户要求）：
 *   - 工作区（项目）行右键菜单被统一成固定六项：
 *       重命名 / 打开文件夹 ─ 置顶工作区 / 设置工作区 ─ 归档工作区 / 删除工作区
 *     其它插件塞进来的条目一律不显示；
 *   - 打开文件夹：一次打开该工作区的主文件夹 + 全部额外文件夹；
 *   - 设置工作区：列出「主工作区（不可移除）」+「额外文件夹」，可添加（系统目录选择器）与移除；
 *   - 置顶工作区 / 归档工作区：宿主没有提供时由本插件补齐（置顶 = 移到列表最上；归档 = 归档该工作区下全部会话）。
 *
 * 菜单接管策略（避免和别的插件互相抢 UI）：
 *   1. 优先订阅内核 context-menu 的当前目标（0.2.x：ctx.get('contextMenus').active）；
 *      老版本没有该服务时退回监听工作区行的 contextmenu 做 DOM 识别。
 *   2. 菜单打开后先等 MutationObserver 静默（别的插件还在改 UI 时不抢），然后最多改写 3 次；
 *      成功即保留官方条目的 React 处理器，只调顺序/文案/可见性并补上缺失项。
 *   3. 3 次都失败 → 只追加「打开文件夹」「设置工作区」两项，其它条目原样保留。
 *
 * 数据与动作全部走 host 半侧的普通 HTTP 路由（/dsh-multi-workspace/*，仅回环）。
 * 手写 CJS 工厂：window.__ModuleLoader__.load 直接执行，不需要构建器；只 require 平台种子表里的
 * react（对话框与菜单用原生 DOM，避免依赖 React 版本/内部组件）。
 *
 * @module dsh-multi-workspace/client
 */

window.__ModuleLoader__.load({
  id: '@kittensleepwalk/dsh-multi-workspace',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var API = '/dsh-multi-workspace'
    var SLOT = 'conversation.session.header.actions'
    var ZN = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().indexOf('zh') === 0

    function tr(zh, en) {
      return ZN ? zh : en
    }

    /* -------------------------------------------------------------- style -- */

    var CSS = [
      '.dmw-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-fill-subtle,transparent);',
      'color:var(--dsw-alias-label-secondary,inherit);border-radius:999px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}',
      '.dmw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.dmw-btn:disabled{opacity:.5;cursor:default}',
      '.dmw-badge{min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b82f6);',
      'color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center}',
      '.dmw-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.34);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.dmw-panel{box-sizing:border-box;width:640px;max-width:100%;max-height:min(84vh,760px);overflow:auto;padding:16px;border-radius:14px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,#1e1f22);',
      'color:var(--dsw-alias-label-primary,inherit);box-shadow:0 24px 64px rgba(0,0,0,.4);font-size:12px;line-height:1.5}',
      '.dmw-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
      '.dmw-title{flex:1 1 auto;min-width:0}',
      '.dmw-title-text{font-size:14px;font-weight:650}',
      '.dmw-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;word-break:break-all;margin-top:2px}',
      '.dmw-x{appearance:none;flex:none;width:26px;height:26px;border-radius:8px;border:1px solid transparent;background:transparent;',
      'color:var(--dsw-alias-label-secondary,inherit);font-size:16px;line-height:1;cursor:pointer}',
      '.dmw-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dmw-err{display:flex;gap:8px;justify-content:space-between;align-items:flex-start;margin:0 0 8px;padding:8px 10px;border-radius:9px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dmw-note{margin:0 0 8px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-fill-subtle,rgba(127,127,127,.1));',
      'color:var(--dsw-alias-label-secondary,inherit)}',
      '.dmw-warn{margin:0 0 10px;padding:8px 10px;border-radius:9px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 40%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 9%,transparent);',
      'color:var(--dsw-alias-label-secondary,inherit)}',
      '.dmw-sec{margin:12px 0 6px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit);text-transform:uppercase}',
      '.dmw-list{display:flex;flex-direction:column;gap:6px}',
      '.dmw-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;padding:8px 10px;',
      'background:var(--dsw-alias-fill-subtle,rgba(127,127,127,.06))}',
      '.dmw-row-primary{border-style:dashed;opacity:.95}',
      '.dmw-row-top{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dmw-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#777)}',
      '.dmw-dot-ok{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dmw-dot-bad{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dmw-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.dmw-meta{flex:none;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;white-space:nowrap}',
      '.dmw-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);',
      'word-break:break-all;margin-top:3px}',
      '.dmw-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '.dmw-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dmw-lock{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}',
      '.dmw-empty{color:var(--dsw-alias-label-tertiary,inherit);padding:10px 2px}',
      '.dmw-foot{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}',
      '.dmw-foot .dmw-spacer{flex:1 1 auto}',
      '.dmw-menu{position:fixed;z-index:2147483001;min-width:190px;padding:5px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,#1e1f22);',
      'box-shadow:0 14px 40px rgba(0,0,0,.36)}',
      '.dmw-menu-item{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-height:34px;padding:6px 8px;border-radius:8px;',
      'border:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
      '.dmw-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dmw-menu-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,inherit)}',
      '.dmw-menu-icon svg{width:14px;height:14px}',
      '.dmw-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dmw-menu-sep,.dmw-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}',
      '.dmw-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483003;max-width:min(80vw,520px);',
      'padding:9px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1e1f22);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-primary,inherit);',
      'font-size:12px;line-height:1.5;box-shadow:0 12px 32px rgba(0,0,0,.35);display:none}',
      '.dmw-modal{width:440px;max-width:100%}',
      '.dmw-desc{color:var(--dsw-alias-label-secondary,inherit);word-break:break-word;margin-top:2px}',
      '.dmw-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;margin-top:10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-fill-subtle,rgba(127,127,127,.06));',
      'color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dmw-input:focus{border-color:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dmw-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      /* 工作区分组外框：每个工作区一圈浅灰，置顶的连成一块深灰。 */
      '.dmw-ws-group{position:relative}',
      '.dmw-ws-group::before{content:"";position:absolute;left:2px;right:2px;top:1px;bottom:1px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:10px;pointer-events:none}',
      '.dmw-ws-group[data-dmw-pinned="1"]::before{border-color:rgba(92,98,106,.78);border-width:1.5px}',
      '.dmw-ws-group[data-dmw-pin-pos="first"]::before{bottom:-5px;border-bottom:0;border-radius:10px 10px 0 0}',
      '.dmw-ws-group[data-dmw-pin-pos="middle"]::before{top:-5px;bottom:-5px;border-top:0;border-bottom:0;border-radius:0}',
      '.dmw-ws-group[data-dmw-pin-pos="last"]::before{top:-5px;border-top:0;border-radius:0 0 10px 10px}',
      '.dmw-ws-group[data-dmw-pin-pos="only"]::before{border-radius:10px}',
    ].join('')

    /* Settings (gear) artwork from the official 16px icon set, one-pixel stroke. */
    var GEAR_SVG = [
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1">',
      '<path d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z" stroke="currentColor"/>',
      '<path d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z" stroke="currentColor" stroke-miterlimit="10"/>',
      '</svg>',
    ].join('')

    /* ---------------------------------------------------------------- dom -- */

    function el(tag, attrs, children) {
      var node = document.createElement(tag)
      if (attrs) {
        for (var key in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue
          var value = attrs[key]
          if (value === undefined || value === null) continue
          if (key === 'text') node.textContent = String(value)
          else if (key === 'class') node.className = String(value)
          else if (key === 'style' && typeof value === 'object') {
            for (var prop in value) if (Object.prototype.hasOwnProperty.call(value, prop)) node.style[prop] = value[prop]
          } else if (key.length > 2 && key.slice(0, 2) === 'on' && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value)
          } else node.setAttribute(key, String(value))
        }
      }
      if (Array.isArray(children)) {
        for (var index = 0; index < children.length; index += 1) {
          var child = children[index]
          if (child === null || child === undefined || child === false) continue
          node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
        }
      } else if (typeof children === 'string') {
        node.textContent = children
      }
      return node
    }

    function basename(path) {
      var parts = String(path).split(/[\\/]+/u)
      for (var i = parts.length - 1; i >= 0; i -= 1) if (parts[i] !== '') return parts[i]
      return String(path)
    }

    function samePath(left, right) {
      return String(left).replace(/[\\/]+$/u, '').toLowerCase() === String(right).replace(/[\\/]+$/u, '').toLowerCase()
    }

    /* ---------------------------------------------------------------- api -- */

    async function request(path, init) {
      var response = await fetch(API + path, init)
      var body = await response.text()
      var value = {}
      if (body !== '') {
        try {
          value = JSON.parse(body)
        } catch {
          value = { ok: false, error: 'bad-response', message: body.slice(0, 200) }
        }
      }
      if (response.ok !== true || value.ok === false) {
        var failure = new Error(value.message || value.error || 'HTTP ' + response.status)
        failure.code = value.error || 'http-' + response.status
        throw failure
      }
      return value
    }

    function getState(workspace, sessionId) {
      var query = '?workspace=' + encodeURIComponent(workspace || '')
      if (sessionId) query += '&sessionId=' + encodeURIComponent(sessionId)
      return request('/state' + query)
    }

    function post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    /* ------------------------------------------------------ workspace data -- */

    function workspaceItems(ctx) {
      try {
        var items = ctx.get('workspaces')?.list?.getSnapshot?.()?.items
        return Array.isArray(items) ? items : []
      } catch {
        return []
      }
    }

    function workspaceOfSessionFromList(items, sessionId) {
      if (!Array.isArray(items) || !sessionId) return null
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        if (item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) >= 0) return item
      }
      return null
    }

    function workspaceOfSession(ctx, sessionId) {
      return workspaceOfSessionFromList(workspaceItems(ctx), sessionId)
    }

    /* ---------------------------------------------------------- rightclick -- */

    var TREE_ROW_SELECTOR = '[role="treeitem"][aria-expanded]'
    var ACTIONS_BUTTON_SELECTOR = 'button[aria-label]'

    function isWorkspaceActionsLabel(label) {
      return /^工作区“.+”的操作$/u.test(label) || /^Workspace actions for .+$/u.test(label)
    }

    function titleFromActionsLabel(label) {
      var zh = /^工作区“(.+)”的操作$/u.exec(label)
      if (zh) return zh[1]
      var en = /^Workspace actions for (.+)$/u.exec(label)
      return en ? en[1] : ''
    }

    /** The workspace-row (project row) a DOM node belongs to, if it is that row itself. */
    function directWorkspaceRow(ctx, node) {
      if (!(node instanceof Element)) return null
      var row = node.closest(TREE_ROW_SELECTOR)
      if (row === null || row === undefined) return null
      var button = row.querySelector(ACTIONS_BUTTON_SELECTOR)
      var label = button === null ? '' : button.getAttribute('aria-label') || ''
      if (!isWorkspaceActionsLabel(label)) return null
      var title = titleFromActionsLabel(label)
      var items = workspaceItems(ctx)
      var matches = items.filter(function (item) {
        return item && item.title === title
      })
      if (matches.length === 1) return { row: row, workspace: matches[0] }
      var key = row.getAttribute('data-row-key') || ''
      if (key.indexOf('workspace:') === 0) {
        var id = key.slice('workspace:'.length)
        var byId = items.filter(function (item) {
          return item && item.workspaceId === id
        })
        if (byId.length === 1) return { row: row, workspace: byId[0] }
      }
      return null
    }

    /* ------------------------------------------------------ menu takeover -- */

    /*
     * 工作区右键菜单由内核 context-menu 汇总多个插件贡献的条目后统一渲染：
     * 贡献是"只增不减"的，所以本插件不在注册表层竞争，而是在菜单渲染完成、DOM
     * 稳定之后做一次"接管式"改写（保留官方条目的 React 处理器，只调顺序/名称/
     * 可见性并补上缺失条目）：
     *   1. 别的插件还在改 UI 时不抢：MutationObserver 静默窗口后才动手；
     *   2. 最多尝试 3 次改写，成功即停；
     *   3. 3 次都失败 → 只追加「打开文件夹」「设置工作区」两项，其余不动。
     */

    var TAKEOVER_LIMIT = 3
    var TAKEOVER_DEADLINE_MS = 4000
    var QUIET_MS = 130

    /** 菜单文案（中/英）；启动时按界面语言取一侧。 */
    var MENU_LABEL = {
      rename: ['重命名', 'Rename'],
      open: ['打开文件夹', 'Open folder'],
      pin: ['置顶工作区', 'Pin workspace'],
      folders: ['设置工作区', 'Workspace settings'],
      archive: ['归档工作区', 'Archive workspace'],
      delete: ['删除工作区', 'Delete workspace'],
    }

    /* 官方 16px 图标几何：只替换 path，外框统一 16 网格 / 1px 描边。 */
    var ICON_BODY = {
      open: '<path d="M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991" stroke="currentColor"></path><path d="M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z" stroke="currentColor"></path>',
      pin: '<path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" stroke="currentColor" stroke-linejoin="round"></path><path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor"></path>',
      folders: '<path d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z" stroke="currentColor"></path><path d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z" stroke="currentColor" stroke-miterlimit="10"></path>',
      archive: '<rect x="1.9" y="2.1" width="12.2" height="3.4" rx="1.1" stroke="currentColor"></rect><path d="M2.95 5.7v4.8a2.9 2.9 0 0 0 2.9 2.9h4.3a2.9 2.9 0 0 0 2.9-2.9V5.7" stroke="currentColor"></path><path d="m6 9.35 1.4 1.4 2.6-2.6" stroke="currentColor"></path>',
      rename: '<path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor"></path><path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor"></path>',
      delete: '<path d="M1.28149 3.88831H14.7187" stroke="currentColor"></path><path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor"></path><path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor"></path><path d="M6.44946 6.98926V11.1238" stroke="currentColor"></path><path d="M9.55054 6.98926V11.1238" stroke="currentColor"></path>',
    }

    function iconSvg(body) {
      return (
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1">' +
        body +
        '</svg>'
      )
    }

    function labelFor(kind) {
      var pair = MENU_LABEL[kind]
      return pair === undefined ? kind : tr(pair[0], pair[1])
    }

    /** Trim, drop ellipsis and spaces so 图标/省略号差异不影响识别。 */
    function normalizedLabel(text) {
      return String(text || '')
        .replace(/…|\.\.\./gu, '')
        .replace(/\s+/gu, '')
        .toLowerCase()
    }

    /** Fuzzy match a menu row's label to one of the six managed actions. */
    function classifyLabel(text) {
      var value = normalizedLabel(text)
      if (value === '') return ''
      if (/重命名|rename/.test(value)) return 'rename'
      if (/打开文件夹|在文件夹|openfolder|showinfolder|reveal/.test(value)) return 'open'
      if (/置顶工作区|pinworkspace/.test(value)) return 'pin'
      if (/设置工作区|工作区文件夹|workspacesettings|workspacefolders/.test(value)) return 'folders'
      if (/归档工作区|archiveworkspace/.test(value)) return 'archive'
      if (/删除工作区|deleteworkspace/.test(value)) return 'delete'
      return ''
    }

    /* ------------------------------------------------------- menu helpers -- */

    function menuRoots() {
      return Array.prototype.slice.call(document.querySelectorAll('[role="menu"]'))
    }

    /** The visible menu with the most specific (last) DOM order. */
    function pickMenuRoot() {
      var roots = menuRoots()
      for (var i = roots.length - 1; i >= 0; i -= 1) {
        if (roots[i].querySelector('button[role="menuitem"]') !== null) return roots[i]
      }
      return null
    }

    /**
     * Menu rows as { button, wrap, flat, kind }. The primitives menu wraps each
     * button in div.itemWrap; some anchored lists put the buttons straight into
     * the list container. `flat` marks that shape so hiding/reordering can never
     * touch the container itself.
     */
    function rowEntries(root) {
      var buttons = Array.prototype.slice.call(root.querySelectorAll('button[role="menuitem"]'))
      var countByParent = new Map()
      for (var i = 0; i < buttons.length; i += 1) {
        var parent = buttons[i].parentElement
        if (parent === null) continue
        countByParent.set(parent, (countByParent.get(parent) || 0) + 1)
      }
      var entries = []
      for (var j = 0; j < buttons.length; j += 1) {
        var button = buttons[j]
        var home = button.parentElement
        var flat = home !== null && (countByParent.get(home) || 0) > 1
        entries.push({
          button: button,
          wrap: flat || home === null ? button : home,
          flat: flat,
          kind: classifyLabel(button.textContent || ''),
        })
      }
      return entries
    }

    /** Backwards-compatible projection (tests/docs). */
    function menuRows(root) {
      return rowEntries(root).map(function (entry) {
        return { button: entry.button, wrap: entry.wrap, kind: entry.kind }
      })
    }

    /** The list container that directly holds the row wrappers (never body/html). */
    function rowContainer(entries) {
      var counts = new Map()
      for (var i = 0; i < entries.length; i += 1) {
        var parent = entries[i].wrap.parentElement
        if (parent === null) continue
        if (parent === document.body || parent === document.documentElement) continue
        var weight = parent.getAttribute('role') === 'presentation' ? 1000 : 0
        counts.set(parent, (counts.get(parent) || 0) + 1 + weight)
      }
      var best = null
      var bestScore = 0
      counts.forEach(function (score, parent) {
        if (score > bestScore) {
          best = parent
          bestScore = score
        }
      })
      return best
    }

    function isOurRow(node) {
      return node !== null && node !== undefined && node.getAttribute('data-dmw-row') !== null
    }

    function nodeButton(node) {
      if (node === null || node === undefined) return null
      if (node.localName === 'button') return node
      return node.querySelector('button[role="menuitem"]')
    }

    function setRowLabel(button, text) {
      var spans = Array.prototype.slice.call(button.querySelectorAll('span'))
      var label = null
      for (var i = 0; i < spans.length; i += 1) {
        if (spans[i].querySelector('svg') === null && String(spans[i].textContent || '') !== '') {
          label = spans[i]
          break
        }
      }
      if (label === null && spans.length > 0) label = spans[spans.length - 1]
      if (label !== null) label.textContent = text
      else button.textContent = text
    }

    function setRowIcon(button, kind) {
      var body = ICON_BODY[kind]
      if (body === undefined) return
      var spans = Array.prototype.slice.call(button.querySelectorAll('span'))
      var icon = null
      for (var i = 0; i < spans.length; i += 1) {
        if (spans[i].querySelector('svg') !== null) {
          icon = spans[i]
          break
        }
      }
      if (icon === null) icon = spans.length > 0 ? spans[0] : null
      if (icon === null) return
      icon.innerHTML = iconSvg(body)
    }

    /** Clone an official row (wrapper or bare button) so the host styles carry over. */
    function buildRow(template, kind, value) {
      var wrap = template.cloneNode(true)
      var inner = wrap.querySelector('[role="separator"]')
      if (inner !== null && inner.parentNode !== null) inner.parentNode.removeChild(inner)
      wrap.setAttribute('data-dmw-row', kind)
      wrap.style.display = ''
      var button = wrap.localName === 'button' ? wrap : nodeButton(wrap) || wrap.firstElementChild
      if (button === null) return null
      var stale = ['aria-keyshortcuts', 'aria-haspopup', 'aria-expanded', 'aria-current', 'aria-disabled', 'aria-describedby', 'aria-checked', 'disabled']
      for (var i = 0; i < stale.length; i += 1) button.removeAttribute(stale[i])
      // A cloned disabled/tooltip row may carry duplicated ids.
      var identified = wrap.querySelectorAll('[id]')
      for (var j = 0; j < identified.length; j += 1) identified[j].removeAttribute('id')
      setRowLabel(button, labelFor(kind))
      setRowIcon(button, kind)
      button.addEventListener(
        'click',
        function (event) {
          event.preventDefault()
          event.stopPropagation()
          closeMenuUi()
          runMenuAction(kind, value)
        },
        true,
      )
      return wrap
    }

    function ensureOurRow(container, template, kind, value) {
      var existing = container.querySelector('[data-dmw-row="' + kind + '"]')
      if (existing !== null) {
        existing.style.display = ''
        var button = nodeButton(existing)
        if (button !== null) {
          setRowLabel(button, labelFor(kind))
          setRowIcon(button, kind)
        }
        return existing
      }
      var wrap = buildRow(template, kind, value)
      if (wrap !== null) container.appendChild(wrap)
      return wrap
    }

    function separatorSample(root) {
      var found = root.querySelector('[role="separator"]')
      return found !== null ? found : null
    }

    function ensureSeparator(container, key, sample) {
      var existing = container.querySelector('[data-dmw-sep="' + key + '"]')
      if (existing !== null) {
        existing.style.display = ''
        return existing
      }
      var node = null
      if (sample !== null) node = sample.cloneNode(false)
      else {
        node = document.createElement('div')
        node.className = 'dmw-sep'
      }
      node.setAttribute('role', 'separator')
      node.setAttribute('data-dmw-sep', key)
      return node
    }

    function hideNode(node, container, hidden) {
      if (node === null || node === undefined || node === container) return
      if (node.getAttribute('role') === 'menu') return
      hidden.push({ node: node, display: node.style.display })
      node.style.display = 'none'
      var sep = node.querySelector('[role="separator"]')
      if (sep !== null) {
        hidden.push({ node: sep, display: sep.style.display })
        sep.style.display = 'none'
      }
    }

    /** Visible direct children of the list container: rows and hairlines. */
    function visibleRowStats(container) {
      var rows = 0
      var seps = 0
      if (container === null) return { rows: rows, seps: seps }
      for (var i = 0; i < container.childNodes.length; i += 1) {
        var node = container.childNodes[i]
        if (node.nodeType !== 1 || node.style.display === 'none') continue
        if (node.getAttribute('role') === 'separator') {
          seps += 1
          continue
        }
        if (nodeButton(node) !== null) rows += 1
      }
      return { rows: rows, seps: seps }
    }

    /** True when the node and every ancestor up to the menu root are displayed. */
    function isVisibleWithin(node, root) {
      var current = node
      while (current !== null && current !== undefined) {
        if (current.nodeType === 1 && current.style !== undefined && current.style !== null && current.style.display === 'none') return false
        if (current === root) return true
        current = current.parentElement
      }
      return false
    }

    /* ------------------------------------------------------- menu layout -- */

    /**
     * Rewrite the workspace menu into the fixed six-entry layout:
     *   重命名 / 打开文件夹 ─ 置顶工作区 / 设置工作区 ─ 归档工作区 / 删除工作区
     * Official rename/delete rows are reused (their React handlers stay intact);
     * every other official row is hidden and every missing action gets our row.
     * The pass is rolled back when the result is not exactly six visible rows and
     * two hairlines, so a structurally different host menu can never end up empty.
     * @returns {'ok'|'retry'}
     */
    function layoutMenu(value) {
      var root = pickMenuRoot()
      if (root === null) return 'retry'
      var entries = rowEntries(root)
      if (entries.length === 0) return 'retry'
      var container = rowContainer(entries)
      if (container === null) return 'retry'

      var template = null
      var official = {}
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (isOurRow(entry.wrap)) continue
        if (template === null && entry.wrap.className) template = entry.wrap
        if (entry.kind === 'rename' && official.rename === undefined) official.rename = entry.wrap
        if (entry.kind === 'delete' && official.delete === undefined) official.delete = entry.wrap
      }
      if (template === null) return 'retry'

      var renameNode = official.rename !== undefined ? official.rename : ensureOurRow(container, template, 'rename', value)
      var deleteNode = official.delete !== undefined ? official.delete : ensureOurRow(container, template, 'delete', value)
      var openNode = ensureOurRow(container, template, 'open', value)
      var pinNode = ensureOurRow(container, template, 'pin', value)
      var foldersNode = ensureOurRow(container, template, 'folders', value)
      var archiveNode = ensureOurRow(container, template, 'archive', value)
      if (renameNode === null || deleteNode === null || openNode === null || pinNode === null || foldersNode === null || archiveNode === null) return 'retry'

      var sample = separatorSample(root)
      var sepA = ensureSeparator(container, 'a', sample)
      var sepB = ensureSeparator(container, 'b', sample)
      var used = [renameNode, deleteNode, openNode, pinNode, foldersNode, archiveNode]
      var originalOrder = Array.prototype.slice.call(container.childNodes)
      var hidden = []

      // Hide every official row we do not reuse, plus their separatorBefore.
      for (var j = 0; j < entries.length; j += 1) {
        var wrap = entries[j].wrap
        if (isOurRow(wrap)) continue
        if (used.indexOf(wrap) >= 0) {
          var ownSep = wrap.querySelector('[role="separator"]')
          if (ownSep !== null) {
            hidden.push({ node: ownSep, display: ownSep.style.display })
            ownSep.style.display = 'none'
          }
          continue
        }
        hideNode(wrap, container, hidden)
      }

      // Stale plugin rows (e.g. our rename row while the official rename exists) stay hidden.
      var ours = container.querySelectorAll('[data-dmw-row]')
      for (var k = 0; k < ours.length; k += 1) {
        if (used.indexOf(ours[k]) < 0) {
          hidden.push({ node: ours[k], display: ours[k].style.display })
          ours[k].style.display = 'none'
        }
      }

      // Only our two group hairlines remain visible.
      var seps = container.querySelectorAll('[role="separator"]')
      for (var s = 0; s < seps.length; s += 1) {
        if (seps[s] === sepA || seps[s] === sepB) {
          seps[s].style.display = ''
          continue
        }
        hidden.push({ node: seps[s], display: seps[s].style.display })
        seps[s].style.display = 'none'
      }

      var order = [renameNode, openNode, sepA, pinNode, foldersNode, sepB, archiveNode, deleteNode]
      for (var m = 0; m < order.length; m += 1) container.appendChild(order[m])

      // Never hand the user an empty or partial menu: verify, else roll back and retry.
      var stats = visibleRowStats(container)
      var allVisible = true
      for (var u = 0; u < order.length; u += 1) {
        if (!isVisibleWithin(order[u], root)) {
          allVisible = false
          break
        }
      }
      if (!allVisible || stats.rows !== 6 || stats.seps !== 2) {
        for (var r = 0; r < hidden.length; r += 1) hidden[r].node.style.display = hidden[r].display
        for (var o = 0; o < originalOrder.length; o += 1) {
          if (originalOrder[o].parentNode !== null) container.appendChild(originalOrder[o])
        }
        var created = container.querySelectorAll('[data-dmw-row]')
        for (var c = 0; c < created.length; c += 1) created[c].style.display = 'none'
        return 'retry'
      }

      container.setAttribute('data-dmw-menu', 'ready')
      return 'ok'
    }

    /**
     * Last resort after three failed takeovers: leave other contributions alone and
     * only add 「打开文件夹」 and 「设置工作区」.
     */
    function layoutFallback(value) {
      var root = pickMenuRoot()
      if (root === null) return false
      var entries = rowEntries(root)
      if (entries.length === 0) return false
      var container = rowContainer(entries)
      if (container === null) return false
      var template = null
      for (var i = 0; i < entries.length; i += 1) {
        if (!isOurRow(entries[i].wrap) && entries[i].wrap.className) {
          template = entries[i].wrap
          break
        }
      }
      if (template === null) return false
      var openNode = ensureOurRow(container, template, 'open', value)
      var foldersNode = ensureOurRow(container, template, 'folders', value)
      var stale = container.querySelectorAll('[data-dmw-row="pin"], [data-dmw-row="archive"], [data-dmw-row="rename"], [data-dmw-row="delete"]')
      for (var k = 0; k < stale.length; k += 1) stale[k].style.display = 'none'
      if (openNode === null || foldersNode === null) return false
      container.appendChild(openNode)
      container.appendChild(foldersNode)
      container.setAttribute('data-dmw-menu', 'fallback')
      return true
    }


    /* -------------------------------------------------- takeover lifecycle -- */

    var takeover = null

    /** Structural fingerprint of the visible menu rows (labels drift with locale, kinds do not). */
    function layoutSignature() {
      var root = pickMenuRoot()
      if (root === null) return null
      var rows = rowEntries(root)
      if (rows.length === 0) return null
      var container = rowContainer(rows)
      if (container === null) return null
      var parts = []
      for (var i = 0; i < container.childNodes.length; i += 1) {
        var node = container.childNodes[i]
        if (node.nodeType !== 1 || node.style.display === 'none') continue
        if (node.getAttribute('role') === 'separator') {
          parts.push('sep')
          continue
        }
        if (isOurRow(node)) {
          parts.push('dmw:' + node.getAttribute('data-dmw-row'))
          continue
        }
        var button = nodeButton(node)
        var kind = button === null ? '' : classifyLabel(button.textContent || '')
        parts.push(kind === 'rename' || kind === 'delete' ? kind : 'other')
      }
      return parts.join('|')
    }

    /** Either official switch is allowed (rename/delete are reused when the host provides them). */
    function expectedLayoutSignatures() {
      var list = []
      for (var r = 0; r < 2; r += 1) {
        for (var d = 0; d < 2; d += 1) {
          list.push(
            [
              r === 0 ? 'rename' : 'dmw:rename',
              'dmw:open',
              'sep',
              'dmw:pin',
              'dmw:folders',
              'sep',
              'dmw:archive',
              d === 0 ? 'delete' : 'dmw:delete',
            ].join('|'),
          )
        }
      }
      return list
    }

    function cancelTakeover() {
      if (takeover === null) return
      var state = takeover
      takeover = null
      state.done = true
      if (state.observer !== null) {
        try {
          state.observer.disconnect()
        } catch {
          /* ignore */
        }
      }
      if (state.quietTimer !== null) clearTimeout(state.quietTimer)
      if (state.pollTimer !== null) clearTimeout(state.pollTimer)
      if (state.deadline !== null) clearTimeout(state.deadline)
      if (state.verifyTimer !== null) clearTimeout(state.verifyTimer)
    }

    /** Start watching for the workspace menu; never touches another plugin's UI before it settles. */
    function beginTakeover(value) {
      cancelTakeover()
      var state = {
        value: value || {},
        attempts: 0,
        done: false,
        applied: false,
        applying: false,
        signature: '',
        observer: null,
        quietTimer: null,
        pollTimer: null,
        deadline: null,
        verifyTimer: null,
        root: null,
      }
      takeover = state
      state.deadline = setTimeout(function () {
        if (takeover === state && !state.done && !state.applied) finishFallback(state)
      }, TAKEOVER_DEADLINE_MS)
      pollForMenu(state)
    }

    function pollForMenu(state) {
      if (takeover !== state || state.done) return
      var root = pickMenuRoot()
      if (root !== null) {
        attachToMenu(root, state)
        return
      }
      state.pollTimer = setTimeout(function () {
        pollForMenu(state)
      }, 40)
    }

    function watchMenuMutations(state) {
      if (state.root === null) return
      if (state.observer !== null) {
        try {
          state.observer.disconnect()
        } catch {
          /* ignore */
        }
      }
      try {
        state.observer = new MutationObserver(function () {
          if (takeover !== state || state.done || state.applying) return
          if (state.applied) {
            // The menu was re-rendered or another plugin touched it: verify, then re-apply within budget.
            var currentRoot = pickMenuRoot()
            if (currentRoot === null) {
              cancelTakeover()
              return
            }
            if (currentRoot !== state.root) {
              state.root = currentRoot
              watchMenuMutations(state)
            }
            var signature = layoutSignature()
            if (signature === state.signature) return
            if (state.attempts >= TAKEOVER_LIMIT) {
              finishFallback(state)
              return
            }
            scheduleAttempt(state)
            return
          }
          scheduleAttempt(state)
        })
        state.observer.observe(state.root, { childList: true, subtree: true })
      } catch {
        state.observer = null
      }
    }

    function attachToMenu(root, state) {
      state.root = root
      watchMenuMutations(state)
      scheduleAttempt(state)
    }

    function scheduleAttempt(state) {
      if (takeover !== state || state.done) return
      if (state.quietTimer !== null) clearTimeout(state.quietTimer)
      state.quietTimer = setTimeout(function () {
        runAttempt(state)
      }, QUIET_MS)
    }

    function runAttempt(state) {
      if (takeover !== state || state.done || state.applying) return
      state.applying = true
      if (state.observer !== null) {
        try {
          state.observer.disconnect()
        } catch {
          /* ignore */
        }
      }
      var result = 'retry'
      try {
        result = layoutMenu(state.value)
      } catch {
        result = 'retry'
      }
      state.applying = false
      if (takeover !== state || state.done) return
      state.attempts += 1
      if (result === 'ok') {
        state.applied = true
        state.signature = layoutSignature()
        if (state.deadline !== null) {
          clearTimeout(state.deadline)
          state.deadline = null
        }
        // Keep watching so a host re-render is repaired (still within the three-attempt budget).
        watchMenuMutations(state)
        scheduleVerify(state)
        return
      }
      if (state.attempts >= TAKEOVER_LIMIT) {
        finishFallback(state)
        return
      }
      watchMenuMutations(state)
      scheduleAttempt(state)
    }

    /** Post-success check: a portal re-mount during the open transition replaces the root node. */
    function scheduleVerify(state) {
      if (state.verifyTimer !== null) clearTimeout(state.verifyTimer)
      state.verifyTimer = setTimeout(function () {
        state.verifyTimer = null
        if (takeover !== state || state.done || state.applying || !state.applied) return
        var currentRoot = pickMenuRoot()
        if (currentRoot === null) {
          cancelTakeover()
          return
        }
        if (currentRoot !== state.root) {
          state.root = currentRoot
          watchMenuMutations(state)
        }
        if (layoutSignature() === state.signature) return
        if (state.attempts >= TAKEOVER_LIMIT) {
          finishFallback(state)
          return
        }
        scheduleAttempt(state)
      }, 350)
    }

    function finishFallback(state) {
      if (takeover !== state || state.done) return
      state.applying = true
      try {
        layoutFallback(state.value)
      } catch {
        /* 放弃改写，保持宿主原菜单 */
      }
      state.applying = false
      state.done = true
      if (state.verifyTimer !== null) {
        clearTimeout(state.verifyTimer)
        state.verifyTimer = null
      }
      if (state.observer !== null) {
        try {
          state.observer.disconnect()
        } catch {
          /* ignore */
        }
      }
      state.observer = null
      if (state.deadline !== null) clearTimeout(state.deadline)
    }

    /* --------------------------------------------------------- menu action -- */

    function closeMenuUi() {
      var api = contextMenuService()
      try {
        if (api !== null && typeof api.close === 'function') {
          api.close()
          return
        }
      } catch {
        /* 退回 Escape */
      }
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } catch {
        /* ignore */
      }
    }

    function workspacePayload(value) {
      var input = value || {}
      return {
        workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : '',
        workspace: typeof input.path === 'string' ? input.path : '',
        title: typeof input.displayTitle === 'string' ? input.displayTitle : '',
      }
    }

    function reportFailure(error) {
      showToast(String(error && error.message ? error.message : error))
    }

    /* ------------------------------------------- open every workspace dir -- */

    var OPEN_IN_APP_APPS = 'open-in-app/apps'
    var OPEN_IN_APP_OPEN = 'open-in-app/open'
    var FILE_MANAGERS = ['explorer', 'finder', 'filemanager']

    /** The same manager the official 「打开文件夹」 row would use. */
    function preferredFileManager(apps) {
      var saved = ''
      try {
        saved = String(window.localStorage.getItem('dsh.open-in-app.choice') || '')
      } catch {
        saved = ''
      }
      if (saved !== '' && apps.indexOf(saved) >= 0) return saved
      for (var i = 0; i < FILE_MANAGERS.length; i += 1) if (apps.indexOf(FILE_MANAGERS[i]) >= 0) return FILE_MANAGERS[i]
      return ''
    }

    /**
     * Open every folder of a workspace by calling the official open-in-app route
     * once per folder (the same request the host's 「打开文件夹」 menu row makes).
     */
    function openAllWorkspaceFolders(payload) {
      return getState(payload.workspace, '').then(function (state) {
        var paths = []
        var add = function (value) {
          if (typeof value === 'string' && value !== '' && paths.indexOf(value) < 0) paths.push(value)
        }
        add(state && state.workspace)
        var folders = state && Array.isArray(state.folders) ? state.folders : []
        for (var i = 0; i < folders.length; i += 1) add(folders[i].path)
        if (paths.length === 0) throw new Error(tr('没有可打开的文件夹', 'No folders to open'))
        return fetch(OPEN_IN_APP_APPS, { headers: { accept: 'application/json' } })
          .then(function (response) {
            return response.ok === true ? response.json() : { apps: [] }
          })
          .then(function (body) {
            var apps = body && Array.isArray(body.apps) ? body.apps.filter(function (id) { return typeof id === 'string' }) : []
            var manager = preferredFileManager(apps)
            if (manager === '') {
              // 没有应用目录时退回 host 侧 explorer 调用（部分环境仍可用）。
              return post('/menu/open-all', payload).then(function (result) {
                var count = result && typeof result.count === 'number' ? result.count : 0
                if (count === 0) throw new Error(tr('打开文件夹失败', 'Could not open folders'))
                return { opened: count, total: paths.length }
              })
            }
            var chain = Promise.resolve()
            var opened = 0
            paths.forEach(function (path) {
              chain = chain.then(function () {
                return fetch(OPEN_IN_APP_OPEN, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ app: manager, path: path }),
                }).then(
                  function (response) {
                    if (response.ok === true) opened += 1
                  },
                  function () {
                    /* 单个失败不影响其它文件夹 */
                  },
                )
              })
            })
            return chain.then(function () {
              if (opened === 0) throw new Error(tr('打开文件夹失败', 'Could not open folders'))
              return { opened: opened, total: paths.length }
            })
          })
      })
    }

    /* ------------------------------------------- workspace group borders -- */

    var PIN_CACHE = { at: 0, pinned: [], workspaces: [] }
    var annotateTimer = null
    var annotateObserver = null

    function normalizeFsPath(value) {
      return String(value || '')
        .replace(/[\\/]+/gu, '\\')
        .replace(/\\+$/u, '')
        .toLowerCase()
    }

    function refreshWorkspacePins(force) {
      if (force !== true && Date.now() - PIN_CACHE.at < 1500) return Promise.resolve(PIN_CACHE)
      return request('/menu/pinned')
        .then(function (result) {
          PIN_CACHE = {
            at: Date.now(),
            pinned: Array.isArray(result.pinned) ? result.pinned : [],
            workspaces: Array.isArray(result.workspaces) ? result.workspaces : [],
          }
          return PIN_CACHE
        })
        .catch(function () {
          return PIN_CACHE
        })
    }

    /** The per-workspace wrapper that holds the title row plus its session rows. */
    function groupSectionOf(row) {
      // Deepest ancestor that still contains only this workspace's title row:
      // a shared list wrapper also contains the sibling workspace rows, so it is excluded.
      var tree = row.closest('[role="tree"]')
      var limit = tree === null || tree === undefined ? 6 : 12
      var node = row
      var best = row.parentElement
      for (var i = 0; i < limit && node !== null && node !== undefined; i += 1) {
        if (node === tree) break
        var inside = node.querySelectorAll('[data-row-key^="workspace:"]')
        if (inside.length > 1) break
        best = node
        node = node.parentElement
      }
      if (best === null || best === undefined || best === tree) best = row.parentElement
      return best
    }

    function pinnedTitleOfRow(row) {
      var button = row.querySelector('button[aria-label]')
      var label = button === null ? '' : button.getAttribute('aria-label') || ''
      return label === '' ? '' : titleFromActionsLabel(label)
    }

    /** Mark every workspace group with its pinned state so CSS can draw the borders. */
    function annotateWorkspaceGroups(force) {
      refreshWorkspacePins(force === true).then(function (cache) {
        var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key^="workspace:"]'))
        var byId = new Map()
        var byTitle = new Map()
        for (var i = 0; i < cache.workspaces.length; i += 1) {
          var summary = cache.workspaces[i]
          if (summary === null || summary === undefined) continue
          byId.set(String(summary.id), summary)
          if (summary.title) byTitle.set(String(summary.title), summary)
        }
        var groups = []
        for (var j = 0; j < rows.length; j += 1) {
          var row = rows[j]
          if (!(row instanceof Element)) continue
          var key = String(row.getAttribute('data-row-key') || '').slice('workspace:'.length)
          var group = groupSectionOf(row)
          if (group === null || group === undefined) continue
          var summary = byId.get(key)
          if (summary === undefined) {
            var title = pinnedTitleOfRow(row)
            if (title !== '') summary = byTitle.get(title)
          }
          var pinned = summary !== undefined && summary.pinned === true
          group.classList.add('dmw-ws-group')
          group.setAttribute('data-dmw-group', '1')
          group.setAttribute('data-dmw-pinned', pinned ? '1' : '0')
          groups.push({ group: group, pinned: pinned })
        }
        // Consecutive pinned groups: first/middle/last so one dark border wraps the whole block.
        for (var k = 0; k < groups.length; k += 1) {
          var entry = groups[k]
          if (!entry.pinned) {
            entry.group.removeAttribute('data-dmw-pin-pos')
            continue
          }
          var start = k === 0 || !groups[k - 1].pinned
          var end = k + 1 >= groups.length || !groups[k + 1].pinned
          entry.group.setAttribute('data-dmw-pin-pos', start && end ? 'only' : start ? 'first' : end ? 'last' : 'middle')
        }
      })
    }

    function scheduleAnnotate(force) {
      if (annotateTimer !== null) clearTimeout(annotateTimer)
      annotateTimer = setTimeout(function () {
        annotateTimer = null
        annotateWorkspaceGroups(force === true)
      }, 140)
    }

    function runMenuAction(kind, value) {
      var payload = workspacePayload(value)
      if (kind === 'folders') {
        openDialog(payload.workspace, payload.title)
        return
      }
      if (kind === 'rename') {
        openPrompt(tr('重命名工作区', 'Rename workspace'), payload.workspace, payload.title, function (name) {
          var body = workspacePayload(value)
          body.title = name
          post('/menu/rename', body)
            .then(function () {
              showToast(tr('工作区已重命名', 'Workspace renamed'))
            })
            .catch(reportFailure)
        })
        return
      }
      if (kind === 'delete') {
        openConfirm(
          tr('删除工作区', 'Delete workspace'),
          tr('将把该工作区从列表中移除；文件夹与会话记录会保留。', 'Removes the workspace from the list; its folder and sessions stay.'),
          tr('删除', 'Delete'),
          function () {
            post('/menu/delete', payload)
              .then(function () {
                showToast(tr('工作区已删除', 'Workspace deleted'))
              })
              .catch(reportFailure)
          },
          true,
        )
        return
      }
      if (kind === 'open') {
        openAllWorkspaceFolders(payload)
          .then(function (result) {
            var text = tr('已打开 ', 'Opened ') + String(result.opened) + '/' + String(result.total) + tr(' 个文件夹', ' folders')
            showToast(text)
          })
          .catch(reportFailure)
        return
      }
      if (kind === 'pin') {
        post('/menu/pin', payload)
          .then(function (result) {
            showToast(result && result.pinned === true ? tr('已置顶工作区', 'Workspace pinned') : tr('已取消置顶', 'Workspace unpinned'))
            scheduleAnnotate(true)
          })
          .catch(reportFailure)
        return
      }
      if (kind === 'archive') {
        openConfirm(
          tr('归档工作区', 'Archive workspace'),
          tr('将归档该工作区下的所有会话；运行中的会话会被跳过。', 'Archives every session in this workspace; running sessions are skipped.'),
          tr('归档', 'Archive'),
          function () {
            post('/menu/archive', payload)
              .then(function (result) {
                var archived = result && typeof result.archived === 'number' ? result.archived : 0
                var skipped = result && Array.isArray(result.skipped) ? result.skipped.length : 0
                var text = tr('已归档 ', 'Archived ') + String(archived) + tr(' 个会话', ' session(s)')
                if (skipped > 0) text += tr('（跳过 ', ' (skipped ') + String(skipped) + '）'
                showToast(text)
              })
              .catch(reportFailure)
          },
          false,
        )
      }
    }

    /** DOM fallback for builds without the core context-menu service. */
    function onDocumentContextMenu(event) {
      try {
        if (!(event.target instanceof Element)) return
        var hit = directWorkspaceRow(clientCtx, event.target)
        if (hit === null) return
        var workspace = hit.workspace
        beginTakeover({
          workspaceId: workspace.workspaceId || workspace.id || '',
          path: workspace.path || workspace.cwd || '',
          displayTitle: workspace.title || '',
        })
      } catch {
        /* 不影响默认右键 */
      }
    }

    /* --------------------------------------------------------------- dialog -- */

    var dialog = null

    function closeDialog() {
      if (dialog === null) return
      var current = dialog
      dialog = null
      try {
        current.dispose()
      } catch {
        /* ignore */
      }
    }

    function openDialog(workspacePath, workspaceTitle) {
      closeDialog()
      var self = { workspacePath: workspacePath, workspaceTitle: workspaceTitle }
      var overlay = el('div', { class: 'dmw-overlay' })
      var panel = el('div', { class: 'dmw-panel', role: 'dialog' })

      var titleText = el('div', { class: 'dmw-title-text' }, (workspaceTitle ? workspaceTitle + ' · ' : '') + tr('工作区文件夹', 'Workspace folders'))
      var subText = el('div', { class: 'dmw-sub' }, workspacePath || '')
      var head = el('div', { class: 'dmw-head' }, [
        el('div', { class: 'dmw-title' }, [titleText, subText]),
        el('button', { type: 'button', class: 'dmw-x', title: tr('关闭', 'Close'), text: '×', onClick: closeDialog }),
      ])

      var errorBox = el('div', { class: 'dmw-err', style: { display: 'none' } })
      var noteBox = el('div', { class: 'dmw-note', style: { display: 'none' } })
      var warnBox = el('div', { class: 'dmw-warn' }, [
        el('div', null, tr(
          '挂载会修改该文件夹的安全设置（与 DSH 对工作区本身所做的一致）：整棵子树标记为 Low 完整性，并添加一条 Everyone 的删除限制 ACE，使沙盒内的命令可写。移除时会尽量还原。首次挂载大目录可能需要数十秒；只应选择你自己的本地 NTFS/ReFS 目录。',
          'Mounting changes the folder security descriptor (same as DSH does for a workspace): the subtree becomes Low integrity and gains an Everyone delete-child deny so sandboxed commands can write. Removal restores it on a best-effort basis. The first mount of a large tree may take tens of seconds. Choose only your own local NTFS/ReFS folders.',
        )),
      ])

      var listBox = el('div')
      var footNote = el('div', { class: 'dmw-meta' })
      var addButton = el('button', { type: 'button', class: 'dmw-btn' }, tr('选择文件夹…', 'Choose folder…'))
      var remountButton = el('button', { type: 'button', class: 'dmw-btn' }, tr('重新挂载全部', 'Remount all'))
      var refreshButton = el('button', { type: 'button', class: 'dmw-btn' }, tr('刷新', 'Refresh'))
      var foot = el('div', { class: 'dmw-foot' }, [addButton, remountButton, refreshButton, el('span', { class: 'dmw-spacer' }), footNote])

      var busy = false
      var timer = null

      function setError(message) {
        if (message === '') {
          errorBox.style.display = 'none'
          errorBox.textContent = ''
          return
        }
        errorBox.style.display = 'flex'
        errorBox.textContent = String(message)
      }

      function setNote(message) {
        if (message === '') {
          noteBox.style.display = 'none'
          noteBox.textContent = ''
          return
        }
        noteBox.style.display = 'block'
        noteBox.textContent = String(message)
      }

      function setBusy(value) {
        busy = value
        var controls = [addButton, remountButton, refreshButton]
        for (var i = 0; i < controls.length; i += 1) controls[i].disabled = value
        var removeButtons = listBox.querySelectorAll('button[data-dmw-remove="1"]')
        for (var k = 0; k < removeButtons.length; k += 1) removeButtons[k].disabled = value
      }

      function folderStateText(folder) {
        if (folder.state === 'mounted') return tr('已挂载', 'mounted')
        if (folder.state === 'missing') return tr('目录不存在', 'missing')
        if (folder.state === 'rejected') return tr('被拒绝', 'rejected')
        if (folder.state === 'failed') return tr('挂载失败', 'failed')
        return tr('未挂载', 'not mounted')
      }

      function dotClass(folder) {
        if (folder.state === 'mounted') return 'dmw-dot dmw-dot-ok'
        if (folder.state === 'failed' || folder.state === 'rejected' || folder.state === 'missing') return 'dmw-dot dmw-dot-bad'
        return 'dmw-dot'
      }

      function render(state) {
        if (dialog !== self) return
        listBox.textContent = ''
        var primary = state && state.workspace ? String(state.workspace) : workspacePath

        listBox.appendChild(el('div', { class: 'dmw-sec' }, tr('主工作区（不可移除）', 'Primary workspace (locked)')))
        var primaryRow = el('div', { class: 'dmw-row dmw-row-primary' }, [
          el('div', { class: 'dmw-row-top' }, [
            el('span', { class: 'dmw-dot dmw-dot-ok' }),
            el('span', { class: 'dmw-name', title: primary }, basename(primary)),
            el('span', { class: 'dmw-lock' }, '🔒 ' + tr('主文件夹', 'primary')),
          ]),
          el('div', { class: 'dmw-code' }, primary),
        ])
        listBox.appendChild(primaryRow)

        listBox.appendChild(el('div', { class: 'dmw-sec' }, tr('额外文件夹', 'Extra folders')))
        var folders = state && Array.isArray(state.folders) ? state.folders : []
        if (folders.length === 0) {
          listBox.appendChild(el('div', { class: 'dmw-empty' }, tr(
            '还没有额外文件夹。点击下方「选择文件夹…」把另一个目录加进当前工作区；加入后 write/edit 与 shell 工具都能在该目录读写。',
            'No extra folders yet. Use "Choose folder…" below to add another directory; write/edit and shell tools can then work there.',
          )))
        } else {
          var list = el('div', { class: 'dmw-list' })
          for (var i = 0; i < folders.length; i += 1) {
            var folder = folders[i]
            var remove = el('button', { type: 'button', class: 'dmw-btn dmw-danger', 'data-dmw-remove': '1' }, tr('移除', 'Remove'))
            remove.addEventListener('click', (function (target) {
              return function (event) {
                event.preventDefault()
                return doRemove(target)
              }
            })(folder))
            var row = el('div', { class: 'dmw-row' }, [
              el('div', { class: 'dmw-row-top' }, [
                el('span', { class: dotClass(folder) }),
                el('span', { class: 'dmw-name', title: folder.path }, basename(folder.path)),
                el('span', { class: 'dmw-meta' }, folderStateText(folder)),
              ]),
              el('div', { class: 'dmw-code' }, folder.path),
              folder.error ? el('div', { class: 'dmw-meta', style: { whiteSpace: 'normal', marginTop: '4px' } }, String(folder.error)) : null,
              el('div', { class: 'dmw-acts' }, [remove]),
            ])
            list.appendChild(row)
          }
          listBox.appendChild(list)
        }
        if (state && state.configPath) footNote.textContent = tr('配置文件：', 'config: ') + state.configPath
        if (state && state.sandboxExtension !== 'windows-acl') {
          setError(tr(
            '当前平台不支持 shell 多根扩展（仅 Windows ACL 后端）；write/edit 工具的多根仍然可用。',
            'This platform does not support shell multi-root (Windows ACL only); write/edit multi-root still works.',
          ))
        }
      }

      function refresh() {
        if (busy) return Promise.resolve()
        return getState(workspacePath, '')
          .then(function (state) {
            render(state)
            setError('')
            return state
          })
          .catch(function (error) {
            setError(String(error.message || error))
          })
      }

      function run(label, action) {
        if (busy) return Promise.resolve()
        setBusy(true)
        setError('')
        setNote('')
        return Promise.resolve()
          .then(action)
          .then(
            function (message) {
              if (message) setNote(message)
            },
            function (error) {
              setError(String(error.message || error))
            },
          )
          .then(function () {
            setBusy(false)
            return refresh()
          })
      }

      function pickDirectory() {
        var uiWorkspace = null
        try {
          uiWorkspace = clientCtx === null ? null : clientCtx.get('uiWorkspace')
        } catch {
          uiWorkspace = null
        }
        if (uiWorkspace !== null && uiWorkspace !== undefined && typeof uiWorkspace.pickDirectory === 'function') {
          return Promise.resolve(uiWorkspace.pickDirectory())
        }
        var remote = null
        try {
          remote = clientCtx === null ? null : clientCtx.get('remote')
        } catch {
          remote = null
        }
        var picker = remote?.directoryPicker
        if (picker !== null && picker !== undefined && typeof picker.pick === 'function') {
          return Promise.resolve(picker.pick()).then(function (result) {
            if (result !== null && result !== undefined && result.ok === true) return result.value
            throw new Error((result !== null && result !== undefined && result.error && result.error.message) || 'directory picker failed')
          })
        }
        return Promise.reject(new Error(tr('当前界面没有可用的目录选择器', 'directory picker unavailable')))
      }

      function doAdd() {
        return run('add', function () {
          return pickDirectory().then(function (picked) {
            if (picked === null || picked === undefined || picked === '') return ''
            return post('/add', { workspace: workspacePath, folder: picked }).then(function () {
              return tr('已添加 ', 'added ') + picked
            })
          })
        })
      }

      function doRemove(folder) {
        return run('remove', function () {
          return post('/remove', { workspace: workspacePath, folder: folder.path }).then(function () {
            return tr('已移除 ', 'removed ') + folder.path
          })
        })
      }

      function doRemount() {
        return run('remount', function () {
          return post('/remount', { workspace: workspacePath }).then(function () {
            return tr('已重新挂载全部文件夹', 'all folders remounted')
          })
        })
      }

      addButton.addEventListener('click', function (event) {
        event.preventDefault()
        if (busy) return
        doAdd()
      })
      remountButton.addEventListener('click', function (event) {
        event.preventDefault()
        if (busy) return
        doRemount()
      })
      refreshButton.addEventListener('click', function (event) {
        event.preventDefault()
        refresh()
      })
      overlay.addEventListener('pointerdown', function (event) {
        if (event.target === overlay) closeDialog()
      })
      var onKey = function (event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeDialog()
        }
      }
      document.addEventListener('keydown', onKey, true)

      panel.appendChild(head)
      panel.appendChild(warnBox)
      panel.appendChild(errorBox)
      panel.appendChild(noteBox)
      panel.appendChild(listBox)
      panel.appendChild(foot)
      overlay.appendChild(panel)
      document.body.appendChild(overlay)

      self.dispose = function () {
        document.removeEventListener('keydown', onKey, true)
        if (timer !== null) clearInterval(timer)
        if (overlay.parentNode !== null) overlay.parentNode.removeChild(overlay)
      }
      dialog = self
      timer = setInterval(function () {
        refresh()
      }, 3000)
      refresh()
    }

    /* ---------------------------------------------------- context service -- */

    var menusApi = null

    /** The core context-menu service (0.2.x); null on hosts that render their own menu. */
    function contextMenuService() {
      if (menusApi !== null) return menusApi
      try {
        menusApi = clientCtx === null || clientCtx === undefined ? null : clientCtx.get('contextMenus') || null
      } catch {
        menusApi = null
      }
      return menusApi
    }

    /* ---------------------------------------------------------- feedback -- */

    var toastNode = null
    var toastTimer = null

    function showToast(text) {
      try {
        if (toastNode === null) {
          toastNode = el('div', { class: 'dmw-toast', role: 'status' })
          document.body.appendChild(toastNode)
        }
        toastNode.textContent = String(text)
        toastNode.style.display = 'block'
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(function () {
          toastTimer = null
          if (toastNode !== null) toastNode.style.display = 'none'
        }, 2400)
      } catch {
        /* 提示失败忽略 */
      }
    }

    /* ------------------------------------------------------- ask dialogs -- */

    var ask = null

    function closeAsk() {
      if (ask === null) return
      var current = ask
      ask = null
      try {
        current.dispose()
      } catch {
        /* ignore */
      }
    }

    function openAsk(options) {
      closeAsk()
      var self = { dispose: null }
      var overlay = el('div', { class: 'dmw-overlay' })
      var panel = el('div', { class: 'dmw-panel dmw-modal', role: 'dialog' })
      var input = null

      panel.appendChild(
        el('div', { class: 'dmw-head' }, [
          el('div', { class: 'dmw-title' }, [el('div', { class: 'dmw-title-text' }, options.title)]),
          el('button', { type: 'button', class: 'dmw-x', title: tr('关闭', 'Close'), text: '×', onClick: closeAsk }),
        ]),
      )
      if (options.description) panel.appendChild(el('div', { class: 'dmw-desc' }, options.description))
      if (options.input !== undefined) {
        input = el('input', { class: 'dmw-input', type: 'text', value: options.input || '', placeholder: options.placeholder || '' })
        panel.appendChild(input)
      }

      var confirmButton = el(
        'button',
        { type: 'button', class: 'dmw-btn' + (options.danger === true ? ' dmw-danger' : '') },
        options.confirmLabel || tr('确定', 'Confirm'),
      )
      var cancelButton = el('button', { type: 'button', class: 'dmw-btn' }, tr('取消', 'Cancel'))
      panel.appendChild(el('div', { class: 'dmw-modal-foot' }, [cancelButton, confirmButton]))
      overlay.appendChild(panel)
      document.body.appendChild(overlay)

      var submit = function () {
        var value = input === null ? undefined : String(input.value || '').trim()
        if (input !== null && value === '') {
          try {
            input.focus()
          } catch {
            /* ignore */
          }
          return
        }
        closeAsk()
        try {
          options.onConfirm(value)
        } catch {
          /* 回调失败不阻塞界面 */
        }
      }
      confirmButton.addEventListener('click', function (event) {
        event.preventDefault()
        submit()
      })
      cancelButton.addEventListener('click', function (event) {
        event.preventDefault()
        closeAsk()
      })
      overlay.addEventListener('pointerdown', function (event) {
        if (event.target === overlay) closeAsk()
      })
      var onKey = function (event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeAsk()
        } else if (event.key === 'Enter' && input !== null) {
          event.preventDefault()
          submit()
        }
      }
      document.addEventListener('keydown', onKey, true)

      self.dispose = function () {
        document.removeEventListener('keydown', onKey, true)
        if (overlay.parentNode !== null) overlay.parentNode.removeChild(overlay)
      }
      ask = self
      if (input !== null) {
        try {
          input.focus()
          input.select()
        } catch {
          /* ignore */
        }
      }
    }

    function openPrompt(title, description, initial, onConfirm) {
      openAsk({ title: title, description: description, input: initial || '', confirmLabel: tr('保存', 'Save'), onConfirm: onConfirm })
    }

    function openConfirm(title, description, confirmLabel, onConfirm, danger) {
      openAsk({ title: title, description: description, confirmLabel: confirmLabel, danger: danger === true, onConfirm: onConfirm })
    }

    /* ------------------------------------------------------------ plugin -- */

    var clientCtx = null
    var inject = ['slots']

    function HeaderButton(props) {
      var sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : ''
      var [count, setCount] = React.useState(0)
      React.useEffect(
        function () {
          if (sessionId === '') return undefined
          var alive = true
          var workspace = workspaceOfSession(clientCtx, sessionId)
          if (workspace === null || workspace === undefined) return undefined
          var load = function () {
            getState(workspace.path, sessionId).then(
              function (state) {
                if (alive && state && Array.isArray(state.folders)) setCount(state.folders.length)
              },
              function () {
                /* 静默 */
              },
            )
          }
          load()
          var timer = setInterval(load, 8000)
          return function () {
            alive = false
            clearInterval(timer)
          }
        },
        [sessionId],
      )
      if (sessionId === '') return null
      return h(
        'button',
        {
          type: 'button',
          className: 'dmw-btn',
          title: tr('多文件夹工作区', 'multi-folder workspace'),
          onClick: function () {
            var workspace = workspaceOfSession(clientCtx, sessionId)
            if (workspace !== null && workspace !== undefined) openDialog(workspace.path, workspace.title)
            else openDialog('', '')
          },
        },
        h('span', null, tr('文件夹', 'Folders')),
        count > 0 ? h('span', { className: 'dmw-badge' }, String(count)) : null,
      )
    }

    function apply(ctx) {
      clientCtx = ctx

      var style = document.createElement('style')
      style.setAttribute('data-dsh-multi-workspace', '1')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(
        function () {
          return function () {
            if (style.parentNode !== null) style.parentNode.removeChild(style)
            cancelTakeover()
            closeAsk()
            closeDialog()
            if (toastTimer !== null) {
              clearTimeout(toastTimer)
              toastTimer = null
            }
            if (toastNode !== null && toastNode.parentNode !== null) toastNode.parentNode.removeChild(toastNode)
            toastNode = null
          }
        },
        'multi-workspace: styles and overlays',
      )

      // 1) 右键菜单：优先订阅内核 context-menu 的当前目标（0.2.x），没有该服务时退回 DOM 行识别。
      var subscription = null
      var serviceTimer = null
      var listenerAttached = false

      var onActive = function () {
        var service = contextMenuService()
        var source = service !== null && service !== undefined ? service.active : null
        if (source === null || source === undefined || typeof source.getSnapshot !== 'function') return
        var target = null
        try {
          target = source.getSnapshot()
        } catch {
          target = null
        }
        if (target !== null && target !== undefined && target.kind === 'workspace' && target.value) beginTakeover(target.value)
        else cancelTakeover()
      }

      var subscribeMenus = function () {
        var service = contextMenuService()
        var source = service !== null && service !== undefined ? service.active : null
        if (source === null || source === undefined || typeof source.subscribe !== 'function') return false
        subscription = source.subscribe(onActive)
        onActive()
        return true
      }

      var attachDomFallback = function () {
        if (listenerAttached) return
        listenerAttached = true
        document.addEventListener('contextmenu', onDocumentContextMenu, true)
      }

      if (!subscribeMenus()) {
        attachDomFallback()
        // 服务可能晚于本插件就绪：短暂探测后切换到订阅模式。
        var probes = 0
        serviceTimer = setInterval(function () {
          probes += 1
          if (subscribeMenus()) {
            if (listenerAttached) {
              document.removeEventListener('contextmenu', onDocumentContextMenu, true)
              listenerAttached = false
            }
            clearInterval(serviceTimer)
            serviceTimer = null
          } else if (probes >= 10) {
            clearInterval(serviceTimer)
            serviceTimer = null
          }
        }, 500)
      }

      ctx.effect(
        function () {
          return function () {
            if (serviceTimer !== null) {
              clearInterval(serviceTimer)
              serviceTimer = null
            }
            if (listenerAttached) {
              document.removeEventListener('contextmenu', onDocumentContextMenu, true)
              listenerAttached = false
            }
            if (subscription !== null) {
              try {
                if (typeof subscription === 'function') subscription()
              } catch {
                /* ignore */
              }
              subscription = null
            }
            cancelTakeover()
          }
        },
        'multi-workspace: context menu subscription',
      )

      // 2) 工作区分组外框 + 置顶标记（DOM 注解，React 重渲染后自动补回）。
      var onSidebarMutations = function (mutations) {
        for (var i = 0; i < mutations.length; i += 1) {
          var mutation = mutations[i]
          var target = mutation.target
          if (target instanceof Element && target.closest('[role="tree"]') !== null) {
            scheduleAnnotate(false)
            return
          }
          for (var j = 0; j < mutation.addedNodes.length; j += 1) {
            var node = mutation.addedNodes[j]
            if (!(node instanceof Element)) continue
            if (String(node.getAttribute('data-row-key') || '').indexOf('workspace:') === 0 || node.querySelector('[data-row-key^="workspace:"]') !== null) {
              scheduleAnnotate(false)
              return
            }
          }
        }
      }
      try {
        annotateObserver = new MutationObserver(onSidebarMutations)
        annotateObserver.observe(document.body, { childList: true, subtree: true })
      } catch {
        annotateObserver = null
      }
      ctx.effect(
        function () {
          return function () {
            if (annotateObserver !== null) {
              try {
                annotateObserver.disconnect()
              } catch {
                /* ignore */
              }
              annotateObserver = null
            }
            if (annotateTimer !== null) {
              clearTimeout(annotateTimer)
              annotateTimer = null
            }
          }
        },
        'multi-workspace: workspace grouping',
      )
      scheduleAnnotate(true)

      // 3) Header action fallback button.
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({ name: SLOT, id: 'multi-workspace', order: 45 }, HeaderButton)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.HeaderButton = HeaderButton
    exports.__test = {
      openDialog: openDialog,
      closeDialog: closeDialog,
      closeAsk: closeAsk,
      showToast: showToast,
      directWorkspaceRow: directWorkspaceRow,
      isWorkspaceActionsLabel: isWorkspaceActionsLabel,
      titleFromActionsLabel: titleFromActionsLabel,
      contextMenuService: contextMenuService,
      normalizedLabel: normalizedLabel,
      classifyLabel: classifyLabel,
      labelFor: labelFor,
      pickMenuRoot: pickMenuRoot,
      menuRows: menuRows,
      layoutMenu: layoutMenu,
      layoutFallback: layoutFallback,
      beginTakeover: beginTakeover,
      cancelTakeover: cancelTakeover,
      takeoverState: function () {
        return takeover
      },
      MENU_LABEL: MENU_LABEL,
      ICON_BODY: ICON_BODY,
      preferredFileManager: preferredFileManager,
      normalizeFsPath: normalizeFsPath,
      annotateWorkspaceGroups: annotateWorkspaceGroups,
      openAllWorkspaceFolders: openAllWorkspaceFolders,
    }
    return module.exports
  },
})
