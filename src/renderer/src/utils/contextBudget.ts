// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 上下文预算（contextBudget）—— 纯函数层                                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 压缩本身已交回 pi SDK 的原生 compaction（触发用真实 usage、切点按 token 预算、
// 摘要由模型生成），请求成形前的机械兜底在 shared/contextGuard.ts。
// 这里只剩两件渲染层自己需要的事：把 n_ctx 折算成可用预算、读压缩边界。
import { agentConfig } from './agentConfig'
import type { AgentMessage, AgentSessionMemory } from '../../../shared/types'

const AGENT_CTX_DEFAULT = agentConfig.ctxDefault    // 取不到真实 n_ctx 时的兜底上下文大小
const AGENT_MAX_OUTPUT = agentConfig.maxOutput     // 与 chatStream 实际 max_tokens 一致
const AGENT_CTX_SAFETY = agentConfig.ctxSafety      // 预留安全余量（token）

// 字符→token 估算的唯一实现住在 shared/contextGuard（主进程的兜底裁剪要用同一个算法，
// 两边各写一份迟早会算出两个水位）。这里原样转出，历史调用方无需改动。
export { estimateTextTokens } from '../../../shared/contextGuard'

// 本次发送可用的 prompt token 预算（扣除输出预留 + 安全余量）
export function computeContextBudget(nCtx: number): number {
  const ctx = nCtx && nCtx > 0 ? nCtx : AGENT_CTX_DEFAULT
  const reserve = Math.min(AGENT_MAX_OUTPUT, Math.max(1024, Math.floor(ctx * 0.3)))
  return Math.max(512, ctx - reserve - AGENT_CTX_SAFETY)
}

// 压缩边界：会话开头有多少条消息已被摘要替代（发送时省略）。
// 值来自 pi 的压缩事件（manager.ts 把 firstKeptEntryId 换算成渲染层消息数组的下标）。
// 这里只做越界钳制 —— 「重新生成」会把尾部消息截掉，截完之后边界可能大于剩余条数，
// 此时按全部已覆盖处理（历史只剩摘要），而不是让发送时切片切出负数或误把未覆盖的当覆盖。
export function coveredPrefixCount(memory: AgentSessionMemory | undefined, messages: AgentMessage[]): number {
  return Math.max(0, Math.min(memory?.coveredCount ?? 0, messages.length))
}
