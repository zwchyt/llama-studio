// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-message —— 消息流渲染（顶栏指标 / 用户气泡 / 思考链 / 流式正文）  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「Markdown 渲染」区域与「模块级 UI 子组件」区域中的
// 消息渲染部分（ThinkBlock 家族 / StreamingContent / AgentMessageRow 等）。
// 逻辑与注释均未改动，仅补齐 import。
//
// 对外导出：AgentTopBarCtx、AgentPrefillBar、AgentMarkdown、UserMessageEntry、
//           ThinkBlock、HistorySummaryBubble、StreamingBadge、StreamingMarkdown、
//           StreamingContent、TopbarBtn、AniIconButton、renderSegmentsFor、
//           stoppedBadge、AgentMessageRow

import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { Brain, ChevronUp, AlignLeft, Play, Square, Trash2, Volume2 } from 'lucide-react'
import { ChevronRightIcon, CircleStopIcon, FileTextIcon, RefreshCwIcon, CopyIcon } from '@animateicons/react/lucide'
import { useStore } from '../../../store/useStore'
import { useCollapseAnimation, COLLAPSE_DURATION_MS } from '../../../utils/useCollapseAnimation'
import { useSmoothStream } from '../hooks/useSmoothStream'
import { ThinkTextContent } from './ThinkTextContent'
import { AttachmentTextPreview } from './AttachmentTextPreview'
import { Markdown } from '../../../markdown/markstream'
import { MermaidCard, parseContentToBlocks } from '../../../mermaid'
import { ChartCard } from '../../../recharts'
import { SvgCard } from '../../../svg/SvgCard'
import CodeBlock from '../../CodeBlock'
import { ToolCallGroup, FileChangeSummary } from '../agent-tools'
import { fmtCompactTok, fmtThinkDur, formatDuration } from '../utils/format'
import type { AgentMsgRowActions, RenderSegmentsOpts, AniIconHandle } from '../types'
import type { AgentMessage, Attachment } from '../../../../../shared/types'

// ── 顶栏指标隔离组件：自订阅 modelMetrics，避免主进程每 2s 广播指标时
//    触发整个工作台全量重渲染（原实现直接在 AgentCodeView 订阅整棵 modelMetrics 树）──
export const AgentTopBarCtx = React.memo(function AgentTopBarCtx({
  active,
  onToggle,
  btnRef,
}: {
  active: boolean
  onToggle: () => void
  btnRef: React.RefObject<HTMLButtonElement | null>
}) {
  const metrics = useStore(s => {
    const rc = s.cards.find(c => c.status === 'running')
    return rc ? s.modelMetrics[rc.template.id] : undefined
  })
  const ctxNCtx = metrics?.nCtx || 0
  const ctxUsed = metrics?.nPromptTokens || 0
  const ctxPct = ctxNCtx > 0 ? Math.min(100, (ctxUsed / ctxNCtx) * 100) : 0
  const ctxWarning = ctxPct >= 80
  const ctxNoModel = !metrics
  return (
    <button
      ref={btnRef}
      className={`agent-ctx-inline ${ctxWarning ? 'warn' : ''} ${active ? 'active' : ''}`}
      onClick={onToggle}
    >
      <span className="agent-ctx-inline-bar">
        <span className="agent-ctx-inline-fill" style={{ width: `${ctxPct}%` }} />
        <span className="agent-ctx-inline-mark" />
      </span>
      <span className="agent-ctx-inline-pct">{ctxNoModel ? '—' : `${ctxPct.toFixed(0)}%`}</span>
      {!ctxNoModel && (
        <span className="agent-ctx-inline-tokens">{`${fmtCompactTok(ctxUsed)}/${fmtCompactTok(ctxNCtx)}`}</span>
      )}
    </button>
  )
})

export const AgentPrefillBar = React.memo(function AgentPrefillBar() {
  const prefillProgress = useStore(s => {
    const rc = s.cards.find(c => c.status === 'running')
    return rc ? (s.modelMetrics[rc.template.id]?.prefillProgress ?? null) : null
  })
  const prefillActive = prefillProgress !== null && prefillProgress < 1
  const prefillDone = prefillProgress !== null && prefillProgress >= 1
  if (!prefillActive) return null
  return (
    <div
      className="metric-bar-wrap agent-prompt-build-bar"
      title={prefillDone ? '提示词加载完成' : '正在加载提示词…'}
    >
      <div
        className="metric-bar-fill"
        style={{ width: `${Math.min(100, (prefillProgress ?? 0) * 100)}%`, background: '#7c3aed', opacity: 0.7 }}
      />
    </div>
  )
})

// 完成态正文：final=true 收敛，代码块一次性高亮，mermaid 渲染成图表
export const AgentMarkdown = React.memo(function AgentMarkdown({ content }: { content: string }) {
  return <Markdown content={content} final variant="agent" />
})

// ── 用户消息气泡：纯文本渲染 + 超长折叠成胶囊 ────────────────────────────
// 用户输入一律按普通字符串显示：不走 Markdown（rehype-raw/sanitize 管线会把
// <LineChart> 这类自定义标签剥成空白）、不渲染 HTML/SVG/图表组件、不套代码块
// 框、不做语法高亮。{text} 文本插值天然转义，`<`、```、反引号都原样可见，
// 任何内容都不会「显示成空白」。pre-wrap + 等宽字体保留换行/空格/缩进，代码
// 结构不乱；超长行自动换行不撑破气泡。
// 超长消息折叠：超过阈值（行数/字符数双阈值）后整条消息收进一枚胶囊——单行
// 预览 + 行数 + 箭头，长文不塞进气泡；点击展开成完整气泡，底部「收起」退回。
// 复制按钮始终复制完整原文，发送给模型的内容不变。
const USER_FOLD_LINES = 10
const USER_FOLD_CHARS = 1000

// INPUT_FOLD_CAP 已抽至 agent-code/utils/constants.ts（输入区与消息区共用）

export const UserMessageEntry = React.memo(function UserMessageEntry({ content, packedText, attachments }: { content: string; packedText?: string; attachments?: Attachment[] }) {
  const [expanded, setExpanded] = useState(false)
  const [packedOpen, setPackedOpen] = useState(false)
  // 图片附件放大预览（点击缩略图 → 全屏）
  const [zoom, setZoom] = useState<string | null>(null)
  // 文件附件（PDF / DOCX / txt / 代码…）点开看抽取文本——即模型真正读到的那段
  const [previewAtt, setPreviewAtt] = useState<Attachment | null>(null)
  const images = useMemo(
    () => (attachments ?? []).filter(a => a.type === 'image' && (a.fullDataUrl || a.dataUrl)),
    [attachments]
  )
  const files = useMemo(
    () => (attachments ?? []).filter(a => a.type === 'file'),
    [attachments]
  )
  const imageNode = images.length > 0 ? (
    <div className="user-msg-images">
      {images.map((a, i) => (
        <img
          key={`${a.name}-${i}`}
          className="user-msg-image"
          src={a.dataUrl || a.fullDataUrl}
          alt={a.name}
          title={`${a.name}（点击放大）`}
          onClick={() => setZoom(a.fullDataUrl || a.dataUrl || null)}
        />
      ))}
    </div>
  ) : null
  const lightboxNode = zoom ? (
    <div className="user-msg-lightbox" onClick={() => setZoom(null)} title="点击任意处关闭">
      <img src={zoom} alt="" />
    </div>
  ) : null
  const fileNode = files.length > 0 ? (
    <div className="user-msg-files">
      {files.map((a, i) => (
        <button
          type="button"
          key={`${a.name}-${i}`}
          className="user-msg-file"
          title={`${a.name}（点击预览抽取到的文本）`}
          onClick={() => setPreviewAtt(a)}
        >
          <FileTextIcon size={12} />
          <span className="user-msg-file-name">{a.name}</span>
        </button>
      ))}
    </div>
  ) : null
  // 附件区统一出口：图片缩略图 + 文件卡片 + 两个浮层（图片全屏 / 附件文本预览）
  const attachmentNode = images.length > 0 || files.length > 0 ? (
    <>
      {imageNode}
      {fileNode}
      {lightboxNode}
      {previewAtt && <AttachmentTextPreview att={previewAtt} onClose={() => setPreviewAtt(null)} />}
    </>
  ) : null
  const text = typeof content === 'string' ? content : String(content ?? '')
  // 打包段是 outgoing 组装时的第一个 part（已 trim），content 一定以它开头；
  // 余下部分（用户后输入的文字 + 引用块）就是气泡正文
  const packed = packedText ?? ''
  const rest = packed && content.startsWith(packed)
    ? content.slice(packed.length).replace(/^\n+/, '')
    : content
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const foldable = useMemo(
    () => lineCount > USER_FOLD_LINES || text.length > USER_FOLD_CHARS,
    [lineCount, text]
  )

  // 含打包段：chip 显示打包内容（点击可展开/收起该段）+ 用户输入的文字照常显示
  if (packed) {
    return (
      <>
        <div
          className="chat-input-fold-chip user-msg-fold-chip"
          title={packedOpen ? '点击收起打包内容' : '点击显示打包内容'}
          onClick={() => setPackedOpen(v => !v)}
        >
          {packedOpen
            ? <ChevronUp size={12} className="chat-input-fold-chip-icon" />
            : <AlignLeft size={12} className="chat-input-fold-chip-icon" />}
          <span className="chat-input-fold-chip-label">已折叠 {packed.split('\n').length} 行</span>
        </div>
        {packedOpen ? (
          <div className="chat-msg-bubble chat-msg-markdown">
            <div className="user-plain-text">{packed}</div>
          </div>
        ) : null}
        {rest.trim() ? (
          <div className="chat-msg-bubble chat-msg-markdown">
            <div className="user-plain-text">{rest}</div>
          </div>
        ) : null}
        {attachmentNode}
      </>
    )
  }

  // 折叠态：与输入框打包 chip 完全同款的小胶囊（图标 + 已折叠 N 行 + 悬停全文
  // 预览），点击展开完整气泡；右对齐由 .chat-msg-user .chat-msg-body 的 flex-end 保证
  if (foldable && !expanded) {
    return (
      <>
        <div
          className="chat-input-fold-chip user-msg-fold-chip"
          title="点击展开完整内容"
          onClick={() => setExpanded(true)}
        >
          <AlignLeft size={12} className="chat-input-fold-chip-icon" />
          <span className="chat-input-fold-chip-label">已折叠 {lineCount} 行</span>
        </div>
        {attachmentNode}
      </>
    )
  }

  return (
    <>
    {/* 只发附件没写文字时正文为空：不渲染空气泡，只留下面的附件区 */}
    {text.trim() ? (
    <div className="chat-msg-bubble chat-msg-markdown">
      <div className="user-plain-text">{text}</div>
      {foldable ? (
        <button type="button" className="user-plain-toggle" onClick={() => setExpanded(false)}>
          <ChevronUp size={12} />收起
        </button>
      ) : null}
    </div>
    ) : null}
    {attachmentNode}
    </>
  )
})


