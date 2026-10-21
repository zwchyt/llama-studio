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

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, AlignLeft, Brain, Eye, Globe, Image as ImageIcon, Search, SearchX, Wrench } from 'lucide-react'
import { CheckIcon, ChevronDownIcon, CircleStopIcon, CodeIcon, FileTextIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, MicIcon, PlayIcon, PlusIcon, QuoteIcon, RefreshCwIcon, SendIcon, ServerIcon, TrashIcon, XIcon } from '@animateicons/react/lucide'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import AgentFilePicker from '../../AgentFilePicker'
import AskUserQuestionInline from '../../AskUserQuestionInline'
import { AgentPrefillBar, AgentTopBarCtx, AniIconButton } from '../agent-message'
import { ImagePill } from '../utils/ImagePill'
import { AttachmentTextPreview, type PreviewableAttachment } from '../agent-message/AttachmentTextPreview'
import { TOOL_META, formatToolArgs } from '../agent-tools'
import { TOOL_METAS } from '../../../utils/tools'
// 预览卡片直接复用会话那套 Markdown 渲染（含 KaTeX 公式覆写），不再自己拼 HTML
import { Markdown } from '../../../markdown/markstream'
import { THINKING_LEVELS } from '../../../../../shared/types'
import type { Attachment, CardState, ModelEndpoint, ThinkingLevel } from '../../../../../shared/types'
import { useStore } from '../../../store/useStore'
import { endpointOfCard, type ModelPickerGroup } from '../../../utils/endpoint'
import { hasVisionProjector } from '../../../utils/modelCapabilities'
import { useBubbleTip } from '../../useBubbleTip'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { rovingKeyNav } from '../utils/rovingKeyNav'
import { useThemeStore } from '../../../store/themeStore'
import type { useAgentGit } from '../hooks/useAgentGit'
import type { useAgentInput } from '../hooks/useAgentInput'
import type { useAgentInputHints } from '../hooks/useAgentInputHints'
import type { useAgentProjects } from '../hooks/useAgentProjects'

/** 输入区顶部状态栏：把「当前阶段」映射成 orb 状态 + 文案。
 *  原来这 40 行 if/else 写在 JSX 的 IIFE 里逐帧执行，抽成组件后可读、也可 memo。 */
const AgentStatusBar = React.memo(function AgentStatusBar({ approvalReq, streamKind, curToolName, thinkDone, streaming, loading, compacting, orbTheme, modelRunning }: {
  approvalReq: AgentInputAreaProps['approval']['approvalReq']
  streamKind: AgentInputAreaProps['run']['streamKind']
  curToolName: string
  thinkDone: boolean
  streaming: boolean
  loading: boolean
  compacting: boolean
  orbTheme: ReturnType<typeof useThemeStore.getState>['theme']
  /** 是否有模型已启动（卡片 status==='running'）：有就常驻呼吸动画 */
  modelRunning: boolean
}) {
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
  // 压缩历史期间让出文字位：pi 的轮间自动压缩发生在工具批次结束之后、下一轮开始之前，
  // 而 streamKind 只在整轮结束才归 idle —— 不抑制的话这里会停在上一阶段的
  // 「工具调用中」，与上方的「正在压缩历史」并列显示，看起来自相矛盾。
  // 审批态例外：它是阻塞性的，必须照常显示。
  const suppressText = compacting && !approvalReq
  return (
    <div className={`agent-status-bar agent-status-bar--${kind}`}>
      {/* 模型已启动就常驻呼吸动画（空闲也动，表示"活着"）；未启动模型时才停成静止帧。
          orb 自带 IntersectionObserver + visibilitychange，滚出视口或窗口隐藏时会自行停 rAF。 */}
      <ThinkingOrb state={orbState} size={20} theme={orbTheme} paused={kind !== 'running' && !modelRunning} className="agent-status-orb" aria-label={text} />
      {!suppressText && kind === 'running' && name && <span className="agent-status-bar-name">{name}</span>}
      {!suppressText && kind === 'running' && <span className="agent-status-bar-text">{text}</span>}
    </div>
  )
})

/** 模型 Logo 的小菜单（更换 / 移除）：坐标由触发点给出，打开即定位。 */
const AgentLogoMenu = React.memo(function AgentLogoMenu({ menu, cards, menuRef, onPickLogo, onRemoveLogo }: {
  menu: { id: string; x: number; y: number }
  cards: AgentInputAreaProps['shell']['cards']
  menuRef: React.RefObject<HTMLDivElement | null>
  onPickLogo: (card: CardState) => unknown
  onRemoveLogo: (card: CardState) => unknown
}) {
  const card = cards.find(c => c.template.id === menu.id)
  if (!card) return null
  return (
    <div
      ref={menuRef}
      className="chat-model-logo-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={e => e.stopPropagation()}
    >
      <button type="button" className="chat-model-logo-menu-item" onClick={() => void onPickLogo(card)}><RefreshCwIcon size={12} />更换图片</button>
      <button type="button" className="chat-model-logo-menu-item danger" onClick={() => void onRemoveLogo(card)}><TrashIcon size={12} />移除 Logo</button>
    </div>
  )
})

/** 来源图标的小菜单（设置 / 更换 / 移除）：与模型 Logo 菜单同一套样式，
 *  区别是直接按 id 操作——来源没有模型卡片，不走 CardState。 */
