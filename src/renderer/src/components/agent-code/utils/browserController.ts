// 浏览器预览的渲染进程侧控制入口。
//
// AgentBrowser 挂载时把自己的导航能力注册进来，卸载时注销；主进程 browser_show
// 指令到达后（useAgentUiState 订阅）通过这里驱动页面切换，并把加载结果回传给主进程。
// 之所以用模块单例而不是 props 逐层下传：浏览器面板只在 rightPanelMode==='browser'
// 时挂载（隐藏即卸载 guest 进程），层级中间的组件都不该关心这件事。
import type { BrowserNavigateCommand, BrowserShowResult } from '../../../../../shared/browserPreview'

export type BrowserNavigator = (cmd: BrowserNavigateCommand) => Promise<Partial<BrowserShowResult>>

let navigator: BrowserNavigator | null = null

export function registerBrowserNavigator(fn: BrowserNavigator): () => void {
  navigator = fn
  return () => {
    if (navigator === fn) navigator = null
  }
}

export async function runBrowserNavigate(cmd: BrowserNavigateCommand, waitMountedMs = 3000): Promise<Partial<BrowserShowResult>> {
  // 面板此前没打开过时 AgentBrowser 尚未挂载（导航能力在组件挂载时才注册），
  // 而调用方刚 setRightPanelMode('browser') 要等一次渲染才生效，这里等它注册上。
  const until = Date.now() + waitMountedMs
  while (!navigator && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!navigator) return { ok: false, error: '浏览器面板未能打开' }
  try {
    return await navigator(cmd)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 主进程回执用的完整结构 */
export function toBrowserShowResult(cmd: BrowserNavigateCommand, r: Partial<BrowserShowResult>): BrowserShowResult {
  return {
    ok: r.ok === true,
    type: cmd.kind,
    title: typeof r.title === 'string' ? r.title : (cmd.title ?? ''),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {})
  }
}