// ── 思考链（reasoning）解析：把含 <think>...</think> 的内容拆成「思考 / 正文」片段 ──
export type ContentSegment = { type: 'text'; value: string } | { type: 'think'; value: string; closed: boolean }
export function parseThinkSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  let rest = content
  while (rest.length > 0) {
    const openIdx = rest.indexOf('<think>')
    if (openIdx === -1) {
      if (rest.trim()) segments.push({ type: 'text', value: rest })
      break
    }
    if (openIdx > 0 && rest.slice(0, openIdx).trim()) {
      segments.push({ type: 'text', value: rest.slice(0, openIdx) })
    }
    rest = rest.slice(openIdx + '<think>'.length)
    const closeIdx = rest.indexOf('</think>')
    if (closeIdx === -1) {
      segments.push({ type: 'think', value: rest, closed: false })
      break
    }
    segments.push({ type: 'think', value: rest.slice(0, closeIdx), closed: true })
    rest = rest.slice(closeIdx + '</think>'.length)
  }
  return segments
}

// ── segments 时间线（pi 模式）──
// 时间线切分在 runPiTurn 内实时构建（appendTextDelta/buildSegs）：
// 思考/正文增量按 <think> 边界切段、工具声明切段，事件到达顺序即真实时间线。
// 渲染采用「单容器」方案（见 renderSegmentsFor）：整条消息只有一个思考链容器，
// 思考段 / 工具卡 / 过程正文按时间线交错收纳其中，仅最终正文段独立成泡。

// 思考块渲染节流间隔（与正文流式落盘节奏 ~30ms 同频）。
// 此前 120ms（8fps）在思考吐字快时每 120ms 跳一大块文字（4-5 个 token），观感「一顿一顿」；
// StreamingThinkText 逐行渲染后每次更新的重绘成本只有一行，40ms（25fps）完全撑得住。
const THINK_THROTTLE_MS = 40
// MIN_EXEC_DISPLAY_MS 已抽至 agent-code/utils/constants.ts（Agent 循环与消息区共用）

// previewLineNoFromTarget 已抽至 agent-code/utils/dom.ts（预览区与消息区共用）

/* ── 像素网格（chevron 波前，Drive 变体）──
   思考状态的统一视觉：首 token 前（ThinkBlock pending 态）与思考块的
   「思考中」头部共用，保证等待窗口到思考流式的视觉全程一致，
   无切换突兀感。650ms 周期短于 720ms 扫过总长，两个波前在飞行。 */
const LOADER_CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

