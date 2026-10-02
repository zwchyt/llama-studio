// 终端能力的转发入口（不依赖 @xterm/*）。
//
// ⚠️ 刻意不依赖 @xterm/*，也不要合并回 terminalRegistry.ts。
// terminalRegistry.ts 开头就静态引入 @xterm/xterm + 两个 addon，而入口模块 App.tsx 需要
// 它的两个能力（写数据 / 释放实例）—— 只要 App 这条链上出现任何一个静态导入，整个 xterm
// 就会被打进入口包（实测入口 chunk 里 xterm.js 出现 6 次）。历史上有两条这样的路径：
//   ① App.tsx  → utils/terminalRegistry        （writeToTerminal）
//   ② App.tsx  → store/terminalStore → utils/terminalRegistry（disposeTerminal）
// 两条都改到本模块后，terminalRegistry 就只剩 TerminalView（已是 React.lazy）一个引用方。
//
// 解耦方式：registry 加载后调 attachTerminalSink 接管；在那之前
//   · 写数据：先缓在这里（策略与 registry 内部的 pendingWrites 一致：256KB、丢最旧的），
//     接管时回放，所以「实例未就绪先攒着」这个语义没有任何变化；
//   · 释放实例：直接忽略 —— registry 都没加载，自然也不存在实例。

type TerminalSink = {
  write: (id: string, data: string) => void
  dispose: (id: string) => void
}

const MAX_BACKLOG_BYTES = 256 * 1024

let sink: TerminalSink | null = null
const backlog: Array<{ id: string; data: string }> = []
let backlogBytes = 0

/** terminalRegistry 加载时调用，接管写入/释放，并回放此前攒下的数据。 */
export function attachTerminalSink(next: TerminalSink): void {
  sink = next
  const pending = backlog.splice(0, backlog.length)
  backlogBytes = 0
  for (const item of pending) next.write(item.id, item.data)
}

export function writeToTerminal(id: string, data: string): void {
  if (sink) { sink.write(id, data); return }
  backlog.push({ id, data })
  backlogBytes += data.length
  while (backlog.length > 1 && backlogBytes > MAX_BACKLOG_BYTES) {
    const dropped = backlog.shift()
    if (!dropped) break
    backlogBytes -= dropped.data.length
  }
}

export function disposeTerminal(id: string): void {
  sink?.dispose(id)
}
