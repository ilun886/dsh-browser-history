# dsh-browser-history

给 DSH 右侧栏的内嵌浏览器加一个**历史记录**列表。

官方侧边栏浏览器只有**顺序**的后退/前进，没有可浏览的历史列表；而且历史不跨重启
保留。这个插件把访问过的页面记成一份列表（跨重启保留），点一下就能回到那一页。

---

## 它解决什么问题

先把话说准，避免误解。官方 `@deepseek-ai/dsh-client-ui-sidebar-browser` 的
Desktop 载体**确实使用 Chromium 原生导航历史**：

> Web uses an iframe with application-managed history; **Desktop uses Electron
> `<webview>` with native navigation history and retained pages.**
> —— 官方 `README.md` L12

> `IframeImpl` uses `BrowserNavigation`, while **`ElectronWebViewImpl` observes
> Chromium history**.
> —— 官方 `README.md` L69

所以**在一个标签页的生命周期内，官方那对 `←` `→` 是能用的**（由
`element.canGoBack()` / `canGoForward()` 驱动）。

真正缺的是另外三件事：

| 缺失 | 官方行为 | 本插件 |
| --- | --- | --- |
| 可浏览的历史**列表** | 只有顺序前进/后退，看不到"我访问过哪些页" | 下拉列表，含标题/域名/时间 |
| 跨**重启**保留 | 每个标签只存一条 URL+标题，且需手动"恢复"才打开 | 全量保留，重启后直接点 |
| 跨**关闭标签**保留 | 官方 README L108：*Closing the tab removes its checkpoint* | 记录独立于标签生命周期 |
| 去重与时间戳 | 无 | 按 URL 去重，最近访问置顶 |

### 官方丢弃的是什么

官方 README 的限制章节写得很明确：

> Saved title and URL survive reloads and plugin unload while the tab remains in
> Sidebar's layout. **Closing the tab removes its checkpoint. Restart restoration
> does not recover page memory, unsaved forms or Chromium's history stack.**
> —— 官方 `README.md` L108

也就是说：

- **标签还在** → 标题/URL 保留，原生前进/后退可用
- **标签关掉** → checkpoint 被删除
- **重启** → 不恢复页面内存、表单，也**不恢复 Chromium 的 history 栈**

### 关于 `clearHistory()`

官方代码里有这么一处：

```js
// ui-sidebar-browser/lib/client.js:1233-1239
observeReady(element, committed) {
  const parsed = committed ? parseBrowserAddress(element.getURL()) : void 0;
  if (parsed?.ok && this.firstDocument) {
    element.clearHistory();          // ← 注意：不是"丢弃用户历史"
    this.firstDocument = false;
  }
  ...
}
```

`firstDocument` 在构造时置 `true`，在 `dropGuest()` 里重置为 `true`；而 webview
创建时的初始地址是 `about:blank#<lease>`（同文件 L1342）。当**第一个真正的
HTTP(S) 文档**提交时，这段代码把引导用的 `about:blank` 从历史栈里清掉，
**目的是让"后退"回不到 `about:blank`**——之后前进/后退照常工作。

### 关于分区不落盘

Desktop 的存储分区是进程内共享的，官方 README 明确说 Cookie / Web storage
**不跨应用重启保留**：

> Desktop 按规范化的工作区 CWD 共享进程内存储分区……
> **Cookie 与 Web storage 不跨应用重启保留。**
> —— 官方 `README.zh.md` L110

本机实测确认磁盘上没有对应的持久化分区，也没有 Chromium 的 `History` 数据库：

```text
%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\
  dsh-platform-0d154612…      ← 只有平台自己的分区，内容仅
  dsh-platform-a18ac6a1…         Preferences / DIPS / 性能观测库
（不存在 dsh-sidebar-browser 分区，也不存在名为 History 的文件）
```

---

## 效果

在右侧栏顶栏多一个时钟图标：