const ThinkGrid = React.memo(function ThinkGrid() {
  return (
    <span aria-hidden className="agent-think-grid">
      {LOADER_CHEVRON.map((d, i) => (
        <span key={i} className="agent-think-cell" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  )
})

// 思考链内的元素（按模型真实时间线排列）：思考续段文本 / 工具卡组 / 过程正文段。
// 供 ThinkBlock 收纳展示——单条消息的思考链 = 一个 ThinkBlock（单容器方案），
// 链内全部思考文本、工具卡与过程正文按时间线交错合并，不再按「思考→工具→正文」
// 切分多个独立思考块；仅最终正文段留在容器下方独立成泡。
// streaming：该思考续段正在流式生长（恢复思考场景，位于 items 而非 value）。
type ThinkChainItem =
  | { kind: 'think'; content: string; durationMs?: number; streaming?: boolean }
  | { kind: 'tools'; toolCalls: NonNullable<AgentMessage['toolCalls']>; durationMs?: number }
  | { kind: 'text'; content: string }

// 思考文本渲染（流式预览 / 完整纯文本窗口 / 短段 Markdown）已抽至
// ThinkTextContent.tsx；行窗口用共享组件 WindowedText.tsx：默认只挂载有界预览
// （THINK_PREVIEW_LINES / THINK_PREVIEW_CHARS），「查看完整思考」走行窗口
// （TEXT_ROW_CHARS 分段，超长自然行不再绕过窗口化）；复制始终使用完整原文。

// 思考段独立折叠块（链内嵌套折叠）：每个思考段（含首段）一个可收起/展开的子块。
// 折叠块跟随容器展开态：思考链被点开（或流式自动展开）时，链内思考内容默认全部
// 展开；容器收起后折叠块随之收起，再次点开再次展开。用户手动收起过的折叠块保持
// 粘性（容器重开不强行展开）。工具卡与过程正文不折叠，工具卡始终默认收起。
// 折叠用 max-height 像素过渡 + 保持挂载（不卸载 DOM），与容器级 ThinkBlock 同方案。
// 展开体设纵向高度上限（.agent-think-fold-body，内部滚动）：单段六七十行不再撑长整条链。
const ThinkSegmentFold = React.memo(function ThinkSegmentFold({ content, durationMs, streaming, containerExpanded }: {
  content: string
  durationMs?: number
  streaming?: boolean
  containerExpanded?: boolean
}) {
  const active = !!streaming || !!containerExpanded
  const bodyRef = useRef<HTMLDivElement>(null)
  const userToggledRef = useRef(false)
  const { expanded, visible, setExpanded, setVisible, expandedRef, onBodyTransitionEnd, collapse, toggle: handleToggle } =
    useCollapseAnimation(bodyRef, { initialExpanded: active, skipFirstAnim: active, beforeToggle: () => { userToggledRef.current = true } })
  // 隐藏段冻结展示输入并停止 rAF 节流；原文仍由消息数据保留，重开时读取最新值。
  // 必须同时检查外层思考链，否则收起外层后内部 streaming 仍会持续更新隐藏 DOM。
  const contentActive = visible && expanded && containerExpanded !== false
  const lastVisibleContent = useRef(content)
  if (contentActive) lastVisibleContent.current = content
  const throttle = content.length > 20000 ? 90 : content.length > 8000 ? 60 : THINK_THROTTLE_MS
  const renderContent = useFrameThrottledValue(lastVisibleContent.current, !!streaming && contentActive, throttle)
  // 折叠块跟随容器展开态：容器展开（点开思考链/流式自动展开）时思考内容默认展开；
  // 容器收起后随之收起（保持挂载）。用户手动收起过的折叠块保持粘性、不被强行展开。
  //
  // 展开侧走「渲染期同步置位」而不是 effect + rAF：容器展开时本段必须与容器同一个 commit
  // 就把内容挂上。旧写法下本段要晚两帧才挂载，而外层 .agent-think-anim 的 max-height
  // 过渡已经开跑 → 展开呈阶梯状、末段再跳一下。渲染期 setState 自身是 React 支持的
  // 「从 props 派生 state」用法，会立即重渲染本组件再提交，不产生额外帧。
  if (!userToggledRef.current && active && (!visible || !expanded)) {
    if (!visible) setVisible(true)
    if (!expanded) setExpanded(true)
  }
  // 收起侧仍留在 effect：collapse() 要读 DOM 高度并写 max-height，不能放在渲染期。
  useEffect(() => {
    if (userToggledRef.current) return
    if (active) return
    // 容器收起引起的收起：不跑本段自己的像素过渡，只切状态并保持内容高度，
    // 由外层 .agent-think-anim 统一按同一时长裁剪。
    // 否则外层与链内每个折叠块会同时各跑一遍过渡，两层叠加使「收起」的体感速度约为
    // 「展开」的两倍（内层先把内容压掉、外层再收窗口），这正是展开/收起节奏不一致的来源。
    // 内容保持挂载也让外层有东西可裁——提前卸载会让收缩途中出现一段空白。
    if (containerExpanded === false) {
      const el = bodyRef.current
      if (el) el.style.maxHeight = 'none'
      setExpanded(false)
      return
    }
    if (visible && expandedRef.current) collapse()
    else { setExpanded(false); setVisible(false) }
  }, [streaming, active]) // eslint-disable-line react-hooks/exhaustive-deps
  // 与 ThinkBlock 相同的首展开优化：容器预挂载后，各思考段的 Markdown 内容也在
  // 浏览器空闲时段预挂载（保持收起、不可见）——否则首次点开容器时每个折叠块
  // 才现解析 Markdown/KaTeX，多段叠加成一帧的重活，表现为首展开卡顿。
  useEffect(() => {
    if (visible) return
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setVisible(true), { timeout: 1500 })
      return () => window.cancelIdleCallback(id)
    }
    const t = setTimeout(() => setVisible(true), 300)
    return () => clearTimeout(t)
  }, [visible, setVisible])
  // 程序化展开（容器点开联动 / 流式自动展开）时直接置自适应高度：不走 0→scrollHeight
  // 过渡——容器高度测量早于折叠块展开，若留着 max-height:0 会出现「箭头已展开但内容
  // 被裁剪为空」。手动点击折叠头（userToggled）仍保留展开动画，跳过本 effect。
  // useLayoutEffect：绘制前生效，折叠块内容随容器同一帧完整呈现。
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (active && visible && expanded && el && !userToggledRef.current) el.style.maxHeight = 'none'
  }, [active, visible, expanded, renderContent])
  // 折叠体内滚动（展开体有高度上限）：流式时贴底跟随最新思考，用户向上滚动阅读时
  // 暂停贴底、滚回底部附近自动恢复；链运行中段结束不重置滚动位置（保持阅读位置），
  // 链结束后复位回顶部，再次展开从头阅读
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  // 完整思考窗口 / Markdown 的挂载门：初值直接 true。
  // 段体只有 visible 为真才渲染，visible 为真本身就意味着「要显示」，重型内容应当与段体
  // 同帧就位。旧写法 useState(active) 在首次挂载时 active 还是 false（外层尚未展开），
  // 于是先渲染轻量预览、几帧后才换成重型内容——展开瞬间的「闪一下」正来自这里。
  // 收起后释放逻辑不变：contentActive 变 false → 过渡结束后卸载。
  const [heavyMounted, setHeavyMounted] = useState(true)
  useEffect(() => {
    if (contentActive) { setHeavyMounted(true); return }
    // transitionend 可能因隐藏父容器、减少动画或卸载而缺失，提供超时释放兜底。
    // 超时必须晚于过渡时长（COLLAPSE_DURATION_MS），否则重型内容会在收起动画途中被卸载，
    // 收缩的最后一小段会露出空白。
    const timer = window.setTimeout(() => setHeavyMounted(false), COLLAPSE_DURATION_MS + 150)
    return () => window.clearTimeout(timer)
  }, [contentActive])
  const handleFoldTransitionEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    onBodyTransitionEnd(e)
    if (e.propertyName === 'max-height' && !expandedRef.current) setHeavyMounted(false)
  }, [onBodyTransitionEnd])
  useEffect(() => {
    if (!streaming || !contentActive) return
    const el = scrollRef.current
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight
  }, [renderContent, streaming, contentActive])
  useEffect(() => {
    if (active) return
    const el = scrollRef.current
    stickBottomRef.current = true
    if (el) el.scrollTop = 0
  }, [active])
  const handleBodyScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  // 稳定引用：避免每次渲染都用新箭头函数打破 ThinkTextContent 的 React.memo
  const renderMarkdown = useCallback((t: string) => <AgentMarkdown content={t} />, [])
  return (
    <div className="agent-think-fold">
      <button className="agent-think-fold-head" onClick={handleToggle}>
        {streaming ? (
          <span className="agent-think-fold-label live">思考中</span>
        ) : durationMs != null ? (
          <span className="agent-think-fold-label">Thought: {formatDuration(durationMs)}</span>
        ) : (
          <span className="agent-think-fold-label">思考过程</span>
        )}
        <ChevronRightIcon size={11} className={`agent-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {visible && (
        <div className="agent-think-fold-anim" ref={bodyRef} onTransitionEnd={handleFoldTransitionEnd}>
          <div className="agent-think-fold-body" ref={scrollRef} onScroll={handleBodyScroll}>
            <ThinkTextContent text={streaming ? renderContent : lastVisibleContent.current} streaming={streaming} mounted={heavyMounted} renderMarkdown={renderMarkdown} />
          </div>
        </div>
      )}
    </div>
  )
})

export const ThinkBlock = React.memo(function ThinkBlock({ value, closed, isStreaming, msgStreaming, bodyAppeared, durationMs, items, onPreviewFile, canUndoFor, onUndo, pending, streamStartAt, runTotalMs, meta }: {
  value: string; closed: boolean; isStreaming?: boolean; msgStreaming?: boolean; bodyAppeared?: boolean; durationMs?: number
  // pending：首 token 前占位态（同一思考卡头部：「思考中」+ 流开始连续计时，不挂载内容），
  // 首个思考段到达后由同组件原地接管——不再「ThinkingLoader → ThinkBlock」两元素切换，
  // 消除视觉跳变与计时回退（loader 的 3.2s → 思考块重新从 0 数的现象）。
  pending?: boolean
  // streamStartAt：流开始时刻（ms）——实时头部时间据此连续计时（含 TTFT），不回退
  streamStartAt?: number
  // runTotalMs：本轮总耗时的定格值（整段墙钟）。有值时完成态头部直接用它，
  // 避免「分段时长之和」（不计正文输出与段间重新请求等待）与流式墙钟两套口径不一致导致跳变。
  runTotalMs?: number
  // meta：模型名 + token 计数徽标（调用方按流式/完成态构造），常驻头部「思考过程/思考已中断」
  // 两分支、完成后不消失——取代原「正文底部流式徽标、完成后消失」的展示位置。
  meta?: React.ReactNode
  // 收纳在本思考块展开体内的链内元素（首段思考 value 之后的交错序列：
  // think 续段 = 后续思考文本；tools = 工具卡组）。无则思考块保持纯文本。
  // 配套渲染回调与 ToolCallGroup 一致（文件预览跳转 / 撤销），由调用方透传。
  items?: ThinkChainItem[]
  onPreviewFile?: (p: string, line?: number) => void
  canUndoFor?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => boolean
  onUndo?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const userToggledRef = useRef(false)
  // 自动折叠单向锁：本次挂载内一旦因「结论正文出现 / 运行结束」自动收起，后续
  // 思考↔正文交替（thinkDone/bodyAppeared 电平翻转）不再自动重开容器——新一轮
  // 思考由链内 ThinkSegmentFold 各自承载，容器保持收起直到用户手动点开。
  const autoCollapsedRef = useRef(false)
  // 标记「本次 expanded=true 是用户手动点击展开」：仅这类展开走 max-height 像素过渡动画，
  // 自动展开（流式 / 容器联动）仍走自适应高度（见下方 useLayoutEffect）。为 true 时表示
  // 「这一次展开」需要动画，由 useLayoutEffect 消费放行，过渡结束（或收起）时复位。
  const manualExpandRef = useRef(false)
  const { expanded, visible, setExpanded, setVisible, expandedRef, collapse: autoCollapse, onBodyTransitionEnd: rawBodyTransitionEnd, toggle: handleToggle } =
    useCollapseAnimation(bodyRef, {
      initialExpanded: isStreaming ?? false,
      beforeToggle: () => {
        userToggledRef.current = true
        // 点击时若当前是收起态 → 这次是「手动展开」，需要走动画
        manualExpandRef.current = !expandedRef.current
      },
    })
  // 过渡结束后：手动展开的标记复位，并把 max-height 落回 none 以自适应后续内容增长。
  const handleBodyTransitionEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName === 'max-height') manualExpandRef.current = false
    rawBodyTransitionEnd(e)
  }, [rawBodyTransitionEnd])
  // 仅当「正在流式」时才显示「思考中」转圈。注意不能用 !closed 参与判断：
  // 模型在「调用工具、不输出闭合 </think>」时 closed 恒为 false，若用 !closed 会让
  // 思考块永远转圈，直到下一轮才补上闭合标签。改为只看 isStreaming（= 真正流式且未闭合），
  // 流式一结束（进入工具执行阶段）思考块立即停止转圈。
  const thinking = isStreaming
  // 思考链内全部工具卡（items 中 tools 组并集）：存在未完成者（待执行/执行中/待确认）
  // 则思考链保持展开显示工具执行态（等待工具结果期间不收起），全部完成后恢复自动收起；
  // 工具总数用于折叠头部「N 次工具调用」标识。
  const chainToolCalls = (items ?? []).flatMap(it => (it.kind === 'tools' ? it.toolCalls : []))
  const hasLiveTools = !!chainToolCalls.some(t => (t.status ?? 'pending') !== 'done')
  const toolCount = chainToolCalls.length
  // 思考链累计思考时长 = 首段 durationMs + 链内各思考续段 durationMs 之和。
  // 头部「思考了 X 秒」与「思考中 X 秒」都用它（+ 当前未定格段的实时 elapsed），
  // 保证时间跨思考段/工具阶段连续增长、不回退：是整条思考链的思考总时间，而非首段时长。
  const chainTotalMs = (durationMs ?? 0) + (items ?? []).reduce(
    (acc, it) => acc + (it.kind === 'think' ? (it.durationMs ?? 0) : it.kind === 'tools' ? (it.durationMs ?? 0) : 0),
    0
  )
  // 「思考链总计时」：头部时间 = 已定格思考段累计 + 已固化工具阶段 + 当前阶段实时读秒。
  // 阶段划分：think（真流式思考中，含工具批之间等待下一轮思考的间隙——运行未结束，计时
  // 继续走）/ tools（链内工具执行中、消息仍流式）/ idle（链结束：最终正文已出现或消息完成）。
  // tools 阶段实时读秒，阶段结束时把耗时固化进 frozenToolsRef——时间跨思考段/工具执行
  // 连续增长、不回退：工具调用期间头部时间继续走，不再停止。
  const [elapsedMs, setElapsedMs] = useState(0)
  const phaseStartRef = useRef<number | null>(null)
  const frozenToolsRef = useRef(0)
  // pending 占位态以 isStreaming=true 挂载（同一「思考中」视觉），phase 自然归入 think，时钟照常走动
  // 阶段划分只看「运行是否结束」，不看 bodyAppeared（「最后一段是正文」是流式临时态，
  // 新一轮思考一到就翻回 false）：运行中时钟连续走（streamStartAt 含 TTFT 不回退），
  // 运行结束才落 idle 定格——头部时间在流式全程连续增长，只在 done 时定格一次。
  const phase: 'think' | 'tools' | 'idle' = isStreaming
    ? 'think'
    : msgStreaming
      ? (hasLiveTools ? 'tools' : 'think')
      : 'idle'
  const phaseRef = useRef<'think' | 'tools' | 'idle'>('idle')
  useEffect(() => {
    const prev = phaseRef.current
    phaseRef.current = phase
    // 退出 tools 阶段：固化该阶段已读秒时长（思考段累计在 chainTotalMs，工具段在此固化）。
    // 工具批全 done 时已把该批跨度定格进 seg.durationMs（chainTotalMs 已含），
    // 这里只补未定格的剩余（多批工具时中间批已定格，差额 = 最后一批的实时跨度），避免双计。
    if (prev === 'tools' && phase !== 'tools' && phaseStartRef.current != null) {
      const stamped = (items ?? []).reduce(
        (acc, it) => acc + (it.kind === 'tools' ? (it.durationMs ?? 0) : 0),
        0
      )
      frozenToolsRef.current += Math.max(0, (Date.now() - phaseStartRef.current) - stamped)
    }
    if (phase === 'idle') { phaseStartRef.current = null; setElapsedMs(0); return }
    if (phase !== prev) { phaseStartRef.current = Date.now(); setElapsedMs(0) }
    if (phaseStartRef.current == null) phaseStartRef.current = Date.now()
    setElapsedMs(Date.now() - phaseStartRef.current)
    const timer = setInterval(() => setElapsedMs(Date.now() - (phaseStartRef.current ?? Date.now())), 100)
    return () => clearInterval(timer)
  }, [phase])
  // 头部展示的总时长：idle 时优先用本轮墙钟定格值（与流式最后一帧同一个数）；
  // 旧消息无该字段时回退到「思考段累计 + 固化工具时长」；think/tools 时实时跳动。
  const headMs = phase === 'idle'
    ? runTotalMs ?? chainTotalMs + frozenToolsRef.current
    : streamStartAt != null
      ? Date.now() - streamStartAt
      : chainTotalMs + frozenToolsRef.current + elapsedMs

  // 主文本（value = 首个思考段）是否为当前生长段：恢复思考（思考→工具→思考）后
  // 生长段位于 items（streamThinkItem），value 已定格。节流与逐行渲染管线
  // 已下沉到 ThinkSegmentFold（每个思考段独立折叠块各自持有一套）。
  const streamThinkItem = (items ?? []).find((it): it is Extract<ThinkChainItem, { kind: 'think' }> => it.kind === 'think' && !!it.streaming)

  useEffect(() => {
    if (userToggledRef.current) return
    // pending 占位态：内容尚未到达，不挂载 body
    if (pending) return
    // 运行中出现新的活动（思考恢复 / 还有未完成的工具）→ 展开，并解除上一次因「正文出现」
    // 做的收起：说明刚才那段正文不是最终结论而是过程文字（模型常在调用工具前先说一句说明）。
    // 不做这一步就会出现「一开始写文件整条思考链缩掉、后面再也不回来」。
    if (thinking || hasLiveTools) {
      setVisible(true)
      setExpanded(true)
      if (msgStreaming) autoCollapsedRef.current = false
      return
    }
    // 运行中且还在思考 / 等工具结果：保持展开。
    if (msgStreaming && !bodyAppeared) return
    // 收起时机：最终正文一开始输出（bodyAppeared，把版面让给结论气泡），或整轮已结束。
    // 已收起过就不再重复调用；运行结束后的收起是终态，不再自动重开。
    if (autoCollapsedRef.current) return
    autoCollapsedRef.current = true
    // 走 collapse() 的像素过渡且保持挂载（不再 setVisible(false) 卸载 DOM）——
    // 卸载会在下一轮思考/重开时全量重解析 Markdown/KaTeX，表现为内容闪断。
    autoCollapse()
  }, [thinking, hasLiveTools, pending, msgStreaming, bodyAppeared, autoCollapse])

  // closed 在「segments 渲染点」等于「本次运行已结束」（closed={!streaming}，单调翻转一次）；
  // 但另一个调用点传的是 `lastClosed || thinkDone`——思考段一闭合、或一进入工具/正文阶段就为真，
  // 运行中途也为真。所以这里必须再加 msgStreaming 守卫：运行期间不收起，只有整轮结束才补齐收尾。
  useEffect(() => {
    if (closed && !msgStreaming && !thinking && !hasLiveTools && !userToggledRef.current && expandedRef.current) {
      autoCollapsedRef.current = true
      autoCollapse()
    }
  }, [closed, msgStreaming, thinking, hasLiveTools, autoCollapse, expandedRef])

  // 首展开卡顿优化：挂载后在浏览器空闲时段预挂载折叠体（保持收起、max-height 0
  // 不可见），把 Markdown/KaTeX 的首次解析成本从「首次点击展开」那一帧挪到空闲期；
  // 之后展开走「已挂载」路径（纯 max-height 过渡，无重挂载）→ 不卡。
  // 消息列表有虚拟窗口，预挂载规模受窗口限制，长会话不会因此全量解析。
  useEffect(() => {
    if (visible || pending) return
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setVisible(true), { timeout: 1500 })
      return () => window.cancelIdleCallback(id)
    }
    const t = setTimeout(() => setVisible(true), 300)
    return () => clearTimeout(t)
  }, [visible, pending, setVisible])

  const prevThinkingRef = useRef(thinking)
  useEffect(() => {
    if (prevThinkingRef.current && !thinking) userToggledRef.current = false
    prevThinkingRef.current = thinking
  }, [thinking])

  // 展开/收起用 max-height 像素过渡（见 agent-code.css）：由 useCollapseAnimation 提供
  // handleToggle / onBodyTransitionEnd。关键：首次展开挂载 Markdown 后【保持挂载】，
  // 收起只把 max-height 收到 0（不卸载 DOM）。否则每次收起卸载、展开重新挂载会重解析
  // Markdown（KaTeX/高亮），在展开瞬间造成明显卡顿。

  // 容器展开时直接以自适应高度呈现（绘制前置 none，不走 0→测量高度 过渡）：
  // 容器高度测量发生在链内折叠块展开之前，测量值偏小——若走过渡，动画期间内容被
  // 裁剪、过渡结束后再「长高」，表现为展开卡顿/回跳。收起仍保留像素过渡动画。
  //
  // 例外：用户「手动点击」展开时必须走像素过渡（0 → scrollHeight），否则无动画。
  // 原因：手动展开时 useCollapseAnimation.expand() 刚把 max-height 设为具体像素值，
  // 若同一帧本 effect 又置 none，过渡的起止值都被抹掉 → 浏览器直接跳到最终高度，
  // 表现为「展开生硬、收起才有缓冲」的不对称。用 manualExpandRef 放行手动展开一帧，
  // 由 transitionend（onBodyTransitionEnd）在动画结束后再置 none 自适应。
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !expanded) return
    if (manualExpandRef.current) return // 手动展开：保持 expand() 设好的像素值，交给过渡
    el.style.maxHeight = 'none'
  }, [expanded])

  // 头部「思考中」状态判定：消息仍在流式即「思考中」（思考/工具/正文/段间间隙统一），
  // 不再看 bodyAppeared（流式临时态，会在两种标题间反复重建）。「思考过程 +
  // 思考了 X 秒」的定格标题只在运行结束（done）时生成一次。
  const showThinking = !!msgStreaming
  // 停止判定必须排除运行中：closed={!streaming} 后运行期间 closed 恒 false，
  // 若不带 msgStreaming 守卫，正文/工具阶段（thinking=false）会被误判「已中断」
  // 而给容器加上 stopped 样式。
  const wasStopped = !msgStreaming && !thinking && !closed
  return (
    <div className={`agent-think ${thinking ? 'thinking' : ''} ${expanded ? 'expanded' : ''} ${wasStopped ? 'stopped' : ''}`}>
      <button className="agent-think-toggle" onClick={handleToggle}>
        {showThinking ? (
          <span className="agent-think-status">
            {/* 思考中（含首 token 前 pending 占位）：像素网格 + 流光文案 + 连续计时，全程同一视觉 */}
            <ThinkGrid /> 思考中
            {/* 实时总时长（含固化工具时长）：思考链未结束前一直显示并持续增长，
                pending → 思考同一连续时钟（streamStartAt），不回退 */}
            <span className="agent-think-dur">{fmtThinkDur(headMs)}</span>
            {/* 工具执行中：头部同时显示工具总数徽标（与完成态一致） */}
            {toolCount > 0 && <span className="agent-think-tools-badge">{toolCount} 次工具调用</span>}
            {/* 模型名 + token 计数：思考链阶段也常驻（token 源 = 含思考标签的流文本，实时估算增长） */}
            {meta}
            <ChevronRightIcon size={13} className={`agent-think-chevron ${expanded ? 'open' : ''}`} />
          </span>
        ) : wasStopped ? (
          <span className="agent-think-status">
            <Brain size={13} className="agent-think-brain" /> 思考已中断
            {toolCount > 0 && <span className="agent-think-tools-badge">{toolCount} 次工具调用</span>}
            {meta}
            <ChevronRightIcon size={13} className={`agent-think-chevron ${expanded ? 'open' : ''}`} />
          </span>
        ) : (
          <span className="agent-think-status">
            <Brain size={13} className="agent-think-brain" /> 思考过程
            {headMs > 0 && <span className="agent-think-dur">思考了 {fmtThinkDur(headMs)}</span>}
            {toolCount > 0 && <span className="agent-think-tools-badge">{toolCount} 次工具调用</span>}
            {meta}
            <ChevronRightIcon size={13} className={`agent-think-chevron ${expanded ? 'open' : ''}`} />
          </span>
        )}
      </button>
      {visible && (
        <div className="agent-think-anim" ref={bodyRef} onTransitionEnd={handleBodyTransitionEnd}>
          {/* 裁剪层（无 padding/border）做 max-height 动画；内容层承载 padding/字体；首次展开后保持挂载，收起只收到 0；
	              流式期间父组件已不会再高频重渲染（store 节流 + 模块级 memo），
	              因此过渡期间 Markdown 不会被重解析，不会卡。 */}
          <div className="agent-think-body">
            {value ? (
              // 首个思考段：独立折叠块（流式中自动展开逐行渲染，完成后自动收起，
              // 「Thought: X」时长上移到折叠头；手动操作后该段内不再被自动干预）
              <ThinkSegmentFold
                content={value}
                durationMs={durationMs}
                streaming={thinking && !streamThinkItem}
                containerExpanded={expanded}
              />
            ) : thinking ? (
              // pending 阶段（首 token 未到 / 模型加载上下文中）：动态等待提示，替代生硬的「（空）」
              <span className="agent-think-waiting"><i /><i /><i />正在加载上下文…</span>
            ) : (
              <span className="agent-think-empty">（暂无内容）</span>
            )}
            {/* 链内元素（思考续段 / 工具卡组 / 过程正文段）按模型时间线交错排列在首段下方，
                思考续段同样为独立折叠块；工具卡与过程正文不折叠、保持常显；
                调用窗口由调用方保证有 items 时必传渲染回调 */}
            {items && items.length > 0 && items.map((it, idx) => (
              <div key={idx} className={`agent-think-item${it.kind === 'text' ? ' agent-think-prose' : ''}`}>
                {it.kind === 'think'
                  ? (
                    <ThinkSegmentFold
                      content={it.content}
                      durationMs={it.durationMs}
                      streaming={it.streaming}
                      containerExpanded={expanded}
                    />
                  )
                  : it.kind === 'tools'
                    ? (
                      <ToolCallGroup
                        toolCalls={it.toolCalls}
                        onPreviewFile={onPreviewFile!}
                        canUndoFor={canUndoFor}
                        onUndo={onUndo}
                      />
                    )
                    : (
                      // 过程正文段：阶段性输出按时间线收纳链内（最终结论在容器下方独立成泡）；
                      // 文字用主文字色（agent-think-prose），比弱化的思考文本更黑更明显，区分主次
                      <AgentMarkdown content={it.content} />
                    )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

// ── 历史摘要气泡：会话顶部展示「发送给模型的早期对话压缩摘要」──
// 默认折叠，展开后用 AgentMarkdown 渲染摘要。原始历史消息在界面上仍全部保留，
// 本气泡仅额外展示被压缩、发送时省略的内容，参照 ThinkBlock 的折叠交互与样式。
export const HistorySummaryBubble = React.memo(function HistorySummaryBubble({ summary, count }: { summary: string; count: number }) {
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)
  const handleToggle = () => {
    if (expanded) { setExpanded(false); setVisible(false) }
    else { setVisible(true); requestAnimationFrame(() => setExpanded(true)) }
  }
  return (
    <div className={`agent-think agent-history-summary ${expanded ? 'expanded' : ''}`}>
      <button className="agent-think-toggle" onClick={handleToggle}>
        <span className="agent-think-status"><Brain size={12} /> 历史摘要（已压缩 {count} 条早期消息）</span>
        <ChevronRightIcon size={13} className={`agent-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {visible && (
        <div className={`agent-think-body agent-think-summary-body ${expanded ? 'open' : ''}`}>
          {summary ? <AgentMarkdown content={summary} /> : <span className="agent-think-empty">（暂无摘要内容）</span>}
        </div>
      )}
    </div>
  )
})

