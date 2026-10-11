/**
 * dsh-browser-history 宿主插件：本插件是纯客户端（浏览器）能力——
 * 宿主侧不挂任何 Cordis 服务、不注册事件，只作为 profile 插件层存在，
 * 让 web 服务器把客户端 bundle 提供给浏览器
 * （/plugins/dsh-browser-history/client.js）。
 *
 * 为什么宿主侧什么都不做：侧边栏浏览器是 Electron <webview>，它的导航事件
 * 派发在**页面 DOM 元素**上（官方 ui-sidebar-browser 自己也是这么监听的），
 * 所以捕获历史只需要一个跑在页面里的客户端半区，不需要宿主进程参与——
 * 也就意味着**不需要 desktop-bridge，不需要碰 resources/app.asar**。
 *
 * @module dsh-browser-history
 */

/** Cordis 插件名（Loader 入口与客户端 bundle id）。 */
export const name = 'dsh-browser-history'

/** 宿主侧无服务依赖。 */
export const inject = []

/** 宿主 apply：无运行时行为，占位保持插件层结构完整。 */
export function apply() {}
