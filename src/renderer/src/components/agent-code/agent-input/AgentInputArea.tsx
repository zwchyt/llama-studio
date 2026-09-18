// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentInputArea —— 聊天输入区（浮层 + 输入行 + 工具栏）                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 从 AgentCodeView.tsx 的 JSX 中原样搬出（结构与注释未改），仅把原来靠闭包读取的
// 状态与回调改为显式 props。DOM 结构完全一致——没有新增包裹元素。
//
// 本组件是「受控视图」：全部状态仍由上层（AgentCodeView 及其各域 hook）持有，
// 组件只负责渲染与派发回调。props 按功能域分组，避免在调用处铺开 110 余个平铺项：
//   input    整个输入域（useAgentInput 的返回值：输入核心 / 附件 / 引用胶囊 / 选区浮层）
//   hints    输入补全浮层域（useAgentInputHints 的返回值：@ 提及 / 斜杠命令）
//   mic      语音输入（useAgentMic）
//   models   模型选择器 + 思考等级 + 模型 logo 菜单
//   search   网络搜索开关菜单
//   run      发送 / 停止 / 流式状态 / 排队信息
//   task     待办卡片内联面板
//   approval 破坏性工具审批内联面板
//   shell    项目·分支·工作区·上下文弹窗等外壳入口
//
// 注：组内成员类型尽量用 ReturnType<typeof 对应 hook> 表达，hook 增删成员时
// 类型会自动跟随，不需要同步改这里。

import React from 'react'
import { AlertCircle, AlignLeft, Brain, Eye, Globe, Image as ImageIcon, MessageSquare, Search, SearchX, Wrench } from 'lucide-react'
import { CheckIcon, ChevronDownIcon, CircleStopIcon, CodeIcon, FileTextIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, MicIcon, PlayIcon, PlusIcon, QuoteIcon, RefreshCwIcon, SendIcon, TrashIcon, XIcon } from '@animateicons/react/lucide'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import AgentFilePicker from '../../AgentFilePicker'
import AskUserQuestionInline from '../../AskUserQuestionInline'
import { AgentTopBarCtx, AniIconButton } from '../agent-message'
import { TaskArrowIcon, TaskCheckIcon, TaskDashedIcon, TaskFilledCheckIcon, TaskPieIcon, TaskRollingCount, TaskXIcon } from '../agent-task'
import { TOOL_META, formatToolArgs } from '../agent-tools'
import { TOOL_METAS } from '../../../utils/tools'
import { THINKING_LEVELS, PLAIN_CHAT_TOOL_NAMES } from '../../../../../shared/types'
import type { Attachment, CardState, ThinkingLevel, TodoUpdate } from '../../../../../shared/types'
import { useStore } from '../../../store/useStore'
import type { useAgentGit } from '../hooks/useAgentGit'
import type { useAgentInput } from '../hooks/useAgentInput'
import type { useAgentInputHints } from '../hooks/useAgentInputHints'
import type { useAgentProjects } from '../hooks/useAgentProjects'
import type { useAgentScroll } from '../hooks/useAgentScroll'

/** 纯聊天工具的中文名（与 PLAIN_CHAT_TOOL_NAMES 一一对应） */
const PLAIN_CHAT_TOOL_LABELS: Record<string, string> = {
  get_datetime: '获取时间',
  web_search: '网络搜索',
  fetch_webpage: '网页抓取',
  knowledge_search: '知识库检索',
}

