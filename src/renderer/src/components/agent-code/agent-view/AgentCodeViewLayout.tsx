// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentCodeViewLayout —— Agent Code 界面骨架（顶栏 / 侧栏 / 聊天区 / 预览区）║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的 return(...) 整段 JSX（DOM 结构与类名逐字未变）。
// 本组件是纯「受控视图」：不持有任何状态，全部数据与回调由 props 注入。
//
// props 分两类：
//   1) 域对象 —— 直接透传对应 hook 的完整返回值（projects / inputDomain / preview /
//      hints / run / ui / condense / messageActions / scroll / git / mic / loop /
//      panels / modals / sessionActions）。这样主组件调用处只有二十余个字段，不必
//      铺开上百个平铺 props；各域内部增删成员时类型自动跟随。
//   2) 散装值 —— 尚未成域、或仅本视图消费的少量项：模型卡片与其派生量、DOM ref
//      （消息末锚点 / 消息行动作 / 输入区 / 任务卡）、输入区键盘处理。
//
// 组件体内把域对象二次解构为局部名，使下方 JSX 与拆分前的写法逐字一致。

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Bug, Database, Copy, Check, ImageDown, FileDown, Wrench } from 'lucide-react'
import html2canvas from 'html2canvas'
import {
  ActivityIcon, BookOpenIcon, BrainIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  EllipsisVerticalIcon, GitBranchIcon, GlobeIcon, LoaderIcon, PencilIcon, QuoteIcon, RouteIcon,
  SendIcon, SlidersHorizontalIcon, SparklesIcon, TerminalIcon, Trash2Icon, UserIcon, CopyIcon, XIcon,
} from '@animateicons/react/lucide'
import { notify } from '../../../store/notificationStore'
import { useStore } from '../../../store/useStore'
import { clearAudit } from '../../../utils/auditLog'
import { clearDebug } from '../../../utils/debugLog'
import { KEEP_RECENT_TURNS } from '../utils/constants'
import { buildSessionPdfHtml } from '../utils/exportSessionPdf'
import { useAgentMessageHeights } from '../hooks/useAgentMessageHeights'
import { useAgentVirtualMessages } from '../hooks/useAgentVirtualMessages'
import { AgentPrefillBar, HistorySummaryBubble, TopbarBtn, UserMessageEntry, AgentMessageRow } from '../agent-message'
import { AuditPanel, DebugPanel, MemoryPanel } from '../agent-panels'
import AgentContextPanel from '../../AgentContextPanel'
import AgentMessageSearch from '../../AgentMessageSearch'
import { AgentTrajectoryPanel } from '../../AgentTrajectoryPanel'
import { AgentSessionSidebar } from '../agent-session/AgentSessionSidebar'
import { AgentInputArea } from '../agent-input/AgentInputArea'
import { AgentPreviewSlot } from '../agent-preview/AgentPreviewSlot'
import type { AgentMsgRowActions } from '../types'
import { PLAIN_CHAT_TOOL_NAMES } from '../../../../../shared/types'
import type { CardState } from '../../../../../shared/types'
import type { useAgentProjects } from '../hooks/useAgentProjects'
import type { useAgentInput } from '../hooks/useAgentInput'
import type { useAgentPreviewTabs } from '../hooks/useAgentPreviewTabs'
import type { useAgentInputHints } from '../hooks/useAgentInputHints'
import type { useAgentRunState } from '../hooks/useAgentRunState'
import type { useAgentUiState } from '../hooks/useAgentUiState'
import type { useAgentCondense } from '../hooks/useAgentCondense'
import type { useAgentMessageActions } from '../hooks/useAgentMessageActions'
import type { useAgentScroll } from '../hooks/useAgentScroll'
import type { useAgentGit } from '../hooks/useAgentGit'
import type { useAgentMic } from '../hooks/useAgentMic'
import type { useAgentLoop } from '../hooks/useAgentLoop'
import type { useAgentPanels } from '../hooks/useAgentPanels'
import type { useAgentModals } from '../hooks/useAgentModals'
import type { useAgentSessionActions } from '../hooks/useAgentSessionActions'

/** 通用模式可启用的工具中文名（与 PLAIN_CHAT_TOOL_NAMES 一一对应） */
const PLAIN_CHAT_TOOL_LABELS: Record<string, string> = {
  get_datetime: '获取时间',
  web_search: '网络搜索',
  fetch_webpage: '网页抓取',
  knowledge_search: '知识库检索',
}

export interface AgentCodeViewLayoutProps {
  /** ── 域对象（各 hook 的完整返回值）── */
  projects: ReturnType<typeof useAgentProjects>
  inputDomain: ReturnType<typeof useAgentInput>
  preview: ReturnType<typeof useAgentPreviewTabs>
  hints: ReturnType<typeof useAgentInputHints>
  run: ReturnType<typeof useAgentRunState>
  ui: ReturnType<typeof useAgentUiState>
  condense: ReturnType<typeof useAgentCondense>
  messageActions: ReturnType<typeof useAgentMessageActions>
  scroll: ReturnType<typeof useAgentScroll>
  git: ReturnType<typeof useAgentGit>
  mic: ReturnType<typeof useAgentMic>
  loop: ReturnType<typeof useAgentLoop>
  panels: ReturnType<typeof useAgentPanels>
  modals: ReturnType<typeof useAgentModals>
  sessionActions: ReturnType<typeof useAgentSessionActions>

  /** ── 散装值：模型卡片与其派生量 ── */
  // cards 直接取自 store；其 CardState 是 useStore 内的私有接口（monitorExpanded 为必填），
  // 与 shared/types 的同名接口在 exactOptionalPropertyTypes 下不可互换，故按 store 的推导类型标注。
  cards: ReturnType<typeof useStore.getState>['cards']
  agentCards: CardState[]
  runningCard: CardState | undefined
  apiBaseUrl: string | null
  modelLabel: string
  handleModelAction: (card: CardState) => Promise<void>
  handleStop: () => void
  /** 正在朗读的消息 id（通用模式用；非该模式恒为 null） */
  speakingId: string | null

