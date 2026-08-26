// 上下文构成估算：把一次请求的 prompt token 总量按来源拆成可读的分类占比。
// 运行时只给出「已用 / 窗口」总数（modelMetrics.nPromptTokens），并无分项，
// 因此这里按会话消息 + 系统提示 + 记忆摘要本地估算，再用「其他」项做差额对齐，
// 保证分段之和 = 真实总量（估计误差 / 知识库 / 内置指引 / 模板开销都归到「其他」）。
import { estimateTextTokens } from './contextBudget'
import { AGENT_SYSTEM_GUIDANCE } from '../../../shared/agentGuidance'
import type { AgentMessage, AgentProject, AgentSession } from '../../../shared/types'

export interface CtxCategory {
  key: string
  label: string
  tokens: number
  color: string
}

export interface MeasuredBreakdown {
  categories: CtxCategory[] // 系统提示 / 对话历史 / 工具调用 / 记忆压缩摘要
  toolByName: Record<string, number> // 各工具名占用的 token（工具调用项细分）
  total: number // 以上四项之和
}

// 被记忆摘要覆盖（发送时省略）的消息不计入历史/工具，因为它们已由 summary 替代。
function isCovered(m: AgentMessage, covered: Set<string>): boolean {
  return covered.has(m.id)
}

export function estimateContextMeasured(
  session: AgentSession | undefined,
  project: AgentProject | undefined,
): MeasuredBreakdown {
  const covered = new Set(session?.memory?.coveredMsgIds ?? [])

  // 系统提示 / 模型信息：内置工具指引（主进程注入系统提示）+ 项目自定义系统提示 + 跨会话项目记忆
  let systemTok = estimateTextTokens(AGENT_SYSTEM_GUIDANCE.join('\n\n'))
  if (project) {
    systemTok += estimateTextTokens(project.systemPrompt ?? '')
    systemTok += estimateTextTokens(project.memory?.notes ?? '')
  }

  // 对话历史 + 工具调用（仅未被摘要覆盖的消息）
  let historyTok = 0
  let toolTok = 0
  const toolByName: Record<string, number> = {}
  for (const m of session?.messages ?? []) {
    if (isCovered(m, covered)) continue
    historyTok += estimateTextTokens(m.content || '')
    for (const tc of m.toolCalls ?? []) {
      const t = estimateTextTokens(tc.args ?? '') + estimateTextTokens(tc.result ?? '')
      toolTok += t
      toolByName[tc.name] = (toolByName[tc.name] ?? 0) + t
    }
  }

  // 记忆压缩摘要（+ 结构化事实附录）
  let memoryTok = 0
  if (session?.memory) {
    memoryTok += estimateTextTokens(session.memory.summary ?? '')
    memoryTok += estimateTextTokens(session.memory.facts ?? '')
  }

  const categories: CtxCategory[] = [
    { key: 'system', label: '系统提示 / 模型信息', tokens: systemTok, color: '#8b5cf6' },
    { key: 'history', label: '对话历史', tokens: historyTok, color: '#3b82f6' },
    { key: 'tools', label: '工具调用', tokens: toolTok, color: '#f59e0b' },
    { key: 'memory', label: '记忆压缩摘要', tokens: memoryTok, color: '#10b981' },
  ]
  const total = systemTok + historyTok + toolTok + memoryTok
  return { categories, toolByName, total }
}