export type AgentInputAreaProps = {

  /** 整个输入域（useAgentInput 返回值） */
  inputDomain: ReturnType<typeof useAgentInput>
  /** 输入补全浮层域（useAgentInputHints 返回值） */
  hintsDomain: ReturnType<typeof useAgentInputHints>
  mic: {
    listening: boolean
    micTranscribing: boolean
    toggleListen: () => void
  }
  models: {
    agentCards: CardState[]
    modelBtnRef: React.RefObject<HTMLButtonElement | null>
    modelCaps: ReturnType<typeof useStore.getState>['modelCapabilities']
    modelLabel: string
    modelLogos: ReturnType<typeof useStore.getState>['modelLogos']
    modelPickerOpen: boolean
    modelPickerRef: React.RefObject<HTMLDivElement | null>
    modelPickerWidth: number
    handleModelAction: (card: CardState) => Promise<void>
    logoMenu: { id: string; x: number; y: number } | null
    logoMenuRef: React.RefObject<HTMLDivElement | null>
    toggleLogoMenu: (e: React.MouseEvent, card: CardState) => void
    pickModelLogo: (card: CardState) => Promise<void>
    removeModelLogo: (card: CardState) => Promise<void>
    setModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>
    thinkLevelMenuRef: React.RefObject<HTMLDivElement | null>
    thinkLevelOpen: boolean
    setThinkLevelOpen: React.Dispatch<React.SetStateAction<boolean>>
    thinkingLevel: ThinkingLevel
    setThinkingLevel: React.Dispatch<React.SetStateAction<ThinkingLevel>>
  }
  search: {
    searchEnabled: ReturnType<typeof useStore.getState>['searchEnabled']
    searchProvider: ReturnType<typeof useStore.getState>['searchProvider']
    searchMenuOpen: boolean
    searchMenuRef: React.RefObject<HTMLDivElement | null>
    setSearchMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
    applySearchChange: (enabled: boolean, provider: 'ddg' | 'bing') => void
  }
  chatMode: {
    /** 当前会话是否处于纯聊天模式（AgentSession.plainChat） */
    plainChat: boolean
    togglePlainChat: () => void
    /** 纯聊天模式下启用的工具名（只含原生聊天那四个） */
    chatTools: string[]
    chatToolsMenuOpen: boolean
    setChatToolsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
    chatToolsMenuRef: React.RefObject<HTMLDivElement | null>
    toggleChatTool: (name: string) => void
  }
  run: {
    apiBaseUrl: string | null
    curToolName: string
    followUpQueueRef: React.RefObject<{ text: string; attachments: Attachment[]; packedText?: string }[]>
    handleSend: (overrideText?: string, overrideAttachments?: Attachment[], packedHint?: string) => Promise<void>
    handleStop: () => void
    loading: boolean
    piReadyRef: React.RefObject<{ sid: string | null; ready: boolean }>
    prevQueueRef: React.RefObject<{ followUp: string[] }>
    queueInfo: { followUp: string[] }
    setQueueInfo: React.Dispatch<React.SetStateAction<{ followUp: string[] }>>
    runningCard: CardState | undefined
    streamKind: 'think' | 'text' | 'tools' | 'idle'
    streaming: boolean
    thinkDone: boolean
  }
  task: {
    currentPlanItems: TodoUpdate[]
    planTitle: string
    setTaskCardClosing: React.Dispatch<React.SetStateAction<boolean>>
    setTaskModalOpen: React.Dispatch<React.SetStateAction<boolean>>
    setTaskPanelCollapsed: React.Dispatch<React.SetStateAction<boolean>>
    taskCardClosing: boolean
    taskCardRef: React.RefObject<HTMLDivElement | null>
    taskDoneCount: number
    taskModalOpen: boolean
    taskPanelCollapsed: boolean
  }
  approval: {
    allowBtnRef: React.RefObject<HTMLButtonElement | null>
    approvalReq: { id: string; name: string; args: string } | null
    autoApproveBtnRef: React.RefObject<HTMLButtonElement | null>
    autoApproveRef: React.RefObject<boolean>
    rejectBtnRef: React.RefObject<HTMLButtonElement | null>
    resolveApproval: (approved: boolean) => void
  }
  shell: {
    activeProject: ReturnType<typeof useAgentProjects>['activeProject']
    activeProjectId: ReturnType<typeof useAgentProjects>['activeProjectId']
    activeSessionId: ReturnType<typeof useAgentProjects>['activeSessionId']
    attachBtnRef: React.RefObject<HTMLButtonElement | null>
    branchBtnRef: ReturnType<typeof useAgentGit>['branchBtnRef']
    branchMenuOpen: ReturnType<typeof useAgentGit>['branchMenuOpen']
    branchMenuRef: ReturnType<typeof useAgentGit>['branchMenuRef']
    branches: ReturnType<typeof useAgentGit>['branches']
    cards: ReturnType<typeof useStore.getState>['cards']
    chatInputAreaRef: React.RefObject<HTMLDivElement | null>
    checkoutBranch: ReturnType<typeof useAgentGit>['checkoutBranch']
    contextModalOpen: boolean
    ctxInlineRef: React.RefObject<HTMLButtonElement | null>
    currentBranch: ReturnType<typeof useAgentGit>['currentBranch']
    projects: ReturnType<typeof useAgentProjects>['projects']
    scrollToBottom: ReturnType<typeof useAgentScroll>['scrollToBottom']
    setActiveProjectId: ReturnType<typeof useAgentProjects>['setActiveProjectId']
    setActiveSessionId: ReturnType<typeof useAgentProjects>['setActiveSessionId']
    setBranchMenuOpen: ReturnType<typeof useAgentGit>['setBranchMenuOpen']
    setContextModalOpen: React.Dispatch<React.SetStateAction<boolean>>
    setWorkspaceMenuOpen: ReturnType<typeof useAgentGit>['setWorkspaceMenuOpen']
    workspaceBtnRef: ReturnType<typeof useAgentGit>['workspaceBtnRef']
    workspaceMenuOpen: ReturnType<typeof useAgentGit>['workspaceMenuOpen']
    workspaceMenuRef: ReturnType<typeof useAgentGit>['workspaceMenuRef']
  }
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
}


