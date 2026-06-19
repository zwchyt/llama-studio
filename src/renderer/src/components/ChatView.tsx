import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Plus, Send, Square, Trash2, Pencil, MessageSquare,
  ChevronDown, Bot, PanelLeftClose, PanelLeftOpen, Brain, RefreshCw,
  Copy, Check, RotateCcw, ArrowDown, X, Eye, SlidersHorizontal, List
} from 'lucide-react'
import { useChatStore, buildOpenAiMessages, DEFAULT_PARAMS } from '../store/chatStore'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import type { ChatSession, ChatMessage, ChatParams } from '../../../shared/types'
import CodeBlock from './CodeBlock'
import ConfirmModal from './ConfirmModal'

// ── Markdown code 组件 ─────────────────────────────────────
// react-markdown v10 不再传 inline prop，用 className 是否含 language- 区分块级/行内
function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '')
  const match = /language-(\w+)/.exec(className || '')
  if (match) {
    return <CodeBlock language={match[1]} value={text} />
  }
  // 无 language class：若含换行则按块处理，否则按行内
  if (text.includes('\n')) {
    return <CodeBlock language="" value={text} />
  }
  return <code className="chat-code-inline">{text}</code>
}

// ── 思考链（reasoning）解析 ─────────────────────────────────
// 把含 <think>...</think> 的内容切分成「普通文本 / 思考内容」片段序列。
// 支持流式中思考未闭合（只有 <think> 没有 </think>）的情况。
type ContentSegment = { type: 'text'; value: string } | { type: 'think'; value: string; closed: boolean }
function parseThinkSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  let rest = content
  while (rest.length > 0) {
    const openIdx = rest.indexOf('<think>')
    if (openIdx === -1) {
      // 没有更多 think 标签，剩余全是正文
      if (rest.trim()) segments.push({ type: 'text', value: rest })
      break
    }
    // openIdx 之前的正文
    if (openIdx > 0 && rest.slice(0, openIdx).trim()) {
      segments.push({ type: 'text', value: rest.slice(0, openIdx) })
    }
    rest = rest.slice(openIdx + '<think>'.length)
    const closeIdx = rest.indexOf('</think>')
    if (closeIdx === -1) {
      // 思考尚未闭合（流式进行中）
      segments.push({ type: 'think', value: rest, closed: false })
      break
    }
    segments.push({ type: 'think', value: rest.slice(0, closeIdx), closed: true })
    rest = rest.slice(closeIdx + '</think>'.length)
  }
  return segments
}

// 思考块：可折叠（流式时自动展开，完成后自动折叠）
const THINK_THROTTLE_MS = 120 // 流式文本节流间隔，避免每个 delta 都重渲染长文本

const ThinkBlock = React.memo(function ThinkBlock({ value, closed, isStreaming, autoExpand }: { value: string; closed: boolean; isStreaming?: boolean; autoExpand?: boolean }) {
  const [expanded, setExpanded] = useState(autoExpand ?? false)
  const userToggledRef = useRef(false)
  const thinking = !closed || isStreaming
  const bodyRef = useRef<HTMLDivElement>(null)

  // 节流显示文本：流式时按固定间隔更新，避免每个 token 都触发长文本重排
  const [displayValue, setDisplayValue] = useState(value)
  useEffect(() => {
    if (!thinking) {
      setDisplayValue(value)
      return
    }
    setDisplayValue(value)
    const timer = setInterval(() => {
      setDisplayValue(value)
    }, THINK_THROTTLE_MS)
    return () => clearInterval(timer)
  }, [value, thinking])

  // 流式思考时自动滚动到底部
  useEffect(() => {
    if (thinking && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [displayValue, thinking, expanded])

  useEffect(() => {
    if (userToggledRef.current) return
    setExpanded(!!thinking)
  }, [thinking])

  // 思考阶段结束时重置手动标记，下次可再次自动展开
  const prevThinkingRef = useRef(thinking)
  useEffect(() => {
    if (prevThinkingRef.current && !thinking) {
      userToggledRef.current = false
    }
    prevThinkingRef.current = thinking
  }, [thinking])

  const handleToggle = () => {
    userToggledRef.current = true
    setExpanded(v => !v)
  }

  return (
    <div className={`chat-think ${thinking ? 'thinking' : ''} ${expanded ? 'expanded' : ''}`}>
      <button className="chat-think-toggle" onClick={handleToggle}>
        {thinking ? (
          <span className="chat-think-status">
            <RefreshCw size={12} className="spin" />
            思考中
          </span>
        ) : (
          <span className="chat-think-status">
            <Brain size={12} />
            思考过程
          </span>
        )}
        <ChevronDown size={13} className={`chat-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {expanded && (
        <div className="chat-think-body" ref={bodyRef}>{displayValue || '（空）'}</div>
      )}
    </div>
  )
})

// ── 用户消息内容解析（代码块 + 行内代码 + 纯文本）──────────
type UserBlock =
  | { type: 'code'; lang: string; code: string }
  | { type: 'text'; text: string }

// 缩进代码块检测：连续 2+ 行以 4 空格或 Tab 开头，自动识别为代码块
function parseIndentedBlocks(text: string): UserBlock[] {
  const lines = text.split('\n')
  const blocks: UserBlock[] = []
  let textBuf: string[] = []
  let codeBuf: string[] = []
  let inCode = false

  const flushText = () => {
    if (textBuf.length > 0) {
      blocks.push({ type: 'text', text: textBuf.join('\n') })
      textBuf = []
    }
  }
  const flushCode = () => {
    if (codeBuf.length > 0) {
      const code = codeBuf.map(l => l.replace(/^( {4}|\t)/, '')).join('\n').replace(/^\n+|\n+$/g, '')
      blocks.push({ type: 'code', lang: '', code })
      codeBuf = []
    }
    inCode = false
  }

  for (const line of lines) {
    const indented = /^( {4,}|\t)/.test(line)
    if (indented) {
      codeBuf.push(line)
      if (!inCode && codeBuf.length >= 2) {
        flushText()
        inCode = true
      }
    } else {
      if (inCode) {
        flushCode()
      } else {
        // 未确认代码块前，缩进行先归入文本缓冲区
        if (codeBuf.length > 0) {
          textBuf.push(...codeBuf)
          codeBuf = []
        }
        textBuf.push(line)
      }
    }
  }
  if (inCode) flushCode()
  else {
    if (codeBuf.length > 0) textBuf.push(...codeBuf)
    flushText()
  }
  return blocks
}

function parseUserContent(content: string): UserBlock[] {
  // 第一步：用围栏代码块（```）切分
  const fenceRe = /```(\w*)\s*\r?\n([\s\S]*?)```/g
  const rawSegments: UserBlock[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(content)) !== null) {
    if (m.index > lastIdx) {
      rawSegments.push({ type: 'text', text: content.slice(lastIdx, m.index) })
    }
    rawSegments.push({ type: 'code', lang: m[1] || '', code: m[2] })
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < content.length) {
    rawSegments.push({ type: 'text', text: content.slice(lastIdx) })
  }

  // 第二步：在每个纯文本片段内检测缩进代码块
  const result: UserBlock[] = []
  for (const seg of rawSegments) {
    if (seg.type === 'code') {
      result.push(seg)
    } else {
      result.push(...parseIndentedBlocks(seg.text))
    }
  }
  return result
}

// 将纯文本片段切分为「普通文本 / 行内代码」序列
function renderTextWithInlineCode(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const inlineRe = /`([^`\n]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<code key={m.index} className="chat-code-inline">{m[1]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const UserMessageContent = React.memo(function UserMessageContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseUserContent(content), [content])
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <CodeBlock key={i} language={block.lang} value={block.code} />
        }
        return <span key={i} className="user-text">{renderTextWithInlineCode(block.text)}</span>
      })}
    </>
  )
})

