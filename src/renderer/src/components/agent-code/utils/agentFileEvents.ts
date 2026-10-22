// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文件变更事件的渲染进程内分发                                            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 为什么需要这一层：文件树与预览列都要听同一个「文件变了」事件，而 preload 的
// onAgentFileChanged 历史上是「先 removeAllListeners 再 on」——第二个订阅者会顶掉第一个，
// 任一订阅者卸载时还会把别人的监听一起删掉。
//
// preload 已改为返回退订函数，但那是跨进程契约：dev 下热更新只换渲染进程，旧 preload
// 仍返回 undefined（调用即 TypeError）。所以把「一个底层监听 + 若干订阅者」放在这里：
// 底层只装一次、返回值一律不信，两个调用方各自订阅/退订，旧 preload 下也不会崩。

export type AgentFileChangedHandler = (data: { dir: string; filename: string }) => void

const subscribers = new Set<AgentFileChangedHandler>()
let installed = false

/**
 * 订阅文件变更。返回退订函数；底层监听只安装一次，且不主动摘除
 * （旧 preload 的 removeAgentFileListeners 会清掉所有订阅者，包括后来者）。
 */
export function subscribeAgentFileChanged(handler: AgentFileChangedHandler): () => void {
  subscribers.add(handler)
  if (!installed) {
    installed = true
    // 忽略返回值：新旧 preload 的返回类型不一致，这里只依赖「注册成功」这一事实
    window.api.onAgentFileChanged((data) => {
      // 复制一份再遍历：订阅者在回调里退订不会影响本轮分发
      Array.from(subscribers).forEach(fn => fn(data))
    })
  }
  return () => { subscribers.delete(handler) }
}
