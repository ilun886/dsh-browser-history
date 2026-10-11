/**
 * dsh-browser-history 客户端插件（浏览器半边）。
 *
 * 给右侧栏浏览器工具栏加一个「历史记录」按钮（悬浮提示 + 点击下拉列表），
 * 记录**用户手动**在侧边栏浏览器里访问过的页面，并可点击回跳。
 *
 * ── 为什么要做 ────────────────────────────────────────────────────────────
 * 官方 @deepseek-ai/dsh-client-ui-sidebar-browser 在 Desktop 上**确实使用**
 * Chromium 原生导航历史（官方 README L12：Desktop uses Electron <webview> with
 * native navigation history and retained pages），所以标签还活着时那对 ← → 是能用的
 * （由 element.canGoBack()/canGoForward() 驱动）。
 *
 * 真正缺的是「历史列表」这一层，以及跨标签/跨重启的保留：
 *   · 官方只存单条 checkpoint（client.js:1264 persist()），且需手动「恢复」才打开
 *   · 关掉 tab 即删（官方 README L108：Closing the tab removes its checkpoint）
 *   · 重启不恢复 Chromium 的 history 栈（同上）
 *
 * ⚠️ 关于 client.js:1237 的 element.clearHistory()——**它不是"丢弃用户历史"**：
 *   firstDocument 在构造时置 true、在 dropGuest() 里重置，而 webview 的初始地址是
 *   about:blank#<lease>（client.js:1342）。这段代码是在第一个真正的 HTTP(S) 文档
 *   提交时，把引导用的 about:blank 从历史栈里清掉，好让"后退"回不到 about:blank。
 *   （本文件早期版本把它误读成"主动丢弃历史"，已更正。）
 *
 * 另外 Desktop 的存储分区是进程内共享、不跨重启的（官方 README L110），
 * 实测磁盘上也没有对应分区与 Chromium History 库。
 *
 * ── 怎么拿到数据 ──────────────────────────────────────────────────────────
 * 桌面端侧边栏浏览器是 Electron <webview>：
 *   client.js:1336   document.createElement("webview")
 *   client.js:1338   element.dataset.sidebarBrowserFrame = "webview"
 * 导航事件派发在**元素**上（client.js:1175-1210），没有 stopPropagation、
 * 没有隔离，所以第三方插件挂同样的监听即可拿到用户点击产生的导航。
 * 地址与标题也从元素上读：element.getURL() / element.getTitle()。
 *
 * ── 三个必须记住的坑（都是实测踩出来的）───────────────────────────────────
 *
 * ① 【绝不能自激】不要「观察 document.body 子树」同时「在同一子树里写 DOM」：
 *      scan() → 写 DOM → 触发 observer → scan() → …
 *    回调走微任务，能把主线程彻底饿死（表现为永久停在 Loading plugins…、
 *    无报错、CPU 100%）。本文件曾因此把整个 app 卡死一次。
 *    现在的防护：observer 跳过自己渲染的 panel / tip / 按钮容器的变更，
 *    并且用 requestAnimationFrame 合并、加 scanning 重入锁。
 *
 * ② 【官方有多个面板】RightbarRoot 为**每个保留的会话**各渲染一份面板，
 *    同一时刻只有一个是可见的（其余 rect 为 0×0、offsetParent 为 null）。
 *    早期版本用 querySelector 只取第一个 → 按钮被插进隐藏面板（隐身）。
 *    后来的版本"只挑可见的" → 面板一换手按钮就跟旧面板一起隐身。
 *    **现在的做法：往每一个面板的工具栏里都插一个按钮**，
 *    这样无论哪个面板可见，它自带的按钮就跟着可见——不需要搬家、不需要轮询。
 *
 * ③ 【HMR 会叠加实例】client-hmr（web-app bundle，默认 500ms 轮询 mtime）在文件
 *    变动时重新求值 factory 并再跑一次 apply，但**不保证**先调用上一实例的清理
 *    函数。若不管，页面上会同时存在多个实例：各自持有 observer 和按钮，互相
 *    删除又互相重建，表现为工具栏里历史图标越堆越多。
 *    现在的做法：单例守卫（apply 开头先销毁上一实例）+ 按实例标识回收按钮。
 *
 * @module dsh-browser-history/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-history',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 宿主侧无服务依赖；sidebarRight 用懒访问，缺失时降级到 webview.loadURL。 */
    var inject = []

    /** 历史存储键。 */
    var KEY = 'dsh.browser-history.v1'
    /** 保留条数上限。 */
    var MAX = 300
    /** 下拉里最多渲染多少条（仅渲染，数据仍全量保留）。 */
    var RENDER_MAX = 60

    var TAG = '[BH]'

    // ────────────────────────────────────────────────────────────────────
    // 存储
    // ────────────────────────────────────────────────────────────────────

    /** 读取历史（按最近访问倒序）。任何异常都降级成空数组。 */
    function readHistory() {
      try {
        var raw = localStorage.getItem(KEY)
        if (!raw) return []
        var parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch (err) {
        return []
      }
    }

    /** 写回历史。配额满等异常静默吞掉——历史不值得打断浏览。 */
    function writeHistory(list) {
      try {
        localStorage.setItem(KEY, JSON.stringify(list))
      } catch (err) {
        console.warn(TAG, '历史写入失败（可能配额已满）', err)
      }
    }

    /**
     * 记录一次访问。按 URL 去重：已存在的同 URL 条目被移除后重新置顶，
     * 这样列表是「每个页面一条、按最近访问排序」，与浏览器历史观感一致。
     */
    function record(url, title) {
      if (!url || url === 'about:blank' || url.indexOf('about:') === 0) return
      if (url.indexOf('devtools:') === 0) return

      var list = readHistory()
      var clean = title ? String(title).trim() : ''

      var next = []
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].url !== url) next.push(list[i])
      }

      next.unshift({ url: url, title: clean, at: Date.now() })
      if (next.length > MAX) next.length = MAX
      writeHistory(next)

      // 下拉开着就实时刷新。
      if (panel && panel.isConnected) renderList()
    }

    // ────────────────────────────────────────────────────────────────────
    // 小工具
    // ────────────────────────────────────────────────────────────────────

    /** 从 URL 取主机名，失败返回原串。 */
    function hostOf(url) {
      try {
        return new URL(url).hostname
      } catch (err) {
        return url
      }
    }

    /** 列表项主标题：优先页面标题，退化到主机名。 */
    function labelOf(item) {
      if (item.title) return item.title
      return hostOf(item.url)
    }

    /** 相对时间，例如「刚刚」「12 分钟前」「3 天前」。 */
    function agoOf(at) {
      var d = Date.now() - (at || 0)
      if (d < 60e3) return '刚刚'
      if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'
      if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'
      return Math.floor(d / 86400e3) + ' 天前'
    }

    // ────────────────────────────────────────────────────────────────────
    // 样式（全部走 --dsw-alias-* 令牌，自动适配明暗主题）
    // ────────────────────────────────────────────────────────────────────

    var CSS = [
      // 尺寸/悬停优先用官方 iconButton 类；这几行是它失效时的兜底
      //（官方类名是 CSS-module 哈希，跨版本可能变），保证按钮至少可点、可见。
      '.dsh_bh_btn{flex:none;width:28px;height:28px;padding:6px;border:0;cursor:pointer;',
      '  border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      '  color:var(--dsw-alias-label-secondary);display:inline-flex;',
      '  align-items:center;justify-content:center;line-height:1}',
      '.dsh_bh_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh_bh_btn svg{width:15px;height:15px}',
      '.dsh_bh_tip{position:fixed;z-index:2147483200;pointer-events:none;',
      '  padding:5px 9px;border-radius:var(--dsw-radius-sm,6px);',
      '  font-size:12px;line-height:16px;white-space:nowrap;',
      '  color:var(--dsw-alias-label-primary);',
      '  background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));',
      '  border:1px solid var(--dsw-alias-border-l2);',
      '  box-shadow:0 4px 14px rgba(0,0,0,.18);',
      '  opacity:0;transition:opacity .12s ease}',
      '.dsh_bh_tip[data-show]{opacity:1}',
      '.dsh_bh_panel{position:fixed;z-index:2147483200;',
      '  width:340px;max-height:min(60vh,460px);display:flex;flex-direction:column;',
      '  background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));',
      '  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      '  box-shadow:0 10px 34px rgba(0,0,0,.26);overflow:hidden;',
      '  font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsh_bh_head{display:flex;align-items:center;gap:8px;flex:none;',
      '  padding:9px 10px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh_bh_title{flex:auto;min-width:0;font-size:12.5px;font-weight:600;',
      '  letter-spacing:.2px;color:var(--dsw-alias-label-primary)}',
      '.dsh_bh_count{flex:none;font-size:11px;font-weight:600;',
      '  color:var(--dsw-alias-label-secondary);',
      '  background:var(--dsw-alias-interactive-bg-hover);',
      '  border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}',
      '.dsh_bh_clear{flex:none;cursor:pointer;font:inherit;font-size:11.5px;',
      '  color:var(--dsw-alias-label-tertiary);background:transparent;border:0;',
      '  border-radius:6px;padding:3px 7px;appearance:none;-webkit-appearance:none;',
      '  transition:background .15s ease,color .15s ease}',
      '.dsh_bh_clear:hover{background:var(--dsw-alias-interactive-bg-hover);',
      '  color:var(--dsw-alias-label-primary)}',
      '.dsh_bh_list{flex:auto;min-height:0;overflow-y:auto;overflow-x:hidden;',
      '  padding:5px;display:flex;flex-direction:column;gap:1px;',
      '  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3) transparent}',
      '.dsh_bh_list::-webkit-scrollbar{width:8px}',
      '.dsh_bh_list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);',
      '  border-radius:4px;border:2px solid transparent;background-clip:content-box}',
      '.dsh_bh_item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;',
      '  background:transparent;border:0;border-radius:7px;padding:6px 8px;cursor:pointer;',
      '  font:inherit;color:inherit;appearance:none;-webkit-appearance:none}',
      '.dsh_bh_item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh_bh_ico{flex:none;width:18px;height:18px;border-radius:4px;display:grid;',
      '  place-items:center;overflow:hidden;font-size:10px;font-weight:700;',
      '  color:var(--dsw-alias-label-secondary);',
      '  background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh_bh_ico img{width:16px;height:16px;display:block}',
      '.dsh_bh_txt{flex:auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dsh_bh_name{font-size:12.5px;line-height:16px;white-space:nowrap;',
      '  overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
      '.dsh_bh_url{font-size:11px;line-height:14px;white-space:nowrap;',
      '  overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary)}',
      '.dsh_bh_time{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));',
      '  font-variant-numeric:tabular-nums}',
      '.dsh_bh_empty{padding:26px 14px;text-align:center;font-size:12px;',
      '  color:var(--dsw-alias-label-tertiary)}'
    ].join('\n')

    /** 注入样式表；重复加载（HMR）时先移除旧的。 */
    function injectCss() {
      var tagId = 'dsh-browser-history'
      var old = document.querySelector('style[data-plugin-css="' + tagId + '"]')
      if (old && old.parentNode) old.parentNode.removeChild(old)
      var tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      ;(document.head || document.documentElement).appendChild(tag)
    }

    // ────────────────────────────────────────────────────────────────────
    // 历史图标（时钟 + 逆时针箭头，对齐官方时钟图标的 16×16 / 1px 描边风格）
    // ────────────────────────────────────────────────────────────────────

    function historyGlyph() {
      var NS = 'http://www.w3.org/2000/svg'
      var svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('width', '15')
      svg.setAttribute('height', '15')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('stroke-width', '1')
      var paths = [
        // 主表盘：左右各留缺口（右侧给箭头）
        'M2.5 8A5.5 5.5 0 1 1 5.25 12.76',
        // 缺口处的箭头（指向逆时针 = 回溯）
        'M4.55 6.25L2.4 8L4.55 9.75',
        // 指针
        'M8 4.9V8.5L10.7 10'
      ]
      for (var i = 0; i < paths.length; i += 1) {
        var p = document.createElementNS(NS, 'path')
        p.setAttribute('d', paths[i])
        p.setAttribute('stroke', 'currentColor')
        p.setAttribute('stroke-linecap', 'round')
        p.setAttribute('stroke-linejoin', 'round')
        svg.appendChild(p)
      }
      return svg
    }

    // ────────────────────────────────────────────────────────────────────
    // 按钮 + 悬浮提示 + 下拉面板
    // ────────────────────────────────────────────────────────────────────

    /**
     * 本模块实例的随机标识。
     *
     * HMR 会重新求值整个 factory，但 **DOM 上的属性不会被清掉**。
     * 用一个实例标识给按钮打标，新实例就能认出「哪些按钮是上一版的」并回收，
     * 同时不会误删自己的。
     */
    var INSTANCE = 'bh-' + Math.random().toString(36).slice(2)

    /** 本实例创建的全部按钮（每个面板一个）。 */
    var myButtons = []

    var tip = null
    var panel = null
    var tipTimer = null
    var activeCtx = null

    /** 悬浮提示：延迟 500ms 出现，与官方 Tooltip 的 delayMs 一致。 */
    function showTip(anchor) {
      hideTip()
      tipTimer = setTimeout(function () {
        if (!anchor || !anchor.isConnected) return
        if (!tip) {
          tip = document.createElement('div')
          tip.className = 'dsh_bh_tip'
          tip.textContent = '历史记录'
          document.body.appendChild(tip)
        }
        var r = anchor.getBoundingClientRect()
        tip.style.top = r.bottom + 6 + 'px'
        tip.style.left = Math.round(r.left + r.width / 2 - tip.offsetWidth / 2) + 'px'
        tip.setAttribute('data-show', '')
      }, 500)
    }

    function hideTip() {
      if (tipTimer) {
        clearTimeout(tipTimer)
        tipTimer = null
      }
      if (tip) tip.removeAttribute('data-show')
    }

    /** 打开下拉：定位在按钮下方。 */
    function openPanel(anchor) {
      if (!anchor) return
      if (!panel) {
        panel = document.createElement('div')
        panel.className = 'dsh_bh_panel'
        document.body.appendChild(panel)
      }
      renderList()
      var r = anchor.getBoundingClientRect()
      var w = 340
      var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
      panel.style.left = Math.round(left) + 'px'
      panel.style.top = Math.round(r.bottom + 6) + 'px'
    }

    function closePanel() {
      if (panel) {
        panel.remove()
        panel = null
      }
    }

    /**
     * 找出当前**可见**的浏览器 webview。
     *
     * 与工具栏同理：官方为每个保留会话各渲染一份面板，隐藏面板里的 webview
     * 尺寸为 0。必须挑可见的那个，否则会把 URL 载进一个看不见的页面。
     */
    function visibleWebview() {
      var views = document.querySelectorAll('webview[data-sidebar-browser-frame]')
      for (var i = views.length - 1; i >= 0; i -= 1) {
        var v = views[i]
        try {
          var r = v.getBoundingClientRect()
          if (r.width > 0 && r.height > 0 && v.offsetParent !== null) return v
        } catch (err) {
          /* 忽略，继续找 */
        }
      }
      return null
    }

    /**
     * 官方 sidebarRight 服务的本地引用。
     *
     * ⛔ 为什么不用 `inject: ['sidebarRight']`（实测踩到）：
     *   对象级/数组级 inject 会把整个 apply() 推迟到该服务就绪之后。而本插件的
     *   按钮与 webview 监听**完全不依赖**这个服务（只有"点历史条目在侧栏打开"
     *   才需要它），把它写进 inject 等于让全部功能去等一个后到的服务；服务若因
     *   某种原因始终缺席，插件就永远不加载。这与 whale-widget 在 issue #154 里
     *   踩到的是同一类竞态。
     *   所以 apply() 立即执行，用局部的 ctx.inject([...], cb) 单独等它，
     *   拿到后存进这个变量；navigate() 在需要时读取。
     */
    var sidebarRightRef = null

    /** 取官方 sidebarRight 服务（可能尚未就绪，取不到返回 null）。 */
    function sidebarRight() {
      if (sidebarRightRef && typeof sidebarRightRef.openTab === 'function') return sidebarRightRef
      try {
        var sr = activeCtx && activeCtx.sidebarRight
        if (sr && typeof sr.openTab === 'function') return sr
      } catch (err) {
        /* 服务未注入 */
      }
      return null
    }

    /**
     * 在**侧边栏**里打开一个 URL（不是系统浏览器）。
     *
     * ⛔ 为什么需要三种策略（读官方源码得出的结论）：
     *   官方 sidebarRight 的 openTab(kind, options) 第一行就调 this.require()，
     *   而 require() 在没有「已挂载的会话界面」时会**直接抛错**：
     *     "sidebarRight: no session surface is mounted"      (client.js:6747)
     *   所以右侧栏处于收起/未挂载状态时，openTab 会抛异常而不是静默失败——
     *   早期版本把它写在 try 里，异常被吞掉，表现就是「点了没反应」。
     *
     *   官方侧边栏浏览器自己用的是另一条路（client.js:1581-1589）：
     *     const target = ctx.sidebarRight.commandTarget(element)
     *     ctx.sidebarRight.openTabFromTarget("browser", target)
     *   commandTarget 会从**当前聚焦元素**或屏上会话推出目标面板，
     *   因此传对元素很关键。我们的按钮就在侧栏工具栏里，是最合适的锚点。
     *
     * 策略顺序（由「最贴近用户在浏览器里点历史」到「最兜底」）：
     *   ① 已有可见的浏览器 webview → 直接 loadURL 导航它（原地打开，不加新标签）
     *   ② openTabFromTarget + commandTarget（官方浏览器用的正规路径）
     *   ③ openTab（简单直接，仅在会话界面已挂载时可用）
     *
     * @param url 目标地址。
     * @param anchor 侧栏里的锚点元素（我们的历史按钮），供 commandTarget 定位。
     * @returns 命中的策略名，全失败返回 null。
     */
    function navigate(url, anchor) {
      var tried = []
      var hit = null

      // ① 复用当前可见的浏览器标签页。
      var view = visibleWebview()
      if (view) {
        try {
          var p = view.loadURL(url)
          if (p && typeof p.catch === 'function') {
            p.catch(function (err) {
              console.warn(TAG, 'loadURL 失败', err)
            })
          }
          hit = 'webview'
        } catch (err) {
          tried.push('webview: ' + (err && err.message))
        }
      } else {
        tried.push('webview: 无可见 webview')
      }

      var sr = hit ? null : sidebarRight()
      if (!hit && !sr) {
        tried.push('service: 未拿到 sidebarRight')
      }

      // ② openTab 是**唯一能携带初始地址**的入口：placeTab 会把 options.params
      //    透传给 tabDomain.navigate(sessionId, tabId, {address, params})，
      //    浏览器 tab 再从 tab.navigation.params.url 读初始地址。
      //    但它开头就调 require()，没有挂载的会话界面时会抛错——所以放在 try 里。
      //    注意：浏览器标签注册时是 multiple:true，所以 openTab 一定会**新开**一个
      //    标签（contentId 带新的 randomUUID）。这也是为什么优先走 ①。
      if (!hit && sr) {
        try {
          sr.openTab('browser', { params: { url: url } })
          hit = 'openTab'
        } catch (err) {
          tried.push('openTab: ' + (err && err.message))
        }
      }

      // ③ 官方浏览器自己用的路径，但它**不传 params**（client.js:6569-6582 只透传
      //    paneId / replaceTab），所以只能把标签开出来，地址得靠 pendingUrl 补。
      if (!hit && sr) {
        try {
          var target = typeof sr.commandTarget === 'function'
            ? sr.commandTarget(anchor || document.activeElement)
            : undefined
          if (target !== undefined && typeof sr.openTabFromTarget === 'function') {
            sr.openTabFromTarget('browser', target)
            pendingUrl = { url: url, at: Date.now() }
            hit = 'openTabFromTarget+pending'
          } else {
            tried.push('commandTarget: ' + (target === undefined ? '未取到目标' : '无 openTabFromTarget'))
          }
        } catch (err) {
          tried.push('openTabFromTarget: ' + (err && err.message))
        }
      }

      // 统一在这里记录一次，成功与否都带上完整信息。
      rememberNav(hit || 'none', tried)
      if (!hit) console.warn(TAG, '没有可用的载体打开', url, tried)
      return hit
    }

    /**
     * 「标签已开、地址还没落地」时暂存的 URL。
     *
     * openTabFromTarget 不支持传初始地址（见上），只能先把浏览器标签开出来；
     * 这里记下地址，等新的 webview 在 scan/attach 里出现时补一次 loadURL。
     * 带时间戳是为了不误伤：超过 10 秒就作废，避免下次开标签时莫名跳到旧地址。
     */
    var pendingUrl = null

    /** 若有未落地的地址且刚记下不久，就把它载入这个 webview。 */
    function applyPending(element) {
      if (!pendingUrl) return false
      if (Date.now() - pendingUrl.at > 10000) {
        pendingUrl = null
        return false
      }
      var url = pendingUrl.url
      pendingUrl = null
      try {
        var p = element.loadURL(url)
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            console.warn(TAG, 'pending loadURL 失败', err)
          })
        }
        return true
      } catch (err) {
        console.warn(TAG, 'pending loadURL 抛错', err)
        return false
      }
    }

    /** 记下最近一次导航尝试的结果，便于外部（磁盘）确认。 */
    function rememberNav(strategy, tried) {
      try {
        localStorage.setItem('dsh.bh.lastnav', JSON.stringify({
          at: Date.now(), strategy: strategy, tried: tried, instance: INSTANCE
        }))
      } catch (err) {
        /* 忽略 */
      }
    }

    /**
     * 渲染下拉内容。
     * ⛔ panel 挂在 document.body 下，而 observer 观察 body 子树；
     *    因此 observer 必须跳过 panel / tip / 按钮容器的变更，否则会自激。
     */
    function renderList() {
      if (!panel || !panel.isConnected) return
      var list = readHistory()

      while (panel.firstChild) panel.removeChild(panel.firstChild)

      var head = document.createElement('div')
      head.className = 'dsh_bh_head'
      var title = document.createElement('span')
      title.className = 'dsh_bh_title'
      title.textContent = '历史记录'
      var count = document.createElement('span')
      count.className = 'dsh_bh_count'
      count.textContent = String(list.length)
      head.appendChild(title)
      head.appendChild(count)
      if (list.length > 0) {
        var clear = document.createElement('button')
        clear.type = 'button'
        clear.className = 'dsh_bh_clear'
        clear.textContent = '清空'
        clear.addEventListener('click', function (e) {
          e.stopPropagation()
          writeHistory([])
          renderList()
        })
        head.appendChild(clear)
      }
      panel.appendChild(head)

      if (list.length === 0) {
        var empty = document.createElement('div')
        empty.className = 'dsh_bh_empty'
        empty.textContent = '还没有记录。在侧边栏浏览器里打开网页后，这里会显示访问历史。'
        panel.appendChild(empty)
        return
      }

      var body = document.createElement('div')
      body.className = 'dsh_bh_list'
      var n = Math.min(list.length, RENDER_MAX)
      for (var i = 0; i < n; i += 1) body.appendChild(rowFor(list[i]))
      panel.appendChild(body)
    }

    /** 生成一行历史条目：图标 + 标题 + 域名 + 相对时间。 */
    function rowFor(item) {
      var row = document.createElement('button')
      row.type = 'button'
      row.className = 'dsh_bh_item'
      row.title = item.url

      var ico = document.createElement('span')
      ico.className = 'dsh_bh_ico'
      ico.textContent = (hostOf(item.url)[0] || '?').toUpperCase()
      try {
        var origin = new URL(item.url).origin
        var img = document.createElement('img')
        img.alt = ''
        img.loading = 'lazy'
        img.src = origin + '/favicon.ico'
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.removeChild(img)
        })
        ico.appendChild(img)
      } catch (err) {
        /* 非法 URL：保留字母兜底 */
      }
      row.appendChild(ico)

      var txt = document.createElement('span')
      txt.className = 'dsh_bh_txt'
      var name = document.createElement('span')
      name.className = 'dsh_bh_name'
      name.textContent = labelOf(item)
      var urlEl = document.createElement('span')
      urlEl.className = 'dsh_bh_url'
      urlEl.textContent = hostOf(item.url)
      txt.appendChild(name)
      txt.appendChild(urlEl)
      row.appendChild(txt)

      var time = document.createElement('span')
      time.className = 'dsh_bh_time'
      time.textContent = agoOf(item.at)
      row.appendChild(time)

      row.addEventListener('click', function () {
        // 把「哪个按钮开的」传下去：commandTarget 需要侧栏里的锚点才能选中面板。
        var anchor = null
        for (var i = 0; i < myButtons.length; i += 1) {
          if (myButtons[i].isConnected) {
            anchor = myButtons[i]
            break
          }
        }
        // navigate() 内部已统一记录结果，这里不重复记。
        navigate(item.url, anchor)
        closePanel()
      })
      return row
    }

    // ────────────────────────────────────────────────────────────────────
    // 把按钮插进右侧栏工具栏
    //
    // 官方锚点：
    //   [data-sidebar-right-mode]    全屏按钮
    //   [data-sidebar-right-toggle]  收起按钮
    //   两者的父节点就是那条 chrome 工具栏（class 形如 _stripChrome_xxx，
    //   并带 data-dockkit-strip-chrome）。
    //
    // ⛔ 官方为**每个保留的会话**各渲染一份面板 ⇒ 有多条工具栏，
    //    同一时刻只有一条可见。所以这里往**每一条**都插一个按钮，
    //    而不是挑"当前可见的那条"——后者在面板换手时按钮会跟着旧面板隐身。
    // ────────────────────────────────────────────────────────────────────

    /** 收集当前文档里所有的 chrome 工具栏容器（去重，排除 tab 条）。 */
    function allStrips() {
      var out = []
      var modes = document.querySelectorAll('[data-sidebar-right-mode]')
      var toggles = document.querySelectorAll('[data-sidebar-right-toggle]')
      var consider = function (el) {
        var g = el && el.parentNode
        if (!g) return
        if (g.querySelector && g.querySelector('[data-sidebar-right-tab]')) return // 这是 tab 行，不是 chrome 行
        for (var i = 0; i < out.length; i += 1) if (out[i] === g) return
        out.push(g)
      }
      for (var i = 0; i < modes.length; i += 1) consider(modes[i])
      for (var j = 0; j < toggles.length; j += 1) consider(toggles[j])
      return out
    }

    /** 造一个历史按钮。 */
    function makeButton(strip) {
      var mode = strip.querySelector('[data-sidebar-right-mode]')
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'dsh_bh_btn' + (mode && mode.className ? ' ' + mode.className : '')
      btn.setAttribute('aria-label', '历史记录')
      btn.setAttribute('data-dsh-bh-button', INSTANCE)
      btn.appendChild(historyGlyph())

      btn.addEventListener('mouseenter', function () {
        showTip(btn)
      })
      btn.addEventListener('mouseleave', hideTip)
      btn.addEventListener('focus', function () {
        showTip(btn)
      })
      btn.addEventListener('blur', hideTip)
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        hideTip()
        if (panel && panel.isConnected) closePanel()
        else openPanel(btn)
      })
      return btn
    }

    /**
     * 保证每条工具栏里都有本实例的按钮。
     *
     * 同时回收：① 上一版实例（或本实例早期版本）留下的按钮；
     *          ② 已被移出文档的按钮引用。
     * @returns 本轮新建的按钮数。
     */
    function syncButtons() {
      var strips = allStrips()

      // 清掉所有**不属于本实例**的按钮（HMR 遗留），否则工具栏里会堆叠图标。
      var stale = document.querySelectorAll('[data-dsh-bh-button]')
      for (var s = 0; s < stale.length; s += 1) {
        if (stale[s].getAttribute('data-dsh-bh-button') !== INSTANCE) {
          try {
            stale[s].remove()
          } catch (err) {
            /* 已被移除 */
          }
        }
      }

      // 丢掉已脱离文档的引用。
      var live = []
      for (var k = 0; k < myButtons.length; k += 1) {
        if (myButtons[k].isConnected) live.push(myButtons[k])
      }
      myButtons = live

      var added = 0
      for (var i = 0; i < strips.length; i += 1) {
        var strip = strips[i]
        var mine = null
        for (var m = 0; m < myButtons.length; m += 1) {
          if (myButtons[m].parentNode === strip) {
            mine = myButtons[m]
            break
          }
        }
        if (mine) continue
        var btn = makeButton(strip)
        strip.insertBefore(btn, strip.firstChild)
        myButtons.push(btn)
        added += 1
      }
      return added
    }

    // ────────────────────────────────────────────────────────────────────
    // webview 监听
    // ────────────────────────────────────────────────────────────────────

    function attach(element) {
      // 同一实例已挂过 → 跳过。
      if (element.__bhInstance === INSTANCE) return false
      // 上一个模块实例（HMR 重载）留下的监听先摘掉，避免旧闭包继续写旧键。
      if (typeof element.__bhDispose === 'function') {
        try {
          element.__bhDispose()
        } catch (err) {
          /* 旧句柄可能已失效 */
        }
      }

      var ac = new AbortController()
      var opts = { signal: ac.signal }

      var current = function (why) {
        try {
          record(element.getURL(), element.getTitle())
        } catch (err) {
          console.warn(TAG, why + ' 读取失败', err)
        }
      }

      // 挂监听可能晚于首次导航 → 先补记一次现状。
      current('attach')

      // 「标签已开、地址未落地」的补偿：openTabFromTarget 不能传初始地址，
      // 所以新 webview 一出现就把暂存的 URL 载进去。
      applyPending(element)

      element.addEventListener('did-navigate', function () {
        current('did-navigate')
      }, opts)
      element.addEventListener('did-navigate-in-page', function (e) {
        if (e && e.isMainFrame === false) return
        current('did-navigate-in-page')
      }, opts)
      element.addEventListener('page-title-updated', function () {
        current('page-title-updated')
      }, opts)

      element.__bhInstance = INSTANCE
      element.__bhDispose = function () {
        ac.abort()
        try {
          delete element.__bhInstance
          delete element.__bhDispose
        } catch (err) {
          /* delete 偶尔会失败，留着无害 */
        }
      }
      return true
    }

    /** 扫一遍 DOM：挂 webview 监听 + 保证按钮齐备。 */
    function scan() {
      var views = document.querySelectorAll('webview[data-sidebar-browser-frame]')
      var attached = 0
      for (var i = 0; i < views.length; i += 1) {
        if (attach(views[i])) attached += 1
      }
      var buttons = syncButtons()
      return { views: views.length, attached: attached, buttons: buttons }
    }

    // ────────────────────────────────────────────────────────────────────
    // 装配
    // ────────────────────────────────────────────────────────────────────

    function apply(ctx) {
      console.log(TAG, '插件已加载', INSTANCE)
      activeCtx = ctx
      injectCss()

      // ⛔ 单例守卫：HMR 不保证调用上一实例的清理函数，所以新实例主动销毁它。
      //    不做这一步，同一页面会同时存在多个实例，各自插按钮、各自扫描。
      try {
        var prev = globalThis.__dshBrowserHistoryDispose
        if (typeof prev === 'function') {
          console.log(TAG, '发现上一个实例，先销毁它')
          prev()
        }
      } catch (err) {
        console.warn(TAG, '销毁上一个实例失败', err)
      }

      // 单独等 sidebarRight 服务（不写进 exports.inject，避免拖住整个 apply：
      // 对象级 inject 会把 apply 推迟到该服务就绪，而按钮与 webview 监听并不依赖它）。
      // 拿到后存起来，navigate() 在用的时候读。
      try {
        ctx.inject(['sidebarRight'], function (scoped) {
          sidebarRightRef = scoped.sidebarRight
        })
      } catch (err) {
        // 拿不到也没关系：sidebarRight() 还有直读 ctx.sidebarRight 的兜底。
        console.warn(TAG, 'ctx.inject([sidebarRight]) 调用失败', err)
      }

      globalThis.__dshBrowserHistory = {
        list: readHistory,
        clear: function () {
          writeHistory([])
          renderList()
          return true
        },
        scan: function () {
          return scan()
        },
        instance: INSTANCE,
        version: '0.1.0'
      }

      var scheduled = false
      var scanning = false
      /**
       * 上一次真正执行 scan 的时间戳。
       *
       * ⛔ 为什么需要节流（性能考量）：observer 观察的是 document.body 的整个子树。
       *   而 DSH 是个聊天应用——助手输出时**每个 token 都会往 DOM 里插节点**，
       *   于是 scheduleScan 会被高频触发。scan() 内部有若干次 querySelectorAll
       *   （全文扫描），若不限速，流式输出期间会以接近帧率（~60/s）的频率反复
       *   全文查询，白白烧 CPU。
       *   250ms 的上限对体验无影响（工具栏重建后按钮最多晚 250ms 出现，肉眼无感），
       *   但把最坏情况的扫描频率压到 4/s。
       */
      var lastScanAt = 0
      var SCAN_MIN_INTERVAL = 250

      /** 合并多次变更成一次扫描；永不在 observer 回调里同步写 DOM。 */
      function scheduleScan() {
        if (scheduled) return
        scheduled = true
        var now = Date.now()
        var wait = SCAN_MIN_INTERVAL - (now - lastScanAt)
        if (wait > 0) {
          // 未到最小间隔：用定时器延后，**不要**递归 rAF——那会以帧率空转。
          setTimeout(function () {
            scheduled = false
            runScan()
          }, wait)
          return
        }
        requestAnimationFrame(function () {
          scheduled = false
          runScan()
        })
      }

      function runScan() {
        if (scanning) return
        scanning = true
        try {
          lastScanAt = Date.now()
          scan()
        } finally {
          scanning = false
        }
      }

      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i += 1) {
          var m = mutations[i]
          // 防护①：自己渲染的下拉 / 提示 / 按钮所在容器的变更，不算「页面变了」。
          if (panel && (m.target === panel || panel.contains(m.target))) continue
          if (tip && (m.target === tip || tip.contains(m.target))) continue
          var ownBtn = false
          for (var b = 0; b < myButtons.length; b += 1) {
            if (m.target === myButtons[b] || myButtons[b].contains(m.target)) {
              ownBtn = true
              break
            }
          }
          if (ownBtn) continue
          if (m.addedNodes && m.addedNodes.length > 0) {
            scheduleScan()
            return
          }
          if (m.removedNodes && m.removedNodes.length > 0) {
            scheduleScan()
            return
          }
        }
      })

      var start = function () {
        var root = document.body || document.documentElement
        if (!root) return false
        observer.observe(root, { childList: true, subtree: true })
        scheduleScan()
        return true
      }
      if (!start()) document.addEventListener('DOMContentLoaded', start, { once: true })

      var onDocPointerDown = function (e) {
        if (!panel || !panel.isConnected) return
        if (panel.contains(e.target)) return
        for (var i = 0; i < myButtons.length; i += 1) {
          if (myButtons[i].contains(e.target)) return
        }
        closePanel()
      }
      var onKeyDown = function (e) {
        if (e.key === 'Escape') {
          closePanel()
          hideTip()
        }
      }
      document.addEventListener('pointerdown', onDocPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)

      var dispose = function () {
        observer.disconnect()
        document.removeEventListener('pointerdown', onDocPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        hideTip()
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip)
        tip = null
        closePanel()
        for (var i = 0; i < myButtons.length; i += 1) {
          try {
            myButtons[i].remove()
          } catch (err) {
            /* 已移除 */
          }
        }
        myButtons = []
        if (globalThis.__dshBrowserHistoryDispose === dispose) {
          try {
            delete globalThis.__dshBrowserHistoryDispose
          } catch (err) {
            globalThis.__dshBrowserHistoryDispose = undefined
          }
        }
        console.log(TAG, '插件已卸载', INSTANCE)
      }
      // 暴露给下一个实例，让它在启动时先销毁我们（HMR 下 cleanup 不保证被调）。
      globalThis.__dshBrowserHistoryDispose = dispose

      ctx.effect(function () {
        return dispose
      }, 'dsh-browser-history: lifecycle')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
