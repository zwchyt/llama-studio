// ── Agent 调试日志（内存环形缓冲）──
// 按「轮次」记录每次 LLM 请求的完整 payload、用量、耗时与工具调用链，供「调试」面板排查。
// 统一承载 agent-gap-analysis 的三项 P2：调试模式（完整 payload）、调用链追踪（逐轮工具链）、
// 性能监控（每轮 token/耗时）。仅存内存（不落盘），超出上限丢弃最旧记录，刷新/重开即清空。

export interface DebugToolCall {
  name: string
  durationMs: number
  failed: boolean
}

export interface DebugTurn {
  id: string
  timestamp: number
  sessionId: string
  turn: number                 // 本次生成内的轮序号
  requestPayload: string       // 完整请求体 JSON（截断，见 PAYLOAD_CAP）
  msgCount: number             // 请求消息条数
  toolCount: number            // 提供的工具数
  dropped: number              // 本轮 trimApiMessages 丢弃的消息数
  promptTokens: number
  completionTokens: number
  ttftMs?: number              // 首 token 延迟
  tps?: number                 // 解码速度（tokens/s）
  durationMs: number           // 本轮总耗时
  tools: DebugToolCall[]       // 本轮工具调用链（有序）
}

const MAX_TURNS = 50
const PAYLOAD_CAP = 8000

const buffer: DebugTurn[] = []
const listeners = new Set<() => void>()
let seq = 0

function capPayload(s: string): string {
  if (typeof s !== 'string') return ''
  return s.length > PAYLOAD_CAP ? s.slice(0, PAYLOAD_CAP) + ` …(+${s.length - PAYLOAD_CAP} 字符已截断)` : s
}

export function recordDebugTurn(
  e: Omit<DebugTurn, 'id' | 'timestamp' | 'requestPayload'> & { requestPayload: string }
): void {
  buffer.push({
    id: `dbg-${++seq}`,
    timestamp: Date.now(),
    sessionId: e.sessionId,
    turn: e.turn,
    requestPayload: capPayload(e.requestPayload || ''),
    msgCount: e.msgCount,
    toolCount: e.toolCount,
    dropped: e.dropped,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    ttftMs: e.ttftMs,
    tps: e.tps,
    durationMs: e.durationMs,
    tools: e.tools,
  })
  while (buffer.length > MAX_TURNS) buffer.shift()
  listeners.forEach(fn => { try { fn() } catch { /* 忽略订阅者异常 */ } })
}

/** 返回快照（最新在前） */
export function getDebugTurns(): DebugTurn[] {
  return buffer.slice().reverse()
}

export function clearDebug(): void {
  buffer.length = 0
  listeners.forEach(fn => { try { fn() } catch { /* ok */ } })
}

export function subscribeDebug(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
