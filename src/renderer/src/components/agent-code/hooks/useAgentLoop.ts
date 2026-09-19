// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentLoop —— Agent 循环域（pi SDK 单轮运行 + 发送消息编排）           ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「pi-agent 模式：pi SDK 驱动的单轮 agent 运行」与
// 「发送消息（构建附件、创建会话、调用 agent）」两个 useCallback，逻辑与注释均未改动。
//
// 自持（仅本域使用的私有 ref）：
//   pendingSendRef  —— 异步准备窗口的排队兜底（loading 置真前的第二条消息）
//   piClientRef     —— 当前 pi 事件客户端（每轮新建、finally 分离）
//   handleSendRef   —— handleSend 的最新引用（runPiTurn 收尾时重放排队消息）
//   runPiTurnRef    —— runPiTurn 的最新引用（followUp 队列自动发起独立新轮）
// 外部输入：
//   projects    —— 项目/会话域（useAgentProjects 返回值，整域透传避免逐项铺开）
//   inputDomain —— 输入域（useAgentInput 返回值：正文/附件/引用胶囊/代码片段/历史栈）
//   运行态与 setter、任务面板 setter、与其它域共用的 12 个 ref、以及主组件内的
//   四个 useCallback（压缩历史 / 队列补写 / 出队检测 / 斜杠命令分发）。
// 对外输出：runPiTurn（单轮运行，供消息操作域的重新生成 / 重发复用）、
//           handleSend（发送编排，供输入区回车与 UI 注释发送复用）。
//
// 互调关系：runPiTurn 经 handleSendRef 重放排队消息；handleSend 直接调用 runPiTurn
// （声明在前，无 TDZ）。两者各自把最新引用写入 ref，故对外函数身份稳定。
//
// 注意：handleSend 的依赖数组刻意未包含 slashCommands / agentConfig 等只读配置
// （与原实现一致，改动会改变闭包新鲜度语义）；本 hook 仅做搬运，未调整依赖项。

import React, { useCallback, useRef } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { playNotificationSound, warmUpAudio } from '../../../utils/sound'
import { agentConfig } from '../../../utils/agentConfig'
import { PiAgentClient } from '../../../utils/piAgentClient'
import { computeContextBudget, splitAgentTurns } from '../../../utils/contextBudget'
import { noteUserCorrection } from '../../../utils/memoryWriter'
import { recordAudit } from '../../../utils/auditLog'
import { recordDebugTurn, type DebugToolCall } from '../../../utils/debugLog'
import { parseSlashCommand, findCommand, expandCommandTemplate } from '../../../agent/slashCommands'
import { newMsgId, uniqueId } from '../utils/ids'
import { MIN_EXEC_DISPLAY_MS, KEEP_RECENT_TURNS } from '../utils/constants'
import type { AgentMessage, AgentSession, Attachment, CardState, ThinkingLevel, TodoUpdate } from '../../../../../shared/types'
import { projectMode } from '../../../../../shared/types'
import type { useAgentInput } from './useAgentInput'
import type { useAgentProjects } from './useAgentProjects'

/** 单轮 pi agent 运行签名（消息操作域的重新生成 / 重发复用同一契约） */
export type RunPiTurn = (
  pid: string,
  sid: string,
  displayMsgs: AgentMessage[],
  opts: {
    port: number
    text: string
    workspaceDir: string
    approveWriteEdit?: boolean
    knowledgeBaseId?: string
    memory?: AgentSession['memory']
    /** 通用模式：不注册工具、不注入工具/图表指引。由所属工作区模式推导（见 projectMode） */
    plainChat?: boolean
    /** 通用模式下启用的工具（只认原生聊天那四个） */
    chatTools?: string[]
  }
) => Promise<{ errored: boolean; aborted: boolean }>

