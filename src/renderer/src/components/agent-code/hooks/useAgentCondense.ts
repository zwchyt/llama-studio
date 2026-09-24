// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentCondense —— 上下文摘要压缩（自动触发 + 手动触发）                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的 condenseSessionMemory / handleManualCondense，
// 逻辑与注释均未改动；提示词模板与纯函数见 agent-code/utils/condensePrompt.ts。
//
// 自持：condensing（压缩中标志，同时被循环域与顶栏提示消费）、condenseMsg（弹层反馈）、
//       condenseErrorRef（最近一次失败原因，供手动压缩给出可读原因）。
// 外部输入：项目/会话指针与 updateSessionInProject、运行态（loading / runningCard /
//           apiBaseUrl / modelLabel）、piReadyRef（压缩成功后使 pi session 失效重建）。
// 对外输出：condensing / condenseMsg / condenseSessionMemory / handleManualCondense。
//
// 注意：condenseSessionMemory 的依赖数组刻意只有 [updateSessionInProject]（与原实现一致）
// ——其内部读取的 memory / messages 均由调用方作为参数传入，不依赖闭包新鲜度。

import React, { useCallback, useRef, useState } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { playEvent } from '../../../utils/sound'
import { agentConfig } from '../../../utils/agentConfig'
import {
  computeContextBudget, splitAgentTurns, estimateApiMsgTokens, estimateTextTokens,
  extractFactsAppendix, CONDENSE_FACTS_CAP,
} from '../../../utils/contextBudget'
import { noteCondenseFacts } from '../../../utils/memoryWriter'
import { getWorkspaceRootForSession } from '../../../tools/workspaceRoot'
import { KEEP_RECENT_TURNS } from '../utils/constants'
import {
  CONDENSE_TRIGGER_RATIO, SUMMARY_PROMPT, SUMMARY_TEMPERATURE,
  buildApiMessagesFull, serializeMessagesForSummary,
} from '../utils/condensePrompt'
import type { AgentMessage, AgentSession, CardState } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'