const SourceLogoMenu = React.memo(function SourceLogoMenu({ menu, menuRef, hasLogo, onPick, onRemove }: {
  menu: { id: string; x: number; y: number }
  menuRef: React.RefObject<HTMLDivElement | null>
  hasLogo: boolean
  onPick: (id: string) => unknown
  onRemove: (id: string) => unknown
}) {
  return (
    <div
      ref={menuRef}
      className="chat-model-logo-menu"
      style={{ left: menu.x, top: menu.y }}
      // 关键：菜单挂在浮层之外，文档级的 pointerdown 关闭监听会把这次按下当成「点外部」，
      // 在 click 落地前就把菜单卸载掉 —— 表现为「点了没反应」。这里拦在菜单根部。
      onPointerDown={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
      onClick={e => e.stopPropagation()}
    >
      <button type="button" className="chat-model-logo-menu-item" onClick={() => void onPick(menu.id)}><RefreshCwIcon size={12} />{hasLogo ? '更换图片' : '设置图标'}</button>
      {hasLogo && <button type="button" className="chat-model-logo-menu-item danger" onClick={() => void onRemove(menu.id)}><TrashIcon size={12} />移除图标</button>}
    </div>
  )
})

/** 队列预览里保留的字符数：够看清开头，又不至于把整条追问铺开 */
const QUEUE_PREVIEW_CHARS = 14

/** 输入框下方的排队操作条：追加下一条 / 追加队列（点击清空）。 */
const AgentQueueActions = React.memo(function AgentQueueActions({ canSend, queueInfo, onSend, activeSessionId, followUpQueueRef, prevQueueRef, setQueueInfo, tip }: {
  canSend: boolean
  queueInfo: AgentInputAreaProps['run']['queueInfo']
  onSend: AgentInputAreaProps['run']['handleSend']
  activeSessionId: string
  followUpQueueRef: AgentInputAreaProps['run']['followUpQueueRef']
  prevQueueRef: AgentInputAreaProps['run']['prevQueueRef']
  setQueueInfo: AgentInputAreaProps['run']['setQueueInfo']
  tip: ReturnType<typeof useBubbleTip>['tipHandlers']
}) {
  // 判据由调用处传入（复用 hasPayload）：新增一种可发送内容时不会出现
  // 「发送键亮着但这里不出现」的分歧
  const queueHas = queueInfo.followUp.length > 0
  if (!canSend && !queueHas) return null
  const last = queueInfo.followUp[queueInfo.followUp.length - 1] ?? ''
  const preview = last.length > QUEUE_PREVIEW_CHARS ? last.slice(0, QUEUE_PREVIEW_CHARS) + '…' : last
  // 这个按钮整颗都是「清空」——提示里必须写明后果，
  // 否则用户点开只想看排队内容，一次误点就把全部追加提问清了。
  const clearTip = [
    `追加队列（${queueInfo.followUp.length} 条）——点击将全部清空：`,
    ...queueInfo.followUp.map(t => '  • ' + t),
  ].join('\n')
  return (
    <div className="chat-queue-actions">
      {canSend && (
        <button
          type="button"
          className="chat-queue-act chat-queue-act-followup"
          onClick={() => onSend(undefined, undefined)}
        >追加下一条</button>
      )}
      {queueHas && (
        <button
          type="button"
          className="chat-queue-indicator"
          onClick={() => { window.api.piAgent.clearQueue(`pi-${activeSessionId}`); followUpQueueRef.current = []; prevQueueRef.current = { followUp: [] }; setQueueInfo({ followUp: [] }) }}
          {...tip(clearTip)}
        >
          <span className="chat-queue-count">追加 {queueInfo.followUp.length}</span>
          {last && <span className="chat-queue-preview">：{preview}</span>}
          <XIcon size={11} className="chat-queue-clear-x" />
        </button>
      )}
    </div>
  )
})

/** 破坏性工具审批面板：内联在输入框内（与提问工具 AskUserQuestionInline 同位置/风格），不弹窗。 */
const ApprovalInline = React.memo(function ApprovalInline({ req, allowBtnRef, rejectBtnRef, autoApproveBtnRef, autoApproveRef, onResolve }: {
  req: NonNullable<AgentInputAreaProps['approval']['approvalReq']>
  allowBtnRef: React.RefObject<HTMLButtonElement | null>
  rejectBtnRef: React.RefObject<HTMLButtonElement | null>
  autoApproveBtnRef: React.RefObject<HTMLButtonElement | null>
  autoApproveRef: React.RefObject<boolean>
  onResolve: (approved: boolean) => void
}) {
  return (
    <div className="agent-approve-inline">
      <div className="agent-approve-inline-head">
        <AlertCircle size={15} className="agent-ask-question-icon" />
        <span className="agent-ask-question-title">需要确认：{TOOL_META[req.name]?.name || req.name}</span>
      </div>
      <div className="agent-approve-inline-body">
        <div className="agent-approve-hint">该操作具有破坏性，执行前需你确认</div>
        <div className="agent-approve-detail-row"><span>工具</span><code>{req.name}</code></div>
        <div className="agent-approve-detail-row">
          <span>参数</span>
          <pre className="agent-approve-args">{formatToolArgs(req.args) || '(无)'}</pre>
        </div>
      </div>
      <div className="agent-approve-inline-footer">
        <button ref={rejectBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => onResolve(false)}>拒绝</button>
        <button ref={autoApproveBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => { autoApproveRef.current = true; onResolve(true) }}>本次全部允许</button>
        <button ref={allowBtnRef} className="agent-prompt-btn agent-prompt-btn-primary" onClick={() => onResolve(true)}>允许</button>
      </div>
    </div>
  )
})

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
    modelGroups: ModelPickerGroup[]
    modelBtnRef: React.RefObject<HTMLButtonElement | null>
    modelCaps: ReturnType<typeof useStore.getState>['modelCapabilities']
    modelLabel: string
    modelLogos: ReturnType<typeof useStore.getState>['modelLogos']
    modelPickerOpen: boolean
    modelPickerRef: React.RefObject<HTMLDivElement | null>
    handleModelAction: (card: CardState) => Promise<void>
    /** 端点上还没建卡的模型名：点这一行就地建卡并启用 */
    pickEndpointModel: (ep: ModelEndpoint, modelId: string) => Promise<void>
    logoMenu: { id: string; x: number; y: number } | null
    logoMenuRef: React.RefObject<HTMLDivElement | null>
    toggleLogoMenu: (e: React.MouseEvent, card: CardState) => void
    pickModelLogo: (card: CardState) => Promise<void>
    removeModelLogo: (card: CardState) => Promise<void>
    /** 左栏「来源」图标：与模型 Logo 同一份存储，key 为 src:<来源名> */
    pickSourceLogo: (id: string) => Promise<void>
    removeSourceLogo: (id: string) => Promise<void>
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
    /** 当前工作区是否处于通用模式（由所属工作区的 mode 推导）：true 时收掉工作区/分支/思考强度等编码控件。
        工作区切换本身在左侧会话栏顶部，通用工具开关在界面顶栏，均不由本组件渲染。 */
    plainChat: boolean
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
  /** 点击附件 chip：按磁盘路径把原文件送到右侧「预览」工作区（PDF 版面 / DOCX / 图片 / HTML / 代码） */
  onPreviewAttachment: (path: string) => void
  /** 点图片胶囊：有磁盘路径的读原文件，只有内存图的（剪贴板粘贴 / 浏览器拖入）用 dataUrl 建预览标签 */
  onPreviewImage: (a: { name: string; path?: string; dataUrl?: string }) => void
}


