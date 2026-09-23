
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：导入声明                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { useEffect, useMemo, useRef } from 'react'
import 'katex/dist/katex.min.css'
// 注：此处原先 import 了 monitoring.css（「模型运行数据」页的样式文件），
// 但本页一个类都没用到 —— 唯一的 agent-ctx-metric-val 已归位到本页的 agent-code.css。
// 每个导航页只引用自己的样式文件。
import {useStore} from '../store/useStore'
import {paramSetOf} from '../utils/engine'
import {usePopoverDismiss} from '../utils/usePopoverDismiss'
import {useTts} from '../utils/useTts'
// ── agent-code 拆分模块（批次 4：hooks）──
import {useAgentProjects} from './agent-code/hooks/useAgentProjects'
import {useAgentInput} from './agent-code/hooks/useAgentInput'
import {useAgentRunState} from './agent-code/hooks/useAgentRunState'
import {useAgentMic} from './agent-code/hooks/useAgentMic'
import {useAgentUiState} from './agent-code/hooks/useAgentUiState'
import {useAgentPanels} from './agent-code/hooks/useAgentPanels'
import {useAgentPreviewTabs} from './agent-code/hooks/useAgentPreviewTabs'
import {useAgentScroll} from './agent-code/hooks/useAgentScroll'
import {useAgentGit} from './agent-code/hooks/useAgentGit'
import {useAgentSessionEffects} from './agent-code/hooks/useAgentSessionEffects'
import {useAgentViewEffects} from './agent-code/hooks/useAgentViewEffects'
import {useAgentSessionActions} from './agent-code/hooks/useAgentSessionActions'
import {useAgentCondense} from './agent-code/hooks/useAgentCondense'
import {useAgentSlashActions} from './agent-code/hooks/useAgentSlashActions'
import {useAgentLoop} from './agent-code/hooks/useAgentLoop'
import {useAgentMessageActions} from './agent-code/hooks/useAgentMessageActions'
import {useAgentModals} from './agent-code/hooks/useAgentModals'
import {useAgentInputHints} from './agent-code/hooks/useAgentInputHints'
import {useAgentInputKeyboard} from './agent-code/hooks/useAgentInputKeyboard'
import {useAgentModelControl} from './agent-code/hooks/useAgentModelControl'
// ── agent-code 拆分模块（批次 5：agent-view 布局）──
import {AgentCodeViewLayout} from './agent-code/agent-view/AgentCodeViewLayout'

import type { AgentMessage, CardState } from '../../../shared/types'
// CodeBlock 的样式已迁到 styles/code-block.css，由 CodeBlock.tsx 自己引入（它是共享组件）。
// 原先靠本页 import chat.css 才生效，属于隐性依赖，已解除；chat.css 随之删除。
import '../styles/agent-code.css'

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：模块级常量与工具函数（已全部下沉，本文件不再保留模块级实现）             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 上下文压缩的常量 / 摘要提示词 / 纯函数（CONDENSE_TRIGGER_RATIO、SUMMARY_PROMPT、
// serializeMessagesForSummary、buildApiMessagesFull、wrapUntrustedFileContent …）
// 已抽至 agent-code/utils/condensePrompt.ts。
// 其余纯函数与常量（ID / 路径 / 格式化 / 文本 / KaTeX 公式 / 音频编码 / 扩展名集合 /
// DOM 辅助 / 共享常量 / Token 估算与上下文裁剪 / Diff 计算 / Markdown 渲染）此前已分别
// 下沉，完整对照表见 agent-code/README.md「模块索引」。

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：主组件 AgentCodeView（各功能域 hook 的装配 + 布局渲染）                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 主组件只做两件事：装配各功能域 hook，把域对象与少量散装值注入布局组件。
// 界面骨架、弹层、消息流、预览、输入区等视图全部在 agent-code/ 下，本文件不再持有 JSX。