export function useAgentCondense({
  activeProjectId, activeSessionId, activeSession, updateSessionInProject,
  loading, apiBaseUrl, runningCard, modelLabel, piReadyRef,
}: {
  activeProjectId: string
  activeSessionId: string
  activeSession: AgentSession | null
  updateSessionInProject: ReturnType<typeof useAgentProjects>['updateSessionInProject']
  loading: boolean
  apiBaseUrl: string | null
  runningCard: CardState | undefined
  modelLabel: string
  piReadyRef: React.RefObject<{ sid: string | null; ready: boolean }>
}) {
  const [condensing, setCondensing] = useState(false)  // 正在压缩历史（顶部轻量提示）
  const [condenseMsg, setCondenseMsg] = useState('')       // 压缩历史弹层内的结果反馈
  const condenseErrorRef = useRef('')                      // 最近一次压缩失败的具体原因


  // 上下文摘要压缩：在发送前自动触发，或由用户手动触发（force=true）。
  // 用与 trimApiMessages 一致的分轮规则估算总 token：自动模式下未超 budget*RATIO 直接返回原 memory；
  // force 模式跳过水位判断，只要存在「最近 KEEP_RECENT_TURNS 轮之前」的更早轮次就压缩。
  // 把该批轮次交给同一本地模型压缩成摘要，持久化到会话并返回新 memory。
  // 失败/超时/空返回一律吞掉异常、返回原 memory（引用不变，供调用方判断是否成功）。
  const condenseSessionMemory = useCallback(async (
    pid: string, sid: string, messages: AgentMessage[],
    memory: AgentSession['memory'], budget: number, port: number, force = false
  ): Promise<AgentSession['memory']> => {
    try {
      // 注：此处不做 abortRef.aborted 短路——该标志在用户点「停止」后残留 true，
      // 直到下轮 runPiTurn 才复位，而自动压缩恰恰发生在 runPiTurn 之前；
      // 若在此检查，「停止后继续对话」的场景会永远跳过压缩。
      // 并发安全已由调用方保证：handleSend 持 sendingRef+!condensing 互斥，手动入口检查 loading||condensing。
      const apiMsgs = buildApiMessagesFull(messages, memory)
      const total = apiMsgs.reduce((s, m) => s + estimateApiMsgTokens(m), 0)
      if (!force && total <= budget * CONDENSE_TRIGGER_RATIO) return memory
      // 定位「已覆盖前缀之后」的消息，切分轮次，保留最近 KEEP_RECENT_TURNS 轮不压缩
      const coveredSet = new Set(memory?.coveredMsgIds || [])
      let coveredPrefix = 0
      while (coveredPrefix < messages.length && coveredSet.has(messages[coveredPrefix]!.id)) coveredPrefix++
      const uncovered = messages.slice(coveredPrefix)
      const turns = splitAgentTurns(uncovered)
      if (turns.length <= KEEP_RECENT_TURNS) return memory
      const batch = turns.slice(0, turns.length - KEEP_RECENT_TURNS).flat()
      if (batch.length === 0) return memory
      const priorSummary = memory?.summary ? `已有摘要：\n${memory.summary}\n\n新增对话：\n` : ''
      let userContent = priorSummary + serializeMessagesForSummary(batch)
      // 输出预算自适应：推理模型会先输出 <think> 再给答案，预留太少会导致「只思考、无正文」→
      // content 为空。故按预算给出较宽裕的输出空间（上限 2048）。
      const summaryMaxTok = Math.min(2048, Math.max(512, Math.floor(budget * 0.4)))
      // 防止摘要请求本身超出模型上下文：按预算（扣除输出预留）截断输入。
      // 压缩恰好发生在历史较长时，若不限制，输入 token 易超 n_ctx 导致服务端 400/500。
      const inputBudgetTok = Math.max(512, budget - summaryMaxTok - 256)
      if (estimateTextTokens(userContent) > inputBudgetTok) {
        const ratio = inputBudgetTok / estimateTextTokens(userContent)
        const keep = Math.max(1000, Math.floor(userContent.length * ratio * 0.9))
        userContent = userContent.slice(0, keep) + '\n\n…（早期内容过长，已截断用于摘要）'
      }
      setCondensing(true)
      const res = await window.api.chatCompletion({
        port, body: {
          model: modelLabel,
          messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: userContent }],
          temperature: SUMMARY_TEMPERATURE, max_tokens: summaryMaxTok, stream: false,
        }
      })
      const data: any = (res as any)?.ok ? (res as any).data : null
      if (!(res as any)?.ok) {
        condenseErrorRef.current = (res as any)?.error || `HTTP ${(res as any)?.status ?? '?'}`
        return memory
      }
      // 提取摘要：去除 <think> 段；content 为空时回退到推理模型的 reasoning_content。
      const msg = data?.choices?.[0]?.message
      const finish = data?.choices?.[0]?.finish_reason
      const stripThinkTag = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim()
      let summary = typeof msg?.content === 'string' ? stripThinkTag(msg.content) : ''
      if (!summary && typeof msg?.reasoning_content === 'string') summary = stripThinkTag(msg.reasoning_content)
      if (!summary) {
        condenseErrorRef.current = finish === 'length'
          ? '模型输出被长度截断且未产出摘要正文（常见于推理模型把预算用在了思考）'
          : '模型返回内容为空'
        return memory
      }
      condenseErrorRef.current = ''
      // 结构化事实附录：与既有附录滚动合并（不送 LLM），超限保留最新并标注截断
      let facts = memory?.facts || ''
      if (agentConfig.condenseFactsEnabled) {
        const appendix = extractFactsAppendix(batch)
        if (appendix) facts = facts ? `${facts}\n\n${appendix}` : appendix
        if (facts.length > CONDENSE_FACTS_CAP) {
          facts = '…（较早附录已截断）\n' + facts.slice(facts.length - CONDENSE_FACTS_CAP)
        }
      }
      const newMemory = {
        summary: summary,
        coveredMsgIds: [...(memory?.coveredMsgIds || []), ...batch.map(m => m.id)],
        updatedAt: Date.now(),
        ...(facts ? { facts } : {}),
      }
      updateSessionInProject(pid, sid, { memory: newMemory })
      // ── 压缩伴生写（阶段 2.3）：被压缩批次里的已验证命令 / 改动热点移交长期记忆 ──
      if (agentConfig.longTermMemoryEnabled) {
        const memRoot = getWorkspaceRootForSession()
        if (memRoot) noteCondenseFacts(memRoot, sid, batch)
      }
      // 压缩已写入会话记忆：使当前 pi session 失效并释放，下次 prompt 重建时按新摘要
      // 注入，否则模型上下文仍持有全量历史，压缩只在 UI 生效。
      piReadyRef.current = { sid: '', ready: false }
      window.api?.piAgent?.dispose?.(`pi-${sid}`).catch(() => { })
      return newMemory
    } catch (e: any) {
      condenseErrorRef.current = e?.message || String(e)
      return memory
    } finally {
      setCondensing(false)
    }
  }, [updateSessionInProject])

  // 手动压缩：用户从顶部按钮主动触发，不等高水位。force 方式调用 condenseSessionMemory，
  // 并根据返回值是否变化给出反馈（无可压缩 / 已压缩 N 条 / 未完成）。
  const handleManualCondense = useCallback(async () => {
    if (loading || condensing) return
    if (!runningCard || !apiBaseUrl) { setCondenseMsg('模型未启动，无法压缩历史。'); notify('模型未启动，无法压缩历史', 'error'); return }
    if (!activeSession || activeSession.messages.length === 0) { setCondenseMsg('当前会话无可压缩的历史。'); return }
    // 预检是否存在「最近保留轮之前」的更早轮次，避免无意义的模型调用
    const msgs = activeSession.messages
    const coveredSet = new Set(activeSession.memory?.coveredMsgIds || [])
    let coveredPrefix = 0
    while (coveredPrefix < msgs.length && coveredSet.has(msgs[coveredPrefix]!.id)) coveredPrefix++
    if (splitAgentTurns(msgs.slice(coveredPrefix)).length <= KEEP_RECENT_TURNS) {
      setCondenseMsg(`暂无可压缩的更早历史：最近 ${KEEP_RECENT_TURNS} 轮会逐字保留，需超过 ${KEEP_RECENT_TURNS} 轮对话才会压缩。`)
      return
    }
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const prevCovered = activeSession.memory?.coveredMsgIds?.length || 0
    setCondenseMsg('')
    condenseErrorRef.current = ''
    const next = await condenseSessionMemory(activeProjectId, activeSessionId, msgs, activeSession.memory, ctxBudget, runningCard.template.serverPort, true)
    const nextCovered = next?.coveredMsgIds?.length || 0
    if (nextCovered > prevCovered) { setCondenseMsg(`✅ 已压缩 ${nextCovered - prevCovered} 条早期消息。`); notify(`已压缩 ${nextCovered - prevCovered} 条早期消息`, 'success'); playEvent('success') }
    else {
      const reason = condenseErrorRef.current ? `：${condenseErrorRef.current}` : '（模型无响应或返回为空）'
      setCondenseMsg(`压缩未完成${reason}`)
      notify('压缩未完成' + reason, 'error')
      playEvent('error')
    }
  }, [loading, condensing, runningCard, apiBaseUrl, activeSession, activeProjectId, activeSessionId, condenseSessionMemory])

  return { condensing, condenseMsg, setCondenseMsg, condenseSessionMemory, handleManualCondense }
}