// ── 流式元信息徽标（参考 pi-web 的模型输出文字流式设计）──
// 展示：模型名 + 解码 token 数 + 实时生成速度 t/s。
// 两者都用服务端真实数据（与「模型数据」监控面板的「生成进度」同源同义）：
// token 数 = /slots 的 n_decoded 原值；t/s = n_decoded 差分 / 时间（2s 广播粒度）。
// 不再做任何本地估算（estimateTextTokens 已从本组件移除）。
export const StreamingBadge = React.memo(function StreamingBadge({ modelLabel, live = true, persistedTps, onRate, decoded, templateId }: {
  modelLabel?: string
  live?: boolean
  persistedTps?: number          // 完成态（刷新后）从消息还原持久化的最后速率
  onRate?: (v: number | null) => void  // 采样值上报（供持久化进消息，刷新后还原 t/s）
  decoded?: number               // 完成态：消息持久化的 n_decoded 原值（刷新后还原，不跟随当前变化）
  templateId?: string            // 模型指标 key（modelMetrics[templateId].nDecoded）
}) {
  // 只订阅本组件：主进程每 2s 广播指标时仅徽标重渲染，不触发行/整页
  const nDecoded = useStore(s => templateId ? s.modelMetrics[templateId]?.nDecoded : undefined)
  // 官方瞬时速率：llamacpp:predicted_tokens_seconds（/metrics，llama.cpp 自身计时的真实 t/s，
  // 非差分推算）；单值或历史数组（模型监控面板速度图同源）
  const decodeTokS = useStore(s => templateId ? s.modelMetrics[templateId]?.decodeTokS : undefined)
  const [tps, setTps] = useState<number | null>(null)
  // 上报回调走 ref：跨渲染稳定，避免父级箭头函数变化触发重复上报/重渲染循环
  const onRateRef = useRef(onRate)
  onRateRef.current = onRate
  // 流式中官方速率到达即显示并上报（供轮末持久化「刷新后还原」）；
  // 完成后保持最后一次采样值常驻，不跟随广播继续变化。
  const rate = Array.isArray(decodeTokS) ? decodeTokS[decodeTokS.length - 1] : decodeTokS
  const liveRate = live && rate != null && typeof rate === 'number' && rate > 0 ? rate : null
  useEffect(() => { if (live) setTps(liveRate) }, [live, liveRate])
  useEffect(() => { onRateRef.current?.(live ? liveRate : null) }, [live, liveRate])
  // token 数：流式中实时 n_decoded 原值；完成态用消息持久化值（不跟随当前变化）
  const shownTokens = live
    ? (nDecoded != null && nDecoded > 0 ? nDecoded : 0)
    : (decoded != null && decoded > 0 ? decoded : 0)
  // 流式采样值优先；完成态（tps 无采样、已保留或刷新后清空）用持久化值兜底
  const shownTps = tps ?? persistedTps ?? null
  // 速度分级配色：>=50 青、>=30 绿、>=15 黄、其余 红（与 pi-web 一致）
  const bg = shownTps == null ? 'var(--text-muted)' : shownTps >= 50 ? '#53b3cb' : shownTps >= 30 ? '#9bc53d' : shownTps >= 15 ? '#f9c22e' : '#e01a4f'
  return (
    <div className="agent-stream-meta">
      {modelLabel && <span className="agent-stream-model">{modelLabel}</span>}
      <span className="agent-stream-tokens" title="已解码 token 数（服务端 /slots n_decoded）">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
        </svg>
        {shownTokens}
      </span>
      {shownTps != null && (
        <span className="agent-stream-tps" style={{ background: bg }}>{shownTps.toFixed(1)} t/s</span>
      )}
    </div>
  )
})

