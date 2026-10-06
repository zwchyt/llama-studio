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
import { noteSendIntent } from '../flight/sendFlight'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { playEvent, warmUpAudio } from '../../../utils/sound'
import { agentConfig } from '../../../utils/agentConfig'
import { hasVisionProjector } from '../../../utils/modelCapabilities'
import { PiAgentClient } from '../../../utils/piAgentClient'
import { computeContextBudget, coveredPrefixCount, piContextWindowFor, COMPACTION_TRIGGER_MARGIN } from '../../../utils/contextBudget'
import { parseSlashCommand, findCommand, expandCommandTemplate } from '../../../agent/slashCommands'
import { newMsgId, uniqueId } from '../utils/ids'
import { MIN_EXEC_DISPLAY_MS } from '../utils/constants'
import type { AgentMessage, AgentSession, AgentTask, Attachment, CardState, ThinkingLevel, TodoUpdate } from '../../../../../shared/types'
import { projectMode } from '../../../../../shared/types'
import { remoteOfCard } from '../../../utils/endpoint'
import type { useAgentInput } from './useAgentInput'
import type { useAgentProjects } from './useAgentProjects'
import type { PanelView } from './useAgentUiState'

/** 压缩记录日志的保留上限：只留最近这些次（元数据很小，限长纯粹是为了会话 JSON 不无限增长） */
const MAX_COMPACTION_LOG = 20

/** 单轮 pi agent 运行签名（消息操作域的重新生成 / 重发复用同一契约） */
export type RunPiTurn = (
  pid: string,
  sid: string,
  displayMsgs: AgentMessage[],
  opts: {
    port: number
    text: string
    workspaceDir: string
    knowledgeBaseId?: string
    memory?: AgentSession['memory']
    // 注：模式（通用 / 编码）与通用模式下的工具集**不在这里传** —— 它们由本轮所属
    // 工作区 / 会话推导，统一在 runPiTurn 内部算一次（见那里的注释）。原先作为可选项
    // 由各调用点分别传，结果 3 个入口漏传导致通用模式工具全开，故从类型上移除。
    /** 项目自定义系统提示词（「提示词」卡片保存的内容）。由调用方从 activeProject 取，
        不经 runPiTurn 自己的闭包 —— 它的依赖数组只有 updateSessionInProject，
        直接读 activeProject 会拿到过期值。 */
    projectSystemPrompt?: string
  }
) => Promise<{ errored: boolean; aborted: boolean }>

