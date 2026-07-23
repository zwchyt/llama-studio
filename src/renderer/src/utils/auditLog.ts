// ── 操作审计日志（内存环形缓冲 + 可选落盘 Tracing）──
// 记录 Agent 每次工具执行的关键信息，供「审计」面板排查。内存部分超出上限后
// 丢弃最旧记录，刷新/重开即清空；若 agentConfig.traceToDisk 开启，同时追加落盘供重启后复现。
import { agentConfig } from './agentConfig'

export interface AuditEntry {
  id: string
  timestamp: number
  sessionId: string
  tool: string
  args: string       // 已截断
  result: string     // 已截断
  durationMs: number
  failed: boolean
  approved: boolean  // 是否经过人工审批
}

const MAX_ENTRIES = 500
const ARG_CAP = 400
const RESULT_CAP = 600

const buffer: AuditEntry[] = []
const listeners = new Set<() => void>()
let seq = 0

function cap(s: string, n: number): string {
  if (typeof s !== 'string') return ''
  return s.length > n ? s.slice(0, n) + ` …(+${s.length - n})` : s
}

export function recordAudit(e: Omit<AuditEntry, 'id' | 'timestamp' | 'args' | 'result'> & { args: string; result: string }): void {
  const entry: AuditEntry = {
    id: `audit-${++seq}`,
    timestamp: Date.now(),
    sessionId: e.sessionId,
    tool: e.tool,
    args: cap(e.args || '', ARG_CAP),
    result: cap(e.result || '', RESULT_CAP),
    durationMs: e.durationMs,
    failed: e.failed,
    approved: e.approved,
  }
  buffer.push(entry)
  while (buffer.length > MAX_ENTRIES) buffer.shift()
  listeners.forEach(fn => { try { fn() } catch { /* 忽略订阅者异常 */ } })
  // 可选萼盘 Tracing：即发即忘，失败不影响主流程。
  if (agentConfig.traceToDisk && e.sessionId && typeof window !== 'undefined' && window.api?.agentTraceAppend) {
    void window.api.agentTraceAppend(e.sessionId, entry).catch(() => { /* 落盘失败静默忽略 */ })
  }
}

/** 返回快照（最新在前） */
export function getAuditEntries(): AuditEntry[] {
  return buffer.slice().reverse()
}

export function clearAudit(): void {
  buffer.length = 0
  listeners.forEach(fn => { try { fn() } catch { /* ok */ } })
}

export function subscribeAudit(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
