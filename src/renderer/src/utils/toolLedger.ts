// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 短期记忆台账（toolLedger）—— 模块二「记忆系统」的会话内结构化记录             ║
// ║                                                                              ║
// ║ 在原始消息流之外维护一份结构化台账：每次工具调用记为「参数指纹 → 结果状态 +   ║
// ║ 结果缓存」，为主循环提供机制化的跨轮重复检测：                                ║
// ║   · 只读工具以完全相同参数再次成功调用 → 直接返回缓存结果（不重复执行），      ║
// ║     并计入既有 spinCount，重复达 spinLimit 仍走原有熔断路径；                 ║
// ║   · 与 auditLog/traceToDisk 互补：台账管「拦截决策」，审计管「落盘复现」。     ║
// ║ 生命周期与 spinCount 对齐：每次生成运行（runAgentTurn）各自新建，跨用户轮     ║
// ║ 不复用——用户可能在两次提问之间改动文件，跨轮缓存有陈旧风险。                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { agentConfig } from './agentConfig'

interface LedgerEntry {
  result: string      // 成功结果（截断后文本，与发给模型的一致）
  failed: boolean
  repeats: number     // 之后又以相同指纹调用的次数（缓存命中次数）
  turn: number        // 首次执行所在轮次
  at: number
}

export interface LedgerCacheHit {
  result: string
  count: number       // 含本次在内，该指纹的累计调用次数
  firstTurn: number
}

const MAX_ENTRIES = 300

export interface ToolLedger {
  /** 查询指纹是否命中「已成功执行过」的缓存（仅只读工具应调用；失败结果不缓存） */
  getCached(key: string): LedgerCacheHit | null
  /** 记录一次真实执行的结果（失败也记录，用于统计；但失败结果不参与缓存返回） */
  record(key: string, opts: { result: string; failed: boolean; turn: number; cacheable: boolean }): void
  /** 缓存命中被消费时递增重复计数 */
  bumpRepeat(key: string): void
  /** 台账规模（调试/验收用） */
  size(): number
}

export function createToolLedger(): ToolLedger {
  const entries = new Map<string, LedgerEntry>()
  return {
    getCached(key: string): LedgerCacheHit | null {
      const e = entries.get(key)
      if (!e || e.failed || !e.result) return null
      return { result: e.result, count: e.repeats + 2, firstTurn: e.turn }
    },
    record(key: string, opts: { result: string; failed: boolean; turn: number; cacheable: boolean }): void {
      if (entries.size >= MAX_ENTRIES && !entries.has(key)) return
      // 超长结果不缓存正文（防内存膨胀），但仍记录状态供重复统计
      const cacheBody = opts.cacheable && !opts.failed && opts.result.length <= agentConfig.ledgerResultCap
      entries.set(key, {
        result: cacheBody ? opts.result : '',
        failed: opts.failed,
        repeats: entries.get(key)?.repeats ?? 0,
        turn: opts.turn,
        at: Date.now(),
      })
    },
    bumpRepeat(key: string): void {
      const e = entries.get(key)
      if (e) e.repeats++
    },
    size(): number {
      return entries.size
    },
  }
}
