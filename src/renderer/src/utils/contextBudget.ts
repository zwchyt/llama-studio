// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 上下文预算与裁剪（contextBudget）—— 从 AgentCodeView 抽出的纯函数层            ║
// ║                                                                              ║
// ║ 职责：Token 估算、预算计算、轮次裁剪、重要性折叠、配对修复、轮次切分、          ║
// ║ 结构化事实附录提取。全部为无 UI / 无 window 依赖的纯函数，                     ║
// ║ 可在 Node 离线环境直接加载——M4 全链路压测据此对贫瘠上下文场景做脚本化验证。     ║
// ║ 注意：仅做搬移封装，逻辑与原 AgentCodeView 实现完全一致。                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { agentConfig } from './agentConfig'
import { TOOL_METAS } from './tools'
import type { AgentMessage } from '../../../shared/types'

// OpenAI 兼容 API 的消息形状（含工具调用与工具结果）
export type ApiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const AGENT_CTX_DEFAULT = agentConfig.ctxDefault    // 取不到真实 n_ctx 时的兜底上下文大小
const AGENT_MAX_OUTPUT = agentConfig.maxOutput     // 与 chatStream 实际 max_tokens 一致
const AGENT_CTX_SAFETY = agentConfig.ctxSafety      // 预留安全余量（token）

export const TOOL_RESULT_LIMIT = 6000
// 单条工具结果的硬上限（字符）：无论上下文多大都不超过此值。
// 关键护栏：32k 这类小上下文模型上，toolResultCharLimit 原随预算放大到 ~68k 字符，
// 一条 Read 大文件就能吃掉大半个 prompt 预算 → 几轮就把上下文填爆。
// 这里封顶，保证单条结果在任何模型上都不会超过 ~16k 字符（约 5k token）。
export const TOOL_RESULT_HARD_CAP = 16000
// 单条工具结果最多可占 prompt 预算的比例：从预算分配层面兜底，
// 即使预算很大，单条也不会吃掉大部分可用上下文（小上下文模型受益最大）。
export const TOOL_RESULT_BUDGET_RATIO = 0.4

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) ascii++
    else if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else ascii += 0.5
  }
  return Math.ceil(ascii * 0.3 + cjk * 1.6) + 2
}

export function estimateApiMsgTokens(m: ApiMessage): number {
  let text = ''
  if (typeof m.content === 'string') text = m.content
  else if (Array.isArray(m.content)) text = m.content.map(p => String((p as Record<string, unknown>).text ?? '')).join('')
  let extra = 0
  const tcs = (m as { tool_calls?: Array<{ function: { arguments: string } }> }).tool_calls
  if (Array.isArray(tcs)) extra = tcs.reduce((s, tc) => s + estimateTextTokens(tc.function?.arguments || ''), 0)
  return estimateTextTokens(text) + extra + 4
}

// 本次发送可用的 prompt token 预算（扣除输出预留 + 安全余量）
export function computeContextBudget(nCtx: number): number {
  const ctx = nCtx && nCtx > 0 ? nCtx : AGENT_CTX_DEFAULT
  const reserve = Math.min(AGENT_MAX_OUTPUT, Math.max(1024, Math.floor(ctx * 0.3)))
  return Math.max(512, ctx - reserve - AGENT_CTX_SAFETY)
}

// 单条工具结果允许的最大字符数：随模型上下文预算伸缩（不再固定 6000），
// 避免大上下文模型也被无意义截断；同时受「硬上限 + 预算占比上限」双重封顶，
// 防止小上下文模型（如 32k）因单条结果过大而几轮内就把 prompt 预算吃爆。
export function toolResultCharLimit(budgetTokens: number): number {
  const n = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : AGENT_CTX_DEFAULT
  const scaled = Math.floor(n * 3)
  const byBudget = Math.floor(n * TOOL_RESULT_BUDGET_RATIO)
  return Math.max(TOOL_RESULT_LIMIT, Math.min(scaled, TOOL_RESULT_HARD_CAP, byBudget))
}