| 功能 | 说明 |
| --- | --- |
| 位置 | 顶栏 `全屏` / `收起右侧边栏` 的左边（`分栏` 在更左侧的独立分组里） |
| 悬浮提示 | 鼠标停留 500ms 显示「历史记录」 |
| 下拉列表 | favicon + 页面标题 + 域名 + 相对时间 |
| 点击回跳 | 在**当前侧边栏**里打开该页面 |
| 清空 | 面板右上角「清空」 |
| 容量 | 最多 300 条，按 URL 去重，最近访问置顶 |
| 渲染 | 下拉一次最多画 60 行（数据仍全量保留，避免长列表卡顿） |
| 持久化 | 存 `localStorage`，**跨重启保留** |

---

## 安装

本机侧边栏浏览器只在 `desktop` profile 挂载，所以**必须装进 desktop profile**：

```powershell
dsh plugin --profile desktop add link:D:\dsh-browser-history
```

装完后重启 DSH。挂载生效需要两处同时存在（缺一不可）：

1. `C:\Users\<你>\.dsh\profiles\desktop\package.json` 的 `dependencies` 里出现
   `"dsh-browser-history": "link:D:/dsh-browser-history"`
2. **同一个文件的 `dsh.profile.bundles` 数组里出现 `"dsh-browser-history"`**

> ⚠️ 光加 `dependencies` **不会**挂载插件。`dsh.profile.bundles` 才是挂载表。

### 卸载

从 profile 的 `package.json` 里删掉上面那两处，重启 DSH 即可。

---

## 工作原理

### 数据从哪来

侧边栏浏览器是 Electron `<webview>`：

```js
// ui-sidebar-browser/lib/client.js:1336-1340
document.createElement("webview")
element.dataset.sidebarBrowserFrame = "webview"
```

导航事件派发在**页面 DOM 元素**上，没有 `stopPropagation`、没有隔离。
所以第三方插件挂同样的监听就能拿到用户点击产生的导航：

| 事件 | 用途 |
| --- | --- |
| `did-navigate` | 整页跳转 |
| `did-navigate-in-page` | 同页跳转（SPA、锚点） |
| `page-title-updated` | 标题变化 |

地址和标题也从元素上读：`element.getURL()` / `element.getTitle()`。

**因为一切都在页面里完成，所以不需要 desktop-bridge、不需要碰 `resources/app.asar`。**

### 点击回跳的三条策略

按「最贴近用户在浏览器里点历史」的顺序尝试：

| 顺序 | 条件 | 行为 |
| --- | --- | --- |
| ① `webview` | 已有可见的浏览器页 | **原地导航**，不新开标签 |
| ② `openTab` | 没有浏览器页 | 用官方服务新开标签，**带初始地址** |
| ③ `openTabFromTarget+pending` | ② 抛错时 | 先开标签，再用 `pendingUrl` 在 webview 出现后补地址 |

优先 ① 的原因：官方浏览器标签注册为 `multiple: true`，所以 `openTab` 一定会
**新开**一个标签。原地导航才不会越点越乱。

策略 ③ 的存在是因为 `openTabFromTarget` **不传 params**（见
`ui-sidebar-right/lib/client.js:6569-6582`，它只透传 `paneId` / `replaceTab`），
会把 URL 丢掉——只能靠 `pendingUrl` 事后补。

最近一次用了哪条策略会记在 `localStorage['dsh.bh.lastnav']`，便于排查。

---

## 三个实现上的坑

这些都是实测踩出来的，改代码前建议先看：

### ① 绝不能自激

**不要**「观察 `document.body` 子树」同时「在同一子树里写 DOM」：

```text
scan() → 写 DOM → 触发 observer → scan() → …
```

回调走微任务，能把主线程彻底饿死（表现为永久停在 `Loading plugins…`、
**无报错**、CPU 100%）。本插件曾因此把整个 app 卡死过一次。

现有防护：

