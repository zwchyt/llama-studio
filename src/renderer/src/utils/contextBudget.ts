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

// ── pi 的 max_tokens 夹紧：补偿它硬编码的那份输出保留 ────────────────────────
// pi 每次请求都会算（pi-ai/dist/api/simple-options.js）：
//   max_tokens = min(配置值, max(1, contextWindow - 已占用 - CONTEXT_SAFETY_TOKENS))
// 其中 CONTEXT_SAFETY_TOKENS = 4096 是模块内常量，不可配置。它和本项目自己在
// computeContextBudget 里留的输出预留是两份，于是真实可用上下文被压到
// n_ctx - 4096：16k 窗口下，已占用超过 12288 时 max_tokens 就被夹到 1 ——
// 表现是「还剩 3k 上下文，模型却什么都不输出」。
// 补偿：报给 pi 的窗口抬高这 4096，它的算式就回到真实窗口：
//   max_tokens = n_ctx - 已占用  →  prompt + 输出恒等于 n_ctx，不浪费一个 token。
export const PI_CONTEXT_SAFETY_TOKENS = 4096

/** 报给 pi 的上下文窗口。拿不到真实 n_ctx 时返回 undefined（沿用 pi 的默认值）。 */
export function piContextWindowFor(nCtx: number): number | undefined {
  return nCtx > 0 ? nCtx + PI_CONTEXT_SAFETY_TOKENS : undefined
}

/** 压缩触发线相对兜底预算的下压量：让 pi 的原生压缩赶在兜底裁剪顶到天花板之前接管 */
export const COMPACTION_TRIGGER_MARGIN = 512

// 压缩边界：会话开头有多少条消息已被摘要替代（发送时省略）。
// 值来自 pi 的压缩事件（manager.ts 把 firstKeptEntryId 换算成渲染层消息数组的下标）。
// 这里只做越界钳制 —— 「重新生成」会把尾部消息截掉，截完之后边界可能大于剩余条数，
// 此时按全部已覆盖处理（历史只剩摘要），而不是让发送时切片切出负数或误把未覆盖的当覆盖。
export function coveredPrefixCount(memory: AgentSessionMemory | undefined, messages: AgentMessage[]): number {
  return Math.max(0, Math.min(memory?.coveredCount ?? 0, messages.length))
}
