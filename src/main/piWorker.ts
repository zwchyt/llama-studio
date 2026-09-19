// pi-agent utility process 入口：把 pi SDK（ESM-only，模块求值同步阻塞主进程事件循环数秒）
// 整体搬进独立进程，主进程只做消息转发，彻底消除启动后 15s 预热导致的整窗"未响应"。
//
// 本文件被 electron-vite 单独打包为 out/main/piWorker.mjs（ESM），由主进程
// utilityProcess.fork() 拉起。进程内加载 @earendil-works/pi-coding-agent 等 ESM 包，
// 工具执行（文件/搜索/知识库等）通过 RPC 回主进程执行。
import { PiAgentManager, createWorkerExecutors } from './services/piAgentBridge/manager'

interface ParentPort {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (e: { data: unknown }) => void): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

// ── 日志透传到主进程（utility 进程 stdout 不可见时便于排查）──
function safeSerialize(v: unknown): unknown {
  if (v instanceof Error) return { message: v.message, stack: v.stack }
  try { JSON.stringify(v); return v } catch { return String(v) }
}
function log(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
  try { parentPort.postMessage({ kind: 'log', level, args: args.map(safeSerialize) }) } catch { /* ignore */ }
}

// ── 未决工具 RPC（worker → main 请求，main 执行后回 tool-result）──
let toolSeq = 0
const pendingTools = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
function callTool<T = unknown>(name: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++toolSeq
    pendingTools.set(id, { resolve: resolve as (v: unknown) => void, reject })
    parentPort.postMessage({ kind: 'tool-call', id, name, args })
  })
}

// ── 未决 ask/approve（worker → main 请求，main 弹窗后回 tool-event）──
let evtSeq = 0
const pendingToolEvents = new Map<number, { resolve: (v: unknown) => void }>()
function callToolEvent<T = unknown>(event: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = ++evtSeq
    pendingToolEvents.set(id, { resolve: resolve as (v: unknown) => void })
    parentPort.postMessage({ kind: 'tool-event', id, event })
  })
}

let manager: PiAgentManager | null = null
function ensureManager(): PiAgentManager {
  if (!manager) throw new Error('pi worker 未初始化（缺少 init）')
  return manager
}

// ── 命令分发：每个 action 对应 manager 的一个方法，返回可序列化结果 ──
async function handleCmd(action: string, args: Record<string, unknown>): Promise<unknown> {
  const m = ensureManager()
  switch (action) {
    case 'create': {
      const opts = args.opts as Parameters<PiAgentManager['createSession']>[0]
      await m.createSession({
        ...opts,
        onEvent: (sessionId, event) => {
          try { parentPort.postMessage({ kind: 'event', sessionId, event: safeSerialize(event) }) } catch { /* ignore */ }
        }
      })
      return { success: true }
    }
    case 'prompt':
      await m.prompt(String(args.sessionId), String(args.text), args.images as never)
      return { success: true }
    case 'steer':
      await m.steer(String(args.sessionId), String(args.text), args.images as never)
      return { success: true }
    case 'followUp':
      await m.followUp(String(args.sessionId), String(args.text), args.images as never)
      return { success: true }
    case 'clearQueue':
      await m.clearQueue(String(args.sessionId))
      return { success: true }
    case 'abort':
      await m.abort(String(args.sessionId))
      return { success: true }
    case 'dispose':
      m.disposeSession(String(args.sessionId))
      return { success: true }
    case 'setThinkingLevel':
      m.setThinkingLevel(String(args.sessionId), args.level as never)
      return { success: true }
    case 'undo': {
      const res = await m.undo(String(args.toolCallId))
      return { success: res.success, path: res.path, error: res.error }
    }
    case 'list':
      return { sessionIds: m.sessionIds }
    default:
      throw new Error(`未知 pi worker 命令: ${action}`)
  }
}

parentPort.on('message', (e: { data: unknown }) => {
  const msg = e.data as Record<string, unknown>
  if (!msg || typeof msg !== 'object') return

  if (msg.kind === 'init') {
    try {
      const executors = createWorkerExecutors(callTool, callToolEvent)
      manager = new PiAgentManager(executors, msg.toolNames as string[] | undefined)
      parentPort.postMessage({ kind: 'ready' })
    } catch (err) {
      parentPort.postMessage({ kind: 'init-error', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.kind === 'cmd') {
    const id = msg.id as number
    handleCmd(msg.action as string, (msg.args ?? {}) as Record<string, unknown>)
      .then((value) => parentPort.postMessage({ kind: 'cmd-result', id, ok: true, value: safeSerialize(value) }))
      .catch((err) => parentPort.postMessage({
        kind: 'cmd-result', id, ok: false,
        value: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }
      }))
    return
  }

  if (msg.kind === 'tool-result') {
    const id = msg.id as number
    const p = pendingTools.get(id)
    pendingTools.delete(id)
    if (p) {
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(typeof msg.value === 'object' && msg.value && 'message' in msg.value ? String((msg.value as { message: unknown }).message) : String(msg.value)))
    }
    return
  }

  if (msg.kind === 'tool-event') {
    const id = msg.id as number
    const p = pendingToolEvents.get(id)
    pendingToolEvents.delete(id)
    p?.resolve(msg.event)
    return
  }
})

process.on('uncaughtException', (err: unknown) => {
  log('error', 'uncaughtException', err)
})
process.on('unhandledRejection', (err: unknown) => {
  log('error', 'unhandledRejection', err)
})