export function useAgentLoop({
  projects: { projects: projectList, setProjects, setActiveSessionId, activeProjectId, activeSessionId, activeProject, activeSession, updateSessionInProject },
  inputDomain,
  loading, setLoading, setStreaming, setStreamKind, setThinkDone, setCurToolName, setQueueInfo,
  apiBaseUrl, runningCard, slashCommands,
  setTaskModalOpen, setPlanTitle, setPlanItems, planItemsRef,
  abortRef, sendingRef, piReadyRef, followUpQueueRef, prevQueueRef,
  appendLiveUserMsgRef, streamingSessionRef, streamStartAtRef, lastRateRef,
  modelLabelRef, backupsRef, thinkingLevelRef,
  appendQueuedUserMsg, queueRemoved, runSlashAction,
  scrollToBottom,
  openPreview,
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
  slashCommands: ReturnType<typeof useStore.getState>['slashCommands']
  setTaskModalOpen: React.Dispatch<React.SetStateAction<boolean>>
  setPlanTitle: React.Dispatch<React.SetStateAction<string>>
  /** 写计划项的唯一入口（同步维护 planItemsRef 镜像） */
  setPlanItems: (next: React.SetStateAction<TodoUpdate[]>) => void
  /** 计划项的渲染期镜像（判「本轮结束时清单是否已收束」用，避开异步闭包读到过期值） */
  planItemsRef: React.RefObject<TodoUpdate[]>
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
  appendQueuedUserMsg: (text: string) => void
  queueRemoved: (prev: string[], next: string[]) => string[]
  runSlashAction: (name: string, args: string) => Promise<void>
  /** 无条件贴底（来自 useAgentScroll）。发消息时用它恢复跟随，见 runPiTurn 里的说明 */
  scrollToBottom: (smooth?: boolean, force?: boolean) => void
  /** 在右侧预览面板打开一个文件（来自 useAgentPreviewTabs）。
      view_image 执行成功时用它把图片自动展开到预览列，让用户同步看到模型正在看的画面。 */
  openPreview?: (path: string, panelMode?: PanelView) => void
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
  // runPiTurn 的依赖数组刻意只有 updateSessionInProject（回调身份要稳定，队列补发 /
  // followUp 都直接引用它），所以它闭包里的 projectList / activeProject / activeSession
  // 全是首次渲染那一份旧快照：通用模式顶栏刚勾选的聊天工具读不到，会话重建时
  // chatTools 恒为空，模型侧收到的工具数一直是 0（现象：四个工具怎么开都没用）。
  // 每次渲染同步一份最新值，起轮时按 pid/sid 从 ref 取。
  const turnScopeRef = useRef({ projectList, activeProject, activeSession })
  turnScopeRef.current = { projectList, activeProject, activeSession }
  // 预览面板的打开回调：与 turnScopeRef 同理——runPiTurn 的依赖数组刻意只有
  // updateSessionInProject（回调身份要稳定，队列补发 / followUp 都直接引用它），
  // 所以这里也走 ref 取最新引用，供 view_image 执行完自动在右侧展开图片。
  const openPreviewRef = useRef<((path: string, panelMode?: PanelView) => void) | null>(null)
  openPreviewRef.current = openPreview ?? null


  // ── pi-agent 模式：pi SDK 驱动的单轮 agent 运行 ──
  // displayMsgs 的最后一条为最新 user 消息（由 prompt 发送）；此前消息作为历史注入 pi session。
  const runPiTurn = useCallback(async (
    pid: string,
    sid: string,
    displayMsgs: AgentMessage[],
    // 与上方导出的 RunPiTurn 共用同一份 opts 类型：原先两处各写一遍，改了一处另一处
    // 就静默漂移（新增 projectSystemPrompt 时正是这样漏掉内联声明的）。
    opts: Parameters<RunPiTurn>[3]
  ): Promise<{ errored: boolean; aborted: boolean }> => {
    const piSessionId = `pi-${sid}`
    // 一轮一份清单：本轮开始前先把上一轮遗留的清单清掉（后端任务表 + 卡片状态）。
    // 后端任务表是按会话存的，merge 分支遇到没见过的 id 只会追加，上一轮没执行完的
    // 条目会和本轮新建的清单前后怼在一起；而上一轮的清单本轮不会执行，留着只是噪音。
    // 放在 runPiTurn 开头：直接发送、队列补发、followUp 三条起轮路径都经过这里。
    setPlanTitle('')
    setPlanItems([])
    setTaskModalOpen(false)
    try {
      await window.api.agentTodoWrite(sid, { merge: false, todos: [] })
    } catch { /* 清不掉不阻塞本轮：本轮首次 TodoWrite 仍会按空表重建 */ }
    // 发消息/重跑是明确的用户意图，这里无条件恢复「贴底跟随」并立刻滚到底。
    // 不这么做的话：用户读长回答时往上滚过一次，pauseFollow 就把 followingRef 置了 false，
    // 之后再发消息，新增的这条只会在下方生成而不被滚进视野，得手动往下滑才看得到。
    // force=true：即便此刻有轨道补间动画在跑也要抢占（scrollToBottom 的早退分支在
    // 重置 followingRef 之前，不加 force 会被直接忽略）。
    scrollToBottom(false, true)
    // 模式与聊天工具集都由「本轮所属工作区 / 会话」决定，集中在这里推导一次。
    //
    // 原先这两个值由每个起轮点各自传（RunPiTurn 的 opts 字段），5 个入口里 3 个
    // —— 重新生成 / 编辑重发 / 运行中追加消息的队列补发 —— 漏传了 plainChat，
    // 于是通用模式走那几条路径时 `plain` 恒为 false：modeSig 从 `plain:...` 翻成
    // 'agent'，pi 会话被重建，主进程按编码模式激活全量工具白名单，Write / Edit /
    // Bash / Delete 全部可用（现象：通用模式里点「重新生成」就能写文件）。
    //
    // 这类「漏传」不该靠人记：判断只保留这一处，RunPiTurn 的 opts 里已不再暴露
    // 这两个字段，调用点想传也传不了。按 pid 取项目而不是直接用 activeProject，
    // 是为了兼容队列补发（setTimeout 期间用户可能已切走项目）这条路径。
    // 读的是 ref 里的最新快照，不是闭包中首次渲染那份旧值（见 turnScopeRef 的说明）。
    const turnScope = turnScopeRef.current
    const projectForTurn = turnScope.projectList.find(p => p.id === pid) ?? turnScope.activeProject
    const sessionForTurn = projectForTurn?.sessions.find(s => s.id === sid) ?? turnScope.activeSession
    const plain = projectMode(projectForTurn) === 'chat'
    const chatTools = plain ? [...(sessionForTurn?.chatTools ?? [])].sort() : []
    const modeSig = plain ? `plain:${chatTools.join(',')}` : 'agent'
    // 首次进入该会话（或会话切换/重建）、以及模式或聊天工具集变化时：创建 pi session 并注入历史
    if (piReadyRef.current.sid !== sid || !piReadyRef.current.ready || piPlainRef.current !== modeSig) {
      // 新 pi 会话：清空上一会话的撤销备份引用
      backupsRef.current = {}
      // 压缩记忆：被覆盖的最早前缀（长度由 memory.coveredCount 给出）用摘要替代注入，
      // 使压缩真正减小模型上下文（否则重建仍全量注入历史，压缩只改 UI 不生效）。
      const prior = displayMsgs.slice(0, -1)
      const coveredPrefix = coveredPrefixCount(opts.memory, prior)
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
      // 「本轮能不能把图发给模型」三层判据，从可信到不可信：
      //   ① 运行中服务端的自述：llama-server 真挂了视觉投影，/props 才会报 modalities.vision=true；
      //   ② 启动参数带了 --mmproj（视觉投影 / 俗称「图片模型」）：主模型 GGUF 常是纯文本架构，
      //      看图能力全在这个投影里，元数据推不出来，只看能力表就会误判成不支持；
      //   ③ 本地能力表：按模型文件名 / chat template 关键词推断，判错还会缓存下来一直用错。
      // 把图片发给一个不认图的端点会直接让这轮请求报错，所以 /props 给了明确答案就以它为准。
      // 远程端点没有 /props，那边只有面板上手勾的那一项可信（未勾就是不支持，不猜）。
      const curCard = useStore.getState().cards.find(c => c.status === 'running')
      const endpoint = remoteOfCard(curCard, useStore.getState().modelEndpoints)
      const capsVision = (): boolean => (curCard ? useStore.getState().modelCapabilities[curCard.template.id]?.vision === true : false)
      let vision = endpoint ? endpoint.vision === true : (capsVision() || hasVisionProjector(curCard?.template.args))
      if (!endpoint) {
        try {
          const props = await window.api.getServerProps(opts.port)
          if (props?.ok && typeof props.modalities?.vision === 'boolean') vision = props.modalities.vision === true
        } catch { /* /props 不可用（非 llama.cpp 系端点等）：沿用本地能力表 */ }
      }
      // 本地 n_ctx 拿不到时用 ctxDefault 兜底：预算绝不能是 0 —— 0 会被 worker 端理解成
      // 「不启用兜底裁剪」，恰好把最贫瘠的上下文场景变成没有防线。
      const ctxN = endpoint?.contextWindow
        ?? (curCard ? useStore.getState().modelMetrics[curCard.template.id]?.nCtx || 0 : 0)
      const ctxEff = ctxN > 0 ? ctxN : agentConfig.ctxDefault
      const contextBudget = computeContextBudget(ctxN)
      // 报给 pi 的上下文窗口要补上它自己那份不可配置的输出保留（4096，见
      // contextBudget.ts 的 PI_CONTEXT_SAFETY_TOKENS）。不补的话 pi 的算式
      // max_tokens = min(配置值, 窗口 - 已占用 - 4096) 会把真实可用上下文压到
      // n_ctx - 4096：16k 窗口下已占用过 12288 就把 max_tokens 夹到 1，
      // 表现是「还剩 3k，模型却什么都不输出」。补偿后算式回到真实窗口，
      // prompt + 输出恒等于 n_ctx。
      const piContextWindow = piContextWindowFor(ctxN)
      // pi 原生压缩的两个阈值：
      //   reserveTokens 决定触发线（contextTokens > piContextWindow - reserveTokens）。
      //     窗口抬高后触发线也会跟着抬高，所以这里按「兜底预算 - 余量」反解，保证压缩在
      //     兜底裁剪顶到天花板之前就能接管，而不是像原先那样永远触发不了。
      //     它同时是摘要请求的输出上限基数（pi 取 0.8×）：偏大无害 —— pi 的 max_tokens
      //     夹紧会保证摘要请求自己也不超窗。
      //   keepRecentTokens = 压缩后逐字保留的量，取预算四成，其余交给摘要。
      // 拿不到真实 n_ctx 时（极少见）不下发窗口、沿用 pi 默认值，压缩阈值维持原口径。
      const compactionReserveTokens = piContextWindow != null
        ? Math.max(512, piContextWindow - Math.max(512, contextBudget - COMPACTION_TRIGGER_MARGIN))
        : Math.max(512, Math.min(agentConfig.maxOutput, ctxEff - contextBudget))
      const compactionKeepRecentTokens = Math.max(600, Math.floor(contextBudget * 0.4))
      const res = await window.api.piAgent.create({
        sessionId: piSessionId,
        port: opts.port,
        // 远程端点整包下发：pi 的 provider 直接按这个 baseUrl / 协议 / key 注册
        ...(endpoint ? { endpoint } : {}),
        cwd: opts.workspaceDir || '.',
        knowledgeBaseId: opts.knowledgeBaseId || undefined,
        plainChat: plain,
        chatTools,
        searchEnabled: useStore.getState().searchEnabled,
        searchProvider: useStore.getState().searchProvider,
        // 用户可编辑的两段提示词：此前只写进了 project 对象，从未送达模型
        projectSystemPrompt: opts.projectSystemPrompt,
        contextWindow: piContextWindow,
        // 兜底裁剪的预算与开关：worker 端每次请求都会按这个预算机械裁剪历史
        // （shared/contextGuard.ts，挂在 pi 的 transformContext 上）。
        contextBudget,
        contextImportanceFold: agentConfig.ctxImportanceEnabled,
        compactionReserveTokens,
        compactionKeepRecentTokens,
        // 模型的输出上限必须与「实际发出的 max_tokens」同口径：pi 用它判断「回复是不是被
        // 上下文挤断了」（output < model.maxTokens → 压缩 + 重跑该轮）。此前主进程硬编码
        // 8192，而实际发出的 max_tokens 被上下文夹紧到 ≤8192，于是上下文一过 8192，
        // 任何一次撞上限的回复都被误判成「被挤断」→ 白烧一次摘要请求 + 白跑一轮重试。
        maxOutputTokens: agentConfig.maxOutput,
        // 模型支持图像输入时才声明 image 模态，browser_screenshot 的截图才会随工具结果回灌
        vision,
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
        // 终态提交：清掉排队的文本提交帧（其闭包 liveMsg 无 modelLabel/lastTps 等终态字段，
        // 延迟执行会覆盖 final commit 刚持久化的数据；commitText 已同步更新闭包 liveMsg，
        // 取消排队帧不会丢最后一次增量）
        if (textCommitFrame !== undefined) { cancelAnimationFrame(textCommitFrame); textCommitFrame = undefined }
        if (projectsSyncTimer) { clearTimeout(projectsSyncTimer); projectsSyncTimer = null }
        lastProjectsSyncAt = performance.now()
        updateSessionInProject(pid, sid, { messages: msgs })
      } else {
        syncProjects()
      }
    }
    // 流式正文 commit 帧对齐：文本增量高频到达时按 rAF 合帧，同一帧内到达的全部增量
    // 合并为至多一次 live 切片更新。此前 50ms setTimeout 节流与 vsync 周期（~16.7ms）
    // 无公约数关系：setTimeout 会被 clamp/错过帧起点，两次 commit 可能落进同一帧
    // （白做一次提交）或恰好错过一帧绘制（该帧显示旧内容、下一帧突进两份）——
    // 肉眼即「顿一下再跳一下」。rAF 合帧保证每次提交恰好命中一次绘制。
    // 显示层另有 useSmoothStream 打字机平滑，本层只负责 store 提交节奏。
    // 工具/思考边界等低频事件仍走 commit 即时提交，保证工具卡状态不错过。
    let textCommitFrame: number | undefined
    const commitText = (patch: Partial<AgentMessage>): void => {
      msgs = msgs.map(m => m.id === liveId ? { ...m, ...patch } : m)
      liveMsg = { ...liveMsg, ...patch }
      if (textCommitFrame !== undefined) return // 本帧已有排队提交，最新 liveMsg 会随其一起提交
      textCommitFrame = requestAnimationFrame(() => {
        textCommitFrame = undefined
        useStore.getState().setLiveAgentMsg(liveMsg)
        syncProjects()
      })
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
    // 把一次 TodoWrite 的参数应用到右上角待办卡片。
    // fromStream=true：参数还在逐 token 生成，拿到的是半截 JSON 的尽力解析快照。此时
    // 只认「已经带上 id 的项」并且一律增量合并——不给缺 id 的半截条目补下标（真 id 到了
    // 会变成两条重复项），也不按 replace 清空（快照本身是不完整的清单，清空＝误删）。
    // fromStream=false：toolcall_end 的完整参数，按 merge 语义正常处理。
    const applyTodoWriteArgs = (rawArgs: string, fromStream: boolean): void => {
      let args: { title?: string; merge?: boolean; todos?: Array<{ id?: string;[k: string]: unknown }> }
      try {
        args = JSON.parse(rawArgs)
      } catch (e) {
        // 流式快照本来就常残缺，不值得刷日志；完整参数随后由 toolcall_end 给出
        if (!fromStream) console.warn('[AgentCode] pi TodoWrite args parse failed:', e, rawArgs.slice(0, 200))
        return
      }
      const all = args.todos ?? []
      if (!all.length) return
      if (typeof args.title === 'string' && args.title.trim()) {
        setPlanTitle(args.title.trim())
      } else if (!fromStream && args.merge === false) {
        setPlanTitle('')
      }
      const todos = (fromStream
        ? all.filter(t => typeof t.id === 'string' && t.id)
        : all) as TodoUpdate[]
      if (!todos.length) return
      const merge = fromStream || args.merge !== false
      if (merge) {
        setPlanItems(prev => {
          const map = new Map<string, TodoUpdate>()
          prev.forEach((t, idx) => { map.set(t.id || String(idx + 1), t) })
          todos.forEach((t, idx) => {
            const key = t.id || String(idx + 1)
            map.set(key, { ...(map.get(key) || {}), ...t, id: t.id || key } as TodoUpdate)
          })
          return Array.from(map.values())
        })
      } else {
        setPlanItems(todos.map((t, idx) => ({ ...t, id: t.id || String(idx + 1) })) as TodoUpdate[])
      }
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
        // 计划面板同步（与 legacy 一致）：TodoWrite 调用后更新待办清单
        if (tc.name === 'TodoWrite') {
          // 打开右上角「待办」卡片（taskModalOpen 是渲染条件；本轮结束在 finally 里关掉）
          setTaskModalOpen(true)
          if (tc.args) applyTodoWriteArgs(tc.args, false)
        }
        commit({ toolCalls: [...toolCalls], segments: buildSegs() })
      },
      // 参数流式快照：让待办条目「生成完一条就上屏一条」，而不是干等整段 JSON 生成完。
      // 只处理 TodoWrite（其它工具的参数要么不需要预览、要么体量太大，主进程已按量丢弃）。
      onToolCallArgs: (tc) => {
        if (tc.name !== 'TodoWrite' || !tc.args) return
        setTaskModalOpen(true)
        applyTodoWriteArgs(tc.args, true)
      },
      // Write/Edit 参数生成中的行数统计（主进程数的换行数）挂到工具卡，让 +N -M 从头就在。
      // 参数流完后渲染层用 LCS 精确值覆盖（getEditDiffStat 只认完整 args）。
      onToolCallStat: (id, stat) => {
        const i = toolCalls.findIndex(t => t.id === id)
        if (i < 0) return
        toolCalls[i] = { ...toolCalls[i]!, streamStat: stat }
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
      onToolExecutionEnd: (id, name, resultText, isError, backupId, tasks) => {
        // 待办工具执行完，后端权威清单随 details.tasks 回来 → 直接以它为准回写卡片。
        // 修正两件事：流式快照里缺 id 而被跳过的项、以及模型参数与后端 id 不一致导致的
        // 重复项。执行失败不覆盖（保留模型声明的那份，用户至少看得见计划）。
        if (name === 'TodoWrite' && !isError && Array.isArray(tasks)) {
          const list = tasks as AgentTask[]
          setPlanItems(list
            .filter(t => t.status !== 'deleted')
            .map((t): TodoUpdate => ({
              id: t.id,
              content: t.subject,
              description: t.description,
              status: t.status as TodoUpdate['status'],
              priority: t.priority,
              activeForm: t.activeForm,
              notes: t.notes
            })))
          setTaskModalOpen(true)
        }
        // pi 模式撤销契约（R2）：撤销按钮是否可用完全由 backupId 是否存在决定。
        // main 仅在写操作成功并真实记录备份后才回传 backupId；只读工具、执行失败、
        // 或备份记录失败时 backupId 为 undefined → 不写入备份引用 → canUndoFor 返回 false
        // → 工具卡不显示撤销按钮，避免「无备份可写回」的空撤销。
        if (backupId) {
          backupsRef.current[id] = { path: `pi-undo:${backupId}`, content: '' }
        }
        // view_image 成功：把这张图自动展开到右侧预览列，让用户同步看到模型正在看的画面
        // （与 browser_show 展开浏览器面板同一个意图）。结果文本就是
        // JSON.stringify({ ok, path, mimeType, bytes, note })，path 是已解析的工作区绝对路径，
        // 直接交给预览域的 openPreview（它按扩展名判图片、读 data URL 渲染 <img>）。
        // 这里用 ref 取最新引用：runPiTurn 的依赖数组必须保持稳定（见 openPreviewRef 说明）。
        if (name === 'view_image' && !isError) {
          try {
            const r = JSON.parse(resultText) as { ok?: boolean; path?: string }
            if (r?.ok && typeof r.path === 'string' && r.path) openPreviewRef.current?.(r.path, 'preview')
          } catch { /* 结果不是 JSON（如「图片读取未启用」）：忽略 */ }
        }
        const elapsed = execStartMs.has(id) ? Date.now() - execStartMs.get(id)! : Number.MAX_SAFE_INTEGER
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
      onTurnEnd: () => { /* pi 事件不携带需要落地的字段，无需额外处理 */ },
      onEnd: () => {
        // 兜底撤掉「压缩中」提示：正常情况下由 compaction_end 清除，但会话中途被销毁时
        // 那条事件可能永远不来，标志会卡在 true、提示条一直挂着。
        useStore.getState().setCompacting(false)
      },
      onQueueUpdate: (_s, f) => {
        // 出队（被执行）的条目 = prev 有而当前无的 → 此刻补写进历史，让其出现在对话里
        const removedFollow = queueRemoved(prevQueueRef.current.followUp, f)
        prevQueueRef.current = { followUp: f }
        setQueueInfo({ followUp: f })
        for (const t of removedFollow) appendQueuedUserMsg(t)
      },
      onCompactionStart: () => {
        // pi 原生压缩开始（手动 / 自动都发）：置位全局「压缩中」，输入区据此渲染提示条。
        useStore.getState().setCompacting(true)
      },
      onCompaction: (info) => {
        // 压缩结束一律撤掉提示条：pi 在成功 / 中止 / 失败三条路径上都会发 compaction_end
        useStore.getState().setCompacting(false)
        // 读「当前」记忆，而不是 opts.memory：后者是本轮开始时捕获的快照，一轮里压缩多次时
        // 第二次会拿旧快照当基线 → 把第一次的记录整条覆盖掉（列表永远只显示一条，看起来
        // 「卡在第 1 次」）。store 里的 agentProjects 才是这条数据的唯一事实来源。
        const prevMemory = useStore.getState().agentProjects
          .find(p => p.id === pid)?.sessions.find(s => s.id === sid)?.memory
        // 本次是否真的产出了新摘要（中止 / 失败时 pi 给的是空 summary）
        const succeeded = !info.aborted && !!info.summary
        // ── 追加一条压缩记录（成功与失败都记）──
        // 失败/中止原先只出现在一个瞬时弹层里，关掉就查不到；这里留痕，供「压缩记录」列表展示。
        // 只记元数据、不记摘要全文：pi 是滚动压缩，每份摘要都包含之前全部内容（见 types 的注释）。
        const compactions = [
          ...(prevMemory?.compactions ?? []),
          {
            reason: info.reason || 'threshold',
            coveredCount: info.coveredCount,
            ...(info.tokensBefore != null ? { tokensBefore: info.tokensBefore } : {}),
            ...(info.tokensAfter != null ? { tokensAfter: info.tokensAfter } : {}),
            ok: succeeded,
            ...(info.errorMessage ? { errorMessage: info.errorMessage } : {}),
            at: Date.now()
          }
        ].slice(-MAX_COMPACTION_LOG)
        // 没成功：不动摘要与边界（保留上一次的成果），只追加记录
        if (!succeeded) {
          updateSessionInProject(pid, sid, {
            memory: prevMemory
              ? { ...prevMemory, compactions }
              : { summary: '', coveredCount: 0, updatedAt: Date.now(), compactions }
          })
          return
        }
        // 边界只允许单调前进：pi 在自己会话里是滚动压缩的，回退会让「已被摘要替代」的
        // 消息在下次重建时重新按原文注入，等于压缩白做。
        const coveredCount = Math.max(prevMemory?.coveredCount ?? 0, info.coveredCount)
        updateSessionInProject(pid, sid, {
          memory: {
            ...(prevMemory?.facts ? { facts: prevMemory.facts } : {}),
            summary: info.summary,
            coveredCount,
            updatedAt: Date.now(),
            compactions
          }
        })
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
      // 提示音总开关由 playEvent 内部读设置，这里只管「什么时候该响」。
      if (!abortRef.current.aborted) playEvent('complete')
      // 输出已结束：立刻停表并把时长定格，再去做任何异步补数。
      // 顺序很关键：下面的 queryMetricsNow 是 IPC + /slots + /metrics 两个 HTTP，刚停时
      // llama-server 还在收尾，一等就是几十到几百毫秒。若停表排在它之后，思考链头部时间在
      // 这段等待里会继续涨，closeOpenThink 定格进 durationMs 的数字也会被同样污染。
      setStreaming(false)
      closeOpenThink()
      // 定格本轮总耗时：头部时间在流式期间走的是「发出请求 → 现在」的连续墙钟，
      // 完成态若改用「各段定格时长之和」会比它小（不计正文输出、段间重新请求与首字等待），
      // 表现为结束瞬间数字跳变。这里把墙钟定格进消息，完成态显示同一个数。
      const thinkTotalMs = Math.max(0, Date.now() - (streamStartAtRef.current ?? Date.now()))
      if (!streamedText && toolCalls.length === 0) {
        commit({ content: '(模型未返回内容)', modelLabel: modelLabelRef.current, thinkTotalMs, decodedTokens: decodedNow() }, true)
      } else {
        // 本轮结束：segments 已是实时时间线顺序（buildSegs），流式/完成态一致交错
        commit({
          content: streamedText,
          toolCalls: [...toolCalls],
          segments: buildSegs(),
          modelLabel: modelLabelRef.current,
          lastTps: lastRateRef.current ?? undefined,
          thinkTotalMs,
          decodedTokens: decodedNow()
        }, true)
      }
      // 端点最新解码数（与 /slots 的 n_decoded 精确一致）只补数字字段，不影响已定格的时间线
      if (tidNow) {
        try {
          const v = await window.api.queryMetricsNow(tidNow)
          if (typeof v === 'number' && v > 0) {
            finalDecoded = v
            commit({ decodedTokens: v }, true)
          }
        } catch { /* 查询失败回退广播值 */ }
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
      // 兜底撤掉「压缩中」提示：pi 的压缩结束事件可能落在 client.detach() 之后
      // （例如运行结束后的溢出恢复压缩），那条事件到不了渲染层，标志会卡在 true、
      // 提示条一直挂着。这里在拆掉客户端的同时无条件复位。
      useStore.getState().setCompacting(false)
      // 待办卡片的收起条件＝「本轮结束 且 清单已全部收束（completed/cancelled）」。
      // 不能只看本轮结束：模型常在「建好计划」这一轮就停下（等下一轮再执行），
      // 那时清单还是 0/N 待办，卡片必须留着，否则计划刚建好就消失。
      // 空清单不收（卡片本来就不该显示，交给切会话那条路径清）。
      {
        const plan = planItemsRef.current
        if (plan.length > 0 && plan.every(t => t.status === 'completed' || t.status === 'cancelled')) {
          setTaskModalOpen(false)
        }
      }
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
        const fuOpts = { port: opts.port, text: nextFU.text, workspaceDir: opts.workspaceDir, knowledgeBaseId: opts.knowledgeBaseId, memory: opts.memory }
        setTimeout(() => { const rt = runPiTurnRef.current; if (rt) rt(pid, sid, fuMsgs, fuOpts) }, 0)
      }
    }
  }, [updateSessionInProject])
  runPiTurnRef.current = runPiTurn

  // ── 区域：发送消息（构建附件、创建会话、调用 agent） ──
  const handleSend = useCallback(async (overrideText?: string, overrideAttachments?: Attachment[], packedHint?: string) => {
    // 用户手势内预热音频：否则完成提示音（await 后播放）会被自动播放策略静默拦截
    warmUpAudio()
    // 发送飞行起跑快照（输入框盒/文字位/旧行位置，同步 DOM 读取；内部吞错，绝不影响发送）
    noteSendIntent()
    const attachmentsForSend: Attachment[] = overrideAttachments ?? attachedFiles.map(a => ({
      name: a.name,
      type: a.isImage ? 'image' : 'file',
      dataUrl: a.isImage ? a.dataUrl : undefined,
      content: a.isImage ? undefined : a.content,
      // 带得上磁盘路径：气泡里的胶囊点一下就能在右侧预览打开原文件
      ...(a.path ? { path: a.path } : {}),
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
    // 通用模式不启用斜杠命令：/clear、/compact 等是编码工作台能力，输入浮层已在
    // hints 域被禁用；这里同样跳过分发，用户手敲的 /xxx 作为普通文本发给模型。
    const parsedCmd = projectMode(activeProject) === 'chat' ? null : parseSlashCommand(text)
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

    // 编码模式把项目删光了：会话没有归属的工作区，照常发送会把消息写进虚空（就地建会话也无处插），
    // 所以在这里拦下并保留输入框内容，让用户先去新建项目。
    if (!activeProjectId) {
      notify('还没有项目，请先在左侧「新建项目」中选择工作目录', 'error')
      return
    }

    // 同步互斥门闩：从这里到本轮 agent 结束前，后到的 handleSend 一律走排队分支
    sendingRef.current = true
    try {
      // 立即清空输入框并复位高度：消息已成功加入会话，避免输入框残留刚发出的内容
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'

      const pid = activeProjectId
      // 确保存在活动会话：项目可能尚无会话（sessions:[]），首次发送时就地创建，避免「按两次才发送」
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

      // ── pi SDK 驱动 agent 循环 ──
      // 自动压缩已交回 pi：触发依据是上一条回复的真实 usage（不再是字符估算），
      // 轮末与发 prompt 前各查一次，溢出时还会「省略失败回复 → 压缩 → 重跑该轮」。
      // 阈值按 n_ctx 在会话创建时下发（见上面 compactionReserveTokens / keepRecentTokens），
      // 压缩产出由 manager.ts 的 compaction_end 订阅镜像回 session.memory。
      // 这里只把当前 memory 交给本轮用于重建注入。
      const memoryForTurn = activeSession?.memory
      await runPiTurn(pid, sid, displayMsgs, {
        port: runningCard.template.serverPort,
        text: resolvedText,
        workspaceDir: activeProject.workspaceDir,
        knowledgeBaseId: activeProject.knowledgeBaseId,
        memory: memoryForTurn,
        // 模式与通用模式的工具集不在这里传：由 runPiTurn 按本轮工作区 / 会话统一推导
        // （见那里的注释），避免各起轮点漏传。
        // 项目级提示词：从 activeProject 实时取（本回调的依赖数组里有 activeProject）
        projectSystemPrompt: activeProject.systemPrompt,
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
  }, [input, attachedFiles, packedInput, refChips, codeSnippets, loading, apiBaseUrl, runningCard, activeProjectId, activeSessionId, activeSession, activeProject, updateSessionInProject])

  // 始终持有最新的 handleSend，供排队回调使用，避免过期闭包
  handleSendRef.current = handleSend

  return { runPiTurn, handleSend }
}