// 按「轮次」裁剪：保留 system + 最新的若干完整轮次，丢弃最早的轮次；
// 轮次以 user 消息为界切分，保证 tool_calls 与其 tool 结果不被拆散。
// 若仅剩的最新一轮仍超限，则进一步从最早的 tool 结果起截断内容（安全阀）。
export function trimApiMessages(messages: ApiMessage[], budget: number): { messages: ApiMessage[]; dropped: number } {
  if (messages.length === 0) return { messages, dropped: 0 }
  // ── 重要性裁剪（阶段 1.3）：同文件重复 Read 只保最新 ──
  // Read 结果以 "File: <path>" 开头；同一文件被多次读取时，旧结果折叠为占位说明，
  // 只收敛内容、不删消息——保证 tool_calls ↔ tool 配对完整。旧版本通常已过时（文件
  // 可能已被编辑），保留只会误导模型且白占预算。
  if (agentConfig.ctxImportanceEnabled) {
    // 解析 Read 结果头：文件路径 + 行区间（FileReadTool 输出格式：File: p\nLines: s-e of n）。
    // 无 Lines 行时视为全文读取（区间取最大）。
    const parseReadHead = (c: string): { path: string; s: number; e: number } | null => {
      const fm = /^"?File: ([^\n"]+)/.exec(c)
      if (!fm) return null
      const lm = /\nLines: (\d+)-(\d+) of \d+/.exec(c)
      return { path: fm[1], s: lm ? +lm[1] : 1, e: lm ? +lm[2] : Number.MAX_SAFE_INTEGER }
    }
    const readsByFile = new Map<string, { idx: number; s: number; e: number }[]>()
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.role === 'tool' && typeof m.content === 'string') {
        const h = parseReadHead(m.content)
        if (h) {
          const arr = readsByFile.get(h.path) ?? []
          arr.push({ idx: i, s: h.s, e: h.e })
          readsByFile.set(h.path, arr)
        }
      }
    }
    if (readsByFile.size > 0) {
      messages = messages.map((m, i) => {
        if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= 400) return m
        const h = parseReadHead(m.content)
        if (!h) return m
        // 仅当后续存在「覆盖本区间」的更新读取时才折叠——
        // 同文件不同行段的分段读取互不误杀（否则信息真丢且占位文案误导模型）
        const covered = readsByFile.get(h.path)?.some(r => r.idx > i && r.s <= h.s && r.e >= h.e)
        if (!covered) return m
        const rangeNote = h.e === Number.MAX_SAFE_INTEGER ? '' : `（第 ${h.s}-${h.e} 行）`
        return { ...m, content: `File: ${h.path}${rangeNote}\n（该区间在后续轮次被再次读取，此旧版内容已省略以节省上下文；最新内容见后文的读取结果。）` }
      })
    }
  }
  const sys = messages[0] && messages[0].role === 'system' ? messages[0] : null
  const rest = sys ? messages.slice(1) : messages
  const turns: ApiMessage[][] = []
  let cur: ApiMessage[] | null = null
  for (const m of rest) {
    // cur 为 null 时也要新建轮次（与 splitAgentTurns 对齐）：否则 system 之后、
    // 首个 user 之前的消息（如恢复会话时的 assistant/tool）会被静默丢弃，
    // 破坏 tool_calls ↔ tool 结果配对。
    if (m.role === 'user' || cur === null) { cur = [m]; turns.push(cur) }
    else { cur.push(m) }
  }
  const sysTok = sys ? estimateApiMsgTokens(sys) : 0
  const turnTok = turns.map(t => t.reduce((s, m) => s + estimateApiMsgTokens(m), 0))
  const kept: ApiMessage[][] = []
  let used = sysTok
  for (let i = turns.length - 1; i >= 0; i--) {
    if (used + turnTok[i] <= budget) { used += turnTok[i]; kept.unshift(turns[i]) }
    else { if (kept.length === 0) kept.unshift(turns[i]); break }
  }
  let result = sys ? [sys, ...kept.flat()] : kept.flat()
  const dropped = messages.length - result.length
  // 安全阀：最新一轮仍超预算时，从最旧起截断 tool 结果内容。
  // 仅截断、绝不丢弃 tool 消息——丢弃会破坏「tool_calls ↔ tool 结果」配对导致 API 400。
  // 单条压到 120 字符后若仍超预算（极端小上下文 + 极长结果的罕见情况），保留轻微超限：
  // 本地模型通常对少量 token 溢出有容忍度，且继续裁剪会损害可读性，故在此止步。
  used = result.reduce((s, m) => s + estimateApiMsgTokens(m), 0)
  // 安全阀：最新一轮仍超预算时，从最早的 tool 结果起压缩内容。
  // 两阶段策略，避免「读 → 被裁没 → 再读」死循环：
  //   1) 先压缩所有「非 Read」工具结果（Bash/Grep 等），Read 结果暂时保全；
  //   2) 仅当非 Read 结果已无可压、仍超限时，才最后压缩 Read 结果（保头尾、留底限），
  //      保证小上下文模型（如 32k）的上下文最终能被压回预算内，而非单调撑爆。
  const READ_FLOOR = 2000 // Read 结果压缩后的最小保留字符（头尾各半，足以让模型「看见」关键片段）
  const isReadContent = (c: string) => /"File: /.test(c) || c.startsWith('File: ')
  const compressTo = (idx: number, floor: number) => {
    const m = result[idx]
    if (m.role !== 'tool' || typeof m.content !== 'string') return
    let text = m.content
    while (used > budget && text.length > floor) {
      text = text.slice(0, Math.floor(text.length * 0.6))
      // 按下标直写：若用 indexOf(旧引用)，首次替换后旧对象已不在数组里、返回 -1，后续压缩会静默失效
      result[idx] = { ...m, content: text }
      used = result.reduce((s, mm) => s + estimateApiMsgTokens(mm), 0)
    }
  }
  // 阶段一：非 Read 结果
  for (let i = 0; i < result.length && used > budget; i++) {
    const m = result[i]
    if (m.role === 'tool' && typeof m.content === 'string' && !isReadContent(m.content)) {
      compressTo(i, 120)
    }
  }
  // 阶段二：Read 结果（最后手段，保留头尾足够内容让模型仍可定位）
  for (let i = 0; i < result.length && used > budget; i++) {
    const m = result[i]
    if (m.role === 'tool' && typeof m.content === 'string' && isReadContent(m.content)) {
      compressTo(i, READ_FLOOR)
    }
  }
  // ── 配对兜底（参考 grok-build 的 repair_dangling_tool_calls）──
  // 若某条 assistant 的 tool_calls 中，有 id 找不到对应的 tool 结果消息（例如熔断/中止时
  // 提前 break 导致后续调用未产生结果、或裁剪时丢掉了结果轮次），会破坏
  // 「tool_calls ↔ tool 结果」配对，发送给模型即触发 API 400。此处补一条合成结果，保证配对完整。
  result = repairDanglingToolCalls(result)
  return { messages: result, dropped }
}