export function useAgentLoop({
  projects: { setProjects, setActiveSessionId, activeProjectId, activeSessionId, activeProject, activeSession, updateSessionInProject },
  inputDomain,
  loading, setLoading, setStreaming, setStreamKind, setThinkDone, setCurToolName, setQueueInfo,
  apiBaseUrl, runningCard, condensing, slashCommands,
  setTaskModalOpen, setTaskPanelCollapsed, setTaskCardClosing, setPlanTitle, setCurrentPlanItems,
  abortRef, sendingRef, piReadyRef, followUpQueueRef, prevQueueRef,
  appendLiveUserMsgRef, streamingSessionRef, streamStartAtRef, lastRateRef,
  modelLabelRef, backupsRef, thinkingLevelRef,
  condenseSessionMemory, appendQueuedUserMsg, queueRemoved, runSlashAction,
  scrollToBottom,
}: {
  /** 项目 / 会话域：useAgentProjects 的完整返回值（本域只消费其中 7 项） */
  projects: ReturnType<typeof useAgentProjects>
  /** 输入域：useAgentInput 的完整返回值（本域只消费其中 13 项） */
  inputDomain: ReturnType<typeof useAgentInput>
  loading: boolean
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>
  setStreamKind: React.Dispatch<React.SetStateAction<'think' | 'text' | 'tools' | 'idle'>>
  setThinkDone: React.Dispatch<React.SetStateAction<boolean>>
  setCurToolName: React.Dispatch<React.SetStateAction<string>>
  setQueueInfo: React.Dispatch<React.SetStateAction<{ followUp: string[] }>>
  apiBaseUrl: string | null
  runningCard: CardState | undefined
  condensing: boolean
  slashCommands: ReturnType<typeof useStore.getState>['slashCommands']
  setTaskModalOpen: React.Dispatch<React.SetStateAction<boolean>>
  setTaskPanelCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setTaskCardClosing: React.Dispatch<React.SetStateAction<boolean>>
  setPlanTitle: React.Dispatch<React.SetStateAction<string>>
  setCurrentPlanItems: React.Dispatch<React.SetStateAction<TodoUpdate[]>>
  /** ── 与其它域共用的 ref（仍由主组件持有）── */
  abortRef: React.RefObject<{ aborted: boolean; resolve: (() => void) | null }>
  sendingRef: React.RefObject<boolean>
  piReadyRef: React.RefObject<{ sid: string | null; ready: boolean }>
  followUpQueueRef: React.RefObject<{ text: string; attachments: Attachment[]; packedText?: string }[]>
  prevQueueRef: React.RefObject<{ followUp: string[] }>
  appendLiveUserMsgRef: React.RefObject<(m: AgentMessage) => void>
  streamingSessionRef: React.RefObject<string | null>
  streamStartAtRef: React.RefObject<number | null>
  lastRateRef: React.RefObject<number | null>
  modelLabelRef: React.RefObject<string>
  backupsRef: React.RefObject<Record<string, { path: string; content: string }>>
  thinkingLevelRef: React.RefObject<ThinkingLevel>
  /** ── 主组件内的 useCallback（作为依赖注入，避免本域反向依赖其声明）── */
  condenseSessionMemory: (
    pid: string, sid: string, messages: AgentMessage[],
    memory: AgentSession['memory'], budget: number, port: number, force?: boolean
  ) => Promise<AgentSession['memory']>
  appendQueuedUserMsg: (text: string) => void
  queueRemoved: (prev: string[], next: string[]) => string[]
  runSlashAction: (name: string, args: string) => Promise<void>
  /** 无条件贴底（来自 useAgentScroll）。发消息时用它恢复跟随，见 runPiTurn 里的说明 */
  scrollToBottom: (smooth?: boolean, force?: boolean) => void
}) {
  const {
    input, setInput, textareaRef, packedInput, setPackedInput,
    attachedFiles, setAttachedFiles, refChips, setRefChips, codeSnippets, setCodeSnippets,
    inputHistoryRef, historyIdxRef,
  } = inputDomain

  // ── 循环域私有 ref ──
  const pendingSendRef = useRef<Array<{ text: string; attachments: Attachment[]; packedText?: string }>>([])
  const piClientRef = useRef<PiAgentClient | null>(null)
  const handleSendRef = useRef<(text?: string, attachments?: Attachment[], packedHint?: string) => void>(() => { })
  const runPiTurnRef = useRef<RunPiTurn | null>(null)
  // 上次建 pi 会话时用的「模式签名」。纯聊天开关与它启用的工具集都是会话级字段，
  // 但 pi 会话建好之后 tools / systemPrompt 就固定了——只改会话字段不会生效，
  // 必须检测到签名变了重建一次。重建会重新注入历史（与切换会话走的是同一条路径），
  // 所以不会丢对话。签名把工具集也带上，开关某个聊天工具同样能触发重建。
  const piPlainRef = useRef<string | null>(null)


  // ── pi-agent 模式：pi SDK 驱动的单轮 agent 运行 ──
  // displayMsgs 的最后一条为最新 user 消息（由 prompt 发送）；此前消息作为历史注入 pi session。
  const runPiTurn = useCallback(async (
    pid: string,
    sid: string,
    displayMsgs: AgentMessage[],
    opts: { port: number; text: string; workspaceDir: string; approveWriteEdit?: boolean; knowledgeBaseId?: string; memory?: AgentSession['memory']; plainChat?: boolean; chatTools?: string[] }
  ): Promise<{ errored: boolean; aborted: boolean }> => {
    const piSessionId = `pi-${sid}`
    // 发消息/重跑是明确的用户意图，这里无条件恢复「贴底跟随」并立刻滚到底。
    // 不这么做的话：用户读长回答时往上滚过一次，pauseFollow 就把 followingRef 置了 false，
    // 之后再发消息，新增的这条只会在下方生成而不被滚进视野，得手动往下滑才看得到。
    // force=true：即便此刻有轨道补间动画在跑也要抢占（scrollToBottom 的早退分支在
    // 重置 followingRef 之前，不加 force 会被直接忽略）。
    scrollToBottom(false, true)
    const plain = opts.plainChat === true
    const chatTools = plain ? [...(opts.chatTools ?? [])].sort() : []
    const modeSig = plain ? `plain:${chatTools.join(',')}` : 'agent'
    // 首次进入该会话（或会话切换/重建）、以及模式或聊天工具集变化时：创建 pi session 并注入历史
    if (piReadyRef.current.sid !== sid || !piReadyRef.current.ready || piPlainRef.current !== modeSig) {
      // 新 pi 会话：清空上一会话的撤销备份引用
      backupsRef.current = {}
      // 压缩记忆：被 coveredMsgIds 覆盖的最早连续前缀用摘要替代注入，使压缩真正
      // 减小模型上下文（否则重建仍全量注入历史，压缩只改 UI 不生效）。
      const prior = displayMsgs.slice(0, -1)
      const coveredSet = new Set(opts.memory?.coveredMsgIds || [])
      let coveredPrefix = 0
      while (coveredPrefix < prior.length && coveredSet.has(prior[coveredPrefix]!.id)) coveredPrefix++
      const history: Array<{ role: 'user' | 'assistant'; content: string; toolCalls?: AgentMessage['toolCalls']; attachments?: AgentMessage['attachments'] }> = []
      if (coveredPrefix > 0) {
        const summary = (opts.memory?.summary || '').trim()
        const facts = (opts.memory?.facts || '').trim()
        history.push({
          role: 'user',
          content: [
            '以下是本会话早期对话的压缩摘要（替代已压缩的原文，作为对话背景，不是用户的新输入）：',
            summary,
            facts ? `\n结构化事实附录（逐字保留）：\n${facts}` : ''
          ].filter(Boolean).join('\n')
        })
      }
      for (const m of prior.slice(coveredPrefix)) {
        history.push({ role: m.role, content: m.content, toolCalls: m.toolCalls, attachments: m.attachments })
      }
      const res = await window.api.piAgent.create({
        sessionId: piSessionId,
        port: opts.port,
        cwd: opts.workspaceDir || '.',
        approveWriteEdit: opts.approveWriteEdit === true,
        knowledgeBaseId: opts.knowledgeBaseId || undefined,
        plainChat: plain,
        chatTools,
        searchEnabled: useStore.getState().searchEnabled,
        searchProvider: useStore.getState().searchProvider,
        contextWindow: (() => {
          const rc = useStore.getState().cards.find(c => c.status === 'running')
          return rc ? useStore.getState().modelMetrics[rc.template.id]?.nCtx || undefined : undefined
        })(),
        history,
      })
      if (!res?.success) throw new Error('pi-agent 会话创建失败')
      piReadyRef.current = { sid, ready: true }
      piPlainRef.current = modeSig
    }
    // 应用当前选择的思考程度（同步方法，按模型能力自动 clamp；不支持思考的模型无效但非致命）
    try { await window.api.piAgent.setThinkingLevel(piSessionId, thinkingLevelRef.current) } catch { /* 模型不支持思考时 SDK 自行 clamp，忽略异常 */ }
    // 占位助手消息（pi 事件驱动其内容/工具卡片）
    const liveId = newMsgId()
    // 流开始时刻：pending 思考卡/思考块实时计时锚点（连续、含 TTFT）
    streamStartAtRef.current = Date.now()
    // 固化本轮模型名（读 store 实时值，避免闭包过期）：思考块头部 meta 徽标常驻用
    const rcNow = useStore.getState().cards.find(c => c.status === 'running')
    modelLabelRef.current = rcNow
      ? (rcNow.template.modelPath?.split(/[\\/]/).pop() || rcNow.template.name || '模型')
      : modelLabelRef.current
    // 流式实时消息走独立 store 切片 liveAgentMsg：只重渲染流式消息组件（AgentStreamingMessage），
    // 整页（侧边栏/文件树/面板…）不再每个 commit 重渲染——实测整页 15-30ms × 20次/秒 是卡顿主因。
    // 整轮 msgs 以 ~500ms 节流同步进项目 store（历史/持久化），轮末 forceSync 一次性写全。
    let liveMsg: AgentMessage = { id: liveId, role: 'assistant', content: '' }
    let msgs: AgentMessage[] = [...displayMsgs, liveMsg]
    // 供队列出队时把用户消息补写进本轮 live msgs（与 store 同步，避免轮末 commit 覆盖丢失）
    appendLiveUserMsgRef.current = (m: AgentMessage) => { msgs.push(m) }
    useStore.getState().setLiveAgentMsg(liveMsg)
    updateSessionInProject(pid, sid, { messages: msgs })
    // 服务端真实解码 token 数：直接取自 /slots 的 n_decoded（与「模型数据」监控面板的
    // 「生成进度」同源同义——那里显示的就是 n_decoded 原值）。模型指标每 2s 广播进
    // modelMetrics[template.id].nDecoded；流式中 StreamingBadge 直接订阅该值（实时），
    // 此处仅在轮末 commit 时同步读取一次，把最终值持久化进消息（刷新后还原）。
    const tidNow = rcNow?.template.id
    const decodedNow = (): number | undefined => {
      if (!tidNow) return undefined
      const v = useStore.getState().modelMetrics[tidNow]?.nDecoded
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    }
    // 轮末精确快照：输出结束时刻主动查询端点最新 /slots（与端点 n_decoded 当前值一致，
    // 不依赖 500ms 广播周期）；查询失败或缺省时回退 store 里最近一次广播值
    let finalDecoded: number | undefined
    const SYNC_PROJECTS_MS = 500
    let projectsSyncTimer: ReturnType<typeof setTimeout> | null = null
    let lastProjectsSyncAt = 0
    const syncProjects = (): void => {
      if (projectsSyncTimer) return
      const apply = (): void => {
        lastProjectsSyncAt = performance.now()
        updateSessionInProject(pid, sid, { messages: msgs })
      }
      const now = performance.now()
      if (now - lastProjectsSyncAt >= SYNC_PROJECTS_MS) apply()
      else projectsSyncTimer = setTimeout(() => { projectsSyncTimer = null; apply() }, SYNC_PROJECTS_MS - (now - lastProjectsSyncAt))
    }
    // forceSync=true：轮末/失败收尾——立即写 projects + 清掉排队同步，保证最终态入库。
    const commit = (patch: Partial<AgentMessage>, forceSync = false): void => {
      msgs = msgs.map(m => m.id === liveId ? { ...m, ...patch } : m)
      liveMsg = { ...liveMsg, ...patch }
      useStore.getState().setLiveAgentMsg(liveMsg)
      if (forceSync) {
        // 终态提交：清掉排队的文本提交（其闭包 liveMsg 无 modelLabel/lastTps 等终态字段，
        // 延迟执行会覆盖 final commit 刚持久化的数据）
        if (textCommitTimer) { clearTimeout(textCommitTimer); textCommitTimer = null }
        if (projectsSyncTimer) { clearTimeout(projectsSyncTimer); projectsSyncTimer = null }
        lastProjectsSyncAt = performance.now()
        updateSessionInProject(pid, sid, { messages: msgs })
      } else {
        syncProjects()
      }
    }
    // 流式正文 commit 节流：文本增量高频到达时合并为每 COMMIT_TEXT_MS 一次 live 切片更新
    // （显示层另有 40ms 帧对齐节流，50ms 合并不会造成视觉滞后）；
    // 工具/思考边界等低频事件仍走 commit 即时提交，保证工具卡状态不错过。
    const COMMIT_TEXT_MS = 50
    let textCommitTimer: ReturnType<typeof setTimeout> | null = null
    let lastTextCommitAt = 0
    const commitText = (patch: Partial<AgentMessage>): void => {
      msgs = msgs.map(m => m.id === liveId ? { ...m, ...patch } : m)
      liveMsg = { ...liveMsg, ...patch }
      const apply = (): void => {
        lastTextCommitAt = performance.now()
        useStore.getState().setLiveAgentMsg(liveMsg)
        syncProjects()
      }
      if (textCommitTimer) return // 已有排队提交，最新 liveMsg 会随其 apply 一起带走
      const now = performance.now()
      if (now - lastTextCommitAt >= COMMIT_TEXT_MS) apply()
      else textCommitTimer = setTimeout(() => { textCommitTimer = null; apply() }, COMMIT_TEXT_MS - (now - lastTextCommitAt))
    }
    let streamedText = ''
    const toolCalls: NonNullable<AgentMessage['toolCalls']> = []
    // ── 时间线切分（segments）：全程（含流式期间）按「事件到达顺序」构建，
    // 思考/正文增量切分为 think/text 段、工具声明切分为 tools 段（只记 id，构建时从
    // 最新 toolCalls 映射对象 —— 状态/结果更新能实时反映，避免缓存旧引用卡在 pending）。
    // 事件顺序即真实时间线：思考 → 工具 → 思考 → 工具 → … → 正文，流式与完成态一致交错。
    // 思考段计时：startMs = 标签开时刻；durationMs 在标签闭合/中断收尾时定格，
    // 供链内每个思考段上方的独立时间标签展示（Thought: 515ms）。
    type ThinkLiveSeg = { kind: 'think'; content: string; startMs?: number; durationMs?: number }
    // tools 段带 startMs（本批首个工具声明时刻）与 durationMs（本批全部完成时定格）：
    // 定格值随 segments 持久化，完成态静态渲染（无 frozenToolsRef 累积）也能还原工具时长，
    // 避免「流式数字 → 完成数字」回退跳变。
    type LiveSeg = { kind: 'tools'; ids: string[]; startMs: number; durationMs?: number } | ThinkLiveSeg | { kind: 'text'; content: string }
    const liveSegs: LiveSeg[] = []
    // 当前打开的思考段引用：用引用而非「最后一个段」定位——thinking_end 可能迟到于
    // 工具声明（工具段已插入），close 时按引用定格，不受中间插入影响
    // （此前按 last 定格：首段思考后紧跟工具时永远定不到格，首个思考过程无时间统计的根因）。
    let curThinkSeg: ThinkLiveSeg | null = null
    // 工具执行开始时间戳（id → ms）：Write/Edit 等本地 IO 工具执行可能不足一帧（<16ms），
    // executing 徽标一闪而过肉眼不可见；结束时若执行时长不足 MIN_EXEC_DISPLAY_MS，
    // 延迟置 done，保证「写入中/编辑中」状态至少可见一瞬（最小展示时长）。
    const execStartMs = new Map<string, number>()
    // 本轮（单次 prompt 运行）内的工具调用链（调试面板用；turn_end 时快照进 recordDebugTurn）
    let turnToolTrace: DebugToolCall[] = []
    let thinkOpen = false
    let curToolIds: string[] | null = null
    let textSinceLastTool = false
    const buildSegs = (): NonNullable<AgentMessage['segments']> =>
      liveSegs.map(s => s.kind === 'tools'
        ? {
          kind: 'tools', toolCalls: s.ids
            .map(id => toolCalls.find(t => t.id === id))
            .filter((t): t is NonNullable<AgentMessage['toolCalls']>[number] => !!t),
          ...(s.durationMs != null ? { durationMs: s.durationMs } : {})
        }
        : s.kind === 'think'
          ? { kind: 'think', content: s.content, ...(s.durationMs != null ? { durationMs: s.durationMs } : {}) }
          : { kind: 'text', content: s.content })
    // 结构化事件驱动（经 piAgentAdapter 已把 <think> 标签从传输层剥离）：
    // thinking_* 直接操作 think 段，text_delta 为纯文本增量；思考段仍按原语义在
    // content/streamedText 里重构成成对 <think>...</think>（兼容 parseThinkSegments）。
    const openThinking = (): void => {
      if (thinkOpen) return
      const seg: ThinkLiveSeg = { kind: 'think', content: '', startMs: Date.now() }
      liveSegs.push(seg)
      curThinkSeg = seg
      thinkOpen = true
      streamedText += '\n<think>'
      setThinkDone(false)
    }
    const appendThinkingDelta = (delta: string): void => {
      if (!thinkOpen) openThinking()
      if (curThinkSeg) curThinkSeg.content += delta
      else {
        const seg: ThinkLiveSeg = { kind: 'think', content: delta, startMs: Date.now() }
        liveSegs.push(seg)
        curThinkSeg = seg
      }
      streamedText += delta
      setThinkDone(false)
      textSinceLastTool = true
    }
    const closeThinking = (): void => {
      if (!thinkOpen) return
      // 思考闭合：定格该段的思考耗时（开→闭壁钟），供段上方时间标签展示
      if (curThinkSeg && curThinkSeg.startMs != null && curThinkSeg.durationMs == null) {
        curThinkSeg.durationMs = Date.now() - curThinkSeg.startMs
      }
      thinkOpen = false
      curThinkSeg = null
      streamedText += '</think>'
      // 思考闭合：思考结束（后续若无新思考增量，思考块收起不转圈）
      setThinkDone(true)
    }
    // 纯文本增量：不解析 <think> 标签；若思考仍开启先闭合思考段，文本落到思考链之后
    const appendTextDelta = (delta: string): void => {
      if (thinkOpen) closeThinking()
      const last = liveSegs[liveSegs.length - 1]
      if (last && last.kind === 'text') last.content += delta
      else liveSegs.push({ kind: 'text', content: delta })
      streamedText += delta
      // 正文出现：思考已结束（Reasonix 同款语义：text 增量闭合推理）
      setThinkDone(true)
      textSinceLastTool = true
    }
    // 中断/整轮收尾：遍历所有未闭合的思考段补上部分时长（用户停止、出错中断时定格到当前时刻），
    // 并闭合当前思考段（补 </think>，保证 streamedText 成对标签）；幂等，已定格的不再覆盖。
    const closeOpenThink = (): void => {
      for (const s of liveSegs) {
        if (s.kind === 'think' && s.startMs != null && s.durationMs == null) {
          s.durationMs = Date.now() - s.startMs
        }
      }
      closeThinking()
    }
    const client = new PiAgentClient({
      onTextDelta: (delta) => {
        appendTextDelta(delta)
        // 状态栏阶段：只有含实际内容的增量才更新（纯文本即「输出中」）
        if (delta.trim()) {
          setStreamKind('text')
        }
        commitText({ content: streamedText, segments: buildSegs() })
      },
      onThinkingStart: () => {
        // openThinking 延迟到首个 thinking_delta（保持与原「首增量才推 <think>」行为一致），
        // 此处仅切状态栏阶段 + 标记思考未结束
        setStreamKind('think')
        setThinkDone(false)
      },
      onThinkingDelta: (delta) => {
        appendThinkingDelta(delta)
        if (delta.trim()) {
          setStreamKind('think')
        }
        commitText({ content: streamedText, segments: buildSegs() })
      },
      onThinkingEnd: () => {
        closeThinking()
        commitText({ content: streamedText, segments: buildSegs() })
      },
      onToolCall: (tc) => {
        // 工具声明 = 进入「工具调用中」阶段（状态栏展示；消息区工具卡执行中另有 verb 徽标）
        setStreamKind('tools')
        setCurToolName(tc.name)
        // 工具声明 = 思考已结束（Reasonix 同款：tool dispatch 结束模型推理阶段）
        setThinkDone(true)
        // 工具声明 = 思考链阶段到此为止：立即定格未闭合的思考段（pi 的 thinking_end
        // 可能迟到于工具声明；否则工具执行期间头部思考总时间因未定格而消失/回退）
        closeOpenThink()
        // 幂等合并：toolcall_start（参数流式开始）先创建卡（args 空 → 显示「参数生成中」），
        // toolcall_end（参数完整）再更新 args；同一工具只保留一张卡、一个工具段。
        let tIdx = toolCalls.findIndex(t => t.id === tc.id)
        if (tIdx < 0) tIdx = toolCalls.findIndex(t => t.name === tc.name && !t.args && t.status === 'pending')
        if (tIdx >= 0) {
          // 参数更新（toolcall_end 携带完整 arguments；start 的空串不覆盖已有参数）
          if (tc.args) toolCalls[tIdx] = { ...toolCalls[tIdx]!, args: tc.args }
        } else {
          toolCalls.push({ id: tc.id, name: tc.name, args: tc.args, status: 'pending' })
        }
        const lastTc = toolCalls[toolCalls.length - 1]!
        // 相邻工具调用（之间无文本增量）并入同一工具批，保持「一批工具一张卡组」的展示粒度
        if (curToolIds && !textSinceLastTool && !curToolIds.includes(lastTc.id)) {
          curToolIds.push(lastTc.id)
        } else if (!curToolIds?.includes(lastTc.id)) {
          curToolIds = [lastTc.id]
          liveSegs.push({ kind: 'tools', ids: curToolIds, startMs: Date.now() })
        }
        textSinceLastTool = false
        // 计划面板同步（与 legacy 一致）：TodoWrite 调用后更新右侧任务清单
        if (tc.name === 'TodoWrite') {
          // 弹出右侧「待办」卡片（taskModalOpen 是卡片渲染条件；pi 模式在
          // 此显式打开）
          setTaskModalOpen(true)
          setTaskPanelCollapsed(false)
          setTaskCardClosing(false)
          try {
            const args = JSON.parse(tc.args) as { title?: string; merge?: boolean; todos?: Array<{ id?: string;[k: string]: unknown }> }
            if (args.todos?.length) {
              if (typeof args.title === 'string' && args.title.trim()) {
                setPlanTitle(args.title.trim())
              } else if (args.merge === false) {
                setPlanTitle('')
              }
              const merge = args.merge !== false
              if (merge) {
                setCurrentPlanItems(prev => {
                  const map = new Map<string, TodoUpdate>()
                  prev.forEach((t, idx) => { map.set(t.id || String(idx + 1), t) })
                  args.todos!.forEach((t, idx) => {
                    const key = t.id || String(idx + 1)
                    map.set(key, { ...(map.get(key) || {}), ...t, id: t.id || key } as TodoUpdate)
                  })
                  return Array.from(map.values())
                })
              } else {
                setCurrentPlanItems(args.todos.map((t, idx) => ({ ...t, id: t.id || String(idx + 1) })) as TodoUpdate[])
              }
            }
          } catch (e) {
            console.warn('[AgentCode] pi TodoWrite args parse failed:', e, tc.args.slice(0, 200))
          }
        }
        commit({ toolCalls: [...toolCalls], segments: buildSegs() })
      },
      onToolExecutionStart: (id, name) => {
        // 先按 id 精确匹配；对不上时按工具名兜底（找最近一个 pending 的同类工具），
        // 保证 executing 状态一定落到卡片上（否则工具卡永远停在 pending 不渲染）
        let i = toolCalls.findIndex(t => t.id === id)
        if (i < 0 && name) i = toolCalls.findIndex(t => t.name === name && t.status === 'pending')
        if (i >= 0) {
          toolCalls[i] = { ...toolCalls[i]!, status: 'executing' }
          execStartMs.set(id, Date.now())
          commit({ toolCalls: [...toolCalls], segments: buildSegs() })
        }
      },
      onToolExecutionEnd: (id, name, resultText, isError, backupId) => {
        // pi 模式撤销契约（R2）：撤销按钮是否可用完全由 backupId 是否存在决定。
        // main 仅在写操作成功并真实记录备份后才回传 backupId；只读工具、执行失败、
        // 或备份记录失败时 backupId 为 undefined → 不写入备份引用 → canUndoFor 返回 false
        // → 工具卡不显示撤销按钮，避免「无备份可写回」的空撤销。
        if (backupId) {
          backupsRef.current[id] = { path: `pi-undo:${backupId}`, content: '' }
        }
        const elapsed = execStartMs.has(id) ? Date.now() - execStartMs.get(id)! : Number.MAX_SAFE_INTEGER
        // 操作审计日志：记录每次已执行工具（pi 模式在 renderer 侧无从得知是否经过
        // main 审批通道，approved 固定 false——审批弹窗的 id 与 toolCallId 无法关联）。
        try {
          const tc = toolCalls.find(t => t.id === id)
          recordAudit({
            sessionId: piSessionId,
            tool: name,
            args: tc?.args ?? '',
            result: resultText,
            durationMs: elapsed === Number.MAX_SAFE_INTEGER ? 0 : elapsed,
            failed: isError,
            approved: false,
          })
        } catch { /* 审计埋点不影响主流程 */ }
        // 调试面板：本轮工具调用链（有序）
        turnToolTrace.push({ name, durationMs: elapsed === Number.MAX_SAFE_INTEGER ? 0 : elapsed, failed: isError })
        // 最小展示时长：执行太快（本地 IO 不足一帧）时延迟置 done，让「写入中」徽标可见
        const applyDone = (): void => {
          // 与 start 同样的兜底：按工具名找正在执行的同类工具
          let i = toolCalls.findIndex(t => t.id === id)
          if (i < 0 && name) i = toolCalls.findIndex(t => t.name === name && t.status === 'executing')
          if (i >= 0) {
            toolCalls[i] = { ...toolCalls[i]!, status: 'done', result: resultText, failed: isError, durationMs: elapsed === Number.MAX_SAFE_INTEGER ? 0 : elapsed }
            // 本批全部完成：定格工具批段时长（声明时刻 → 本支完成时刻），随 segments 持久化，
            // 完成态静态渲染（ThinkBlock 重挂载、frozenToolsRef 归零）时据此还原工具阶段耗时，
            // 头部「思考了 X 秒」流式→完成不回退。
            const tseg = liveSegs.find(s => s.kind === 'tools' && s.ids.includes(id))
            if (tseg && tseg.kind === 'tools' && tseg.durationMs == null
              && tseg.ids.every(tid => { const t = toolCalls.find(tc => tc.id === tid); return !!t && t.status === 'done' })) {
              tseg.durationMs = Math.max(0, Date.now() - tseg.startMs)
            }
            commit({ toolCalls: [...toolCalls], segments: buildSegs() })
          }
        }
        if (elapsed >= MIN_EXEC_DISPLAY_MS) applyDone()
        else setTimeout(applyDone, MIN_EXEC_DISPLAY_MS - elapsed)
      },
      onTurnEnd: (info) => {
        // 调试面板：按轮记录（pi 事件不携带 requestPayload/msgCount/toolCount/dropped/
        // ttft/tps，这些字段留空；tokens 与耗时来自 turn_start/turn_end 事件）。
        try {
          recordDebugTurn({
            sessionId: piSessionId,
            turn: info.turnIndex,
            requestPayload: '',
            msgCount: 0,
            toolCount: 0,
            dropped: 0,
            promptTokens: info.promptTokens,
            completionTokens: info.completionTokens,
            ttftMs: undefined,
            tps: undefined,
            durationMs: info.durationMs,
            tools: turnToolTrace.slice(),
          })
        } catch { /* 调试埋点不影响主流程 */ }
        turnToolTrace = []
      },
      onEnd: () => { /* prompt 返回即结束，无需额外处理 */ },
      onQueueUpdate: (_s, f) => {
        // 出队（被执行）的条目 = prev 有而当前无的 → 此刻补写进历史，让其出现在对话里
        const removedFollow = queueRemoved(prevQueueRef.current.followUp, f)
        prevQueueRef.current = { followUp: f }
        setQueueInfo({ followUp: f })
        for (const t of removedFollow) appendQueuedUserMsg(t)
      },
    })
    piClientRef.current = client
    client.attach(piSessionId)
    abortRef.current.aborted = false
    setLoading(true)
    setStreaming(true)
    streamingSessionRef.current = sid
    useStore.getState().setAgentPhase({ kind: 'waiting_model' })
    try {
      // 图片附件：从最后一条 user 消息提取（pi 的 prompt 支持 images）
      const lastUserMsg = displayMsgs[displayMsgs.length - 1]
      const images: Array<{ type: 'image'; data: string; mimeType: string }> | undefined =
        lastUserMsg?.attachments
          ?.filter(a => a.type === 'image' && a.dataUrl)
          .map(a => {
            const mime = /^data:([^;,]+)/.exec(a.dataUrl!)?.[1] ?? 'image/png'
            const base64 = a.dataUrl!.split(',')[1] ?? ''
            return { type: 'image' as const, data: base64, mimeType: mime }
          })
      await window.api.piAgent.prompt(piSessionId, opts.text, images && images.length > 0 ? images : undefined)
      // 对话完成提示音：必须紧跟「输出结束」这一时刻播放。绝不能放到下面那次指标查询之后：
      // queryMetricsNow 是 IPC + 两次 HTTP（/slots 与 /metrics），刚生成完时 llama-server
      // 还在收尾，这一等就是几十到几百毫秒，提示音会明显滞后于输出结束（实测的延迟就是这么来的）。
      // 用户手动停止（aborted）或出错（走 catch）时不播放。
      if (!abortRef.current.aborted && useStore.getState().soundEnabled) {
        playNotificationSound(useStore.getState().notificationSound)
      }
      // 输出已结束：此刻主动查询端点最新解码数（与 /slots 的 n_decoded 当前值精确一致）
      if (tidNow) {
        try {
          const v = await window.api.queryMetricsNow(tidNow)
          if (typeof v === 'number' && v > 0) finalDecoded = v
        } catch { /* 查询失败回退广播值 */ }
      }
      // 先结束流式态：让最终 commit 直接走「完成态交错」渲染分支（streamingMsg=false），
      // 避免 StreamingContent 把思考/正文再重复渲染一遍（工具卡+思考重复显示的根源之一）。
      setStreaming(false)
      if (!streamedText && toolCalls.length === 0) {
        commit({ content: '(模型未返回内容)', modelLabel: modelLabelRef.current, decodedTokens: finalDecoded ?? decodedNow() }, true)
      } else {
        // 本轮结束：segments 已是实时时间线顺序（buildSegs），流式/完成态一致交错
        closeOpenThink()
        // modelLabel/lastTps/decodedTokens 随最终 commit 持久化：刷新后完成态徽标可还原模型名、最后速率与真实解码数
        commit({
          content: streamedText,
          toolCalls: [...toolCalls],
          segments: buildSegs(),
          modelLabel: modelLabelRef.current,
          lastTps: lastRateRef.current ?? undefined,
          decodedTokens: finalDecoded ?? decodedNow()
        }, true)
      }
      return { errored: false, aborted: abortRef.current.aborted }
    } catch (e: any) {
      commit({ content: `发送失败：${e?.message || String(e)}`, modelLabel: modelLabelRef.current, decodedTokens: finalDecoded ?? decodedNow() }, true)
      return { errored: true, aborted: false }
    } finally {
      client.detach()
      piClientRef.current = null
      setLoading(false)
      setStreaming(false)
      setStreamKind('idle')
      setCurToolName('')
      setThinkDone(true)
      // 停止/失败兜底：未完成工具（待执行/执行中）标记为已完成（失败），
      // 避免卡片永远停在「待执行/写入中」——参考项目同款：中止时工具卡收敛为终态
      closeOpenThink()
      if (toolCalls.some(t => (t.status ?? 'pending') !== 'done')) {
        for (const t of toolCalls) {
          if ((t.status ?? 'pending') !== 'done') {
            t.status = 'done'
            t.failed = true
            t.result = t.result ?? '(工具未完成：已停止生成)'
          }
        }
        commit({ toolCalls: [...toolCalls], segments: buildSegs(), modelLabel: modelLabelRef.current, lastTps: lastRateRef.current ?? undefined, decodedTokens: finalDecoded ?? decodedNow() }, true)
      }
      streamingSessionRef.current = null
      // 流式结束：清空实时切片（projects 已由上面的 forceSync 写入最终 msgs），
      // 消息列表从 store 渲染完成态行（AgentMessageRow）。
      useStore.getState().setLiveAgentMsg(null)
      useStore.getState().setAgentPhase(null)
      const queue = pendingSendRef.current
      pendingSendRef.current = []
      if (!abortRef.current.aborted) {
        for (const pending of queue) {
          if (pending.text.trim() || pending.attachments.length) {
            setTimeout(() => handleSendRef.current(pending.text || undefined, pending.attachments, pending.packedText), 0)
          }
        }
      }
      // 前端 followUp 队列：当前轮结束后自动发起独立新轮，产生独立 user + assistant 回复
      const nextFU = followUpQueueRef.current.shift()
      if (nextFU && !abortRef.current.aborted) {
        const fuUserMsg: AgentMessage = { id: newMsgId(), role: 'user', content: nextFU.text, attachments: nextFU.attachments.length ? nextFU.attachments : undefined, packedText: nextFU.packedText }
        const fuMsgs = [...msgs, fuUserMsg]
        updateSessionInProject(pid, sid, { messages: fuMsgs })
        setQueueInfo(prev => ({ ...prev, followUp: prev.followUp.slice(1) }))
        const fuOpts = { port: opts.port, text: nextFU.text, workspaceDir: opts.workspaceDir, approveWriteEdit: opts.approveWriteEdit, knowledgeBaseId: opts.knowledgeBaseId, memory: opts.memory }
        setTimeout(() => { const rt = runPiTurnRef.current; if (rt) rt(pid, sid, fuMsgs, fuOpts) }, 0)
      }
    }
  }, [updateSessionInProject])
  runPiTurnRef.current = runPiTurn

  // ── 区域：发送消息（构建附件、创建会话、调用 agent） ──
  const handleSend = useCallback(async (overrideText?: string, overrideAttachments?: Attachment[], packedHint?: string) => {
    // 用户手势内预热音频：否则完成提示音（await 后播放）会被自动播放策略静默拦截
    warmUpAudio()
    const attachmentsForSend: Attachment[] = overrideAttachments ?? attachedFiles.map(a => ({
      name: a.name,
      type: a.isImage ? 'image' : 'file',
      dataUrl: a.isImage ? a.dataUrl : undefined,
      content: a.isImage ? undefined : a.content,
    }))
    // 引用胶囊：仅在非 override（非重新生成/重发）时拼入正文，作为引用块；最后接用户自己输入的正文。
    // 超长打包 chip 的内容是用户正文的前段，排在最前。
    const rawBody = overrideText ?? input
    let outgoing = rawBody
    if (overrideText === undefined && (packedInput || refChips.length > 0 || codeSnippets.length > 0)) {
      const parts: string[] = []
      // 超长打包 chip：整段被打包的正文（用户消息本体的前段）
      if (packedInput?.trim()) parts.push(packedInput.trim())
      // 代码片段胶囊：以 fenced code block + 文件行号标注注入
      for (const snip of codeSnippets) {
        const ext = (/\.([a-z0-9]+)$/i.exec(snip.fileName)?.[1] || '').toLowerCase()
        parts.push(`[代码引用: ${snip.fileName} L${snip.startLine}-L${snip.endLine}]\n\`\`\`${ext}\n${snip.code}\n\`\`\``)
      }
      // 引用胶囊
      const toQ = (t: string) => t.split('\n').map(l => `> ${l}`).join('\n')
      for (const c of refChips) { if (c.text.trim()) parts.push(toQ(c.text.trim())) }
      if (rawBody.trim()) parts.push(rawBody.trim())
      outgoing = parts.join('\n\n')
    }
    const text = outgoing.trim()
    const hasAttach = attachmentsForSend.length > 0
    // ── /命令 展开：/name args → 提示词模板（参数替换为 $ARGUMENTS）──
    // 在模型未启动的提前返回之前展开：保留展开后的文本在输入框，待启动后可手动发送。
    let resolvedText = text
    const parsedCmd = parseSlashCommand(text)
    if (parsedCmd) {
      const cmd = findCommand(parsedCmd.name, slashCommands)
      if (!cmd) {
        notify(`未知命令 /${parsedCmd.name}（输入 / 查看可用命令）`, 'error')
        if (text) { setInput(text); setPackedInput(null); setRefChips([]); setCodeSnippets([]) }
        return
      }
      // 动作型命令：renderer 侧直接处理（状态查询 / UI 动作），不发给模型
      if (cmd.kind === 'action') {
        setInput('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        setAttachedFiles([])
        setPackedInput(null)
        setRefChips([])
        setCodeSnippets([])
        await runSlashAction(cmd.name, parsedCmd.args)
        return
      }
      resolvedText = expandCommandTemplate(cmd.template, parsedCmd.args)
    }
    if (!apiBaseUrl || !runningCard) {
      // 模型未启动：把建议文本保留在输入框，待启动后手动发送（胶囊已合入文本，清空避免重复）
      if (resolvedText) { setInput(resolvedText); setPackedInput(null); setRefChips([]); setCodeSnippets([]) }
      return
    }
    if (sendingRef.current && !loading) {
      // 异步准备窗口（loading 已置真前）：沿用原排队兜底，避免并发双流
      pendingSendRef.current.push({ text: outgoing, attachments: attachmentsForSend, packedText: overrideText === undefined ? packedInput?.trim() || undefined : undefined })
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      setAttachedFiles([])
      if (overrideText === undefined) { setPackedInput(null); setRefChips([]); setCodeSnippets([]) }
      return
    }
    if (loading) {
      // 空插话：仅复位输入，不向 SDK 发空消息
      if (!resolvedText && attachmentsForSend.length === 0) {
        setInput('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        setAttachedFiles([])
        if (overrideText === undefined) { setPackedInput(null); setRefChips([]); setCodeSnippets([]) }
        return
      }
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      setAttachedFiles([])
      if (overrideText === undefined) { setPackedInput(null); setRefChips([]); setCodeSnippets([]) }
      // 运行中：追加（followUp）走前端队列，当前轮 runPiTurn 结束后自动发起独立新轮，
      // 让模型真正作答（SDK 自动续跑会被单轮 runPiTurn 架构吞掉回复）。
      followUpQueueRef.current.push({ text: resolvedText, attachments: attachmentsForSend, packedText: overrideText === undefined ? packedInput?.trim() || undefined : undefined })
      setQueueInfo(prev => ({ ...prev, followUp: [...prev.followUp, resolvedText] }))
      return
    }
    if (!resolvedText && !hasAttach) return

    // 同步互斥门闩：从这里到本轮 agent 结束前，后到的 handleSend 一律走排队分支
    sendingRef.current = true
    try {
      // 立即清空输入框并复位高度：消息已成功加入会话，避免输入框残留刚发出的内容
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'

      const pid = activeProjectId
      // 确保存在活动会话：默认项目可能尚无会话（sessions:[]），首次发送时就地创建，避免「按两次才发送」
      let sid = activeSessionId
      let baseMessages: AgentMessage[] = activeSession ? activeSession.messages : []
      if (!activeSession) {
        sid = uniqueId('sess')
        const freshSess: AgentSession = {
          id: sid,
          title: resolvedText.slice(0, 40),
          messages: []
        }
        setProjects(prev => prev.map(p => p.id === pid ? { ...p, sessions: [...p.sessions, freshSess] } : p))
        setActiveSessionId(sid)
        baseMessages = freshSess.messages
      }

      // 记录历史输入（仅文本），供 ↑ / ↓ 回溯
      if (resolvedText) {
        const hist = inputHistoryRef.current
        if (hist[hist.length - 1] !== resolvedText) hist.push(resolvedText)
        historyIdxRef.current = -1
      }

      // 构建附件（已在上文算好 attachmentsForSend）
      const attachments = attachmentsForSend
      if (overrideText === undefined) { setAttachedFiles([]); setPackedInput(null); setRefChips([]); setCodeSnippets([]) }

      // packedText：本次发送含「超长打包 chip」的那段正文 → 气泡里该段显示为 chip
      const packedPart = overrideText === undefined ? packedInput?.trim() || undefined : packedHint
      const userMsg: AgentMessage = { id: newMsgId(), role: 'user', content: resolvedText, attachments: attachments.length ? attachments : undefined, packedText: packedPart }
      // 仅在该会话尚无任何用户消息时，用首条消息自动生成标题（后续不再覆盖，保留手动重命名）
      const shouldAutoTitle = !baseMessages.some(m => m.role === 'user')
      let displayMsgs: AgentMessage[] = [...baseMessages, userMsg]
      updateSessionInProject(pid, sid, {
        messages: displayMsgs,
        ...(shouldAutoTitle ? { title: (resolvedText || '附件对话').slice(0, 40) } : {})
      })

      // ── 即时沉淀（阶段 2.3）：启发式识别用户纠正 / 约束语气，原话逐字写入长期记忆
      // （仅当会话已有助手回复时才可能是「纠正」，首条消息不触发）──
      if (agentConfig.longTermMemoryEnabled && resolvedText && activeProject.workspaceDir && baseMessages.some(m => m.role === 'assistant')) {
        noteUserCorrection(activeProject.workspaceDir, sid, resolvedText)
      }

      // ── pi SDK 驱动 agent 循环 ──
      // 自动压缩：历史超过保留轮数时先压缩（condenseSessionMemory 内部按 token 水位
      // 判断，未超预算直接跳过；压缩成功会使 pi session 失效并在下方重建），
      // 避免长对话模型上下文无限增长。用返回值取最新 memory（压缩可能更新了
      // coveredMsgIds/summary，而 activeSession 是旧闭包）。
      let memoryForTurn = activeSession?.memory
      if (activeSession && !condensing && runningCard) {
        const coveredSet = new Set(activeSession.memory?.coveredMsgIds || [])
        let coveredPrefix = 0
        while (coveredPrefix < activeSession.messages.length && coveredSet.has(activeSession.messages[coveredPrefix]!.id)) coveredPrefix++
        const turns = splitAgentTurns(activeSession.messages.slice(coveredPrefix))
        if (turns.length > KEEP_RECENT_TURNS) {
          const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
          const ctxBudget = computeContextBudget(ctxN)
          memoryForTurn = await condenseSessionMemory(activeProjectId, activeSessionId, activeSession.messages, activeSession.memory, ctxBudget, runningCard.template.serverPort, false)
        }
      }
      await runPiTurn(pid, sid, displayMsgs, {
        port: runningCard.template.serverPort,
        text: resolvedText,
        workspaceDir: activeProject.workspaceDir,
        approveWriteEdit: !!activeProject.approveWriteEdit,
        knowledgeBaseId: activeProject.knowledgeBaseId,
        memory: memoryForTurn,
        // 模式由所属工作区决定（不是会话字段）：切工作区即换模式，同一会话不会被改造成另一种模式。
        // 工具集是会话级字段，这里实时读；变化后由 runPiTurn 的 modeSig 守卫重建 pi 会话。
        plainChat: projectMode(activeProject) === 'chat',
        chatTools: activeSession?.chatTools,
      })
    } catch (e) {
      // 准备阶段（系统提示词构建/历史压缩）异常：本轮 agent 未启动，其收尾逻辑
      // 不会排空队列，这里兜底提示并重放排队消息，避免 sendingRef 窗口内
      // 入队的消息永久滞留（队列为空时重放自然跳过）。
      notify(`发送失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      const queue = pendingSendRef.current
      pendingSendRef.current = []
      for (const pending of queue) {
        if (pending.text.trim() || pending.attachments.length) {
          setTimeout(() => handleSendRef.current(pending.text || undefined, pending.attachments, pending.packedText), 0)
        }
      }
    } finally {
      sendingRef.current = false
    }
  }, [input, attachedFiles, packedInput, refChips, codeSnippets, loading, apiBaseUrl, runningCard, activeProjectId, activeSessionId, activeSession, activeProject, updateSessionInProject, condenseSessionMemory])

  // 始终持有最新的 handleSend，供排队回调使用，避免过期闭包
  handleSendRef.current = handleSend

  return { runPiTurn, handleSend }
}