// ── 单条消息 ───────────────────────────────────────────────
const MessageBubble = React.memo(function MessageBubble({ msg, isStreaming, onCopy, onEdit, onRegenerate }: {
  msg: ChatMessage
  isStreaming?: boolean
  onCopy?: () => void
  onEdit?: () => void
  onRegenerate?: () => void
}) {
  const isUser = msg.role === 'user'
  const [copied, setCopied] = useState(false)
  // 助手消息解析思考链片段（含 <think>...</think>）
  const segments = useMemo(
    () => (!isUser ? parseThinkSegments(msg.content) : []),
    [isUser, msg.content]
  )

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    onCopy?.()
  }

  // 流式中不显示操作栏
  if (isStreaming) {
    return (
      <div className="chat-msg chat-msg-assistant" data-msg-id={msg.id}>
        <div className="chat-msg-avatar"><Bot size={14} /></div>
        <div className="chat-msg-body">
          {msg.content ? (
            <>
              {segments.map((seg, i) => {
                if (seg.type === 'think') {
                  const thinkStreaming = true
                  return <ThinkBlock key={i} value={seg.value} closed={seg.closed} isStreaming={thinkStreaming && !seg.closed} />
                }
                return (
                  <div key={i} className="chat-msg-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode as any }}>
                      {seg.value}
                    </ReactMarkdown>
                  </div>
                )
              })}
              {segments.length > 0 && segments[segments.length - 1].type === 'text' && <span className="chat-cursor" />}
            </>
          ) : (
            <div className="chat-msg-placeholder">
              <ThinkBlock value="" closed={false} isStreaming={true} autoExpand={false} />
            </div>
          )}
      </div>
      </div>
    )
  }

  return (
    <div className={`chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}`} data-msg-id={msg.id}>
      {!isUser && (
        <div className="chat-msg-avatar">
          <Bot size={14} />
        </div>
      )}
      <div className="chat-msg-body">
        {isUser ? (
          <div className="chat-msg-bubble chat-msg-bubble-user"><UserMessageContent content={msg.content} /></div>
        ) : msg.error ? (
          <div className="chat-msg-error">{msg.content}</div>
        ) : msg.content ? (
          <>
            {segments.map((seg, i) => {
              if (seg.type === 'think') {
                return <ThinkBlock key={i} value={seg.value} closed={seg.closed} isStreaming={false} />
              }
              return (
                <div key={i} className="chat-msg-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode as any }}>
                    {seg.value}
                  </ReactMarkdown>
                </div>
              )
            })}
            {msg.stopped && (
              <div className="chat-msg-stopped-badge">
                <Square size={10} />
                <span>已停止生成</span>
              </div>
            )}
            {/* Token 统计信息 */}
            {!msg.error && (msg.tokensDecoded != null || msg.msFirstToken != null || msg.decodeTokS != null) && (
              <div className="chat-msg-token-stats">
                {msg.decodeTokS != null && <span>{typeof msg.decodeTokS === 'number' ? msg.decodeTokS.toFixed(1) : msg.decodeTokS} tok/s</span>}
                {msg.tokensDecoded != null && <span>{msg.tokensDecoded} tokens</span>}
                {msg.msFirstToken != null && <span>TTFT {msg.msFirstToken}ms</span>}
              </div>
            )}
          </>
        ) : (
          <div className="chat-msg-placeholder">（空回复）</div>
        )}
        {/* 悬停操作栏 */}
        {msg.content && !msg.error && (
          <div className="chat-msg-actions">
            <button className="chat-msg-action-btn" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {isUser && onEdit && (
              <button className="chat-msg-action-btn" onClick={onEdit}>
                <Pencil size={13} />
              </button>
            )}
            {!isUser && onRegenerate && (
              <button className="chat-msg-action-btn" onClick={onRegenerate}>
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      {isUser && (
        <div className="chat-msg-avatar chat-msg-avatar-user">
          <span style={{ fontSize: 12, fontWeight: 700 }}>我</span>
        </div>
      )}
    </div>
  )
})

// ── 左栏：会话列表 ─────────────────────────────────────────
function SessionList({ sessions, activeId, onSelect, onNew, onRename, onDeleteRequest, runningModels, streamingSessionIds }: {
  sessions: ChatSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDeleteRequest: (session: ChatSession) => void
  runningModels: Array<{ id: string; name: string; port: number }>
  streamingSessionIds: string[]
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const startEdit = (s: ChatSession) => {
    setEditingId(s.id)
    setEditValue(s.title)
  }
  const commitEdit = () => {
    if (editingId) onRename(editingId, editValue)
    setEditingId(null)
  }

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-title">会话</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={onNew}
        >
          <Plus size={13} /> 新建
        </button>
      </div>
      <div className="chat-session-list">
        {sessions.length === 0 ? (
          <div className="chat-session-empty">
            点击「新建」开始第一个对话。
          </div>
        ) : sessions.map((s) => {
          const model = runningModels.find((m) => m.id === s.templateId)
          const isStreaming = streamingSessionIds.includes(s.id)
          const state = isStreaming ? 'streaming' : (model ? 'running' : 'stopped')
          return (
            <div
              key={s.id}
              className={`chat-session-item ${activeId === s.id ? 'active' : ''} ${state}`}
              onClick={() => onSelect(s.id)}
            >
              <div className={`chat-session-indicator ${state}`} />
              {editingId === s.id ? (
                <input
                  className="chat-session-edit"
                  value={editValue}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                  onBlur={commitEdit}
                />
              ) : (
                <>
                  <div className="chat-session-main">
                    <div className="chat-session-name">{s.title}</div>
                  </div>
                  <div className="chat-session-actions">
                    <button
                      className="chat-session-btn"
                      onClick={(e) => { e.stopPropagation(); startEdit(s) }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="chat-session-btn danger"
                      onClick={(e) => { e.stopPropagation(); onDeleteRequest(s) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 参数/系统提示词设置弹窗 ───────────────────────────────
const PARAM_CONFIG: Array<{
  key: keyof ChatParams
  label: string
  min: number
  max: number
  step: number
  defaultVal: number
}> = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, defaultVal: DEFAULT_PARAMS.temperature ?? 0.8 },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05, defaultVal: DEFAULT_PARAMS.top_p ?? 0.95 },
  { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, defaultVal: DEFAULT_PARAMS.top_k ?? 40 },
  { key: 'max_tokens', label: 'Max Tokens', min: -1, max: 8192, step: 1, defaultVal: DEFAULT_PARAMS.max_tokens ?? -1 },
  { key: 'repeat_penalty', label: 'Repeat Penalty', min: 0, max: 2, step: 0.1, defaultVal: DEFAULT_PARAMS.repeat_penalty ?? 1.1 },
]

function ChatSettingsCard({ session, anchorRect, onClose, onSetSystemPrompt, onSetParams, onMouseEnter, onMouseLeave }: {
  session: ChatSession | null
  anchorRect: DOMRect | null
  onClose: () => void
  onSetSystemPrompt: (prompt: string) => void
  onSetParams: (params: Partial<ChatParams>) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const [sysPrompt, setSysPrompt] = useState(session?.systemPrompt || '')
  const [params, setLocalParams] = useState<ChatParams>(session ? { ...session.params } : { ...DEFAULT_PARAMS })
  const cardRef = useRef<HTMLDivElement>(null)

  const handleSysPromptBlur = () => {
    if (!session) return
    if (sysPrompt !== (session.systemPrompt || '')) {
      onSetSystemPrompt(sysPrompt)
    }
  }

  const handleParamChange = (key: keyof ChatParams, val: number) => {
    if (!session) return
    const next = { ...params, [key]: val }
    setLocalParams(next)
    onSetParams({ [key]: val })
  }

  const handleReset = () => {
    if (!session) return
    setLocalParams({ ...DEFAULT_PARAMS })
    onSetParams(DEFAULT_PARAMS)
  }

  const sysPromptRef = useRef(sysPrompt)
  useEffect(() => { sysPromptRef.current = sysPrompt }, [sysPrompt])

  const handleClose = useCallback(() => {
    if (session && sysPromptRef.current !== (session.systemPrompt || '')) {
      onSetSystemPrompt(sysPromptRef.current)
    }
    onClose()
  }, [session, onSetSystemPrompt, onClose])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }
    // 延迟注册避免触发当前 click
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [handleClose])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  // 计算卡片位置：在按钮下方，右对齐
  const style: React.CSSProperties = { position: 'fixed', zIndex: 1100 }
  if (anchorRect) {
    style.top = anchorRect.bottom + 6
    style.right = window.innerWidth - anchorRect.right
  }

  return (
    <div className="chat-settings-card" ref={cardRef} style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {!session ? (
        <div className="chat-settings-empty">
          <SlidersHorizontal size={24} strokeWidth={1.2} style={{ opacity: 0.3 }} />
          <p>请先选择或创建一个会话</p>
        </div>
      ) : (
        <>
          <div className="chat-settings-card-header">
            <span className="chat-settings-card-title">会话参数</span>
            <button className="chat-settings-card-reset" onClick={handleReset}>恢复默认</button>
          </div>

          {/* System Prompt */}
          <div className="chat-settings-section">
            <label className="chat-settings-label">System Prompt</label>
            <textarea
              className="chat-settings-textarea"
              value={sysPrompt}
              onChange={(e) => setSysPrompt(e.target.value)}
              onBlur={handleSysPromptBlur}
              placeholder="设置系统提示词…"
              rows={3}
            />
          </div>

          {/* 参数滑块 */}
          {PARAM_CONFIG.map(({ key, label, min, max, step, defaultVal }) => {
            const val = (params[key] ?? defaultVal) as number
            return (
              <div className="chat-settings-param" key={String(key)}>
                <div className="chat-settings-param-header">
                  <span className="chat-settings-param-name">{label}</span>
                  <span className="chat-settings-param-value">{val}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={val}
                  onChange={(e) => handleParamChange(key, parseFloat(e.target.value))}
                />
              </div>
            )
          })}

          <div className="chat-settings-hint">参数在下次发送消息时生效，无需重启模型</div>
        </>
      )}
    </div>
  )
}

// ── 消息导航侧边栏（minimap 式竖椭圆导航）─────────────────
const NAV_PREVIEW_LEN = 200

const MessageNav = React.memo(function MessageNav({
  messages, activeMsgId, containerRef
}: {
  messages: ChatMessage[]
  activeMsgId: string | null
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const [hovered, setHovered] = useState(false)
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [viewportRatio, setViewportRatio] = useState(1)
  const [nodes, setNodes] = useState<{ topRatio: number; msg: ChatMessage }[]>([])
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const userMsgs = useMemo(() => messages.filter(m => m.role === 'user'), [messages])
  const userCount = userMsgs.length

  // 面板实际高度（同步测量，避免首次 tooltip 位置偏差）
  const [panelHeight, setPanelHeight] = useState(0)
  useLayoutEffect(() => {
    if (panelRef.current) setPanelHeight(panelRef.current.clientHeight)
  }, [hovered])

  // 跟踪滚动容器的滚动位置，计算各消息圆点位置
  useEffect(() => {
    const el = containerRef.current
    if (!el || userCount < 2) return
    const update = () => {
      const totalH = el.scrollHeight
      const clientH = el.clientHeight
      const scrollable = totalH - clientH
      setScrollRatio(scrollable > 0 ? el.scrollTop / scrollable : 0)
      setViewportRatio(clientH / totalH)
      if (totalH <= 0) { setNodes([]); return }
      const msgEls = el.querySelectorAll<HTMLElement>('[data-msg-id]')
      const msgMap = new Map(userMsgs.map(m => [m.id, m]))
      const newNodes: { topRatio: number; msg: ChatMessage }[] = []
      const containerRect = el.getBoundingClientRect()
      msgEls.forEach((msgEl) => {
        const msgId = msgEl.dataset.msgId
        const msg = msgId ? msgMap.get(msgId) : undefined
        if (!msg) return
        const rect = msgEl.getBoundingClientRect()
        const top = rect.top - containerRect.top + el.scrollTop
        newNodes.push({ topRatio: top / totalH, msg })
      })
      setNodes(newNodes)
    }
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    update()
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [containerRef, userMsgs, userCount])

  const handleEnter = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    setHovered(true)
  }, [])

  const handleLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => { setHovered(false); setMouseYRatio(null) }, 200)
  }, [])

  const handleClick = useCallback((msgId: string) => {
    const el = containerRef.current?.querySelector(`[data-msg-id="${msgId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [containerRef])

  if (userCount < 2) return null

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100
  const viewportBoxHeight = viewportRatio * 100

  const nearestIndex = hovered && mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node, i) =>
        Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? i : best, 0)
    : null

  const nearestNode = nearestIndex !== null ? nodes[nearestIndex] : null
  const tooltipY = nearestNode ? nearestNode.topRatio * (panelHeight || 400) : 0
  const TOOLTIP_H = 24
  const tooltipTop = Math.max(1, Math.min(panelHeight - TOOLTIP_H - 1, tooltipY - TOOLTIP_H / 2))

  return (
    <div className="chat-nav-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button className="chat-nav-trigger"><List size={14} /></button>
      {hovered && (
        <>
          <div
            className="chat-nav-panel"
            ref={panelRef}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setMouseYRatio((e.clientY - rect.top) / rect.height)
            }}
          >
            <div className="nav-centerline" />
            <div className="nav-viewport" style={{ top: `${viewportBoxTop}%`, height: `${viewportBoxHeight}%` }} />
            {nodes.map((node, i) => {
              const isUser = node.msg.role === 'user'
              const isNearest = nearestIndex === i
              const isActive = activeMsgId === node.msg.id
              return (
                <div
                  key={node.msg.id}
                  className="nav-node"
                  style={{ top: `${node.topRatio * 100}%` }}
                  onClick={() => handleClick(node.msg.id)}
                >
                  <div
                    className={`nav-node-indicator ${isUser ? 'user' : 'assistant'} ${isActive ? 'active' : ''}`}
                    style={{
                      transform: isNearest ? 'scale(1.6)' : 'scale(1)',
                      animation: isNearest ? 'nav-bob 0.6s ease-in-out infinite' : 'none',
                    }}
                  />
                </div>
              )
            })}
          </div>
          {nearestNode && (
            <div className="nav-tooltip" style={{ top: tooltipTop }}>
              <span className="nav-tooltip-text">
                {nearestNode.msg.content.slice(0, NAV_PREVIEW_LEN)}
                {nearestNode.msg.content.length > NAV_PREVIEW_LEN ? '…' : ''}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
})

// ── 主视图 ─────────────────────────────────────────────────
export default function ChatView() {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingId = useChatStore((s) => s.streamingId)
  const streamingSessionIds = useChatStore((s) => s.streamingSessionIds)
  const loaded = useChatStore((s) => s.loaded)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const createSession = useChatStore((s) => s.createSession)
  const createEmptySession = useChatStore((s) => s.createEmptySession)
  const selectSession = useChatStore((s) => s.selectSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setSessionModel = useChatStore((s) => s.setSessionModel)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const markLastMessageError = useChatStore((s) => s.markLastMessageError)
  const setStreamingId = useChatStore((s) => s.setStreamingId)
  const persist = useChatStore((s) => s.persist)
  const truncateAfter = useChatStore((s) => s.truncateAfter)

  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt)
  const setParams = useChatStore((s) => s.setParams)
  const cards = useStore((s) => s.cards)
  const setView = useStore((s) => s.setView)
  const runningModels = useMemo(
    () => cards.filter((c) => c.status === 'running')
      .map((c) => ({ id: c.template.id, name: c.template.name, port: c.template.serverPort || 8080 })),
    [cards]
  )

  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastScrollSessionRef = useRef<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [deletingSession, setDeletingSession] = useState<ChatSession | null>(null)
  const [activeNavMsgId, setActiveNavMsgId] = useState<string | null>(null)
  // 输入框代码预览：用户手动关闭后，任意输入变化即可重新触发
  const [inputPreviewDismissed, setInputPreviewDismissed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null)
  const settingsHoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => {
      if (settingsHoverTimeoutRef.current) clearTimeout(settingsHoverTimeoutRef.current)
    }
  }, [])

  function handleSettingsEnter(): void {
    if (settingsHoverTimeoutRef.current) clearTimeout(settingsHoverTimeoutRef.current)
    if (settingsBtnRef.current) {
      setSettingsAnchor(settingsBtnRef.current.getBoundingClientRect())
    }
    setShowSettings(true)
  }

  function handleSettingsLeave(): void {
    settingsHoverTimeoutRef.current = setTimeout(() => {
      setShowSettings(false)
    }, 300)
  }

  function handleSettingsCardEnter(): void {
    if (settingsHoverTimeoutRef.current) clearTimeout(settingsHoverTimeoutRef.current)
  }

  function handleSettingsCardLeave(): void {
    settingsHoverTimeoutRef.current = setTimeout(() => {
      setShowSettings(false)
    }, 300)
  }

  // 只有实际存在代码块时才显示预览（避免空壳子）
  const hasCodeBlocks = useMemo(() => {
    return /```(\w*)\s*\r?\n[\s\S]*?```/.test(input) ||
      (() => {
        const lines = input.split('\n')
        let run = 0
        for (const line of lines) {
          run = /^( {4,}|\t)/.test(line) ? run + 1 : 0
          if (run >= 2) return true
        }
        return false
      })()
  }, [input])

  const showInputPreview = hasCodeBlocks && !inputPreviewDismissed
  // 看门狗：防止流卡住导致输入框永久冻结
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstChunkReceivedRef = useRef(false)
  // 重新生成回滚备份：失败时恢复旧消息
  const regenerateRollbackRef = useRef<{ sessionId: string; messages: ChatMessage[]; streamId: string } | null>(null)

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null
  const activeMessages = activeSession?.messages || []
  const activeModel = runningModels.find((m) => m.id === activeSession?.templateId)

  // 首次加载会话
  useEffect(() => { loadSessions() }, [loadSessions])

  // 加载完成后若无任何会话且模型运行中，自动创建首个会话
  useEffect(() => {
    if (!loaded) return
    if (sessions.length > 0) return
    if (runningModels.length === 0) return
    const m = runningModels[0]
    createSession(m.id, m.port, m.name)
  }, [loaded, sessions.length, runningModels, createSession])

  // 选中会话时，若其模型未运行但存在其他运行中模型，自动切换
  useEffect(() => {
    if (!activeSessionId || !loaded) return
    if (activeModel) return
    if (runningModels.length === 0) return
    const m = runningModels[0]
    setSessionModel(activeSessionId, m.id, m.port)
  }, [activeSessionId, activeModel, runningModels, setSessionModel, loaded])

  // 全局监听流式 chunk
  useEffect(() => {
    // 清除可能残留的 streamingId（ChatView unmount 时流未结束导致卡死）
    const initSt = useChatStore.getState()
    if (initSt.streamingId) {
      initSt.setStreamingId(null)
    }

    window.api.onChatStreamChunk((data) => {
      const st = useChatStore.getState()
      // chunk 通过 streamId 关联到会话：发起流时把 streamId 记在会话最后一条 assistant 消息上
      const targetSession = st.sessions.find((s) =>
        s.messages.some((m) => m.id === data.streamId)
      )
      if (!targetSession) return
      if (data.delta) {
        firstChunkReceivedRef.current = true
        st.appendDeltaToLast(targetSession.id, data.delta)
        st.setSessionStreaming(targetSession.id, true)
      }
      if (data.done) {
        // 清理看门狗定时器
        if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
        firstChunkReceivedRef.current = false
        st.setSessionStreaming(targetSession.id, false)
        if (data.error) {
          // 如果是重新生成失败，回滚恢复旧消息
          const rollback = regenerateRollbackRef.current
          if (rollback && rollback.streamId === data.streamId) {
            const st = useChatStore.getState()
            st.replaceMessages(rollback.sessionId, rollback.messages)
            regenerateRollbackRef.current = null
            notify(`重新生成失败：${data.error}，已恢复原回复`, 'error')
          } else {
            st.markLastMessageError(targetSession.id, data.error)
          }
        } else {
          // 成功：清除回滚备份
          regenerateRollbackRef.current = null
          // 回填 token 统计
          if (data.usage != null || data.msFirstToken != null || data.decodeTokS != null) {
            st.finalizeLastMessage(targetSession.id, {
              tokensDecoded: data.usage?.completionTokens,
              msFirstToken: data.msFirstToken,
              decodeTokS: data.decodeTokS
            })
          }
        }
        st.persist(targetSession.id)
        if (st.streamingId === data.streamId) st.setStreamingId(null)
      }
    })
    return () => {
      window.api.removeChatStreamListener()
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
    }
  }, [])

  // 自动滚动到底部
  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    if (!container || !activeSessionId) return

    const isSessionSwitch = lastScrollSessionRef.current !== activeSessionId
    if (isSessionSwitch) {
      // 切换会话：无条件滚到底部，重置 autoScroll，用 rAF 在布局完成后二次确认
      lastScrollSessionRef.current = activeSessionId
      container.scrollTop = container.scrollHeight
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
      if (!autoScroll) setAutoScroll(true)
      return
    }

    // 同一会话内：仅在 autoScroll 开启时跟随滚动
    if (!autoScroll) return
    container.scrollTop = container.scrollHeight
  }, [activeSessionId, activeMessages.length, activeMessages[activeMessages.length - 1]?.content, autoScroll])

  // 监听滚动：用户上滚则暂停自动滚动
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(atBottom)
    // 导航栏：检测当前可见的用户消息
    const userEls = el.querySelectorAll('.chat-msg-user[data-msg-id]')
    const containerTop = el.scrollTop
    let visible: string | null = null
    userEls.forEach((node) => {
      const top = (node as HTMLElement).offsetTop
      if (top <= containerTop + 120) visible = (node as HTMLElement).dataset.msgId || null
    })
    if (visible) setActiveNavMsgId(visible)
  }, [])

  // 新建会话
  const handleNew = useCallback(() => {
    if (runningModels.length > 0) {
      const m = runningModels[0]
      createSession(m.id, m.port, m.name)
    } else {
      createEmptySession()
    }
    setInput('')
  }, [runningModels, createSession, createEmptySession])

  // 发送消息（发起流）
  const handleSend = useCallback(async () => {
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    const content = input.trim()
    if (!content) return
    // 如果上一个流仍在进行，先终止它再发送新消息
    if (streamingId) {
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
      window.api.abortChatStream(streamingId)
      const prevSt = useChatStore.getState()
      // 找到实际在流的会话进行落盘（而非 activeSessionId，后者可能已切换）
      const streamingSession = prevSt.sessions.find((s) =>
        s.messages.some((m) => m.id === streamingId)
      )
      if (streamingSession) {
        prevSt.persist(streamingSession.id)
        prevSt.setSessionStreaming(streamingSession.id, false)
      }
      prevSt.setStreamingId(null)
    }

    // 校验模型仍在运行
    const modelStillRunning = runningModels.find((m) => m.id === session.templateId)
    if (!modelStillRunning) {
      notify('该会话关联的模型未运行，请先启动或切换模型', 'error')
      return
    }

    setInput('')
    setAutoScroll(true)

    // 追加用户消息
    appendUserMessage(session.id, content)

    // 追加空的 assistant 占位消息，用 streamId 作为消息 id（用于 chunk 路由）
    const streamId = (crypto as any).randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))
    const assistantMsg: ChatMessage = {
      id: streamId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }
    appendMessage(session.id, assistantMsg)
    setStreamingId(streamId)
    useChatStore.getState().setSessionStreaming(session.id, true)

    // 看门狗：若 90 秒内既没收到任何 chunk、流也没结束，强制恢复输入能力
    // （防止模型加载缓慢或 IPC 异常导致输入框永久冻结）
    firstChunkReceivedRef.current = false
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current)
    streamWatchdogRef.current = setTimeout(() => {
      const st = useChatStore.getState()
      if (st.streamingId === streamId && !firstChunkReceivedRef.current) {
        st.markLastMessageError(session.id, '响应超时（90s 内无数据返回），可能是模型仍在加载中')
        st.setStreamingId(null)
        st.setSessionStreaming(session.id, false)
        notify('响应超时，请确认模型已加载完成', 'error')
      }
    }, 90000)

    // 组装 OpenAI 请求
    const updatedSession = { ...useChatStore.getState().sessions.find((s) => s.id === session.id)! }
    updatedSession.messages = [...updatedSession.messages] // 已含刚追加的两条
    const messages = buildOpenAiMessages(updatedSession)

    try {
      const res = await window.api.chatStream({
        streamId,
        port: session.port,
        body: {
          messages,
          temperature: session.params.temperature,
          top_p: session.params.top_p,
          top_k: session.params.top_k,
          max_tokens: session.params.max_tokens,
          repeat_penalty: session.params.repeat_penalty,
          stream: true
        }
      })
      if (!res.success && res.error) {
        // 错误已在 chunk 回调里处理；这里兜底
        const st = useChatStore.getState()
        if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
        if (st.streamingId === streamId) {
          st.setStreamingId(null)
          st.setSessionStreaming(session.id, false)
        }
      }
    } catch (e: any) {
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
      const st = useChatStore.getState()
      st.markLastMessageError(session.id, e?.message || '请求失败')
      if (st.streamingId === streamId) {
        st.setStreamingId(null)
        st.setSessionStreaming(session.id, false)
      }
    }
  }, [activeSessionId, input, streamingId, appendUserMessage, appendMessage, setStreamingId, markLastMessageError, runningModels])

  // 停止生成
  const handleStop = useCallback(() => {
    if (streamingId) {
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
      window.api.abortChatStream(streamingId)
      const st = useChatStore.getState()
      // 找到实际在流的会话，标记消息为手动停止（含落盘）
      const streamingSession = st.sessions.find((s) =>
        s.messages.some((m) => m.id === streamingId)
      )
      if (streamingSession) {
        st.markLastMessageStopped(streamingSession.id)
        st.setSessionStreaming(streamingSession.id, false)
      }
      setStreamingId(null)
    }
  }, [streamingId, setStreamingId])

  // 切换会话绑定的模型
  const handleSwitchModel = useCallback((templateId: string) => {
    if (!activeSessionId) return
    const m = runningModels.find((x) => x.id === templateId)
    if (m) setSessionModel(activeSessionId, m.id, m.port)
  }, [activeSessionId, runningModels, setSessionModel])

  // textarea 自适应高度 + Enter 发送
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // 任意输入变化（包括空格）均可重新触发代码预览
    setInputPreviewDismissed(false)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 编辑用户消息：将内容回填到输入框，截断该消息及之后的所有消息
  const handleEditMessage = useCallback((msgId: string, content: string) => {
    if (!activeSessionId) return
    setInput(content)
    truncateAfter(activeSessionId, msgId)
    persist(activeSessionId)
    inputRef.current?.focus()
  }, [activeSessionId, truncateAfter, persist])

  // 重新生成：找到该助手消息前面的用户消息，截断后重新发送（失败自动回滚）
  const handleRegenerate = useCallback(async (assistantMsgId: string) => {
    if (!activeSessionId || streamingId || runningModels.length === 0) return
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    const idx = session.messages.findIndex((m) => m.id === assistantMsgId)
    if (idx <= 0) return
    // 找到前一条用户消息
    let userMsgIdx = idx - 1
    while (userMsgIdx >= 0 && session.messages[userMsgIdx].role !== 'user') userMsgIdx--
    if (userMsgIdx < 0) return
    const userMsg = session.messages[userMsgIdx]

    // 备份旧消息（用于失败回滚）
    const savedMessages = [...session.messages]

    // 截断：从该用户消息之后全部删除
    truncateAfter(activeSessionId, userMsg.id)
    // 重新添加用户消息（truncateAfter 删掉了它）
    appendMessage(activeSessionId, userMsg)
    // 重新走发送流程
    setInput('')
    setAutoScroll(true)
    const streamId = (crypto as any).randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))

    // 设置回滚备份
    regenerateRollbackRef.current = { sessionId: activeSessionId, messages: savedMessages, streamId }

    const assistantMsg: ChatMessage = {
      id: streamId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }
    appendMessage(activeSessionId, assistantMsg)
    setStreamingId(streamId)
    useChatStore.getState().setSessionStreaming(activeSessionId, true)

    const updatedSession = { ...useChatStore.getState().sessions.find((s) => s.id === activeSessionId)! }
    updatedSession.messages = [...updatedSession.messages]
    const messages = buildOpenAiMessages(updatedSession)

    try {
      await window.api.chatStream({
        streamId,
        port: session.port,
        body: {
          messages,
          temperature: session.params.temperature,
          top_p: session.params.top_p,
          top_k: session.params.top_k,
          max_tokens: session.params.max_tokens,
          repeat_penalty: session.params.repeat_penalty,
          stream: true
        }
      })
    } catch (e: any) {
      // 请求异常：回滚恢复旧消息
      regenerateRollbackRef.current = null
      const st = useChatStore.getState()
      st.replaceMessages(activeSessionId, savedMessages)
      st.setStreamingId(null)
      st.setSessionStreaming(activeSessionId, false)
      notify(`重新生成失败：${e?.message || '请求失败'}，已恢复原回复`, 'error')
    }
  }, [activeSessionId, streamingId, truncateAfter, appendMessage, setStreamingId, runningModels])

  return (
    <div className={`chat-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="chat-sidebar-collapser" style={{ display: sidebarCollapsed ? 'none' : undefined }}>
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={selectSession}
          onNew={handleNew}
          onRename={renameSession}
          onDeleteRequest={(s) => setDeletingSession(s)}
          runningModels={runningModels}
          streamingSessionIds={streamingSessionIds}
        />
      </div>

      <div className="chat-main">
        <div className="chat-header">
          <button
            className="chat-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <div className="chat-header-info">
            <span className="chat-header-title">{activeSession?.title || '聊天'}</span>
            <select
              className="chat-model-select"
              value={activeSession && runningModels.length > 0 ? activeSession.templateId : ''}
              onChange={(e) => handleSwitchModel(e.target.value)}
              disabled={runningModels.length === 0}
            >
              {runningModels.length === 0 ? (
                <option value="">模型未运行</option>
              ) : runningModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name} (:{m.port})</option>
              ))}
            </select>
          </div>
          <button
            ref={settingsBtnRef}
            className="chat-settings-btn"
            onClick={() => {
              if (settingsBtnRef.current) {
                setSettingsAnchor(settingsBtnRef.current.getBoundingClientRect())
              }
              setShowSettings((v) => !v)
            }}
            onMouseEnter={handleSettingsEnter}
            onMouseLeave={handleSettingsLeave}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>

        <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {activeSession ? (
            activeMessages.length === 0 ? (
              <div className="chat-welcome">
                <Bot size={40} style={{ opacity: 0.3 }} />
                {activeModel ? (
                  <>
                    <p>向 {activeModel.name} 提个问题吧</p>
                    <div className="chat-welcome-suggestions">
                      <span className="chat-welcome-suggestions-label">试试这些提问</span>
                      <div className="chat-welcome-suggestions-grid">
                        {[
                          '用简单的语言解释一下量子计算',
                          '帮我写一段 Python 快速排序',
                          '给我讲一个有趣的冷知识',
                          '帮我总结今天的要点',
                        ].map((q) => (
                          <button
                            key={q}
                            className="chat-welcome-suggestion-btn"
                            onClick={() => { setInput(q); inputRef.current?.focus() }}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div>
                    <p>该会话的模型未运行，无法发送消息</p>
                    <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setView('cards')}>
                      前往「我的模板」启动模型
                    </button>
                  </div>
                )}
              </div>
            ) : (
              activeMessages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  isStreaming={streamingId === m.id}
                  onEdit={m.role === 'user' ? () => handleEditMessage(m.id, m.content) : undefined}
                  onRegenerate={m.role === 'assistant' ? () => handleRegenerate(m.id) : undefined}
                />
              ))
            )
          ) : (
            <div className="chat-welcome">
              <div className="chat-welcome-brand">
                <MessageSquare size={56} strokeWidth={1.2} />
              </div>
              <h2 className="chat-welcome-title">开始对话</h2>
              <p className="chat-welcome-subtitle">
                从左侧选择一个已有会话，或点击「新建」开始新的对话。
              </p>
              <div className="chat-welcome-tips">
                <div className="chat-welcome-tip">
                  <Plus size={16} />
                  <span>点击「新建」创建会话</span>
                </div>
                <div className="chat-welcome-tip">
                  <Pencil size={16} />
                  <span>点铅笔图标可重命名</span>
                </div>
                <div className="chat-welcome-tip">
                  <Trash2 size={16} />
                  <span>悬停会话可删除</span>
                </div>
              </div>
              {runningModels.length > 0 && (
                <div className="chat-welcome-suggestions">
                  <span className="chat-welcome-suggestions-label">试试这些提问</span>
                  <div className="chat-welcome-suggestions-grid">
                    {[
                      '用简单的语言解释一下量子计算',
                      '帮我写一段 Python 快速排序',
                      '给我讲一个有趣的冷知识',
                      '帮我总结今天的要点',
                    ].map((q) => (
                      <button
                        key={q}
                        className="chat-welcome-suggestion-btn"
                        onClick={() => { setInput(q); inputRef.current?.focus() }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div ref={messagesEndRef} />
          {!autoScroll && activeMessages.length > 0 && (
            <button
              className="chat-scroll-bottom-btn"
              onClick={() => {
                setAutoScroll(true)
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
              }}
            >
              <ArrowDown size={16} />
            </button>
          )}
        </div>

        {/* 消息导航侧边栏 */}
        {activeMessages.length >= 2 && (
          <MessageNav
            messages={activeMessages}
            activeMsgId={activeNavMsgId}
            containerRef={messagesContainerRef}
          />
        )}

        {/* 输入代码预览：独立于输入框，置于其上方 */}
        {showInputPreview && (
          <div className="chat-input-preview">
            <div className="chat-input-preview-header">
              <Eye size={12} />
              <span>代码预览</span>
              <button
                className="chat-input-preview-close"
                onClick={() => setInputPreviewDismissed(true)}
              >
                <X size={12} />
              </button>
            </div>
            <div className="chat-input-preview-body">
              <UserMessageContent content={input} />
            </div>
          </div>
        )}

        <div className={`chat-input-wrap${streamingId ? ' streaming' : ''}`}>
          <textarea
            ref={inputRef}
            className="chat-input"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            placeholder={
              streamingId
                ? '正在生成，可发送新消息（将自动停止当前流）…'
                : activeModel
                  ? `给 ${activeModel.name} 发消息（Enter 发送，Shift+Enter 换行）`
                  : '请先启动模型后再发送消息'
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!activeModel}
          />
          {streamingId ? (
            <button className="btn btn-danger chat-send-btn" onClick={handleStop}>
              <Square size={15} />
            </button>
          ) : (
            <button
              className="btn btn-primary chat-send-btn"
              onClick={handleSend}
              disabled={!input.trim() || !activeModel}
            >
              <Send size={15} />
            </button>
          )}
        </div>

      </div>

      {/* 参数/系统提示词设置卡片 */}
      {showSettings && (
        <ChatSettingsCard
          session={activeSession}
          anchorRect={settingsAnchor}
          onClose={() => setShowSettings(false)}
          onSetSystemPrompt={(prompt) => activeSession && setSystemPrompt(activeSession.id, prompt)}
          onSetParams={(params) => activeSession && setParams(activeSession.id, params)}
          onMouseEnter={handleSettingsCardEnter}
          onMouseLeave={handleSettingsCardLeave}
        />
      )}

      <ConfirmModal
        open={deletingSession !== null}
        title="删除会话"
        message={deletingSession ? `确定删除会话「${deletingSession.title}」？此操作不可撤销。` : ''}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (deletingSession) deleteSession(deletingSession.id)
          setDeletingSession(null)
        }}
        onCancel={() => setDeletingSession(null)}
      />
    </div>
  )
}