export function AgentInputArea({
  inputDomain, hintsDomain, mic, models, search, chatMode, run, task, approval, shell, handleKeyDown, handleInputChange,
}: AgentInputAreaProps) {
  // ── 域解构：把分组 props 摊平回局部名字，组件体内沿用原 JSX 的标识符 ──

  const {
    input, textareaRef, packedInput, setPackedInput, fileInputRef,
    attachedFiles, setAttachedFiles, filePickerAttached,
    setFilePickerAttached, filePickerOpen, setFilePickerOpen,
    handleAttachmentSelect, removeAttachment, handleFilePickerAttach,
    handleInputDragOver, handleInputDrop, handleBrowseSystemFiles,
    handleFilePickerRemove, toggleFilePicker, refChips, codeSnippets,
    removeRefChip, removeCodeSnippet,
  } = inputDomain
  const {
    atQuery, atFiles, atPopRef, slashQuery, slashList, slashIdx,
    setSlashIdx, slashPopRef, onPickAtFile, onPickSlash,
  } = hintsDomain
  const { listening, micTranscribing, toggleListen } = mic
  const { agentCards, modelBtnRef, modelCaps, modelLabel, modelLogos, modelPickerOpen, modelPickerRef, modelPickerWidth, handleModelAction, logoMenu, logoMenuRef, toggleLogoMenu, pickModelLogo, removeModelLogo, setModelPickerOpen, thinkLevelMenuRef, thinkLevelOpen, setThinkLevelOpen, thinkingLevel, setThinkingLevel } = models
  const { searchEnabled, searchProvider, searchMenuOpen, searchMenuRef, setSearchMenuOpen, applySearchChange } = search
  const { plainChat, togglePlainChat, chatTools, chatToolsMenuOpen, setChatToolsMenuOpen, chatToolsMenuRef, toggleChatTool } = chatMode
  // 已启用的纯聊天工具数（网络搜索沿用全局 searchEnabled，与左侧搜索开关同一份状态）
  const chatToolOnCount = PLAIN_CHAT_TOOL_NAMES.filter(
    n => (n === 'web_search' ? searchEnabled : chatTools.includes(n))
  ).length
  const { apiBaseUrl, curToolName, followUpQueueRef, handleSend, handleStop, loading, piReadyRef, prevQueueRef, queueInfo, setQueueInfo, runningCard, streamKind, streaming, thinkDone } = run
  const { currentPlanItems, planTitle, setTaskCardClosing, setTaskModalOpen, setTaskPanelCollapsed, taskCardClosing, taskCardRef, taskDoneCount, taskModalOpen, taskPanelCollapsed } = task
  const { allowBtnRef, approvalReq, autoApproveBtnRef, autoApproveRef, rejectBtnRef, resolveApproval } = approval
  const { activeProject, activeProjectId, activeSessionId, attachBtnRef, branchBtnRef, branchMenuOpen, branchMenuRef, branches, cards, chatInputAreaRef, checkoutBranch, contextModalOpen, ctxInlineRef, currentBranch, projects, scrollToBottom, setActiveProjectId, setActiveSessionId, setBranchMenuOpen, setContextModalOpen, setWorkspaceMenuOpen, workspaceBtnRef, workspaceMenuOpen, workspaceMenuRef } = shell
  return (
    <div className="chat-input-area" ref={chatInputAreaRef}>
      {/* 破坏性工具审批面板：内联显示在输入框内（与提问工具 AskUserQuestionInline 同款位置/风格），不弹窗 */}
      {approvalReq && (
        <div className="agent-approve-inline">
          <div className="agent-approve-inline-head">
            <AlertCircle size={15} className="agent-ask-question-icon" />
            <span className="agent-ask-question-title">需要确认：{TOOL_META[approvalReq.name]?.name || approvalReq.name}</span>
          </div>
          <div className="agent-approve-inline-body">
            <div className="agent-approve-hint">该操作具有破坏性，执行前需你确认</div>
            <div className="agent-approve-detail-row"><span>工具</span><code>{approvalReq.name}</code></div>
            <div className="agent-approve-detail-row">
              <span>参数</span>
              <pre className="agent-approve-args">{formatToolArgs(approvalReq.args) || '(无)'}</pre>
            </div>
          </div>
          <div className="agent-approve-inline-footer">
            <button ref={rejectBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => resolveApproval(false)}>拒绝</button>
            <button ref={autoApproveBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => { autoApproveRef.current = true; resolveApproval(true) }}>本次全部允许</button>
            <button ref={allowBtnRef} className="agent-prompt-btn agent-prompt-btn-primary" onClick={() => resolveApproval(true)}>允许</button>
          </div>
        </div>
      )}
      {taskModalOpen && (
        <div
          ref={taskCardRef}
          className={`agent-task-card agent-task-card-inline${taskPanelCollapsed ? ' collapsed' : ''}${taskCardClosing ? ' closing' : ''}`}
          onTransitionEnd={(e) => {
            // 仅当收起动画结束（max-height 过渡完成）且确实处于关闭过渡态时，才真正卸载卡片
            if (e.propertyName === 'max-height' && taskCardClosing) {
              setTaskModalOpen(false)
              setTaskPanelCollapsed(false)
              setTaskCardClosing(false)
            }
          }}
        >
          <div className="agent-task-card-head">
            <span className="agent-task-card-head-icon">
              {currentPlanItems.length > 0 && taskDoneCount === currentPlanItems.length ? (
                <TaskFilledCheckIcon />
              ) : currentPlanItems.length > 0 ? (
                <TaskPieIcon pct={Math.round((taskDoneCount / currentPlanItems.length) * 100)} />
              ) : (
                <TaskDashedIcon on />
              )}
            </span>
            <span className="agent-task-card-title">待办</span>
            <span className="agent-task-card-count"><TaskRollingCount value={`${taskDoneCount}/${currentPlanItems.length}`} /></span>
            <div className="agent-task-card-head-actions">
              <button className="agent-task-card-head-btn" onClick={() => {
                setTaskPanelCollapsed(p => !p)
                // 用户主动展开/收起：双 rAF 等布局稳定（含 --task-card-h 写入）后滚到底，
                // 让消息区底部贴合卡片上边框。展开方向 scrollHeight 增大，必须无条件滚，
                // 不能依赖 atBottom 判断（否则会被误判为离底而不顶上去）。
                requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
              }}>{taskPanelCollapsed ? '展开' : '收起'}</button>
              <button className="agent-task-card-head-btn" onClick={() => {
                setTaskCardClosing(true)
                // 关闭动画期间高度持续收缩，双 rAF 触发一次滚到底，后续由 RO 实时跟降
                requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
              }}>关闭</button>
            </div>
          </div>
          {!taskPanelCollapsed && (
            planTitle && (
              <div className="agent-task-card-plan-title">{planTitle}</div>
            )
          )}
          {!taskPanelCollapsed && (
            <div className="agent-task-card-body">
              {currentPlanItems.length === 0 ? (
                <div className="agent-task-card-empty">暂无计划</div>
              ) : (
                currentPlanItems.map((item, i) => {
                  // 修复③：显式覆盖全部状态枚举，避免 cancelled 被 fallback 成「待完成」
                  const raw = item.status || 'pending'
                  const isDone = raw === 'completed'
                  const isActive = raw === 'in_progress'
                  const isCancelled = raw === 'cancelled'
                  // 仿 Reasonix：每条只显示一行。进行中且有备注(notes)时，备注作为 activeForm 显示；
                  // 否则显示 content。notes 不再作为独立第二行渲染。
                  const text = raw === 'in_progress' && item.notes
                    ? item.notes
                    : (item.content || item.description || '')
                  // 修复④：用稳定 id 作为 key（无 id 时回退下标），减少 merge 导致顺序变化时 DOM 复用错乱
                  return (
                    <div
                      key={item.id ?? i}
                      className={`agent-task-card-item${isDone ? ' done' : ''}${isActive ? ' active' : ''}`}
                      style={{ ['--i' as string]: i }}
                    >
                      <span className="agent-task-iconwrap">
                        <TaskDashedIcon on={!isDone && !isActive && !isCancelled} />
                        <TaskArrowIcon on={isActive} />
                        <TaskCheckIcon on={isDone} />
                        <TaskXIcon on={isCancelled} />
                      </span>
                      <div className="agent-task-card-content">
                        <div className="agent-task-card-text" data-label={text}>{text}</div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}
      <AskUserQuestionInline />
      {atQuery !== null && (
        <div className="chat-at-file-pop" ref={atPopRef}>
          {atFiles.length === 0 ? (
            <div className="chat-at-empty">无匹配文件</div>
          ) : (
            atFiles.map(f => (
              <button className="chat-at-item" key={f.path} onClick={() => onPickAtFile(f)} title={f.path}>
                <FileTextIcon size={13} />
                <span className="chat-at-name">{f.name}</span>
                <span className="chat-at-rel">{f.relPath}</span>
              </button>
            ))
          )}
        </div>
      )}
      {slashQuery !== null && (
        <div className="chat-slash-pop" ref={slashPopRef}>
          {slashList.length === 0 ? (
            <div className="chat-at-empty">无匹配命令</div>
          ) : (
            slashList.map((c, i) => (
              <button
                className={`chat-slash-item${i === slashIdx ? ' active' : ''}`}
                key={c.name}
                ref={i === slashIdx ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => onPickSlash(c)}
                title={c.template}
              >
                <span className="chat-slash-name">/{c.name}</span>
                <span className="chat-slash-desc">{c.description}</span>
              </button>
            ))
          )}
        </div>
      )}

      {filePickerOpen && activeProject.workspaceDir && (
        <AgentFilePicker
          workspaceDir={activeProject.workspaceDir}
          attached={filePickerAttached}
          onAttach={handleFilePickerAttach}
          onRemove={handleFilePickerRemove}
          onClose={() => setFilePickerOpen(false)}
          triggerRef={attachBtnRef}
          onBrowseSystem={handleBrowseSystemFiles}
        />
      )}
      {attachedFiles.length > 0 && (
        <div className="chat-attach-tray">
          {attachedFiles.map(att => (
            <div className="chat-attach-chip" key={att.id}>
              {att.isImage && att.dataUrl
                ? <img src={att.dataUrl} className="chat-attach-thumb" alt={att.name} />
                : <FileTextIcon size={14} className="chat-attach-fileicon" />}
              <span className="chat-attach-name" title={att.name}>{att.name}</span>
              <button className="chat-attach-remove" onClick={() => removeAttachment(att.id)} disabled={loading}><XIcon size={11} /></button>
            </div>
          ))}
          {attachedFiles.length > 1 && (
            <button className="chat-attach-clear-all" onClick={() => { setAttachedFiles([]); setFilePickerAttached([]) }} disabled={loading}>
              <XIcon size={12} />全部清除
            </button>
          )}
        </div>
      )}
      <div ref={modelPickerRef} className={`chat-model-picker${modelPickerOpen ? ' open' : ''}`} style={{ width: modelPickerWidth }}>
        {agentCards.map(card => (
          <div key={card.template.id} className={`chat-model-item ${card.status}`} onClick={() => handleModelAction(card)}>
            <div className="chat-model-logo" onClick={e => { e.stopPropagation(); toggleLogoMenu(e, card) }}>
              {modelLogos[card.template.id]
                ? <img src={modelLogos[card.template.id]!} alt={card.template.name} className="chat-model-logo-img" />
                : <ImageIcon size={12} />}
            </div>
            <div className="chat-model-item-info">
              <div className="chat-model-item-name">{card.template.name}</div>
              {modelCaps[card.template.id] && (
                <span className="chat-model-caps">
                  {modelCaps[card.template.id]?.thinking && <span className="chat-model-cap cap-thinking"><Brain size={13} /></span>}
                  {modelCaps[card.template.id]?.tools && <span className="chat-model-cap cap-tools"><Wrench size={13} /></span>}
                  {modelCaps[card.template.id]?.vision && <span className="chat-model-cap cap-vision"><Eye size={13} /></span>}
                </span>
              )}
              <button className="chat-model-item-action" onClick={e => { e.stopPropagation(); handleModelAction(card) }}>
                {card.status === 'running' ? <CircleStopIcon size={12} /> : <PlayIcon size={12} />}
              </button>
            </div>
          </div>
        ))}
      </div>
      {logoMenu && (() => {
        const menuCard = cards.find(c => c.template.id === logoMenu.id)
        if (!menuCard) return null
        return (
          <div
            ref={logoMenuRef}
            className="chat-model-logo-menu"
            style={{ left: logoMenu.x, top: logoMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            <div className="chat-model-logo-menu-item" onClick={() => void pickModelLogo(menuCard)}><RefreshCwIcon size={12} />更换图片</div>
            <div className="chat-model-logo-menu-item danger" onClick={() => void removeModelLogo(menuCard)}><TrashIcon size={12} />移除 Logo</div>
          </div>
        )
      })()}
      <div className="chat-input-row">
        <div className="chat-input-field" onDragOver={handleInputDragOver} onDrop={handleInputDrop}>
          {/* ① 状态栏：并入输入框顶部，无框无底；默认只显示 orb 图标，模型运行时才显示文字 */}
          {(() => {
            let kind: 'running' | 'idle' = 'idle'
            let name = ''
            let text = '就绪'
            // thinking-orbs 0.3.1 新增 connecting/weaving/breathing 三个状态：
            // connecting=连接/准备中，weaving=写入/编辑（编织进项目），breathing=待机呼吸；
            // searching=搜索类工具（0.1.1 已有，此前未用）
            let orbState: OrbState = 'breathing'
            if (approvalReq) {
              kind = 'running'; name = approvalReq.name; text = '等待确认…'; orbState = 'listening'
            } else if (streamKind === 'tools') {
              // 工具调用/执行阶段：状态栏显示「工具调用中」+ 当前工具名；
              // 消息区工具卡另有具体 verb 徽标（如 Write → 写入中）。
              // orb 按工具类型细分：搜索类→searching，写入/编辑类→weaving，其余→working
              kind = 'running'; name = curToolName; text = '工具调用中'
              const toolKind = TOOL_METAS[curToolName]?.kind
              if (toolKind === 'search' || curToolName === 'web_search' || curToolName === 'web_search_bing') orbState = 'searching'
              else if (toolKind === 'write' || toolKind === 'edit') orbState = 'weaving'
              else orbState = 'working'
            } else if (streamKind === 'think' && !thinkDone) {
              // 思考闭合（thinkDone=true）后即使 streamKind 残留 'think' 也不再显示
              // 「思考中」转圈——模型已结束思考（在输出参数/正文/工具的路上）
              kind = 'running'; text = '思考中'; orbState = 'solving'
            } else if (streamKind === 'text') {
              kind = 'running'; text = '输出中'; orbState = 'composing'
            } else if (streaming) {
              // 流式中但尚无实际内容（首 token 前）：连接模型/建立会话
              kind = 'running'; text = '准备中…'; orbState = 'connecting'
            } else if (loading) {
              kind = 'running'; text = '准备中…'; orbState = 'connecting'
            }
            return (
              <div className={`agent-status-bar agent-status-bar--${kind}`}>
                <ThinkingOrb state={orbState} size={20} theme="light" paused={false} className="agent-status-orb" aria-label={text} />
                {kind === 'running' && name && <span className="agent-status-bar-name">{name}</span>}
                {kind === 'running' && <span className="agent-status-bar-text">{text}</span>}
              </div>
            )
          })()}
          {/* ② 输入区（中间）：引用胶囊 + 文本 */}
          <div className="chat-input-mid">
            <div className="chat-input-textwrap">
              {refChips.map(chip => (
                <div className="agent-ref-chip" key={chip.id}>
                  <QuoteIcon size={12} className="agent-ref-chip-icon" />
                  <span className="agent-ref-chip-label">引用</span>
                  <button className="agent-ref-chip-remove" onClick={() => removeRefChip(chip.id)} disabled={loading}><XIcon size={10} /></button>
                  <span className="agent-ref-chip-tip">{chip.text}</span>
                </div>
              ))}
              {codeSnippets.map(snip => (
                <div className="code-snippet-chip" key={snip.id}>
                  <CodeIcon size={12} className="code-snippet-chip-icon" />
                  <span className="code-snippet-file">{snip.fileName}:L{snip.startLine}-L{snip.endLine}</span>
                  <button className="agent-ref-chip-remove" onClick={() => removeCodeSnippet(snip.id)} disabled={loading}><XIcon size={10} /></button>
                </div>
              ))}
              {packedInput ? (
                /* 超长打包 chip：完全按「引用」胶囊样式与功能——图标 + 标签 +
                   × 移除按钮 + 悬停全文预览；输入框为空时 Backspace/Delete
                   也能删掉它。chip 里的正文发送时拼回正文 */
                <div className="chat-input-fold-chip">
                  <AlignLeft size={12} className="chat-input-fold-chip-icon" />
                  <span className="chat-input-fold-chip-label">已折叠 {packedInput.split('\n').length} 行</span>
                  <button className="agent-ref-chip-remove" title="移除" onClick={() => setPackedInput(null)}>
                    <XIcon size={10} />
                  </button>
                  <span className="chat-input-fold-chip-tip">{packedInput}</span>
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                className="chat-input"
                placeholder="" rows={1} value={input}
                onChange={handleInputChange} onKeyDown={handleKeyDown}
              />
            </div>
            {loading && runningCard && (() => {
              const hasInput = input.trim() !== '' || attachedFiles.length > 0 || refChips.length > 0 || codeSnippets.length > 0 || !!packedInput?.trim()
              const queueHas = queueInfo.followUp.length > 0
              if (!hasInput && !queueHas) return null
              return (
                <div className="chat-queue-actions">
                  {hasInput && (
                    <button
                      type="button"
                      className="chat-queue-act chat-queue-act-followup"
                      onClick={() => handleSend(undefined, undefined)}
                    >追加下一条</button>
                  )}
                  {queueHas && (() => {
                    const _last = queueInfo.followUp[queueInfo.followUp.length - 1] ?? ''
                    const _prev = _last.length > 14 ? _last.slice(0, 14) + '…' : _last
                    const _tip = [
                      `追加（${queueInfo.followUp.length}）：`,
                      ...queueInfo.followUp.map(t => '  • ' + t),
                    ].join('\n')
                    return (
                      <button
                        type="button"
                        className="chat-queue-indicator"
                        onClick={() => { window.api.piAgent.clearQueue(`pi-${activeSessionId}`); followUpQueueRef.current = []; prevQueueRef.current = { followUp: [] }; setQueueInfo({ followUp: [] }) }}
                        title={_tip}
                      >
                        <span className="chat-queue-count">追加 {queueInfo.followUp.length}</span>
                        {_last && <span className="chat-queue-preview">：{_prev}</span>}
                        <XIcon size={11} />
                      </button>
                    )
                  })()}
                </div>
              )
            })()}
          </div>
          {/* ③ 底部按钮行：文件目录 + 模型列表（左）… 发送（右） */}
          <div className="chat-input-tools">
            <AniIconButton className="chat-upload-btn" icon={PlusIcon} size={14} onClick={() => fileInputRef.current?.click()} title="添加附件" />
            <AniIconButton ref={attachBtnRef} className={`chat-attach-btn${filePickerOpen ? ' active' : ''}`} icon={FolderOpenIcon} size={14} onClick={toggleFilePicker} title="选择文件" />
            <AniIconButton className={`chat-mic-btn${listening || micTranscribing ? ' listening' : ''}`} icon={MicIcon} size={14} onClick={toggleListen} disabled={micTranscribing} title={micTranscribing ? '识别中…' : listening ? '停止录音' : '语音输入'} />
            {activeProject.workspaceDir && (
              <div className="chat-workspace-badge-wrap">
                <button
                  ref={workspaceBtnRef}
                  className={`chat-workspace-badge${workspaceMenuOpen ? ' active' : ''}`}
                  title={`点击切换工作区：${activeProject.workspaceDir}`}
                  onClick={() => setWorkspaceMenuOpen(v => !v)}
                >
                  <FolderIcon size={12} />
                  <span className="chat-workspace-name">
                    {activeProject.workspaceDir.replace(/\\/g, '/').split('/').pop() || '工作区'}
                  </span>
                </button>
                {workspaceMenuOpen && (
                  <div ref={workspaceMenuRef} className="chat-workspace-menu">
                    {projects.map(p => (
                      <button
                        key={p.id}
                        className={`chat-workspace-item${p.id === activeProjectId ? ' active' : ''}`}
                        onClick={() => {
                          if (p.id !== activeProjectId) {
                            setActiveProjectId(p.id)
                            setActiveSessionId(p.sessions[0]?.id ?? '')
                          }
                          setWorkspaceMenuOpen(false)
                        }}
                      >
                        <FolderIcon size={11} />
                        <span>{p.title || '未命名'}</span>
                        {p.id === activeProjectId && <CheckIcon size={11} className="chat-workspace-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeProject.workspaceDir && currentBranch && (
              <div className="chat-branch-selector">
                <div className="chat-branch-wrap">
                  <button
                    ref={branchBtnRef}
                    className={`chat-branch-trigger${branchMenuOpen ? ' active' : ''}`}
                    onClick={() => setBranchMenuOpen(v => !v)}
                    title={`当前分支：${currentBranch}`}
                  >
                    <GitBranchIcon size={12} />
                    <span className="chat-branch-name">{currentBranch}</span>
                    <ChevronDownIcon size={10} className="chat-branch-caret" />
                  </button>
                  {branchMenuOpen && branches.length > 0 && (
                    <div ref={branchMenuRef} className="chat-branch-menu">
                      {branches.map(b => (
                        <button
                          key={b}
                          className={`chat-branch-item${b === currentBranch ? ' active' : ''}`}
                          onClick={() => checkoutBranch(b)}
                        >
                          <GitBranchIcon size={11} />
                          <span>{b}</span>
                          {b === currentBranch && <CheckIcon size={11} className="chat-branch-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <AgentTopBarCtx
              active={contextModalOpen}
              onToggle={() => setContextModalOpen(v => !v)}
              btnRef={ctxInlineRef}
            />
            <button
              ref={modelBtnRef}
              className={`chat-model-dropdown${modelPickerOpen ? ' active' : ''}${runningCard ? ' running' : ''}${runningCard?.ready ? ' ready' : ''}`}
              onClick={() => setModelPickerOpen(v => !v)}
            >
              {runningCard && (
                <span className="chat-model-logo chat-model-dropdown-logo">
                  {modelLogos[runningCard.template.id]
                    ? <img src={modelLogos[runningCard.template.id]!} className="chat-model-logo-img" alt="" />
                    : <ImageIcon size={11} />}
                </span>
              )}
              <span className="chat-model-dropdown-name">{runningCard ? modelLabel : '选择模型'}</span>
            </button>
            <div
              ref={thinkLevelMenuRef}
              className={`chat-think-level${thinkLevelOpen ? ' open' : ''}`}
            >
              <button
                type="button"
                className="chat-think-level-trigger"
                disabled={loading}
                onClick={() => setThinkLevelOpen(v => !v)}
              >
                <span className="chat-think-level-label">{thinkingLevel}</span>
              </button>
              {thinkLevelOpen && (
                <ul className="chat-think-level-menu">
                  {THINKING_LEVELS.map(l => (
                    <li
                      key={l}
                      className={`chat-think-level-item${l === thinkingLevel ? ' active' : ''}`}
                      onClick={() => {
                        setThinkingLevel(l)
                        setThinkLevelOpen(false)
                        const cur = piReadyRef.current
                        if (cur.ready && cur.sid) {
                          window.api.piAgent.setThinkingLevel(`pi-${cur.sid}`, l).catch(() => { /* 非致命 */ })
                        }
                      }}
                    >
                      {l}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* 纯聊天开关（会话级）：打开后主进程不注册任何工具、也不注入编码 agent 的
                工具 / 图表指引，只做普通对话。复用搜索开关的按钮外观，开启态用强调色标出。
                切换会作废当前 pi 会话，下一轮按新模式重建（历史会重新注入，对话不丢）。 */}
            <button
              type="button"
              className={`chat-search-trigger chat-plain-toggle${plainChat ? ' on' : ''}`}
              disabled={loading}
              onClick={togglePlainChat}
              title={plainChat
                ? '当前是纯聊天模式：不注册任何工具，也不注入编码 agent 的工具 / 图表指引。点击恢复工作台模式。'
                : '切到纯聊天模式：关掉全部工具与工具 / 图表指引，把工作台当原生聊天用（下一轮生效）。'}
            >
              <MessageSquare size={14} />
              <span className="chat-search-label">纯聊天</span>
            </button>
            {/* 纯聊天工具开关（仅纯聊天模式）：只列原生聊天那四个工具，默认全关。
                工作台模式不显示——那边的 20+ 工具走主进程白名单，与此互不干扰。 */}
            {plainChat && (
              <div ref={chatToolsMenuRef} className={`chat-search-switch${chatToolsMenuOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="chat-search-trigger"
                  disabled={loading}
                  onClick={() => setChatToolsMenuOpen(v => !v)}
                  title="纯聊天模式下可启用的工具（默认全关）"
                >
                  <Wrench size={14} />
                  <span className="chat-search-label">工具{chatToolOnCount > 0 ? ` ${chatToolOnCount}` : ''}</span>
                </button>
                {chatToolsMenuOpen && (
                  <ul className="chat-search-menu">
                    {PLAIN_CHAT_TOOL_NAMES.map(name => {
                      const on = name === 'web_search' ? searchEnabled : chatTools.includes(name)
                      return (
                        <li
                          key={name}
                          className={`chat-search-item${on ? ' active' : ''}`}
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
            <div
              ref={searchMenuRef}
              className={`chat-search-switch${searchMenuOpen ? ' open' : ''}`}
            >
              <button
                type="button"
                className="chat-search-trigger"
                disabled={loading}
                onClick={() => setSearchMenuOpen(v => !v)}
              >
                {!searchEnabled ? (
                  <SearchX size={14} />
                ) : searchProvider === 'bing' ? (
                  <Globe size={14} />
                ) : (
                  <Search size={14} />
                )}
                <span className="chat-search-label">{!searchEnabled ? '搜索关' : searchProvider === 'bing' ? '必应' : 'DDG'}</span>
              </button>
              {searchMenuOpen && (
                <ul className="chat-search-menu">
                  <li
                    className={`chat-search-item${!searchEnabled ? ' active' : ''}`}
                    onClick={() => applySearchChange(false, searchProvider)}
                  ><SearchX size={12} />关闭网络搜索</li>
                  <li
                    className={`chat-search-item${searchEnabled && searchProvider === 'bing' ? ' active' : ''}`}
                    onClick={() => applySearchChange(true, 'bing')}
                  ><Globe size={12} />必应 Bing（国内）</li>
                  <li
                    className={`chat-search-item${searchEnabled && searchProvider === 'ddg' ? ' active' : ''}`}
                    onClick={() => applySearchChange(true, 'ddg')}
                  ><Search size={12} />DuckDuckGo（国际）</li>
                </ul>
              )}
            </div>
            {loading ? (
              <AniIconButton className="btn btn-ghost chat-stop-btn" icon={CircleStopIcon} size={16} onClick={handleStop} title="停止" />
            ) : (
              <AniIconButton className="btn btn-primary chat-send-btn" icon={SendIcon} size={16} onClick={() => handleSend()} disabled={(!input.trim() && attachedFiles.length === 0 && refChips.length === 0 && codeSnippets.length === 0 && !packedInput?.trim()) || !apiBaseUrl} title="发送" />
            )}
          </div>
        </div>
      </div>
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleAttachmentSelect} />
    </div>
  )
}