export function AgentInputArea({
  inputDomain, hintsDomain, mic, models, search, chatMode, run, approval, shell, handleKeyDown, handleInputChange,
  onPreviewAttachment, onPreviewImage,
}: AgentInputAreaProps) {
  // ── 域解构：把分组 props 摊平回局部名字，组件体内沿用原 JSX 的标识符 ──

  const {
    input, setInput, textareaRef, packedInput, setPackedInput, fileInputRef,
    attachedFiles, clearAttachments, filePickerAttached,
    attachFromFiles, notePaste,
    filePickerOpen, setFilePickerOpen,
    handleAttachmentSelect, removeAttachment, handleFilePickerAttach,
    handleInputDragOver, handleInputDrop,
    handleFilePickerRemove, toggleFilePicker, refChips, codeSnippets,
    removeRefChip, removeCodeSnippet,
  } = inputDomain
  const {
    atQuery, atFiles, atPopRef, slashQuery, slashList, slashIdx,
    setSlashIdx, slashPopRef, onPickAtFile, onPickSlash,
  } = hintsDomain
  const { listening, micTranscribing, toggleListen } = mic
  const { modelGroups, modelBtnRef, modelCaps, modelLabel, modelLogos, modelPickerOpen, modelPickerRef, handleModelAction, pickEndpointModel, pickSourceLogo, removeSourceLogo, logoMenu, logoMenuRef, toggleLogoMenu, pickModelLogo, removeModelLogo, setModelPickerOpen, thinkLevelMenuRef, thinkLevelOpen, setThinkLevelOpen, thinkingLevel, setThinkingLevel } = models
  const { searchEnabled, searchProvider, searchMenuOpen, searchMenuRef, setSearchMenuOpen, applySearchChange } = search
  const { plainChat } = chatMode
  const { apiBaseUrl, curToolName, followUpQueueRef, handleSend, handleStop, loading, piReadyRef, prevQueueRef, queueInfo, setQueueInfo, runningCard, streamKind, streaming, thinkDone } = run
  const { allowBtnRef, approvalReq, autoApproveBtnRef, autoApproveRef, rejectBtnRef, resolveApproval } = approval
  const { activeProject, activeProjectId, activeSessionId, attachBtnRef, branchBtnRef, branchMenuOpen, branchMenuRef, branches, cards, chatInputAreaRef, checkoutBranch, contextModalOpen, ctxInlineRef, currentBranch, projects, setActiveProjectId, setActiveSessionId, setBranchMenuOpen, setContextModalOpen, setWorkspaceMenuOpen, workspaceBtnRef, workspaceMenuOpen, workspaceMenuRef } = shell
  // 没有磁盘路径的附件（读取时拿不到真实文件）退化成浮层看抽取文本，与消息气泡里的文件卡片同一层
  const [attPreview, setAttPreview] = useState<PreviewableAttachment | null>(null)
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）；
  // 斜杠补全行已有 onMouseEnter，走 showTip/hideTip 合并进去
  const { tipHandlers: tip, tipNode, showTip, hideTip } = useBubbleTip()
  // 模型选择弹窗里的气泡（来源图标 / 模型名）改用带悬停延迟的一份：
  // 弹窗是扫视式浏览，鼠标掠过就弹会盖住列表；停 400ms 才显示名称更稳。
  const { tipHandlers: tipHover, tipNode: tipHoverNode } = useBubbleTip('below', 400)
  // 胶囊的悬停预览卡片：显示/隐藏交给状态，不靠纯 :hover——卡片的 pointer-events 可用性
  // 反过来依赖 :hover，指针移向卡片那一小段缝里会两头落空、卡片先收。
  // 事件挂在胶囊上，而卡片是胶囊的子节点，所以 mouseleave 的判定范围就是「胶囊 + 卡片」整体。
  const [tipKey, setTipKey] = useState<string | null>(null)
  const tipTimer = useRef<number | null>(null)
  const openTip = (key: string) => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current)
    tipTimer.current = null
    setTipKey(key)
  }
  // 延后一拍再收：指针快速掠过缝隙时不至于把卡片直接收掉
  const closeTip = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current)
    tipTimer.current = window.setTimeout(() => setTipKey(null), 120)
  }
  // 外部端点：卡片只存 endpointId，这里查表是为了区分「本机端口 / 远程」的角标与提示文案；
  // 端点本身在「外部端点」页管理，下拉里只留一个跳转入口。
  const modelEndpoints = useStore(s => s.modelEndpoints)
  const setView = useStore(s => s.setView)
  // 历史压缩中（pi 原生压缩，手动 / 自动都置位）：驱动输入框上方的提示条
  const compacting = useStore(s => s.compacting)
  // 通用模式收掉「选择文件」（工作区文件选择器）：若切换时它正开着，先关掉再收按钮，
  // 否则切回编码模式会看到上次遗留的弹层自己冒出来。
  useEffect(() => {
    if (plainChat) setFilePickerOpen(false)
  }, [plainChat, setFilePickerOpen])
  // 模型下拉左栏当前选中的来源（分组标题）。面板每次打开重置为「运行中模型所在来源」，
  // 否则第一组；shownModelGroup 用派生值兜底——来源集合变化（端点增删）后旧选中项失效
  // 会自动落到第一组，不会出现右栏空白。
  const [activeModelGroup, setActiveModelGroup] = useState<string | null>(null)
  const modelPickerWasOpen = useRef(false)
  useEffect(() => {
    if (modelPickerOpen && !modelPickerWasOpen.current) {
      const runningGroup = modelGroups.find(g => g.rows.some(r => r.card?.template.id === runningCard?.template.id))
      setActiveModelGroup(runningGroup?.title ?? modelGroups[0]?.title ?? null)
    }
    modelPickerWasOpen.current = modelPickerOpen
  }, [modelPickerOpen, modelGroups, runningCard])
  const shownModelGroup = modelGroups.find(g => g.title === activeModelGroup) ?? modelGroups[0]
  // 左栏来源图标：右键弹出的小菜单（更换 / 移除）；固定定位坐标来自右键点。
  // 面板关闭时一并收起，避免菜单浮在已关闭的下拉外面。
  const [sourceLogoMenu, setSourceLogoMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const sourceLogoMenuRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(!!sourceLogoMenu, () => setSourceLogoMenu(null), undefined, undefined, sourceLogoMenuRef)
  useEffect(() => { if (!modelPickerOpen) setSourceLogoMenu(null) }, [modelPickerOpen])
  // 审批是阻塞性交互：出现即把焦点交给「允许」（键盘用户不必先 Tab 过去）；
  // 审批结束后焦点会随按钮卸载掉到 body，这里把它还给输入框，用户可以直接接着打字。
  const hadApprovalRef = useRef(false)
  useEffect(() => {
    const had = hadApprovalRef.current
    hadApprovalRef.current = !!approvalReq
    if (approvalReq) { allowBtnRef.current?.focus(); return }
    if (had && (document.activeElement === null || document.activeElement === document.body)) {
      textareaRef.current?.focus()
    }
  }, [approvalReq, allowBtnRef, textareaRef])
  // 拖拽落点反馈：只在「真能接收」的拖拽上亮，避免拖选文字时整块输入区跟着高亮
  const [dragOver, setDragOver] = useState(false)
  const isFileDrag = (e: React.DragEvent) => {
    const t = e.dataTransfer?.types
    return !!t && (t.includes('Files') || t.includes('application/x-agent-file-path') || t.includes('application/x-agent-files'))
  }
  // 发送键的可用条件与禁用原因收成一处：此前 disabled 里含 !apiBaseUrl，但 title 恒为
  // 「发送」——模型没启动时按钮灰掉却不说明原因，用户只能猜（这是最常遇到的一种）。
  // 顺带消掉原来在 JSX 里重复两遍的长表达式。
  const hasPayload = input.trim() !== '' || attachedFiles.length > 0 || refChips.length > 0 || codeSnippets.length > 0 || !!packedInput?.trim()
  // 粘贴：剪贴板里的图片直接挂成图片胶囊（桌面端最高频的操作之一）；纯文本走默认粘贴行为，
  // 只给输入域打一个「本次是粘贴」的标记——长文本据此决定是否收成胶囊。
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const images: File[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const f = item.getAsFile()
      if (f) images.push(f)
    }
    if (images.length > 0) {
      e.preventDefault()
      void attachFromFiles(images)
      return
    }
    notePaste()
  }
  const sendDisabled = !hasPayload || !apiBaseUrl
  const sendTitle = !apiBaseUrl ? '请先启动一个模型' : !hasPayload ? '输入内容后发送' : '发送'
  // 动画小球的配色随应用亮/暗主题走：此前写死 light，暗底下对比度全靠运气。
  const orbTheme = useThemeStore(s => s.theme)
  // 文件类附件的胶囊：排在输入框内部（正文上方一整行，与「引用」胶囊同一容器）。
  // 图片同样排在这里，但自成一整行（.chat-input-imgrow）——与正文彻底分开：
  // 上面是图片胶囊，胶囊下面才是输入的文字。不再往正文里插行内记号、也不再按记号位置盖胶囊。
  const fileChips = useMemo(() => attachedFiles.filter(a => !a.isImage), [attachedFiles])
  const imageAtts = useMemo(() => attachedFiles.filter(a => a.isImage), [attachedFiles])
  const attachTray = fileChips.length > 0 && (
    <div className="chat-attach-tray">
      {fileChips.map(att => {
        // 有磁盘路径 → 点开右侧「预览」工作区看原文件（PDF 版面 / DOCX / HTML / 代码）；
        // 拿不到路径的才退回浮层，看模型实际读到的那段文本。
        const path = att.path
        const open = path
          ? () => onPreviewAttachment(path)
          : att.content ? () => setAttPreview({ name: att.name, content: att.content }) : undefined
        return (
          <div
            className={`chat-attach-chip${open ? ' previewable' : ''}`}
            key={att.id}
            onClick={open}
            {...tip(open ? `${path ?? att.name}（点击${path ? '在右侧预览' : '预览抽取到的文本'}）` : att.name)}
          >
            <FileTextIcon size={14} className="chat-attach-fileicon" />
            <span className="chat-attach-name" {...tip(att.name)}>{att.name}</span>
            <button className="chat-attach-remove" onClick={e => { e.stopPropagation(); removeAttachment(att.id) }} disabled={loading}><XIcon size={11} /></button>
          </div>
        )
      })}
      {attachedFiles.length > 1 && (
        <button className="chat-attach-clear-all" onClick={clearAttachments} disabled={loading}>
          <XIcon size={12} />全部清除
        </button>
      )}
    </div>
  )
  return (
    <div
      className="chat-input-area" ref={chatInputAreaRef}
      // 拖放区覆盖整个输入区（工具栏、上下文行都算）：原来只绑在 .chat-input-field 上，
      // 拖到旁边一点就失效，用户只能精确对准输入框。
      onDragOver={e => { if (!isFileDrag(e)) return; handleInputDragOver(e); setDragOver(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
      onDrop={e => { setDragOver(false); handleInputDrop(e) }}
    >
      {tipNode}
      {tipHoverNode}
      {/* 破坏性工具审批面板：内联显示在输入框内（与提问工具 AskUserQuestionInline 同款位置/风格），不弹窗 */}
      {approvalReq && (
        <ApprovalInline
          req={approvalReq}
          allowBtnRef={allowBtnRef}
          rejectBtnRef={rejectBtnRef}
          autoApproveBtnRef={autoApproveBtnRef}
          autoApproveRef={autoApproveRef}
          onResolve={resolveApproval}
        />
      )}
      <AskUserQuestionInline />
      {atQuery !== null && (
        <div className="chat-at-file-pop" ref={atPopRef} role="listbox" aria-label="引用文件">
          {atFiles.length === 0 ? (
            <div className="chat-at-empty">无匹配文件</div>
          ) : (
            atFiles.map(f => (
              <button className="chat-at-item" key={f.path} role="option" aria-selected={false} data-row onKeyDown={rovingKeyNav} onClick={() => onPickAtFile(f)} {...tip(f.path)}>
                <FileTextIcon size={13} />
                <span className="chat-at-name">{f.name}</span>
                <span className="chat-at-rel">{f.relPath}</span>
              </button>
            ))
          )}
        </div>
      )}
      {logoMenu && (
        <AgentLogoMenu
          menu={logoMenu}
          cards={cards}
          menuRef={logoMenuRef}
          onPickLogo={pickModelLogo}
          onRemoveLogo={removeModelLogo}
        />
      )}
      {sourceLogoMenu && (
        <SourceLogoMenu
          menu={sourceLogoMenu}
          menuRef={sourceLogoMenuRef}
          hasLogo={!!modelLogos[sourceLogoMenu.id]}
          onPick={id => { setSourceLogoMenu(null); return pickSourceLogo(id) }}
          onRemove={id => { setSourceLogoMenu(null); return removeSourceLogo(id) }}
        />
      )}
      {/* ── 输入框上方的上下文行（仅编码模式）──
          当前工作区目录 + git 分支 + 待发送附件胶囊。前两项描述的是「这段对话跑在哪个
          工作区里」，属于**上下文**而不是操作按钮，所以从底部工具行里提出来单独占一行。
          两个下拉都是 bottom:100% 向上弹出，放在这里反而比原来更不容易被容器裁掉。
          附件胶囊跟着这一行走（不再单独占一行压在项目名上方）；只有这一行的成员之一
          存在时才渲染。通用模式没有工作区概念，整行不渲染，胶囊改单独贴在输入框上方。 */}
      {!plainChat && (activeProject.workspaceDir || currentBranch || attachedFiles.length > 0) && (
        <div className="chat-input-context">
          {activeProject.workspaceDir && (
            <div className="chat-workspace-badge-wrap">
              <button
                ref={workspaceBtnRef}
                className={`chat-workspace-badge${workspaceMenuOpen ? ' active' : ''}`}
                aria-haspopup="menu"
                aria-expanded={workspaceMenuOpen}
                aria-label={`切换工作区：${activeProject.workspaceDir}`}
                {...tip(`点击切换工作区：${activeProject.workspaceDir}`)}
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
                  aria-haspopup="menu"
                  aria-expanded={branchMenuOpen}
                  aria-label={`当前分支：${currentBranch}`}
                  onClick={() => setBranchMenuOpen(v => !v)}
                  {...tip(`当前分支：${currentBranch}`)}
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
        </div>
      )}
      <div className="chat-input-row">
        <div className={`chat-input-field${dragOver ? ' dragover' : ''}`}>
          {/* /命令 补全浮层：锚定输入字段本体（CSS 绝对定位 left/right:0 + bottom:100%），
              与输入框同宽、紧贴框顶向上弹出——不依赖输入区 padding（hero 空态 padding 不同
              也不会错位），也不受附件托盘/排队条高度影响。通用模式 detectSlash 不触发，
              slashQuery 恒为 null，这里自然不渲染。 */}
          {slashQuery !== null && (
            <div className="chat-slash-pop" ref={slashPopRef} role="listbox" aria-label="斜杠命令">
              {slashList.length === 0 ? (
                <div className="chat-at-empty">无匹配命令</div>
              ) : (
                slashList.map((c, i) => (
                  <button
                    className={`chat-slash-item${i === slashIdx ? ' active' : ''}`}
                    key={c.name}
                    role="option"
                    aria-selected={i === slashIdx}
                    data-row
                    onKeyDown={rovingKeyNav}
                    ref={i === slashIdx ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onMouseEnter={(e) => { setSlashIdx(i); showTip(c.template, e.currentTarget) }}
                    onMouseLeave={() => hideTip()}
                    onClick={() => onPickSlash(c)}
                  >
                    <span className="chat-slash-name">/{c.name}</span>
                    <span className="chat-slash-desc">{c.description}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {/* ① 状态栏：并入输入框顶部，无框无底；默认只显示 orb 图标，模型运行时才显示文字 */}
          <AgentStatusBar
            approvalReq={approvalReq}
            streamKind={streamKind}
            curToolName={curToolName}
            thinkDone={thinkDone}
            streaming={streaming}
            loading={loading}
            compacting={compacting}
            orbTheme={orbTheme}
            modelRunning={!!runningCard}
          />
          {/* ② 输入区（中间）：引用胶囊 + 文本 */}
          <div className="chat-input-mid">
            <div className="chat-input-textwrap">
              {refChips.map(chip => {
                const tipId = `ref-${chip.id}`
                return (
                <div className={`agent-ref-chip${tipKey === tipId ? ' tip-open' : ''}`} key={chip.id}
                  onMouseEnter={() => openTip(tipId)} onMouseLeave={closeTip}>
                  <QuoteIcon size={12} className="agent-ref-chip-icon" />
                  <span className="agent-ref-chip-label">引用</span>
                  <button className="agent-ref-chip-remove" onClick={() => removeRefChip(chip.id)} disabled={loading}><XIcon size={10} /></button>
                  {/* 预览内容只在悬停（tipKey 命中）时挂载：每颗胶囊都常驻一份完整 Markdown
                      （可能含 KaTeX）的话，输入区每次重渲染都要把它们重新解析一遍。
                      外层 div 保留，opacity 过渡与悬停桥不受影响。 */}
                  <div className="agent-ref-chip-tip chat-msg-markdown">
                    {tipKey === tipId && <Markdown content={chip.text} final variant="agent" />}
                  </div>
                </div>
                )
              })}
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
                <div className={`chat-input-fold-chip${tipKey === 'fold' ? ' tip-open' : ''}`}
                  onMouseEnter={() => openTip('fold')} onMouseLeave={closeTip}>
                  <AlignLeft size={12} className="chat-input-fold-chip-icon" />
                  {/* 标签可点：把胶囊里的正文放回输入框继续编辑。
                      此前胶囊只有「删除」，长文本一旦被折叠就只能重打。 */}
                  <button
                    type="button"
                    className="chat-input-fold-chip-label"
                    aria-label="展开编辑"
                    {...tip('点击展开编辑')}
                    onClick={() => {
                      setInput(packedInput)
                      setPackedInput(null)
                      requestAnimationFrame(() => textareaRef.current?.focus())
                    }}
                  >已折叠 {packedInput.split('\n').length} 行</button>
                  <button className="agent-ref-chip-remove" aria-label="移除" {...tip('移除')} onClick={() => setPackedInput(null)}>
                    <XIcon size={10} />
                  </button>
                  {/* 同引用胶囊：折叠正文的预览也只在悬停时解析 */}
                  <div className="chat-input-fold-chip-tip chat-msg-markdown">
                    {tipKey === 'fold' && <Markdown content={packedInput} final variant="agent" />}
                  </div>
                </div>
              ) : null}
              {/* 附件胶囊排在正文上方（同一容器内 width:100% 自成一整行） */}
              {attachTray}
              {/* 图片胶囊：自成一整行排在正文上方——胶囊在上、文字在下，两者彻底分开。
                  此前是「正文里插行内记号 + 按量出的记号坐标盖胶囊」，需要隐形镜像逐字量算、
                  还要跟 textarea 的滚动同步，量偏一点胶囊就错位；改成独立一行后这套全都不需要了。
                  胶囊本体仍是消息气泡那副 .agent-img-pill（悬停预览卡 + 点开右侧预览）。 */}
              {imageAtts.length > 0 && (
                <div className="chat-input-imgrow">
                  {imageAtts.map(att => (
                    <ImagePill key={att.id} name={att.name} src={att.dataUrl}
                      onRemove={() => removeAttachment(att.id)} removeDisabled={loading}
                      onClick={() => onPreviewImage(att)}
                      clickHint="点击在右侧预览" />
                  ))}
                  {/* 「全部清除」在文件托盘里已有一颗；只有这里才渲染时补上，免得并排出现两颗 */}
                  {attachedFiles.length > 1 && fileChips.length === 0 && (
                    <button className="chat-attach-clear-all" onClick={clearAttachments} disabled={loading}>
                      <XIcon size={12} />全部清除
                    </button>
                  )}
                </div>
              )}
              <div className="chat-input-tabox">
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  aria-label="消息输入框"
                  placeholder={plainChat ? '输入消息，Enter 发送 · Shift+Enter 换行' : '输入消息，Enter 发送 · Shift+Enter 换行 · / 命令 · @ 引用文件'}
                  rows={1} value={input}
                  onChange={handleInputChange} onKeyDown={handleKeyDown} onPaste={handlePaste}
                />
              </div>
            </div>
            {loading && runningCard && (
              <AgentQueueActions
                canSend={hasPayload}
                queueInfo={queueInfo}
                onSend={handleSend}
                activeSessionId={activeSessionId}
                followUpQueueRef={followUpQueueRef}
                prevQueueRef={prevQueueRef}
                setQueueInfo={setQueueInfo}
                tip={tip}
              />
            )}
          </div>
          {/* ③ 底部按钮行：附件 / 麦克风（左）… 上下文 · 模型 · 搜索 · 发送（右）
              （工作区目录与 git 分支已上移到 .chat-input-context） */}
          <div className="chat-input-tools">
            <AniIconButton className="chat-upload-btn" icon={PlusIcon} size={14} onClick={() => fileInputRef.current?.click()} title="添加附件" />
            {/* 「选择文件」浏览的是工作区目录（AgentFilePicker），编码专属：通用模式收掉。
                「添加附件」走系统文件选择，聊天同样用得上，两模式都保留。
                按钮与面板包进相对定位锚点，面板贴按钮正上方弹出、打开才挂载——
                与「选择模型」/「思考程度」同一套逻辑（CSS 负责 bottom:100% + 左缘对齐）。 */}
            {!plainChat && (
              <div className="chat-attach-anchor">
                <AniIconButton ref={attachBtnRef} className={`chat-attach-btn${filePickerOpen ? ' active' : ''}`} icon={FolderOpenIcon} size={14} onClick={toggleFilePicker} title="选择文件" />
                {filePickerOpen && activeProject.workspaceDir && (
                  <AgentFilePicker
                    workspaceDir={activeProject.workspaceDir}
                    attached={filePickerAttached}
                    onAttach={handleFilePickerAttach}
                    onRemove={handleFilePickerRemove}
                    onClose={() => setFilePickerOpen(false)}
                    triggerRef={attachBtnRef}
                  />
                )}
              </div>
            )}
            <AniIconButton className={`chat-mic-btn${listening || micTranscribing ? ' listening' : ''}`} icon={MicIcon} size={14} onClick={toggleListen} disabled={micTranscribing} title={micTranscribing ? '识别中…' : listening ? '停止录音' : '语音输入'} />
            {/* 预填充进度：吃掉左侧按钮组（附件/选择文件/语音）与右侧控件组
                （上下文 · 模型 · 搜索 · 思考程度 · 发送）之间那段空白。
                靠 flex:1 自适应宽度，无进度时整块不渲染，右侧那组的
                margin-left:auto 会自动接管这段空白 —— 布局与原来一致。 */}
            <AgentPrefillBar />
            {/* 工作区目录与 git 分支已上移到输入框上方那一行（.chat-input-context），
                它们描述的是「这段对话在哪个工作区里」，属于上下文而非操作按钮。 */}
            <AgentTopBarCtx
              active={contextModalOpen}
              onToggle={() => setContextModalOpen(v => !v)}
              btnRef={ctxInlineRef}
            />
            {/* 模型按钮 + 选择面板包进一个相对定位锚点：面板像思考等级/搜索菜单那样
                直接弹在按钮正上方（CSS 负责 bottom:100% + 右缘对齐），不再靠 JS 算坐标。 */}
            <div className="chat-model-anchor">
              <button
                ref={modelBtnRef}
                className={`chat-model-dropdown${modelPickerOpen ? ' active' : ''}${runningCard ? ' running' : ''}${runningCard?.ready ? ' ready' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={modelPickerOpen}
                aria-label="选择模型"
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
              {/* 与搜索/思考等级菜单同一套弹出逻辑：打开才挂载，点外部或 Esc 关闭。
                  双栏：左栏来源（llama.cpp / 端点名…），右栏只列选中来源的模型；
                  只有一个来源时不渲染左栏，退回原单列样式。底部入口横贯全宽、不随列表滚动。 */}
              {modelPickerOpen && (
                <div ref={modelPickerRef} className="chat-model-picker" role="group" aria-label="选择模型">
                  <div className="chat-model-picker-body">
                    {modelGroups.length > 1 && (
                      <div className="chat-model-picker-nav" aria-label="模型来源">
                        {modelGroups.map(g => {
                          const logoKey = `src:${g.title}`
                          const logo = modelLogos[logoKey]
                          const active = g.title === shownModelGroup?.title
                          return (
                            <button
                              key={g.title}
                              type="button"
                              aria-pressed={active}
                              aria-label={g.title}
                              className={`chat-model-nav-item${active ? ' active' : ''}`}
                              {...tipHover(`${g.title} · 右键设置图标`)}
                              onClick={() => setActiveModelGroup(g.title)}
                              onContextMenu={e => {
                                e.preventDefault()
                                // 还没图标 → 直接选图；已有 → 弹出更换/移除菜单
                                if (!logo) { void pickSourceLogo(logoKey); return }
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                setSourceLogoMenu({ id: logoKey, x: rect.right + 4, y: rect.top })
                              }}
                            >
                              {logo
                                ? <img src={logo} alt="" className="chat-model-nav-logo" />
                                : <span className="chat-model-nav-letter">{g.title.trim().charAt(0).toUpperCase()}</span>}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    <div className="chat-model-picker-list" role="listbox" aria-label="模型列表">
                      {shownModelGroup && (
                        <>
                          {shownModelGroup.rows.map(row => {
                            const card = row.card
                            // 端点记录：卡片行按 endpointId 查，端点行（还没建卡）就是它自己
                            const ep = card ? endpointOfCard(card, modelEndpoints) : row.endpoint
                            const running = card?.status === 'running'
                            const pick = () => { if (card) void handleModelAction(card); else if (row.endpoint) void pickEndpointModel(row.endpoint, row.modelId ?? '') }
                            // 能力三态：暗=不支持，中性=支持但没启动，点亮=正在跑且真实可用。
                            // 视觉单独判：纯文本模型启动时不挂 --mmproj，这时即使主模型架构能看图也保持熄灭。
                            const caps = card ? modelCaps[card.template.id] : null
                            const capOn = {
                              thinking: !!caps?.thinking,
                              tools: !!caps?.tools,
                              vision: !!caps?.vision && (ep?.kind === 'remote' ? ep.vision === true : hasVisionProjector(card?.template.args)),
                            }
                            const capClass = (kind: 'thinking' | 'tools' | 'vision') =>
                              `chat-model-cap cap-${kind}${capOn[kind] ? ' on' : ''}${running && capOn[kind] ? ' lit' : ''}`
                            return (
                              <div
                                key={row.key}
                                className={`chat-model-item ${card ? card.status : 'idle'}${card ? '' : ' pending'}`}
                                role="option"
                                aria-selected={!!running}
                                data-row
                                tabIndex={0}
                                onKeyDown={rovingKeyNav}
                                {...tipHover(row.name)}
                                onClick={pick}
                              >
                                <div className="chat-model-logo" onClick={e => { if (!card) return; e.stopPropagation(); toggleLogoMenu(e, card) }}>
                                  {card && modelLogos[card.template.id]
                                    ? <img src={modelLogos[card.template.id]!} alt={row.name} className="chat-model-logo-img" />
                                    : ep ? <ServerIcon size={11} /> : <ImageIcon size={11} />}
                                </div>
                                <div className="chat-model-item-info">
                                  <div className="chat-model-item-name">{row.name}</div>
                                  {card && (
                                    <span className="chat-model-caps">
                                      <span className={capClass('thinking')}><Brain size={11} /></span>
                                      <span className={capClass('tools')}><Wrench size={11} /></span>
                                      <span className={capClass('vision')}><Eye size={11} /></span>
                                    </span>
                                  )}
                                  <div className="chat-model-item-tail">
                                    {running && <CheckIcon size={12} className="chat-model-item-check" />}
                                    <button
                                      className="chat-model-item-action"
                                      aria-label={ep
                                        ? (ep.kind === 'remote'
                                          ? running ? '停用该端点（不会碰那边的服务）' : '探测并启用该端点'
                                          : running ? '断开接管（不会关掉那边的服务）' : '接管该端口上的服务')
                                        : undefined}
                                      {...(ep
                                        ? tipHover(ep.kind === 'remote'
                                          ? running ? '停用该端点（不会碰那边的服务）' : '探测并启用该端点'
                                          : running ? '断开接管（不会关掉那边的服务）' : '接管该端口上的服务')
                                        : {})}
                                      onClick={e => { e.stopPropagation(); pick() }}
                                    >
                                      {running ? <CircleStopIcon size={12} /> : ep ? <ServerIcon size={12} /> : <PlayIcon size={12} />}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="chat-model-attach-sep" />
                  <button className="chat-model-attach-entry" onClick={() => { setModelPickerOpen(false); setView('endpoints') }}>
                    <ServerIcon size={13} /> 管理外部端点…
                  </button>
                </div>
              )}
            </div>
            {/* 思考程度：两种模式都显示。聊天模式后台本就每次发送都下发思考程度
                （useAgentLoop 里 setThinkingLevel 不分模式），这里放开 UI 让它可见可控；
                模型不支持思考时主进程/SDK 自动 clamp，与编码模式行为一致。 */}
            <div
              ref={thinkLevelMenuRef}
              className={`chat-think-level${thinkLevelOpen ? ' open' : ''}`}
            >
              <button
                type="button"
                className="chat-think-level-trigger"
                disabled={loading}
                aria-haspopup="listbox"
                aria-expanded={thinkLevelOpen}
                aria-label="思考程度"
                onClick={() => setThinkLevelOpen(v => !v)}
              >
                <span className="chat-think-level-label">{thinkingLevel}</span>
              </button>
              {thinkLevelOpen && (
                <ul className="chat-think-level-menu" role="listbox" aria-label="思考程度">
                  {THINKING_LEVELS.map(l => (
                    <li
                      key={l}
                      className={`chat-think-level-item${l === thinkingLevel ? ' active' : ''}`}
                      role="option"
                      aria-selected={l === thinkingLevel}
                      data-row
                      tabIndex={0}
                      onKeyDown={rovingKeyNav}
                      onClick={async () => {
                        setThinkingLevel(l)
                        setThinkLevelOpen(false)
                        const cur = piReadyRef.current
                        if (cur.ready && cur.sid) {
                          // 主进程按模型能力 clamp 后回传实际生效档（如 max/xhigh 无映射→high），
                          // 回填后 UI 不再显示一个实际没生效的档位。
                          try {
                            const res = await window.api.piAgent.setThinkingLevel(`pi-${cur.sid}`, l)
                            if (res?.level && res.level !== l) setThinkingLevel(res.level)
                          } catch { /* 非致命 */ }
                        }
                      }}
                    >
                      {l}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* 网络搜索开关：只在编码模式出现。
                通用模式的工具开关（含网络搜索）已经统一在界面顶栏那个「工具」按钮里
                （见 AgentCodeViewLayout 的 chat-tools 菜单），这里再放一个就是同一份
                状态的第二个入口 —— 去掉，避免重复与语义混淆。
                编码模式没有那个顶栏菜单，搜索开关只能靠这里，必须保留。
                模式切换（编码 / 通用）在左侧会话栏顶部。 */}
            {!plainChat && (
              <div
                ref={searchMenuRef}
                className={`chat-search-switch${searchMenuOpen ? ' open' : ''}`}
              >
                <button
                  type="button"
                  className="chat-search-trigger"
                  disabled={loading}
                  aria-haspopup="listbox"
                  aria-expanded={searchMenuOpen}
                  aria-label="网络搜索"
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
                  <ul className="chat-search-menu" role="listbox" aria-label="网络搜索">
                    <li
                      className={`chat-search-item${!searchEnabled ? ' active' : ''}`}
                      role="option"
                      aria-selected={!searchEnabled}
                      data-row
                      tabIndex={0}
                      onKeyDown={rovingKeyNav}
                      onClick={() => applySearchChange(false, searchProvider)}
                    ><SearchX size={12} />关闭网络搜索</li>
                    <li
                      className={`chat-search-item${searchEnabled && searchProvider === 'bing' ? ' active' : ''}`}
                      role="option"
                      aria-selected={searchEnabled && searchProvider === 'bing'}
                      data-row
                      tabIndex={0}
                      onKeyDown={rovingKeyNav}
                      onClick={() => applySearchChange(true, 'bing')}
                    ><Globe size={12} />必应 Bing（国内）</li>
                    <li
                      className={`chat-search-item${searchEnabled && searchProvider === 'ddg' ? ' active' : ''}`}
                      role="option"
                      aria-selected={searchEnabled && searchProvider === 'ddg'}
                      data-row
                      tabIndex={0}
                      onKeyDown={rovingKeyNav}
                      onClick={() => applySearchChange(true, 'ddg')}
                    ><Search size={12} />DuckDuckGo（国际）</li>
                  </ul>
                )}
              </div>
            )}
            {loading ? (
              <AniIconButton className="btn btn-ghost chat-stop-btn" icon={CircleStopIcon} size={16} onClick={handleStop} title="停止" />
            ) : (
              <AniIconButton className="btn btn-primary chat-send-btn" icon={SendIcon} size={16} onClick={() => handleSend()} disabled={sendDisabled} title={sendTitle} />
            )}
          </div>
        </div>
      </div>
      {attPreview && <AttachmentTextPreview att={attPreview} onClose={() => setAttPreview(null)} />}
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleAttachmentSelect} />
    </div>
  )
}