export default function AgentCodeView() {
  // ── store 订阅与派生量 ──
  const cards = useStore(s => s.cards)
  const backends = useStore(s => s.backends)
  const runningCard = cards.find(c => c.status === 'running')
  // 模型下拉只列可对话/代理的模型：排除生图模型（stable-diffusion.cpp 引擎）与 OCR 模型；
  // 已运行中的除外（保留停止入口）
  const isExcludedModel = (card: CardState): boolean => {
    const kind = paramSetOf(card.template.paramSet ?? backends.find(b => b.name === card.template.backendVersion)?.kind)
    return kind === 'sdcpp' || kind === 'audiocpp' || /ocr/i.test(card.template.name)
  }
  const agentCards = useMemo(() => cards.filter(c => !isExcludedModel(c) || c.status === 'running'), [cards, backends])

  // 顶栏 prefill 进度与内联上下文指示器已抽为自订阅小组件（AgentPrefillBar / AgentTopBarCtx），
  // 此处不再订阅 modelMetrics，避免主进程每 2s 广播指标时触发整个工作台全量重渲染。
  const apiBaseUrl = runningCard ? `http://127.0.0.1:${runningCard.template.serverPort}` : null
  const modelLabel = runningCard?.template.modelPath?.split(/[\\/]/).pop() || runningCard?.template.name || '模型'
  const storedProjects = useStore(s => s.agentProjects)
  const setAgentProjects = useStore(s => s.setAgentProjects)
  // 自定义 /命令
  const slashCommands = useStore(s => s.slashCommands)

  // ── 模型卡片启停编排（见 agent-code/hooks/useAgentModelControl.ts）──
  const modelControl = useAgentModelControl()

  // ── 项目 / 会话列表（自持 state 与增删改，见 agent-code/hooks/useAgentProjects.ts）──
  let projectsDomain!: ReturnType<typeof useAgentProjects>
  const {
    setProjects, activeProjectId, setActiveSessionId,
    activeSessionId, activeProject, activeSession,
    updateSessionInProject, exportSession,
  } = (projectsDomain = useAgentProjects({ storedProjects }))

  // ── 整个输入域（自持 state / ref / 回调，见 agent-code/hooks/useAgentInput.ts）──
  // 整个域对象同时透传给 AgentInputArea，避免在调用处铺开 20 余个 props。
  let inputDomain!: ReturnType<typeof useAgentInput>
  const {
    input, setInput, textareaRef,
    autoResize, insertAtCursor, replaceRange, setSelectionPopover,
  } = (inputDomain = useAgentInput({ draftScope: projectsDomain.mode }))

  // ── 流式运行态与跨域共享 ref（见 agent-code/hooks/useAgentRunState.ts）──
  let run!: ReturnType<typeof useAgentRunState>
  const {
    loading, setLoading, streaming, setStreaming, setStreamKind, setThinkDone,
    thinkingLevel, setThinkingLevel, thinkingLevelRef, setCurToolName, setQueueInfo,
    condenseOpen, setCondenseOpen,
    sendingRef, streamingSessionRef, abortRef, streamStartAtRef,
    modelLabelRef, lastRateRef, piReadyRef,
    prevQueueRef, appendLiveUserMsgRef, followUpQueueRef,
  } = (run = useAgentRunState())

  // ── 麦克风语音输入（自持 ref / state / 回调，见 agent-code/hooks/useAgentMic.ts）──
  const mic = useAgentMic({ input, setInput })

  // ── 界面状态域（面板 / 弹层 / 模型选择器 / 任务卡 / 审批，见 agent-code/hooks/useAgentUiState.ts）──
  let ui!: ReturnType<typeof useAgentUiState>
  const {
    ctxInlineRef, condenseBtnRef, trajBtnRef, memoryBtnRef,
    modelPickerOpen, setModelPickerOpen, modelPickerRef, modelBtnRef,
    treeOpen, setTreeOpen, rightPanelMode, setRightPanelMode,
    contextModalOpen, setContextModalOpen,
    trajOpen, setTrajOpen,
    memoryOpen, setMemoryOpen,
    taskModalOpen, setTaskModalOpen, setTaskCardClosing,
    setCurrentPlanItems, setPlanTitle, setTaskPanelCollapsed,
    editingMsgId, setEditingMsgId, editDraft, setEditDraft,
  } = (ui = useAgentUiState({
    agentCards, loading, piReadyRef,
    // 模式由所属工作区决定（不再挂在会话上），所以这里传的是 projects 域的模式
    mode: projectsDomain.mode,
    activeProjectId, activeSessionId, activeSession, updateSessionInProject,
  }))

  // ── 三块可拖拽面板（预览区 / 侧边栏 / 右侧面板，见 agent-code/hooks/useAgentPanels.ts）──
  const panels = useAgentPanels({ rightPanelMode })

  // ── 预览标签页与内容读取（自持 state 与回调，见 agent-code/hooks/useAgentPreviewTabs.ts）──
  // 整个域对象同时透传给 AgentPreviewSlot，避免在调用处铺开 30 余个 props。
  let previewDomain!: ReturnType<typeof useAgentPreviewTabs>
  previewDomain = useAgentPreviewTabs({ setRightPanelMode, setTreeOpen })

  // 通用弹窗关闭：点击弹窗/触发按钮外部 或 Escape 键时关闭。
  // 实现见 utils/usePopoverDismiss（支持 btnRef / popRef / popSelector 三种判定，
  // popRef 基于 contains 对 portal 安全；并统一处理 Esc 与事件阶段）。
  usePopoverDismiss(modelPickerOpen, setModelPickerOpen, modelBtnRef, undefined, modelPickerRef)

  usePopoverDismiss(contextModalOpen, setContextModalOpen, ctxInlineRef, '.agent-card-ctx')
  usePopoverDismiss(condenseOpen, setCondenseOpen, condenseBtnRef, '.agent-card-condense')
  usePopoverDismiss(trajOpen, setTrajOpen, trajBtnRef, '.agent-card-traj')
  usePopoverDismiss(memoryOpen, setMemoryOpen, memoryBtnRef, '.agent-card-memstore')

  // ── 跨域共享 ref（各动作域共用的备份 / 撤销 / 回滚状态）──
  const backupsRef = useRef<Record<string, { path: string; content: string }>>({})
  // handleUndo 在 runSlashAction 之后定义，用 ref 转发避免声明顺序/闭包报错
  const handleUndoRef = useRef<((msgId: string, tcId: string) => Promise<void>) | null>(null)
  // 本轮是否已作废过旧备份：新一轮对话产生第一个修改备份时清空更早对话的备份，
  // 撤销状态只停留在「当前正在执行的修改」上（旧消息的撤销按钮随之置灰）。
  const regenRollbackRef = useRef<{ sid: string; messages: AgentMessage[] } | null>(null)

  // ── DOM ref（消息末锚点 / 输入区 / 任务卡）──
  const msgEndRef = useRef<HTMLDivElement>(null)
  const chatInputAreaRef = useRef<HTMLDivElement>(null)
  const taskCardRef = useRef<HTMLDivElement>(null)

  // ── 聊天区滚动跟随 + 目录 rail（自持 ref / state / 回调，见 agent-code/hooks/useAgentScroll.ts）──
  let scroll!: ReturnType<typeof useAgentScroll>
  scroll = useAgentScroll({
    activeSession, streaming, setSelectionPopover, taskCardRef, taskModalOpen,
    scrollScope: projectsDomain.mode,
  })

  // ── Git 变更 / 分支（自持 state 与 ref，见 agent-code/hooks/useAgentGit.ts）──
  let git!: ReturnType<typeof useAgentGit>
  git = useAgentGit({
    workspaceDir: activeProject.workspaceDir, rightPanelMode, treeOpen,
    setRightPanelMode, setTreeOpen, setContextModalOpen,
  })

  // ── 会话生命周期 / 工作区同步 / 记忆沉淀（见 agent-code/hooks/useAgentSessionEffects.ts）──
  useAgentSessionEffects({ storedProjects, setAgentProjects, projects: projectsDomain, run, ui, scroll })

  // ── 消费「开一个纯聊天会话」的外部请求（模型卡片的「纯聊天」按钮投递）──
  // 不能直接写 store 的 agentProjects：本组件常驻挂载，projects 状态只在首次挂载时读一次
  // store，之后再写也传不进来。所以改成投递一条待处理指令、由这里自己建会话并切过去。
  // 订阅 pendingPlainChat 是为了让写入能触发重渲染，否则 effect 不会重新执行。
  // 注意新会话归属**通用工作区**（不是当前项目）：所以走 openNewChatSession，
  // 它会把模式一并切到通用——普通聊天不会被塞进编码项目里变成编码上下文。
  const pendingPlainChat = useStore(s => s.pendingPlainChat)
  useEffect(() => {
    if (!pendingPlainChat) return
    useStore.getState().setPendingPlainChat(null)
    // 当前已经是「通用模式下还没说过话的会话」就直接复用：否则连点几次按钮会堆出一串空会话
    if (projectsDomain.mode === 'chat' && activeSession && activeSession.messages.length === 0) return
    projectsDomain.openNewChatSession(pendingPlainChat.title)
  }, [pendingPlainChat, projectsDomain, activeSession])

  // ── 视图副作用：预览跳行高亮 / 输入区测高（见 agent-code/hooks/useAgentViewEffects.ts）──
  useAgentViewEffects({ preview: previewDomain, scroll, chatInputAreaRef })

  // ── 会话动作：队列补写 / 片段引用 / 停止 / 目录 / 重命名（见 agent-code/hooks/useAgentSessionActions.ts）──
  const sessionActions = useAgentSessionActions({ projects: projectsDomain, run, ui, preview: previewDomain, inputDomain })

  // ── 上下文摘要压缩域（自动触发 + 手动触发，见 agent-code/hooks/useAgentCondense.ts）──
  let condense!: ReturnType<typeof useAgentCondense>
  const { condensing, condenseSessionMemory, handleManualCondense } = (condense = useAgentCondense({
    activeProjectId, activeSessionId, activeSession, updateSessionInProject,
    loading, apiBaseUrl, runningCard, modelLabel, piReadyRef,
  }))

  // ── 动作型 /命令 分发域（renderer 侧直接处理，见 agent-code/hooks/useAgentSlashActions.ts）──
  const { runSlashAction } = useAgentSlashActions({
    activeProject, activeProjectId, activeSession, activeSessionId,
    setProjects, setActiveSessionId, updateSessionInProject, exportSession,
    runningCard, cards, modelLabel, slashCommands, thinkingLevel, setThinkingLevel,
    currentPlanItems: ui.currentPlanItems, handleManualCondense, backupsRef, handleUndoRef,
  })

  // ── Agent 循环域（pi SDK 单轮运行 + 发送消息编排，见 agent-code/hooks/useAgentLoop.ts）──
  // 自持循环私有 ref（排队兜底 / 事件客户端 / 互调转发）；共享 ref 与运行态由本组件注入。
  let loop!: ReturnType<typeof useAgentLoop>
  const { runPiTurn, handleSend } = (loop = useAgentLoop({
    projects: projectsDomain,
    inputDomain,
    loading, setLoading, setStreaming, setStreamKind, setThinkDone, setCurToolName, setQueueInfo,
    apiBaseUrl, runningCard, condensing, slashCommands,
    setTaskModalOpen, setTaskPanelCollapsed, setTaskCardClosing, setPlanTitle, setCurrentPlanItems,
    abortRef, sendingRef, piReadyRef, followUpQueueRef, prevQueueRef,
    appendLiveUserMsgRef, streamingSessionRef, streamStartAtRef, lastRateRef,
    modelLabelRef, backupsRef, thinkingLevelRef,
    condenseSessionMemory,
    appendQueuedUserMsg: sessionActions.appendQueuedUserMsg,
    queueRemoved: sessionActions.queueRemoved,
    runSlashAction,
    // 发消息时无条件贴底：恢复被用户上滚关掉的跟随，否则新消息会在视野外生成
    scrollToBottom: scroll.scrollToBottom,
  }))

  // ── 语音朗读（纯聊天模式的消息行用）──
  const { speakingId, speak, stop: stopSpeak } = useTts()

  // ── 消息级操作（自持逻辑、复用循环域与项目域的共享引用，见 agent-code/hooks/useAgentMessageActions.ts）──
  let messageActions!: ReturnType<typeof useAgentMessageActions>
  const { msgRowActionsRef } = (messageActions = useAgentMessageActions({
    activeSession, activeProject, activeProjectId, activeSessionId,
    loading, runningCard, updateSessionInProject, setProjects, setActiveSessionId,
    runPiTurn, backupsRef, piReadyRef, regenRollbackRef, handleUndoRef,
    editingMsgId, setEditingMsgId, editDraft, setEditDraft,
    openFileAtLine: previewDomain.openFileAtLine, openGitDiffAt: git.openGitDiffAt,
    speak, stopSpeak,
  }))

  // ── 提示词 / 知识库弹层、欢迎页建议与注释发送（见 agent-code/hooks/useAgentModals.tsx）──
  const modals = useAgentModals({
    projects: projectsDomain, ui, preview: previewDomain, inputDomain,
    loading, apiBaseUrl, runningCard, handleSend,
  })

  // ── 输入框补全浮层（@ 提及 / 斜杠命令，自持 state 与回调，见 agent-code/hooks/useAgentInputHints.ts）──
  // 整个域对象同时透传给 AgentInputArea。
  let hintsDomain!: ReturnType<typeof useAgentInputHints>
  hintsDomain = useAgentInputHints({
    input, setInput, insertAtCursor, replaceRange, textareaRef, autoResize,
    workspaceDir: activeProject.workspaceDir,
  })

  // ── 输入框键盘处理与 onChange 补全检测（见 agent-code/hooks/useAgentInputKeyboard.ts）──
  const { handleKeyDown, handleInputChange } = useAgentInputKeyboard({
    inputDomain, hintsDomain, handleSend, workspaceDir: activeProject.workspaceDir,
  })

  // ── 区域：布局渲染（顶栏、侧边栏、聊天区、预览区、弹层） ──
  // 各功能域的完整返回值（域对象）与少量散装值一并注入布局组件；
  // 布局是纯受控视图，不持有状态，全部数据与回调来自此处。
  return (
    <AgentCodeViewLayout
      view={{
        // ── 域对象（各 hook 的完整返回值）──
        projects: projectsDomain,
        inputDomain,
        preview: previewDomain,
        hints: hintsDomain,
        run,
        ui,
        condense,
        messageActions,
        scroll,
        git,
        mic,
        loop,
        panels,
        modals,
        sessionActions,
        // ── 散装值：模型卡片与其派生量 ──
        cards,
        agentCards,
        runningCard,
        apiBaseUrl,
        modelLabel,
        handleModelAction: modelControl.handleModelAction,
        handleStop: sessionActions.handleStop,
        // 正在朗读的消息 id（纯聊天模式用；plainChat 本身由 ui 域提供，不重复传）
        speakingId,
        // ── 散装值：DOM ref 与输入区键盘处理 ──
        msgEndRef,
        msgRowActionsRef,
        chatInputAreaRef,
        taskCardRef,
        handleKeyDown,
        handleInputChange,
      }}
    />
  )
}