  /** ── 散装值：DOM ref ── */
  msgEndRef: React.RefObject<HTMLDivElement | null>
  msgRowActionsRef: React.RefObject<AgentMsgRowActions>
  chatInputAreaRef: React.RefObject<HTMLDivElement | null>
  taskCardRef: React.RefObject<HTMLDivElement | null>

  /** ── 散装值：输入区键盘处理 ── */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
}

export function AgentCodeViewLayout({ view }: { view: AgentCodeViewLayoutProps }) {
  const {
    projects: projectsDomain, inputDomain, preview: previewDomain, hints: hintsDomain,
    run, ui, condense, messageActions, scroll, git, mic, loop, panels, modals, sessionActions,
    cards, agentCards, runningCard, apiBaseUrl, modelLabel, handleModelAction, handleStop,
    speakingId,
    msgEndRef, msgRowActionsRef, chatInputAreaRef, taskCardRef,
    handleKeyDown, handleInputChange,
  } = view

  const {
    projects, activeProject, activeProjectId, activeSession, activeSessionId,
    setActiveProjectId, setActiveSessionId, updateProject, createProject, deleteProject,
    exportSession, importSessionToProject, addSessionToProject, deleteSession,
    projectWrapRefs, toggleProjectExpanded,
  } = projectsDomain
  const {
    insertAtCursor, selectionPopover, selectionPopoverRef, copySelection, quoteSelection,
    handlePreviewMouseDown, handlePreviewMouseUp, handleMessagesMouseUp,
  } = inputDomain
  const {
    htmlAnnotateActive, htmlAnnotations, injectHtmlAnnotate, toggleHtmlAnnotate,
    clearHtmlAnnotations, removeHtmlAnnotation, openFileAtLine,
  } = previewDomain
  const {
    loading, streaming, thinkDone, condenseOpen, setCondenseOpen,
    modelLabelRef, streamStartAtRef, handleStreamRate, streamingSessionRef,
    queueInfo, setQueueInfo, streamKind, curToolName,
    thinkLevelOpen, setThinkLevelOpen, thinkLevelMenuRef, thinkingLevel, setThinkingLevel,
    followUpQueueRef, piReadyRef, prevQueueRef,
  } = run
  const {
    approveWriteEditDraft, auditBtnRef, auditOpen, condenseBtnRef, contextModalOpen,
    cumTokens, debugBtnRef, debugOpen, editDraft, editingMsgId, kbBtnRef, kbCopiedId,
    kbModalOpen, knowledgeBases, memoryBtnRef, memoryDraft, memoryOpen, promptBtnRef,
    promptDraft, promptModalOpen, reqCount, rightPanelMode, setApproveWriteEditDraft,
    setAuditOpen, setContextModalOpen, setDebugOpen, setEditDraft, setEditingMsgId,
    setKbCopiedId, setMemoryDraft, setMemoryOpen, setPromptDraft, setPromptModalOpen,
    setRightPanelMode, setSidebarOpen, setTrajOpen, setTreeOpen, sidebarOpen,
    terminalMounted, trajBtnRef, trajOpen, treeOpen,
    allowBtnRef, approvalReq, autoApproveBtnRef, autoApproveRef, attachBtnRef,
    ctxInlineRef, currentPlanItems, logoMenu, logoMenuRef, modelBtnRef, modelCaps,
    modelLogos, modelPickerOpen, modelPickerRef, modelPickerWidth, pickModelLogo,
    planTitle, rejectBtnRef, removeModelLogo, resolveApproval, searchEnabled,
    searchMenuOpen, searchMenuRef, searchProvider, setModelPickerOpen, setSearchMenuOpen,
    plainChat, setPlainChat,
    chatTools, chatToolsMenuOpen, setChatToolsMenuOpen, chatToolsMenuRef, toggleChatTool,
    setTaskCardClosing, setTaskModalOpen, setTaskPanelCollapsed, taskCardClosing,
    taskDoneCount, taskModalOpen, taskPanelCollapsed, toggleLogoMenu, applySearchChange,
  } = ui
  const { condensing, condenseMsg, setCondenseMsg, handleManualCondense } = condense
  const { copyMessage, editAt, resendAt, branchAt, confirmEdit, deleteMessage } = messageActions
  const {
    activeRailId, atBottom, chatScrollRef, onChatScroll, onChatWheel, pauseFollow,
    railItems, railOverflowing, railScrolling, scrollToBottom, scrollToRailItem,
    historyStartIndex, loadEarlierMessages, registerVirtualApi,
  } = scroll
  const {
    gitChanges, gitLoading, gitFocusPath, onGitFocusHandled, refreshGitChanges,
    onWorkspaceFilesChanged, toggleGitDiff, currentBranch, branches, branchMenuOpen,
    setBranchMenuOpen, branchBtnRef, branchMenuRef, workspaceMenuOpen,
    setWorkspaceMenuOpen, workspaceBtnRef, workspaceMenuRef, checkoutBranch,
  } = git
  const { listening, micTranscribing, toggleListen } = mic
  const { handleSend } = loop
  const {
    sidebarHandleIconRef, previewHandleIconRef, previewPanelHandleIconRef,
  } = panels
  const { resizing: sidebarResizing, startResize: startSidebarResize } = panels.sidebarResize
  const { resizing: previewResizing, startResize: startPreviewResize } = panels.previewResize
  const { resizing: rightResizing, startResize: startRightResize } = panels.rightResize
  const {
    openPromptModal, saveSystemPrompt, openKbModal,
    AGENT_SUGGESTIONS, sendSuggestion, sendAnnotationsToAgent, sendHtmlAnnotations,
  } = modals
  const {
    addCodeSnippet, changeProjectDir, sessRenamingId, setSessRenamingId,
    sessRenameText, setSessRenameText, sessRenameInputRef, projRenamingId,
    setProjRenamingId, projRenameText, setProjRenameText, projRenameInputRef,
    confirmProjRename, startSessRename, confirmSessRename,
  } = sessionActions
  // 通用模式已启用的工具数（网络搜索沿用全局 searchEnabled，与输入区左侧的搜索开关是同一份状态）
  const chatToolOnCount = PLAIN_CHAT_TOOL_NAMES.filter(
    n => (n === 'web_search' ? searchEnabled : chatTools.includes(n))
  ).length
  // ── 消息级屏外卸载 ──
  // 已加载区间（与渲染同源）：虚拟化只在这个区间内做，historyStartIndex 之前的消息本来就不挂载。
  const loadedMessages = useMemo(
    () => activeSession?.messages.slice(historyStartIndex) ?? [],
    [activeSession?.messages, historyStartIndex],
  )
  // 高度持续变化、不参与缓存的那一条：正在流式输出、且属于当前会话的末条助手消息。
  const volatileId = useMemo(() => {
    if (!streaming || streamingSessionRef.current !== activeSession?.id) return null
    const msgs = activeSession?.messages ?? []
    const last = msgs[msgs.length - 1]
    return last && last.role === 'assistant' ? last.id : null
  }, [activeSession, streaming])
  const { heightsRef, version: heightsVersion } = useAgentMessageHeights({
    sessionId: activeSession?.id,
    viewportRef: chatScrollRef,
    messages: loadedMessages,
    volatileId,
  })
  // 必须常驻挂载的原始下标：流式中那条 + 正在编辑那条（窗口滚动时不能被顶掉）。
  const pinnedIndices = useMemo(() => {
    const msgs = activeSession?.messages ?? []
    const out: number[] = []
    if (volatileId) {
      const i = msgs.findIndex(m => m.id === volatileId)
      if (i >= 0) out.push(i)
    }
    if (editingMsgId) {
      const i = msgs.findIndex(m => m.id === editingMsgId)
      if (i >= 0) out.push(i)
    }
    return out
  }, [activeSession?.messages, volatileId, editingMsgId])
  const virtual = useAgentVirtualMessages({
    viewportRef: chatScrollRef,
    messages: loadedMessages,
    startIndex: historyStartIndex,
    heightsRef,
    heightsVersion,
    pinnedIndices,
  })

  // 把虚拟化的「确保挂载」注册给滚动逻辑：点目录点跳向已被屏外卸载的消息时，
  // 由它先把窗口扩到包含该条，等 DOM 就位后再走统一的滚动动画。
  useEffect(() => {
    registerVirtualApi({ ensureMounted: virtual.ensureMounted })
    return () => registerVirtualApi(null)
  }, [registerVirtualApi, virtual.ensureMounted])

  // 导出为图片（仅通用模式）：html2canvas 截取消息区 → PNG 落盘。
  // 注意消息区是虚拟滚动的（屏外消息被卸载、用等高占位顶住），所以导出的是
  // 「当前这一屏」而不是整段对话——按钮 title 里写明，免得以为导出了全部。
  const [exporting, setExporting] = useState(false)
  const handleExportImage = useCallback(async () => {
    const el = chatScrollRef.current
    if (!el || exporting) return
    setExporting(true)
    try {
      const canvas = await html2canvas(el, { useCORS: true, backgroundColor: '#fff' })
      const filePath = await window.api.savePng(canvas.toDataURL('image/png'))
      notify(`PNG 已保存: ${filePath}`, 'success')
    } catch {
      notify('导出图片失败', 'error')
    } finally {
      setExporting(false)
    }
  }, [chatScrollRef, exporting])

  // 导出为 PDF（仅通用模式）：遍历全部消息重排成打印 HTML，主进程隐藏窗口 printToPDF。
  // 与上面的「导出图片」互补——那个只截得到当前一屏，长对话要完整记录得用这个。
  const [pdfExporting, setPdfExporting] = useState(false)
  const handleExportPdf = useCallback(async () => {
    if (!activeSession || pdfExporting) return
    setPdfExporting(true)
    try {
      const filePath = await window.api.printToPDF(await buildSessionPdfHtml(activeSession))
      notify(`PDF 已保存: ${filePath}`, 'success')
    } catch {
      notify('导出 PDF 失败', 'error')
    } finally {
      setPdfExporting(false)
    }
  }, [activeSession, pdfExporting])

  // 消息列表元素缓存（useMemo）：目录高亮 / rail 波浪 / 贴底按钮等纯滚动状态变化
  // 不再重建整棵消息树；仅消息数据、流式状态、编辑态或相关回调变化时重建。
  // 依赖均为稳定引用（useCallback 回调 / ref / store 内消息数组），不会击穿缓存。
  const messageListNode = useMemo(() => {
    if (!activeSession || activeSession.messages.length === 0) return null
    // 只渲染虚拟窗口内的消息；窗口外的消息由等高占位（spacerTop / spacerBottom）顶住高度，
    // 滚动条长度与位置保持不变。data-message-index 仍是会话内原始下标，目录与搜索据此对齐。
    return activeSession.messages.slice(historyStartIndex + virtual.windowStart, historyStartIndex + virtual.windowEnd).map((msg, visibleIndex) => {
      const i = historyStartIndex + virtual.windowStart + visibleIndex
      // 「继续生成」注入的接续指令：必须发给模型，但不作为用户消息显示在界面上（直接跳过渲染）。
      // 下标 i 仍按会话内原始位置计算，目录 / 虚拟窗口 / 搜索对齐不受影响。
      if (msg.continuation) return null
      const isLast = i === activeSession.messages.length - 1
      // 流式状态仅归属于发起它的会话：切会话后不校验归属会误判末条助手消息为流式中。
      const streamingHere = streaming && streamingSessionRef.current === activeSession.id
      const streamingMsg = streamingHere && isLast && msg.role === 'assistant'
      return (
        <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`} data-slot="message" data-from={msg.role} data-message-index={i}>
          {msg.role !== 'user' && (
            <div className="chat-msg-avatar"><Bot size={14} /></div>
          )}
          <div className="chat-msg-body">
            {msg.role === 'user' ? (
              editingMsgId === msg.id ? (
                <div className="chat-msg-edit">
                  {/* 内联回调 ref 每次渲染重新执行：随内容自动撑高（上限由 CSS max-height 封顶） */}
                  <textarea className="agent-msg-edit-area" value={editDraft} ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px' } }} onChange={e => setEditDraft(e.target.value)} autoFocus spellCheck={false} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmEdit(); if (e.key === 'Escape') setEditingMsgId(null) }} />
                  <div className="agent-msg-edit-actions">
                    <span className="agent-msg-edit-hint">Ctrl+Enter 保存 · Esc 取消</span>
                    <button className="btn btn-primary btn-xs" onClick={confirmEdit}>保存</button>
                    <button className="btn btn-ghost btn-xs" onClick={() => setEditingMsgId(null)}>取消</button>
                  </div>
                </div>
              ) : msg.content ? (
                <>
                  <UserMessageEntry content={msg.content} packedText={msg.packedText} attachments={plainChat ? msg.attachments : undefined} />
                  <div className="chat-msg-actions">
                    <button className="chat-msg-action-btn" title="复制" onClick={() => copyMessage(msg.content)}><CopyIcon size={13} /></button>
                    <button className="chat-msg-action-btn" title="编辑" onClick={() => editAt(msg.id)} disabled={loading}><PencilIcon size={13} /></button>
                    <button className="chat-msg-action-btn" title="重新发送" onClick={() => resendAt(msg.id)} disabled={loading}><SendIcon size={13} /></button>
                    <button className="chat-msg-action-btn" title="创建分支" onClick={() => branchAt(msg.id)} disabled={loading}><GitBranchIcon size={13} /></button>
                    {/* 删除消息只在通用模式提供（编码模式的用户消息是工作流的输入，删掉会让上下文断裂） */}
                    {plainChat && (
                      <button className="chat-msg-action-btn" title="删除这条消息" onClick={() => deleteMessage(msg.id)} disabled={loading}><Trash2Icon size={13} /></button>
                    )}
                  </div>
                </>
              ) : null
            ) : (
              <>
                {/* 交错渲染：segments 单容器时间线布局（思考链→工具卡→正文→…）；流式行走实时 content 渲染，
                    finalize 仅变化 streaming prop，DOM 不卸载重挂 → 完成瞬间零跳动。 */}
                {streamingMsg ? (
                  <AgentMessageRow
                    msg={msg}
                    isLast={isLast}
                    loading={loading}
                    actionsRef={msgRowActionsRef}
                    streaming
                    modelLabel={modelLabelRef.current}
                    thinkDone={thinkDone}
                    streamStartAt={streamStartAtRef.current ?? undefined}
                    onRate={handleStreamRate}
                    modelTemplateId={runningCard?.template.id}
                    plainChat={plainChat}
                    speakingId={speakingId}
                  />
                ) : (
                  <AgentMessageRow msg={msg} isLast={isLast} loading={loading} actionsRef={msgRowActionsRef} streaming={streaming} modelLabel={modelLabelRef.current} modelTemplateId={runningCard?.template.id} plainChat={plainChat} speakingId={speakingId} />
                )}
              </>
            )}
          </div>
          {msg.role === 'user' && (
            <div className="chat-msg-avatar"><UserIcon size={14} /></div>
          )}
        </div>
      )
    })
  }, [activeSession, historyStartIndex, virtual.windowStart, virtual.windowEnd, streaming, loading, thinkDone, editingMsgId, editDraft, confirmEdit, copyMessage, editAt, resendAt, branchAt, msgRowActionsRef, modelLabelRef, streamStartAtRef, handleStreamRate, runningCard, setEditDraft, setEditingMsgId])
  return (
    <div className={`agent-code-view ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <div className="agent-code-topbar" onDoubleClick={() => { const anyOpen = sidebarOpen || treeOpen; setSidebarOpen(!anyOpen); setTreeOpen(!anyOpen); setContextModalOpen(false) }}>
        <div className="agent-code-topbar-left">
          <button className="chat-collapse-btn" onClick={() => setSidebarOpen(v => !v)} style={{ marginTop: 0, width: 28, height: 28 }}>
            {sidebarOpen ? <ChevronLeftIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
          <span className="agent-code-topbar-title">{activeSession?.title || '新会话'}</span>
        </div>

        <div className="agent-code-topbar-right">
          {/* Prefill 进度条：复用「模型运行数据」面板的同一数据源（modelMetrics[].prefillProgress），
              自订阅指标，仅在 prefill 进行中（pp < 1）显示，完成后自动消失。 */}
          <div className="agent-code-topbar-right-scroll">
            <AgentPrefillBar />
            {/* 通用模式（plainChat）收掉编码工作台的六个入口：压缩历史 / 审计 / 轨迹 / 调试 / 记忆 / 变更。
                提示词、知识库、浏览器、终端不受影响——通用模式同样用得上。 */}
            {!plainChat && (
              <TopbarBtn
                btnRef={condenseBtnRef}
                active={condenseOpen}
                onClick={() => setCondenseOpen(v => !v)}
                icon={condensing ? LoaderIcon : BrainIcon}
                iconClassName={condensing ? 'spin' : undefined}
              >压缩历史</TopbarBtn>
            )}
            <TopbarBtn btnRef={promptBtnRef} active={promptModalOpen} onClick={openPromptModal} icon={SlidersHorizontalIcon}>提示词</TopbarBtn>
            <TopbarBtn btnRef={kbBtnRef} active={kbModalOpen} onClick={openKbModal} icon={Database} title="知识库列表（智能体可检索全部库）">知识库</TopbarBtn>
            {!plainChat && (
              <TopbarBtn btnRef={auditBtnRef} active={auditOpen} onClick={() => setAuditOpen(v => !v)} icon={ActivityIcon}>审计</TopbarBtn>
            )}
            {!plainChat && (
              <TopbarBtn btnRef={trajBtnRef} active={trajOpen} onClick={() => setTrajOpen(v => !v)} icon={RouteIcon}>轨迹</TopbarBtn>
            )}
            {!plainChat && (
              <TopbarBtn btnRef={debugBtnRef} active={debugOpen} onClick={() => setDebugOpen(v => !v)} icon={Bug}>调试</TopbarBtn>
            )}
            {!plainChat && (
              <TopbarBtn btnRef={memoryBtnRef} active={memoryOpen} onClick={() => setMemoryOpen(v => !v)} icon={BookOpenIcon}>记忆</TopbarBtn>
            )}
            {!plainChat && (
              <TopbarBtn active={rightPanelMode === 'diff'} onClick={toggleGitDiff} icon={GitBranchIcon}>变更</TopbarBtn>
            )}
            <TopbarBtn active={rightPanelMode === 'browser'} onClick={() => { setRightPanelMode(m => m === 'browser' ? 'files' : 'browser'); if (!treeOpen) setTreeOpen(true) }} icon={GlobeIcon}>浏览器</TopbarBtn>
            <TopbarBtn active={rightPanelMode === 'terminal'} onClick={() => { setRightPanelMode(m => m === 'terminal' ? 'files' : 'terminal'); if (!treeOpen) setTreeOpen(true) }} icon={TerminalIcon}>终端</TopbarBtn>
            {/* 导出只在通用模式出现（编码模式的消息带工具卡与文件改动，截图意义不大） */}
            {plainChat && (
              <>
                <TopbarBtn active={false} onClick={handleExportImage} icon={ImageDown} title="把当前可见的对话导出为 PNG（消息区是虚拟滚动的，只截当前这一屏）">导出图片</TopbarBtn>
                <TopbarBtn active={false} onClick={handleExportPdf} icon={FileDown} title="把整段对话导出为 PDF（遍历全部消息，不受虚拟滚动限制）">导出 PDF</TopbarBtn>
              </>
            )}
          </div>
          {/* 通用模式的工具开关（原在输入区，随模式切换一起上移到顶栏）。
              必须放在 -right-scroll 之外：那个容器 overflow-x:auto 会把向下展开的菜单裁掉。 */}
          {plainChat && (
            <div ref={chatToolsMenuRef} className="agent-code-tools-switch">
              <TopbarBtn active={chatToolsMenuOpen} onClick={() => setChatToolsMenuOpen(v => !v)} icon={Wrench} title="通用模式下可启用的工具（默认全关）">
                工具{chatToolOnCount > 0 ? ` ${chatToolOnCount}` : ''}
              </TopbarBtn>
              {chatToolsMenuOpen && (
                <ul className="agent-code-tools-menu">
                  {PLAIN_CHAT_TOOL_NAMES.map(name => {
                    const on = name === 'web_search' ? searchEnabled : chatTools.includes(name)
                    return (
                      <li
                        key={name}
                        className={`agent-code-tools-item${on ? ' active' : ''}`}
                        onClick={() => toggleChatTool(name)}
                      >
                        {on ? <CheckIcon size={12} /> : <XIcon size={12} />}{PLAIN_CHAT_TOOL_LABELS[name] ?? name}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
          <button className="chat-collapse-btn" onClick={() => { setContextModalOpen(false); setTreeOpen(v => !v) }} style={{ marginTop: 0, width: 28, height: 28 }}>
            {treeOpen ? <ChevronRightIcon size={14} /> : <ChevronLeftIcon size={14} />}
          </button>
        </div>
      </div>

      <div className={`agent-code-body ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <div className="agent-code-sidebar-collapser">
        <AgentSessionSidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          setActiveProjectId={setActiveProjectId}
          setActiveSessionId={setActiveSessionId}
          projectWrapRefs={projectWrapRefs}
          createProject={createProject}
          toggleProjectExpanded={toggleProjectExpanded}
          changeProjectDir={changeProjectDir}
          deleteProject={deleteProject}
          importSessionToProject={importSessionToProject}
          addSessionToProject={addSessionToProject}
          exportSession={exportSession}
          deleteSession={deleteSession}
          projRenamingId={projRenamingId}
          setProjRenamingId={setProjRenamingId}
          projRenameText={projRenameText}
          setProjRenameText={setProjRenameText}
          projRenameInputRef={projRenameInputRef}
          confirmProjRename={confirmProjRename}
          sessRenamingId={sessRenamingId}
          setSessRenamingId={setSessRenamingId}
          sessRenameText={sessRenameText}
          setSessRenameText={setSessRenameText}
          sessRenameInputRef={sessRenameInputRef}
          startSessRename={startSessRename}
          confirmSessRename={confirmSessRename}
          plainChat={plainChat}
          setPlainChat={setPlainChat}
        />
        </div>
        <div className={`agent-code-sidebar-resize-handle${sidebarResizing ? ' agent-code-resize-handle--active' : ''}`} onPointerDown={startSidebarResize} onMouseEnter={() => sidebarHandleIconRef.current?.startAnimation()} onMouseLeave={() => sidebarHandleIconRef.current?.stopAnimation()}>
          <EllipsisVerticalIcon ref={sidebarHandleIconRef} size={16} className="nav-animate-icon agent-resize-handle-icon" />
        </div>

        <div className="agent-code-chat">
          <div className="chat-messages" ref={chatScrollRef} onScroll={onChatScroll} onWheel={onChatWheel} onTouchMove={pauseFollow} onMouseUp={handleMessagesMouseUp}>
            {condensing && (
              <div className="agent-condensing"><LoaderIcon size={13} className="spin" /> 正在压缩历史…</div>
            )}
            {activeSession?.memory?.summary && (
              <HistorySummaryBubble summary={activeSession.memory.summary} count={activeSession.memory.coveredMsgIds.length} />
            )}
            {historyStartIndex > 0 && (
              <div style={{ padding: '8px 16px', textAlign: 'center' }}>
                <button type="button" className="btn btn-ghost btn-xs" onClick={loadEarlierMessages}>
                  加载更早消息（还有 {historyStartIndex} 条）
                </button>
                <div className="text-muted">目录和搜索仅包含已加载消息</div>
              </div>
            )}
            {!activeSession || activeSession.messages.length === 0 ? (
              <div className="agent-welcome">
                <div className="agent-welcome-title">
                  <SparklesIcon size={20} className="agent-welcome-icon" />
                  一个LLM本地智能体
                </div>
                <div className="agent-welcome-desc">描述任务，或随便问点什么。</div>
                <div className="agent-welcome-hint">
                  <span className="agent-welcome-chip"><span className="agent-welcome-key">⏎</span> 发送</span>
                  <span className="agent-welcome-chip"><span className="agent-welcome-key">@</span> 文件</span>
                </div>
                <div className="agent-welcome-suggestions">
                  {AGENT_SUGGESTIONS.map((s) => (
                    <button key={s.text} className="agent-suggestion" onClick={() => sendSuggestion(s.text)}>
                      <span className="agent-suggestion-icon">{s.icon}</span>
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {virtual.spacerTop > 0 && <div data-slot="message-spacer" aria-hidden="true" style={{ height: virtual.spacerTop }} />}
                {messageListNode}
                {virtual.spacerBottom > 0 && <div data-slot="message-spacer" aria-hidden="true" style={{ height: virtual.spacerBottom }} />}
              </>
            )}
            <div ref={msgEndRef} />
          </div>
          <div className={`agent-chat-rail${railOverflowing && railItems.length > 1 ? ' agent-chat-rail--visible' : ''}${railScrolling ? ' agent-chat-rail--scrolling' : ''}`}>
            {(() => {
              const activeIndex = railItems.findIndex(it => it.id === activeRailId)
              return railItems.map((item, index) => {
                const distance = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0
                // 滚动期间不写波次延迟：此时过渡已被 --scrolling 类禁用，延迟无意义，
                // 且能避免每个点的内联 style 随 activeIndex 每次变化而重建。
                const delay = railScrolling ? 0 : distance * 20
                return (
                  <button
                    key={item.id}
                    className={`agent-chat-rail-item${activeRailId === item.id ? ' agent-chat-rail-item--active' : ''}`}
                    onClick={() => scrollToRailItem(item)}
                    aria-label={item.ariaLabel}
                    type="button"
                    style={railScrolling ? undefined : ({ '--rail-wave-delay': `${delay}ms` } as React.CSSProperties)}
                  >
                    <span className="agent-chat-rail-dot" />
                    <span className="agent-chat-rail-preview">
                      <span className="agent-chat-rail-preview-label">{item.label}</span>
                      {item.description && <span className="agent-chat-rail-preview-desc">{item.description}</span>}
                    </span>
                  </button>
                )
              })
            })()}
          </div>
          {/* 选中模型输出文字后的浮动操作条（引用 / 复制，均不默认选中）。
              onMouseDown 阻止默认行为，避免点击按钮时清除当前选区。 */}
          {selectionPopover && (
            <div
              ref={selectionPopoverRef}
              className="agent-sel-popover"
              style={{ left: selectionPopover.x, top: selectionPopover.y }}
              onMouseDown={e => e.preventDefault()}
            >
              <button className="agent-sel-btn" onClick={() => quoteSelection(selectionPopover.text)}>
                <QuoteIcon size={13} /> 引用
              </button>
              <button className="agent-sel-btn" onClick={() => copySelection(selectionPopover.text)}>
                <CopyIcon size={13} /> 复制
              </button>
            </div>
          )}
          {/* 上下文卡片（浮动在聊天区右上角） */}
          {contextModalOpen && (
            <div className="agent-task-card agent-card-ctx">
              <div className="agent-task-card-header">
                <span>上下文窗口</span>
              </div>
              <div className="agent-task-card-body">
                <AgentContextPanel
                  templateId={runningCard?.template.id ?? null}
                  startedAt={runningCard?.startedAt}
                  requests={reqCount}
                  cumTokens={cumTokens}
                  session={activeSession}
                  project={activeProject}
                />
              </div>
            </div>
          )}
          {/* 压缩历史卡片（浮动在聊天区右上角）*/}
          {condenseOpen && (
            <div className="agent-task-card agent-card-condense">
              <div className="agent-task-card-header">
                <span>压缩会话历史</span>
              </div>
              <div className="agent-task-card-body agent-card-condense-body">
                <p className="agent-condense-hint">把较早的对话轮次交给本地模型压缩为摘要，节省上下文（最近 {KEEP_RECENT_TURNS} 轮始终逐字保留）。</p>
                <div className="agent-condense-status">
                  {activeSession?.memory?.summary
                    ? `当前已压缩 ${activeSession.memory.coveredMsgIds.length} 条早期消息。`
                    : '当前会话尚无压缩摘要。'}
                </div>
                {activeSession?.memory?.summary && (
                  <pre className="agent-condense-preview">{activeSession.memory.summary}</pre>
                )}
                {condenseMsg && <div className="agent-condense-result">{condenseMsg}</div>}
                <div className="agent-condense-actions">
                  <button
                    className="agent-prompt-btn agent-prompt-btn-primary agent-condense-run"
                    onClick={handleManualCondense}
                    disabled={loading || condensing || !runningCard}
                  >
                    {condensing ? <><LoaderIcon size={12} className="spin" /> 正在压缩…</> : '立即压缩历史'}
                  </button>
                  {activeSession?.memory?.summary && (
                    <button
                      className="agent-prompt-btn agent-prompt-btn-ghost"
                      onClick={() => {
                        const prev = activeProject.memory?.notes || ''
                        const stamp = new Date().toLocaleString('zh-CN')
                        const appended = (prev ? prev + '\n\n' : '') + `【来自会话「${activeSession!.title}」· ${stamp}】\n` + activeSession!.memory!.summary
                        updateProject(activeProjectId, { memory: { notes: appended, updatedAt: Date.now() } })
                        setCondenseMsg('✅ 已将本会话摘要追加到项目记忆。')
                        notify('已追加到项目记忆', 'success')
                      }}
                    >
                      追加到项目记忆
                    </button>
                  )}
                </div>
                {!runningCard && <div className="agent-condense-note">需先启动模型才能压缩。</div>}
              </div>
            </div>
          )}
          {/* 操作审计卡片（浮动在聊天区右上角）*/}
          {auditOpen && (
            <div className="agent-task-card agent-card-audit">
              <div className="agent-task-card-header">
                <span>操作审计日志</span>
                <button className="agent-audit-clear" onClick={() => clearAudit()}><Trash2Icon size={12} /> 清空</button>
              </div>
              <div className="agent-task-card-body agent-card-audit-body">
                <AuditPanel />
              </div>
            </div>
          )}
          {/* 轨迹台账卡片（浮动在聊天区右上角）：pi 会话事件流落盘的只读视图 */}
          {trajOpen && (
            <div className="agent-task-card agent-card-traj">
              <div className="agent-task-card-header">
                <span>轨迹台账 · {activeSessionId ? `pi-${activeSessionId}` : '无会话'}</span>
              </div>
              <div className="agent-task-card-body agent-card-traj-body">
                <AgentTrajectoryPanel piSessionId={activeSessionId ? `pi-${activeSessionId}` : null} />
              </div>
            </div>
          )}
          {/* 调试卡片（浮动在聊天区右上角）*/}
          {debugOpen && (
            <div className="agent-task-card agent-card-debug">
              <div className="agent-task-card-header">
                <span>调试（逐轮）· 跨会话·最新在前</span>
                <button className="agent-audit-clear" onClick={() => clearDebug()}><Trash2Icon size={12} /> 清空</button>
              </div>
              <div className="agent-task-card-body agent-card-debug-body">
                <DebugPanel />
              </div>
            </div>
          )}
          {/* 长期记忆卡片（浮动在聊天区右上角）：查看 / 归档智能体自动沉淀的跨会话记忆 */}
          {memoryOpen && (
            <div className="agent-task-card agent-card-memstore">
              <div className="agent-task-card-header">
                <span>长期记忆 · {activeProject.title}</span>
              </div>
              <div className="agent-task-card-body agent-card-memstore-body">
                <MemoryPanel dir={activeProject.workspaceDir} />
              </div>
            </div>
          )}
          {/* 提示词卡片（浮动在聊天区右上角） */}
          {promptModalOpen && (
            <div className="agent-task-card agent-card-prompt">
              <div className="agent-task-card-header">
                <span>系统提示词 · {activeProject.title}</span>
              </div>
              <div className="agent-task-card-body agent-card-prompt-body">
                <p className="agent-prompt-hint">为该项目的智能体追加自定义指令（如「只用中文回复」「优先最小改动」）。留空则使用默认工具指引。</p>
                <textarea className="agent-prompt-textarea" value={promptDraft} onChange={e => setPromptDraft(e.target.value)} placeholder="例如：你只允许使用中文；修改文件时优先给出最小改动；不要随意运行删除命令。" />
                <div className="agent-prompt-memory-label">项目记忆（跨会话）</div>
                <p className="agent-prompt-hint">此处记录希望在本项目所有会话中长期携带的结论/约定（可从「压缩历史」弹层一键追加会话摘要）。留空则不注入。</p>
                <textarea className="agent-prompt-textarea" value={memoryDraft} onChange={e => setMemoryDraft(e.target.value)} placeholder="例如：本项目后端入口为 src/main/index.ts；构建用 npm run build；已确定不使用 xxx 方案。" />
                <label className="agent-prompt-check">
                  <input type="checkbox" className="agent-prompt-checkbox" checked={approveWriteEditDraft} onChange={e => setApproveWriteEditDraft(e.target.checked)} />
                  对写入 / 编辑（Write / Edit）也要求人工确认
                </label>
              </div>
              <div className="agent-card-prompt-footer">
                <button className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => { setPromptDraft(''); setApproveWriteEditDraft(false) }}>重置默认</button>
                <button className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => setPromptModalOpen(false)}>取消</button>
                <button className="agent-prompt-btn agent-prompt-btn-primary" onClick={saveSystemPrompt}>保存</button>
              </div>
            </div>
          )}
          {/* 知识库卡片（独立按钮；只读展示全部知识库，无绑定/选择操作） */}
          {kbModalOpen && (
            <div className="agent-task-card agent-card-prompt agent-card-kb">
              <div className="agent-task-card-header">
                <span>知识库 · {knowledgeBases.length} 个</span>
              </div>
              <div className="agent-task-card-body agent-card-prompt-body">
                <p className="agent-prompt-hint">智能体自带 knowledge_search / knowledge_read 两阶段检索工具，可访问下列所有知识库；模型会按库名指定检索目标，无需在此选择。</p>
                {knowledgeBases.length === 0 ? (
                  <p className="agent-prompt-hint">尚未创建知识库——可在左侧「知识库」页面新建并导入文档。</p>
                ) : (
                  <ul className="agent-kb-list">
                    {knowledgeBases.map(kb => (
                      <li key={kb.id} className="agent-kb-item" title={kb.name}>
                        <Database size={13} />
                        <span className="agent-kb-item-name">{kb.name}</span>
                        <span className="agent-kb-item-count">{kb.docCount} 文档</span>
                        <button
                          className="agent-kb-copy"
                          title="复制库名"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigator.clipboard.writeText(kb.name)
                            setKbCopiedId(kb.id)
                            window.setTimeout(() => setKbCopiedId(null), 1200)
                          }}
                        >{kbCopiedId === kb.id ? <Check size={12} /> : <Copy size={12} />}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {/* 会话内消息搜索（Ctrl/Cmd+F 唤出，浮在对话区右上）。
              传完整 messages：索引要与消息节点的 data-message-index 对齐（该属性是会话内原始下标，
              不是已加载区间的相对下标），这样屏外未加载的消息也能被搜到。*/}
          <AgentMessageSearch key={activeSession?.id} containerRef={chatScrollRef} messages={activeSession?.messages ?? []} onEnsureMessage={virtual.ensureMounted} />
          {/* 滚动到底部浮动按钮：仅当消息列表较长且用户已向上滚动（非贴底）时显示。
              置于 .agent-code-chat（非滚动容器）内，用 --chat-input-h 变量精确浮在输入框上方。 */}
          {!atBottom && (
            <button className="agent-code-scroll-bottom-btn" onClick={() => scrollToBottom(true, true)} >
              <ChevronDownIcon size={18} />
            </button>
          )}
          <AgentInputArea
            inputDomain={inputDomain}
            hintsDomain={hintsDomain}
            mic={{
              listening, micTranscribing, toggleListen,
            }}
            models={{
              agentCards, modelBtnRef, modelCaps, modelLabel, modelLogos,
              modelPickerOpen, modelPickerRef, modelPickerWidth, handleModelAction,
              logoMenu, logoMenuRef, toggleLogoMenu, pickModelLogo, removeModelLogo,
              setModelPickerOpen, thinkLevelMenuRef, thinkLevelOpen,
              setThinkLevelOpen, thinkingLevel, setThinkingLevel,
            }}
            search={{
              searchEnabled, searchProvider, searchMenuOpen, searchMenuRef,
              setSearchMenuOpen, applySearchChange,
            }}
            chatMode={{
              plainChat,
            }}
            run={{
              apiBaseUrl, curToolName, followUpQueueRef, handleSend, handleStop,
              loading, piReadyRef, prevQueueRef, queueInfo, setQueueInfo,
              runningCard, streamKind, streaming, thinkDone,
            }}
            task={{
              currentPlanItems, planTitle, setTaskCardClosing, setTaskModalOpen,
              setTaskPanelCollapsed, taskCardClosing, taskCardRef, taskDoneCount,
              taskModalOpen, taskPanelCollapsed,
            }}
            approval={{
              allowBtnRef, approvalReq, autoApproveBtnRef, autoApproveRef,
              rejectBtnRef, resolveApproval,
            }}
            shell={{
              activeProject, activeProjectId, activeSessionId, attachBtnRef,
              branchBtnRef, branchMenuOpen, branchMenuRef, branches, cards,
              chatInputAreaRef, checkoutBranch, contextModalOpen, ctxInlineRef,
              currentBranch, projects, scrollToBottom, setActiveProjectId,
              setActiveSessionId, setBranchMenuOpen, setContextModalOpen,
              setWorkspaceMenuOpen, workspaceBtnRef, workspaceMenuOpen,
              workspaceMenuRef,
            }}
            handleKeyDown={handleKeyDown}
            handleInputChange={handleInputChange}
          />
        </div>

        {/* 手柄与面板同包在槽内：手柄 absolute 以槽为包含块、left:0 锚定面板真实左缘，
              不再从 body 右缘用 --agent-right-width 镜像推算（变量与面板实际宽度脱节时会脱锚漂移） */}
        <AgentPreviewSlot
          preview={previewDomain}
          activeProject={activeProject}
          rightPanelMode={rightPanelMode}
          treeOpen={treeOpen}
          rightResizing={rightResizing}
          previewResizing={previewResizing}
          startRightResize={startRightResize}
          startPreviewResize={startPreviewResize}
          previewHandleIconRef={previewHandleIconRef}
          previewPanelHandleIconRef={previewPanelHandleIconRef}
          terminalMounted={terminalMounted}
          handlePreviewMouseDown={handlePreviewMouseDown}
          handlePreviewMouseUp={handlePreviewMouseUp}
          openFileAtLine={openFileAtLine}
          addCodeSnippet={addCodeSnippet}
          insertAtCursor={insertAtCursor}
          htmlAnnotateActive={htmlAnnotateActive}
          htmlAnnotations={htmlAnnotations}
          injectHtmlAnnotate={injectHtmlAnnotate}
          toggleHtmlAnnotate={toggleHtmlAnnotate}
          clearHtmlAnnotations={clearHtmlAnnotations}
          removeHtmlAnnotation={removeHtmlAnnotation}
          sendHtmlAnnotations={sendHtmlAnnotations}
          sendAnnotationsToAgent={sendAnnotationsToAgent}
          gitChanges={gitChanges}
          gitLoading={gitLoading}
          gitFocusPath={gitFocusPath}
          onGitFocusHandled={onGitFocusHandled}
          refreshGitChanges={refreshGitChanges}
          onWorkspaceFilesChanged={onWorkspaceFilesChanged}
        />
      </div>
    </div>
  )

}