/* ─────────────────────────────────────────────────────────
 * THINKING LOADER — 已并入 ThinkBlock 的 pending 态（首 token 前占位）：
 * 同一思考卡头部 + 流开始连续计时 + 「模型思考中」，不再单独组件切换，
 * 消除「ThinkingLoader → 思考块」两元素替换的视觉跳变与计时回退。
 * ───────────────────────────────────────────────────────── */

// ── 流式正文（非思考段）Markdown 渲染 ──
// 模型主输出在流式期间每 ~30ms 落盘一次（STREAM_FLUSH_MS）。旧实现对每次落盘都做一次
// react-markdown 全量解析（remark-gfm/math + rehype-katex/raw/sanitize），文本越长单帧越贵，
// 于是叠了「帧节流 + 轻量插件栈」两层防御。改走 markstream 后这两层都不需要了，
// 具体理由见下面 StreamingMarkdown 的注释。


// 帧对齐节流 hook：rAF + 时间戳，真正把「内容变化」与「显示更新」解耦。
// 此前把 setDisplay 放在依赖 value 的 effect 里：内容一变就立即重渲染，rAF 循环形同虚设，
// 每个 commit（~30ms）都全量重解析 markdown——节流从未生效。现在：
//  - on=false：直通，内容变化立即透传；
//  - on=true：内容变化只写 latestRef，由 rAF 循环按 throttleMs 上限统一取最新值更新。
// 主线程忙时 rAF 自然降频（不积压任务），空闲时按 throttleMs 上限更新，吐字平滑。
function useFrameThrottledValue(value: string, active: boolean | undefined, throttleMs: number): string {
  const on = !!active
  const latestRef = useRef(value)
  latestRef.current = value
  const [display, setDisplay] = useState(value)
  // 非节流态：内容变化立即透传。用渲染期同步而非 effect——effect 晚一个 commit，
  // 在「节流 → 非节流」切换（流式结束）与思考链展开的瞬间会多闪一帧旧内容。
  if (!on && display !== latestRef.current) setDisplay(latestRef.current)
  // 节流态：rAF 循环按 throttleMs 上限取最新内容更新（不依赖 value，循环不被重置）
  useEffect(() => {
    if (!on) return
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      if (t - last >= throttleMs) {
        last = t
        setDisplay(latestRef.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [on, throttleMs])
  return display
}

// 流式正文 Markdown：正文先经打字机平滑层（useSmoothStream），再交给 markstream。
// 历史沿革：旧 react-markdown 实现叠了「rAF 帧节流 + 轻量插件栈」两层防御，把重解析
// 频率与落盘频率解耦；markstream 接入后节点级复用让单次更新成本与全文长度弱相关
// （实测 50 tok/s 喂入时单次更新 7.1ms，react-markdown 现状 48.0ms；阻塞总时长
// 176ms vs 5878ms），公式/HTML 的 mid-state 也由解析器自维护，两层防御随之移除、
// 直传 content。但「到达节奏 = 显示节奏」仍在：token 突发时一帧蹦出一坨字、短暂
// 空窗时画面干等，观感「一顿一顿」。现由平滑层把到达与显示彻底解耦：
//   · 到达只写缓冲（ref），显示端 rAF 每帧从缓冲匀速取字，速率自适应实测吐字速率；
//   · 突发被摊到后续帧匀速释放，空窗自然放缓 —— 画面按帧匀速生长；
//   · 揭示输出仍是 target 的前缀，markstream 的节点级复用完全适用，解析成本不变；
//   · isStreaming=false（流结束）立即直通冲刷，终态与持久化内容严格一致。
export const StreamingMarkdown = React.memo(function StreamingMarkdown({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const smooth = useSmoothStream(content, { active: !!isStreaming })
  if (!smooth) return null
  return <Markdown content={smooth} final={!isStreaming} variant="agent" />
})

// 旧消息（无 segments）的内容渲染：与 segments 消息同构的「单容器」方案——
// 按 <think> 边界切出的片段全部收纳进唯一思考链容器（ThinkBlock，链内按时间线
// 交错收纳思考续段 / 过程正文 / 工具卡），仅最后一个正文段（最终结论）留在容器
// 下方独立成泡；流式期间「最后一段是正文」只是临时最终态，思考恢复后声明式地
// 自动收纳回容器。legacy 工具卡无时间线信息，沿用旧规则收纳进容器尾部；
// 无思考段时保持传统布局（工具卡独立成组、正文按序成泡）。
export const StreamingContent = React.memo(function StreamingContent({ content, streaming, thinkDone, toolCalls, runTotalMs, onPreviewFile, canUndoFor, onUndo }: {
  content: string; streaming?: boolean; thinkDone?: boolean;
  runTotalMs?: number
  toolCalls?: NonNullable<AgentMessage['toolCalls']>;
  onPreviewFile?: (p: string, line?: number) => void;
  canUndoFor?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => boolean;
  onUndo?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => void
}) {
  const { value, items, finalText, lastClosed, hasThink } = useMemo(() => {
    type Entry = { kind: 'think'; content: string; closed: boolean } | { kind: 'text'; content: string }
    const entries: Entry[] = []
    let lastClosed = true
    for (const seg of parseThinkSegments(content || '')) {
      if (seg.type === 'think') {
        // 已闭合的空思考段（<think></think> 噪声）跳过；未闭合空段保留（等待态占位）
        if (seg.closed && seg.value.trim() === '') continue
        entries.push({ kind: 'think', content: seg.value, closed: seg.closed })
        lastClosed = seg.closed
      } else {
        // 跳过空正文段：避免渲染出透明占位容器（padding + flex gap 造成的不可见空隙）
        if ((seg.value || '').trim() === '') continue
        entries.push({ kind: 'text', content: seg.value })
      }
    }
    const items: ThinkChainItem[] = []
    let value = ''
    let valueAssigned = false
    let finalText: string | null = null
    entries.forEach((e, i) => {
      if (e.kind === 'think') {
        // 生长中的思考段（未闭合且是最后一条）且不是主文本时，标记 streaming 走逐行流式渲染
        const isLive = !!streaming && !e.closed && i === entries.length - 1
        if (!valueAssigned) { value = e.content; valueAssigned = true; return }
        items.push(isLive ? { kind: 'think', content: e.content, streaming: true } : { kind: 'think', content: e.content })
        return
      }
      // 最后一个正文段 = 最终结论：留容器下方独立成泡；其余为过程正文收进容器
      if (i === entries.length - 1) { finalText = e.content; return }
      items.push({ kind: 'text', content: e.content })
    })
    const hasThink = entries.some(e => e.kind === 'think')
    // legacy 工具卡无时间线信息，沿用旧规则收纳进容器尾部（仅在有思考段时进容器，
    // 无思考段保持独立成组的传统布局）
    if (hasThink && toolCalls?.length) items.push({ kind: 'tools', toolCalls })
    return { value, items, finalText, lastClosed, hasThink }
  }, [content, streaming, toolCalls])

  // 无思考段：传统布局——工具卡独立成组（不套思考链容器），正文段按序成泡
  // （此处 items 只含已完成的正文片段，生长中的正文段在 finalText）
  if (!hasThink) {
    // 辅助函数：将文本内容分割成文本和Mermaid块
    const renderContentWithMermaid = (content: string, isStreamingContent: boolean) => {
      // streaming 透传：流式期间未闭合的 mermaid 代码不会产出图表块（否则会拿残码
      // 渲染出一张「渲染失败」错误卡，等代码补全后再替换成正确的图 —— 先错图后对图的闪替）。
      const blocks = parseContentToBlocks(content, isStreamingContent)
      return blocks.map((block, i) => {
        if (block.kind === 'mermaid') {
          return (
            <MermaidCard
              key={`mermaid-${i}`}
              code={block.code}
              renderFallback={(fallbackCode) => (
                <CodeBlock language="" value={fallbackCode} />
              )}
            />
          )
        }
        if (block.kind === 'chart') {
          return (
            <ChartCard
              key={`chart-${i}`}
              code={block.code}
              renderFallback={(fallbackCode) => (
                <CodeBlock language="" value={fallbackCode} />
              )}
            />
          )
        }
        if (block.kind === 'svg') {
          return (
            <SvgCard
              key={`svg-${i}`}
              code={block.code}
              streaming={block.streaming === true}
              renderFallback={(fallbackCode) => (
                <CodeBlock language="" value={fallbackCode} />
              )}
            />
          )
        }
        return (
          <div key={`text-${i}`} className={`chat-msg-bubble chat-msg-markdown${isStreamingContent ? ' chat-msg-bubble--streaming' : ''}`}>
            {isStreamingContent ? <StreamingMarkdown content={block.content} isStreaming={isStreamingContent} /> : <AgentMarkdown content={block.content} />}
          </div>
        )
      })
    }

    return (
      <>
        {toolCalls?.length ? (
          <ToolCallGroup toolCalls={toolCalls} onPreviewFile={onPreviewFile!} canUndoFor={canUndoFor} onUndo={onUndo} />
        ) : null}
        {items.map((it) => it.kind === 'text' ? (
          renderContentWithMermaid(it.content, false)
        ) : null)}
        {finalText != null && renderContentWithMermaid(finalText, !!streaming)}
      </>
    )
  }
  return (
    <>
      <ThinkBlock
        value={value}
        items={items}
        // thinkDone：本轮已进入工具/正文阶段时视为正常收尾（「思考过程」折叠态而非
        // 「思考中」转圈，也不误判「思考已中断」）；停止于未闭合思考段时 closed=false
        // → 头部显示「思考已中断」。
        closed={lastClosed || !!thinkDone}
        isStreaming={!!streaming && !lastClosed && !thinkDone}
        msgStreaming={!!streaming}
        bodyAppeared={finalText != null}
        runTotalMs={runTotalMs}
        onPreviewFile={onPreviewFile}
        canUndoFor={canUndoFor}
        onUndo={onUndo}
      />
      {finalText != null && (
        // 最终结论气泡：仍在流式时用轻量流式栈；完成态走 AgentMarkdown 完整栈
        // 补齐 KaTeX 公式/raw HTML/sanitize，否则完成后公式不渲染。
        (() => {
          // streaming 透传：流式期间不把未闭合的 mermaid 代码当图表渲染（见该函数注释）
          const blocks = parseContentToBlocks(finalText, !!streaming)
          return blocks.map((block, i) => {
            if (block.kind === 'mermaid') {
              return (
                <div key={`mermaid-final-${i}`} className="agent-msg-ui">
                  <MermaidCard
                    code={block.code}
                    renderFallback={(c) => <CodeBlock language="" value={c} />}
                  />
                </div>
              )
            }
            if (block.kind === 'chart') {
              return (
                <div key={`chart-final-${i}`} className="agent-msg-ui">
                  <ChartCard
                    code={block.code}
                    renderFallback={(c) => <CodeBlock language="" value={c} />}
                  />
                </div>
              )
            }
            if (block.kind === 'svg') {
              return (
                <div key={`svg-final-${i}`} className="agent-msg-ui">
                  <SvgCard
                    code={block.code}
                    streaming={block.streaming === true}
                    renderFallback={(c) => <CodeBlock language="" value={c} />}
                  />
                </div>
              )
            }
            return (
              <div key={`text-final-${i}`} className={`chat-msg-bubble chat-msg-markdown${streaming ? ' chat-msg-bubble--streaming' : ''}`}>
                {streaming ? <StreamingMarkdown content={block.content} isStreaming={streaming} /> : <AgentMarkdown content={block.content} />}
              </div>
            )
          })
        })()
      )}
    </>
  )
})

/** 顶栏按钮（动态图标联动版）：鼠标落在按钮任意区域——图标/名称/留白——都通过 ref 触发图标动画；
 *  animateicons 默认只在图标自身 hover 时动画，名称与留白区域 hover 无响应，此处统一提升到按钮级。 */
export function TopbarBtn({ icon: Icon, size = 12, btnRef, baseClass = 'agent-code-topbar-btn', className, active, onClick, title, children, iconClassName }: {
  icon: React.ElementType
  size?: number
  btnRef?: React.Ref<HTMLButtonElement>
  baseClass?: string
  className?: string
  active?: boolean
  onClick?: () => void
  title?: string
  children?: React.ReactNode
  iconClassName?: string
}) {
  const iconRef = useRef<AniIconHandle>(null)
  return (
    <button
      ref={btnRef}
      className={`${baseClass}${active ? ' active' : ''}${className ? ' ' + className : ''}`}
      onClick={onClick}
      title={title}
      onMouseEnter={() => iconRef.current?.startAnimation?.()}
      onMouseLeave={() => iconRef.current?.stopAnimation?.()}
    >
      <Icon ref={iconRef as never} size={size} className={iconClassName} />
      {children}
    </button>
  )
}

/** 输入框按钮（动态图标联动版）：整按钮 hover 即触发 @animateicons 动画，与顶栏 TopbarBtn 同款。 */
export const AniIconButton = React.forwardRef<HTMLButtonElement, {
  icon: React.ElementType
  size?: number
  onClick?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
  className?: string
  title?: string
  disabled?: boolean
  children?: React.ReactNode
}>(function AniIconButton({ icon: Icon, size = 14, onClick, onMouseDown, className, title, disabled, children }, ref) {
  const iconRef = useRef<AniIconHandle>(null)
  return (
    <button
      ref={ref}
      className={className}
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={title}
      disabled={disabled}
      onMouseEnter={() => iconRef.current?.startAnimation?.()}
      onMouseLeave={() => iconRef.current?.stopAnimation?.()}
    >
      <Icon ref={iconRef as never} size={size} />
      {children}
    </button>
  )
})

// ── 已完成助手消息行组件（React.memo）──
// 流式期间每次 commit（~50ms）整页都会重渲染；已完成消息的 msg 对象引用在 commit 之间
// 保持不变（只有流式那条消息被替换），所以用 React.memo + 稳定 actionsRef 让已完成行
// 完全跳过 reconcile——整页渲染成本从实测的 15-40ms 降到 ~2ms。
// AgentMsgRowActions / RenderSegmentsOpts 类型已抽至 agent-code/types（对外契约类型）

// segments 渲染（思考链 / 工具卡 / 正文气泡）：流式分支与完成分支共用同一实现
// （原为 AgentCodeView 内部闭包，抽到模块级供 AgentMessageRow 复用，避免两处拷贝漂移）。
//
// 单容器时间线：整条消息只有一个思考链容器（一个 ThinkBlock）——思考段、工具卡组、
// 过程正文段按 segments 原序交错收纳进同一容器；仅最后一个正文段（最终结论）留在
// 容器下方独立成泡。流式期间「最后一段是正文」只是临时最终态：后续思考/工具段一旦
// 到达，该正文段声明式地自动收纳回容器，容器重开「思考中」并继续计时（streamStartAt
// 连续时钟跨思考/工具/正文阶段不回退），无需任何段落迁移逻辑。工具卡一律收进容器
// （正文不承载工具卡）。附带保证（沿用原平铺修复）：任意顺序的段都按位渲染，不丢内容。
export function renderSegmentsFor(segments: NonNullable<AgentMessage['segments']>, msgId: string, streaming: boolean, tailToolCalls: NonNullable<AgentMessage['toolCalls']> | undefined, o: RenderSegmentsOpts): React.ReactNode[] {
  // 流式尾部实时工具卡（尚未切分进 segments）：视为排在时间线最后——它的存在说明
  // 模型在「最终正文」之后又发起了调用，最后正文段随之降级为过程正文收进容器
  const hasTailTools = !!tailToolCalls && tailToolCalls.length > 0
  // 最终正文段：仅当最后一个段是非空 text（且无尾部工具卡）时成立
  const lastSeg = segments[segments.length - 1]
  let finalText: string | null = null
  let finalTextIdx = -1
  if (!hasTailTools && lastSeg && lastSeg.kind === 'text' && lastSeg.content.trim() !== '') {
    finalTextIdx = segments.length - 1
    finalText = lastSeg.content
  }
  const items: ThinkChainItem[] = []
  let value = ''
  let valueDurationMs: number | undefined
  let sawThink = false
  segments.forEach((seg, i) => {
    if (seg.kind === 'think') {
      sawThink = true
      // 生长中的思考段（最后一段且仍在流式）：即使内容暂空也保留（等待态/流式渲染标记）
      const isLive = streaming && !o.thinkDone && !hasTailTools && i === segments.length - 1
      if (seg.content.trim() === '' && !isLive) return
      // 首个非空思考段作为容器主文本（value，沿用流式节流管线）；其余为链内续段
      if (!value && seg.content.trim() !== '') {
        value = seg.content
        if (seg.durationMs != null) valueDurationMs = seg.durationMs
        return
      }
      items.push({ kind: 'think', content: seg.content, ...(seg.durationMs != null ? { durationMs: seg.durationMs } : {}), ...(isLive ? { streaming: true } : {}) })
      return
    }
    if (seg.kind === 'tools') {
      if (seg.toolCalls.length > 0) items.push({ kind: 'tools', toolCalls: seg.toolCalls, ...(seg.durationMs != null ? { durationMs: seg.durationMs } : {}) })
      return
    }
    // 过程正文段（最终正文段除外）按时间线收纳进容器；空正文段跳过
    if (i === finalTextIdx || seg.content.trim() === '') return
    items.push({ kind: 'text', content: seg.content })
  })
  if (hasTailTools) items.push({ kind: 'tools', toolCalls: tailToolCalls! })

  const out: React.ReactNode[] = []
  if (sawThink || items.length > 0) {
    out.push(
      <ThinkBlock
        key="think-chain"
        value={value}
        durationMs={valueDurationMs}
        // closed 只表达「本次运行已结束」：流式期间恒 false、运行结束单调翻转为 true。
        // 不再并入 thinkDone——它是「思考↔正文/工具」的阶段电平，会随模型输出交替往返
        // 翻转（思考→正文→思考时 false→true→false），曾导致容器「收起 → 重开」反复横跳。
        // thinkDone 仅保留在下方 isStreaming 中控制「思考中」转圈。
        closed={!streaming}
        isStreaming={streaming && !o.thinkDone && !hasTailTools && lastSeg?.kind === 'think'}
        msgStreaming={streaming}
        bodyAppeared={finalTextIdx >= 0}
        streamStartAt={o.streamStartAt}
        runTotalMs={o.runTotalMs}
        meta={o.meta}
        items={items}
        onPreviewFile={o.onPreviewFile}
        canUndoFor={o.canUndoFor}
        onUndo={(tc) => o.onUndo(msgId, tc)}
      />
    )
  }
  if (finalTextIdx >= 0 && finalText != null) {
    // 将最终文本分割成文本和Mermaid块，按顺序渲染
    // streaming 透传：流式期间不把未闭合的 mermaid 代码当图表渲染（见该函数注释）
    const blocks = parseContentToBlocks(finalText, streaming)
    blocks.forEach((block, i) => {
      if (block.kind === 'mermaid') {
        out.push(
          <div key={`mermaid-seg-final-${i}`} className="agent-msg-ui">
            <MermaidCard
              code={block.code}
              renderFallback={(c) => <CodeBlock language="" value={c} />}
            />
          </div>
        )
      } else if (block.kind === 'chart') {
        out.push(
          <div key={`chart-seg-final-${i}`} className="agent-msg-ui">
            <ChartCard
              code={block.code}
              renderFallback={(c) => <CodeBlock language="" value={c} />}
            />
          </div>
        )
      } else if (block.kind === 'svg') {
        out.push(
          <div key={`svg-seg-final-${i}`} className="agent-msg-ui">
            <SvgCard
              code={block.code}
              // streaming 必须透传：parseContentToBlocks 在流式期间会为「围栏还没闭合」的
              // ```svg 产出 { kind:'svg', streaming:true }，SvgCard 靠这个标记走 innerHTML
              // 渐进渲染分支（随输出逐步成形）。漏传的话它会走 <img src="data:..."> 全量分支，
              // 半截 SVG 过不了 looksLikeSvg → 降级成普通代码块，实时渲染就没了。
              // 注意与上面 StreamingContent 里同名调用点保持一致，两处不可漂移。
              streaming={block.streaming === true}
              renderFallback={(c) => <CodeBlock language="" value={c} />}
            />
          </div>
        )
      } else {
        out.push(
          <div key={`text-seg-final-${i}`} className={`chat-msg-bubble chat-msg-markdown${streaming ? ' chat-msg-bubble--streaming' : ''}`}>
            {streaming ? <StreamingMarkdown content={block.content} isStreaming /> : <AgentMarkdown content={block.content} />}
          </div>
        )
      }
    })
  }
  return out
}

// 「已停止生成」徽标（流式/完成分支共用）
export const stoppedBadge = (
  <div className="chat-msg-stopped-badge">
    <CircleStopIcon size={10} />
    <span>已停止生成</span>
  </div>
)

// 助手消息行：流式与完成的统一渲染者——streaming 期间订阅 liveAgentMsg 切片
// （selector 按消息 id 短路：非本行 commit 返回 null，零重渲染，保持「仅流式行 ~50ms
// 更新」的性能特性）；finalize 时 live 清空 → 回退到 msg 完成态渲染。流式/完成切换
// 只变化 props、不卸载重挂，思考块/工具卡/正文容器 DOM 全程连续 → 消除完成瞬间的跳动。

export const AgentMessageRow = React.memo(function AgentMessageRow({ msg, isLast, loading, actionsRef, streaming, modelLabel, thinkDone, streamStartAt, onRate, modelTemplateId, plainChat, isSpeaking }: {
  msg: AgentMessage
  isLast: boolean
  loading: boolean
  actionsRef: React.MutableRefObject<AgentMsgRowActions>
  streaming?: boolean
  modelLabel?: string
  thinkDone?: boolean
  streamStartAt?: number  // 流开始时刻：pending 思考卡与思考块实时计时共用（连续不回退）
  onRate?: (v: number | null) => void  // t/s 采样上报（parent 持久化进消息）
  modelTemplateId?: string  // 模型指标 key（StreamingBadge 订阅 modelMetrics[templateId].nDecoded 取真实解码数）
  /** 纯聊天模式：额外显示朗读 / 继续生成 / 删除（工作台模式不显示这些聊天向操作） */
  plainChat?: boolean
  /** 本条是否正在朗读。传布尔而不是 speakingId：布尔只在命中的那一行变化，
      传 id 会让窗口内每一行都拿到新 prop，一次朗读开关整屏重渲染。 */
  isSpeaking?: boolean
}) {
  // 流式切片订阅：id 不匹配时返回 null（引用恒定 → 该行不随其它 commit 重渲染）。
  // 流式行：live 每次 commit 是新对象 → 只这一行跟随更新。
  const live = useStore(s => (s.liveAgentMsg && s.liveAgentMsg.id === msg.id) ? s.liveAgentMsg : null)
  const isStreaming = !!streaming && !!live
  const src = isStreaming ? live : msg
  const a = actionsRef.current
  const toolCalls = src.toolCalls ?? []
  const hasToolCalls = toolCalls.length > 0
  const allToolsDone = toolCalls.every(t => t.status === 'done')
  const showFileSummary = !isStreaming && hasToolCalls && allToolsDone
  const fileSummary = showFileSummary ? (
    <FileChangeSummary toolCalls={msg.toolCalls} onOpenChange={a.openGitDiffAt} canUndoAll={!!(msg.toolCalls?.some(t => a.canUndoFor(t)))} onUndoAll={() => a.handleUndoAll(msg.id, msg.toolCalls)} />
  ) : null
  const actions = !isStreaming ? (
    <div className="chat-msg-actions">
      <button className="chat-msg-action-btn" title="复制" onClick={() => a.copyMessage(msg.content || '')}><CopyIcon size={13} /></button>
      {isLast && (
        <button className="chat-msg-action-btn" title="重新生成" onClick={() => a.regenerateAt(msg.id)} disabled={loading}><RefreshCwIcon size={13} /></button>
      )}
      {/* 朗读 / 继续生成 / 删除只在纯聊天模式出现：工作台模式的消息带工具调用与文件改动，
          这些聊天向操作在那边没有意义，也不该混进工作流的操作区 */}
      {plainChat && msg.role === 'assistant' && (
        <>
          <button
            className="chat-msg-action-btn"
            title={isSpeaking ? '停止朗读' : '朗读'}
            onClick={() => (isSpeaking ? a.stopSpeak() : a.speakMessage(msg.id, msg.content || ''))}
          >
            {isSpeaking ? <Square size={12} /> : <Volume2 size={13} />}
          </button>
          {isLast && (
            <button className="chat-msg-action-btn" title="继续生成" onClick={() => a.continueAt(msg.id)} disabled={loading}><Play size={13} /></button>
          )}
          <button className="chat-msg-action-btn" title="删除这条回复" onClick={() => a.deleteMessage(msg.id)} disabled={loading}><Trash2 size={13} /></button>
        </>
      )}
    </div>
  ) : null
  // 已切分进 segments 的工具调用 id：流式时把「当前轮尚未切分」的工具卡作为实时尾部追加，
  // 避免流式期所有工具卡堆在顶部、完成后才跳回交错。
  const liveToolCalls = isStreaming ? (() => {
    const segmentedToolIds = new Set<string>()
    if (live.segments) for (const seg of live.segments) if (seg.kind === 'tools') for (const t of seg.toolCalls) segmentedToolIds.add(t.id)
    return (live.toolCalls || []).filter(t => !segmentedToolIds.has(t.id))
  })() : undefined
  // 首 token 前（无正文/无思考/无工具）：pending 态思考卡（ThinkGrid + 思考中 + 连续计时），
  // 首个思考段到达后由同一思考卡接管，避免等待窗口留白且全程无跳变
  const pendingFirstToken = isStreaming && !src.content && !(src.segments?.length) && !hasToolCalls
  // 模型名/token 计数徽标：常驻思考块头部（流式中含 t/s 速率采样，
  // 完成后模型名/token 总数/t/s（持久化 lastTps 还原）保留不消失）
  const label = src.modelLabel || modelLabel
  const meta = label ? (
    <StreamingBadge
      modelLabel={label}
      live={isStreaming}
      persistedTps={isStreaming ? undefined : src.lastTps}
      decoded={src.decodedTokens}
      onRate={onRate}
      templateId={modelTemplateId}
    />
  ) : null
  if (src.segments && src.segments.length > 0) {
    // segments 已切分：单容器时间线布局（唯一思考链容器收纳思考/工具卡/过程正文，
    // 最终正文独立成泡），完成后同一结构静态渲染（ThinkBlock closed、正文切 AgentMarkdown 完整栈）。
    return (
      <>
        {renderSegmentsFor(src.segments, msg.id, isStreaming, isStreaming ? liveToolCalls : undefined, {
          thinkDone: isStreaming ? !!thinkDone : true,
          onPreviewFile: a.onPreviewFile, canUndoFor: a.canUndoFor, onUndo: a.onUndo,
          streamStartAt: isStreaming ? streamStartAt : undefined,
          runTotalMs: src.thinkTotalMs,
          meta
        })}

        {src.stopped && stoppedBadge}
        {fileSummary}
        {actions}
      </>
    )
  }
  // 兜底：流式首 token 前（pending 思考卡 + 实时内容）或旧消息（无 segments，传统布局）
  return (
    <>
      {src.stopped && stoppedBadge}
      {pendingFirstToken && (
        <ThinkBlock pending value="" closed={false} isStreaming msgStreaming bodyAppeared={false} streamStartAt={streamStartAt} />
      )}
      <StreamingContent content={src.content} streaming={isStreaming} toolCalls={src.toolCalls || undefined} runTotalMs={src.thinkTotalMs} onPreviewFile={a.onPreviewFile} canUndoFor={a.canUndoFor} onUndo={(tc) => a.onUndo(msg.id, tc)} />

      {!isStreaming && hasToolCalls && fileSummary}
      {!isStreaming && !hasToolCalls && actions}
    </>
  )
})