- observer 跳过自己渲染的 `panel` / `tip` / 按钮容器的变更
- `requestAnimationFrame` 合并多次变更
- `scanning` 重入锁
- **250ms 最小扫描间隔** —— DSH 是聊天应用，助手每输出一个 token 都会插 DOM
  节点；不限速的话全文 `querySelectorAll` 会被拉到接近帧率。实测节流后
  约 1 次/秒。

### ② 官方有多个面板

`RightbarRoot` 为**每个保留的会话**各渲染一份面板，同一时刻只有一个是可见的
（其余 rect 为 `0×0`、`offsetParent` 为 `null`）。

| 做法 | 结果 |
| --- | --- |
| `querySelector` 只取第一个 | 按钮插进隐藏面板 → 隐身 |
| 只挑"当前可见的" | 面板一换手，按钮跟着旧面板隐身 |
| **往每一条工具栏都插一个** ✅ | 无论哪个面板可见，它自带的按钮就跟着可见 |

### ③ HMR 会叠加实例

`client-hmr`（默认 500ms 轮询 mtime）在文件变动时重新求值 factory 并**再跑一次
`apply`**，但**不保证**先调用上一实例的清理函数。不管的话页面上会同时存在多个
实例，各自持有 observer 和按钮，互相删除又互相重建，表现为工具栏里图标越堆越多。

现有防护：**单例守卫**（`apply` 开头先销毁上一实例）+ 按实例标识回收孤儿按钮。

---

## 调试

页面控制台可用（`Ctrl+Shift+I`）：

```js
__dshBrowserHistory.list()      // 当前历史数组
__dshBrowserHistory.clear()     // 清空
__dshBrowserHistory.scan()      // 立刻扫一遍 DOM，返回 {views, attached, buttons}
__dshBrowserHistory.instance    // 当前实例标识（排查多实例用）
```

日志前缀统一为 `[BH]`。

---

## 代码结构

```text
dsh-browser-history/
├─ package.json          双半区声明：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      bundle patch（挂载声明）
└─ lib/
   ├─ index.js           宿主半区：不注册服务、不挂事件，仅占位
   └─ client.js          全部逻辑（约 980 行）
```

**宿主半区为什么是空的**：侧边栏浏览器是 `<webview>`，导航事件派发在页面 DOM 上，
捕获历史只需要一个跑在页面里的客户端半区。宿主进程不参与，也就**不需要
desktop-bridge、不需要改 `app.asar`**。

---

## 兼容性

依赖以下官方内部结构，DSH 升级后**可能需要同步调整**：

| 依赖 | 位置 |
| --- | --- |
| `webview[data-sidebar-browser-frame]` | `ui-sidebar-browser` |
| `[data-sidebar-right-mode]` / `-toggle` | `ui-sidebar-right` |
| `ctx.sidebarRight.openTab(kind, options)` | `ui-sidebar-right` 服务 |
| `tab.navigation.params.url` | 浏览器标签的初始地址 |

样式全部走 `--dsw-alias-*` 设计令牌，自动适配明暗主题。
按钮复用官方 `iconButton` 类名（CSS-module 哈希，跨版本可能变），
同时有独立的兜底样式，保证官方类名失效时按钮仍然可点、可见。

---

## 已知限制

- 记录时机是导航**提交**（`did-navigate` / `did-navigate-in-page`）与标题更新，
  所以加载失败的页面（如 `ERR_CONNECTION_TIMED_OUT`）也会被记下 URL
- 不记录表单内容、滚动位置（官方也不恢复这些）
- 时间显示为相对时间（"3 分钟前"），不精确到秒
- 每个 URL 只保留一条（重新访问会置顶并更新时间）
- 只覆盖侧边栏浏览器；系统浏览器 / 外部 Chrome 的活动不在范围内
- **不接管** `←` `→` 后退/前进——那是 Chromium 原生行为，官方已在用；
  本插件只提供官方没有的"历史列表"这一层

## 许可

MIT