// 纯函数：扫描所有 assistant 的 tool_calls，对缺少对应 tool 结果的 id 补一条合成结果。
// 合成结果标注来源，避免模型误以为是真实执行产出。幂等、不改原数组。
export function repairDanglingToolCalls(msgs: ApiMessage[]): ApiMessage[] {
  const presentIds = new Set<string>()
  for (const m of msgs) {
    if (m.role === 'tool') presentIds.add(m.tool_call_id)
  }
  const synthetic: ApiMessage[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant' || !('tool_calls' in m) || !m.tool_calls || m.tool_calls.length === 0) continue
    for (const tc of m.tool_calls) {
      if (!presentIds.has(tc.id)) {
        presentIds.add(tc.id)
        synthetic.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: '该工具调用未产生结果（可能因达到熔断/轮次上限被提前中止）。请换用其他方案或向用户说明。' })
        })
      }
    }
  }
  if (synthetic.length === 0) return msgs
  return [...msgs, ...synthetic]
}

// 按「user 消息为界」把消息切分为轮次（与 trimApiMessages 一致），保证工具配对不被拆散
export function splitAgentTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = []
  let cur: AgentMessage[] | null = null
  for (const m of messages) {
    if (m.role === 'user' || cur === null) { cur = [m]; turns.push(cur) }
    else { cur.push(m) }
  }
  return turns
}

export const CONDENSE_FACTS_CAP = 4000      // 结构化事实附录总长上限（超限保留最新）
const FACTS_USER_MSG_CAP = 300       // 附录中单条用户原话的最大字符数

// 结构化事实附录（阶段 2.2）：从待压缩轮次机械提取「不可转写」的事实——
// 文件操作清单（写/改/删了哪些文件、成败）与用户消息原话。
// 附录不送 LLM 精炼、逐字保留，规避摘要转写造成的路径/原话失真。
export function extractFactsAppendix(batch: AgentMessage[]): string {
  const userLines: string[] = []
  const fileOps: string[] = []
  const seenOps = new Set<string>()
  for (const m of batch) {
    if (m.role === 'user' && (m.content || '').trim()) {
      const t = m.content.trim().replace(/\n+/g, ' ')
      userLines.push('- ' + (t.length > FACTS_USER_MSG_CAP ? t.slice(0, FACTS_USER_MSG_CAP) + '…' : t))
    }
    for (const tc of m.toolCalls || []) {
      const meta = TOOL_METAS[tc.name]
      if (!meta || (meta.kind !== 'write' && meta.kind !== 'edit' && meta.kind !== 'delete')) continue
      try {
        const a = JSON.parse(tc.args || '{}')
        const p = typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : ''
        if (!p) continue
        const line = `- ${meta.label} ${p}（${tc.failed ? '失败' : '成功'}）`
        if (!seenOps.has(line)) { seenOps.add(line); fileOps.push(line) }
      } catch { /* 参数损坏的调用跳过 */ }
    }
  }
  const parts: string[] = []
  if (userLines.length) parts.push('### 用户消息原话（逐字保留）\n' + userLines.join('\n'))
  if (fileOps.length) parts.push('### 文件操作清单\n' + fileOps.join('\n'))
  return parts.join('\n\n')
}
