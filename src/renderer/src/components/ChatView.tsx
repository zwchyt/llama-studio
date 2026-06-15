import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Plus, Send, Square, Trash2, Pencil, MessageSquare, Settings2,
  ChevronDown, ChevronUp, Bot, PanelLeftClose, PanelLeftOpen, Brain, RefreshCw
} from 'lucide-react'
import { useChatStore, buildOpenAiMessages } from '../store/chatStore'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import type { ChatSession, ChatMessage } from '../../../shared/types'
import CodeBlock from './CodeBlock'

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

// 思考块：可折叠
function ThinkBlock({ value, closed, isStreaming, autoExpand }: { value: string; closed: boolean; isStreaming?: boolean; autoExpand?: boolean }) {
  const [expanded, setExpanded] = useState(autoExpand ?? false)
  const thinking = !closed || isStreaming
  return (
    <div className={`chat-think ${thinking ? 'thinking' : ''} ${expanded ? 'expanded' : ''}`}>
      <button className="chat-think-toggle" onClick={() => setExpanded(!expanded)}>
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
        <div className="chat-think-body">{value || '（空）'}</div>
      )}
    </div>
  )
}

// ── 单条消息 ───────────────────────────────────────────────
function MessageBubble({ msg, isStreaming }: { msg: ChatMessage; isStreaming?: boolean }) {
  const isUser = msg.role === 'user'
  // 助手消息解析思考链片段（含 <think>...</think>）
  const segments = useMemo(
    () => (!isUser ? parseThinkSegments(msg.content) : []),
    [isUser, msg.content]
  )

  return (
    <div className={`chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}`}>
      <div className="chat-msg-avatar">
        {isUser ? (
          <span style={{ fontSize: 12, fontWeight: 700 }}>我</span>
        ) : (
          <Bot size={14} />
        )}
      </div>
      <div className="chat-msg-body">
        {isUser ? (
          <div className="chat-msg-text">{msg.content}</div>
        ) : msg.error ? (
          <div className="chat-msg-error">{msg.content}</div>
        ) : msg.content ? (
          <>
            {segments.map((seg, i) => {
              if (seg.type === 'think') {
                // 思考片段：只有这条消息正在流式 且 该思考块尚未闭合时，显示「思考中」动画
                const thinkStreaming = isStreaming && !seg.closed
                return <ThinkBlock key={i} value={seg.value} closed={seg.closed} isStreaming={thinkStreaming} />
              }
              // 文本片段：正常 Markdown 渲染
              return (
                <div key={i} className="chat-msg-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode as any }}>
                    {seg.value}
                  </ReactMarkdown>
                </div>
              )
            })}
            {/* 光标：仅当最后一段是文本、且无未闭合思考块、且正在流式时显示 */}
            {isStreaming && segments.length > 0 &&
              segments[segments.length - 1].type === 'text' &&
              <span className="chat-cursor" />}
          </>
        ) : (
          <div className="chat-msg-placeholder">
            {isStreaming ? (
              <ThinkBlock value="" closed={false} isStreaming={true} autoExpand={false} />
            ) : '（空回复）'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 左栏：会话列表 ─────────────────────────────────────────
function SessionList({ sessions, activeId, onSelect, onNew, onRename, onDelete, runningModels }: {
  sessions: ChatSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  runningModels: Array<{ id: string; name: string; port: number }>
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
          disabled={runningModels.length === 0}
          title={runningModels.length === 0 ? '请先启动一个模型' : '新建对话'}
        >
          <Plus size={13} /> 新建
        </button>
      </div>
      <div className="chat-session-list">
        {sessions.length === 0 ? (
          <div className="chat-session-empty">
            {runningModels.length === 0
              ? '先在「我的模板」启动一个模型，再来这里对话。'
              : '点击「新建」开始第一个对话。'}
          </div>
        ) : sessions.map((s) => {
          const model = runningModels.find((m) => m.id === s.templateId)
          return (
            <div
              key={s.id}
              className={`chat-session-item ${activeId === s.id ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
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
                    <div className="chat-session-meta">
                      <span className={`chat-session-model ${model ? '' : 'stale'}`}>
                        {model ? model.name : '模型未运行'}
                      </span>
                      <span>· 端口 {s.port}</span>
                    </div>
                  </div>
                  <div className="chat-session-actions">
                    <button
                      className="chat-session-btn"
                      onClick={(e) => { e.stopPropagation(); startEdit(s) }}
                      title="重命名"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="chat-session-btn danger"
                      onClick={(e) => { e.stopPropagation(); if (confirm(`删除会话「${s.title}」？`)) onDelete(s.id) }}
                      title="删除"
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

// ── 右栏：参数面板 ─────────────────────────────────────────
function ParamsPanel({ session, onUpdate }: {
  session: ChatSession
  onUpdate: (params: Partial<typeof session.params>, systemPrompt?: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [localPrompt, setLocalPrompt] = useState(session.systemPrompt || '')
  const p = session.params

  useEffect(() => { setLocalPrompt(session.systemPrompt || '') }, [session.id, session.systemPrompt])

  const commitPrompt = () => {
    if (localPrompt !== (session.systemPrompt || '')) onUpdate({}, localPrompt)
  }

  return (
    <div className="chat-params-panel">
      <button className="chat-params-toggle" onClick={() => setExpanded(!expanded)}>
        <Settings2 size={14} />
        <span>采样参数</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="chat-params-body">
          <div className="chat-param-row">
            <label className="chat-param-label">
              Temperature <span className="chat-param-value">{p.temperature ?? '—'}</span>
            </label>
            <input
              type="range" min={0} max={2} step={0.05}
              value={p.temperature ?? 0.8}
              onChange={(e) => onUpdate({ temperature: parseFloat(e.target.value) })}
            />
          </div>
          <div className="chat-param-row">
            <label className="chat-param-label">
              Top P <span className="chat-param-value">{p.top_p ?? '—'}</span>
            </label>
            <input
              type="range" min={0} max={1} step={0.01}
              value={p.top_p ?? 0.95}
              onChange={(e) => onUpdate({ top_p: parseFloat(e.target.value) })}
            />
          </div>
          <div className="chat-param-row">
            <label className="chat-param-label">
              Top K <span className="chat-param-value">{p.top_k ?? '—'}</span>
            </label>
            <input
              type="range" min={0} max={200} step={1}
              value={p.top_k ?? 40}
              onChange={(e) => onUpdate({ top_k: parseInt(e.target.value) })}
            />
          </div>
          <div className="chat-param-row">
            <label className="chat-param-label">
              Max tokens <span className="chat-param-value">{(p.max_tokens ?? -1) === -1 ? '∞' : p.max_tokens}</span>
            </label>
            <input
              type="number" min={-1} step={16}
              value={p.max_tokens ?? -1}
              onChange={(e) => onUpdate({ max_tokens: parseInt(e.target.value) })}
            />
          </div>
          <div className="chat-param-row">
            <label className="chat-param-label">
              Repeat penalty <span className="chat-param-value">{p.repeat_penalty ?? '—'}</span>
            </label>
            <input
              type="range" min={1} max={2} step={0.01}
              value={p.repeat_penalty ?? 1.1}
              onChange={(e) => onUpdate({ repeat_penalty: parseFloat(e.target.value) })}
            />
          </div>
          <div className="chat-param-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <label className="chat-param-label">System Prompt</label>
            <textarea
              className="form-input chat-param-textarea"
              placeholder="设定模型的角色或行为（可选）"
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={commitPrompt}
              rows={4}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── 主视图 ─────────────────────────────────────────────────
export default function ChatView() {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingId = useChatStore((s) => s.streamingId)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const createSession = useChatStore((s) => s.createSession)
  const selectSession = useChatStore((s) => s.selectSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt)
  const setParams = useChatStore((s) => s.setParams)
  const setSessionModel = useChatStore((s) => s.setSessionModel)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const markLastMessageError = useChatStore((s) => s.markLastMessageError)
  const setStreamingId = useChatStore((s) => s.setStreamingId)
  const persist = useChatStore((s) => s.persist)

  const cards = useStore((s) => s.cards)
  const runningModels = useMemo(
    () => cards.filter((c) => c.status === 'running')
      .map((c) => ({ id: c.template.id, name: c.template.name, port: c.template.serverPort || 8080 })),
    [cards]
  )

  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 看门狗：防止流卡住导致输入框永久冻结
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstChunkReceivedRef = useRef(false)

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null
  const activeMessages = activeSession?.messages || []
  const activeModel = runningModels.find((m) => m.id === activeSession?.templateId)

  // 首次加载会话
  useEffect(() => { loadSessions() }, [loadSessions])

  // 全局监听流式 chunk
  useEffect(() => {
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
      }
      if (data.done) {
        // 清理看门狗定时器
        if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
        firstChunkReceivedRef.current = false
        if (data.error) {
          st.markLastMessageError(targetSession.id, data.error)
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
  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [activeMessages.length, activeMessages[activeMessages.length - 1]?.content, autoScroll])

  // 监听滚动：用户上滚则暂停自动滚动
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(atBottom)
  }, [])

  // 新建会话
  const handleNew = useCallback(() => {
    if (runningModels.length === 0) {
      notify('请先在「我的模板」启动一个模型', 'error')
      return
    }
    // 若只有一个运行模型直接用；多个则用第一个（用户可后续在面板切换）
    const m = runningModels[0]
    createSession(m.id, m.port, m.name)
    setInput('')
  }, [runningModels, createSession])

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
      prevSt.persist(activeSessionId!)
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

    // 看门狗：若 90 秒内既没收到任何 chunk、流也没结束，强制恢复输入能力
    // （防止模型加载缓慢或 IPC 异常导致输入框永久冻结）
    firstChunkReceivedRef.current = false
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current)
    streamWatchdogRef.current = setTimeout(() => {
      const st = useChatStore.getState()
      if (st.streamingId === streamId && !firstChunkReceivedRef.current) {
        st.markLastMessageError(session.id, '响应超时（90s 内无数据返回），可能是模型仍在加载中')
        st.setStreamingId(null)
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
        if (st.streamingId === streamId) st.setStreamingId(null)
      }
    } catch (e: any) {
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
      const st = useChatStore.getState()
      st.markLastMessageError(session.id, e?.message || '请求失败')
      if (st.streamingId === streamId) st.setStreamingId(null)
    }
  }, [activeSessionId, input, streamingId, appendUserMessage, appendMessage, setStreamingId, markLastMessageError, runningModels])

  // 停止生成
  const handleStop = useCallback(() => {
    if (streamingId) {
      if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null }
      window.api.abortChatStream(streamingId)
      const st = useChatStore.getState()
      st.persist(activeSessionId!) // 落盘已生成部分
      setStreamingId(null)
    }
  }, [streamingId, activeSessionId, setStreamingId, persist])

  // 切换会话绑定的模型
  const handleSwitchModel = useCallback((templateId: string) => {
    if (!activeSessionId) return
    const m = runningModels.find((x) => x.id === templateId)
    if (m) setSessionModel(activeSessionId, m.id, m.port)
  }, [activeSessionId, runningModels, setSessionModel])

  // 参数更新
  const handleParamsUpdate = useCallback((params: Partial<ChatSession['params']>, systemPrompt?: string) => {
    if (!activeSessionId) return
    if (Object.keys(params).length > 0) setParams(activeSessionId, params)
    if (systemPrompt !== undefined) setSystemPrompt(activeSessionId, systemPrompt)
  }, [activeSessionId, setParams, setSystemPrompt])

  // textarea 自适应高度 + Enter 发送
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
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

  // ── 空状态：无运行模型 ──
  if (runningModels.length === 0) {
    return (
      <div className="chat-empty">
        <MessageSquare size={48} style={{ opacity: 0.3 }} />
        <h3>没有正在运行的模型</h3>
        <p>原生聊天界面通过 llama-server 的 API 工作。<br />请先在「我的模板」启动一个模型，再回到这里对话。</p>
      </div>
    )
  }

  return (
    <div className={`chat-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {!sidebarCollapsed && (
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={selectSession}
          onNew={handleNew}
          onRename={renameSession}
          onDelete={deleteSession}
          runningModels={runningModels}
        />
      )}

      <div className="chat-main">
        {activeSession ? (
          <>
            <div className="chat-header">
              <button
                className="chat-collapse-btn"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                title={sidebarCollapsed ? '展开会话列表' : '折叠会话列表'}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <div className="chat-header-info">
                <span className="chat-header-title">{activeSession.title}</span>
                <select
                  className="chat-model-select"
                  value={activeSession.templateId}
                  onChange={(e) => handleSwitchModel(e.target.value)}
                  title="切换本会话使用的模型"
                >
                  {runningModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} (:{m.port})</option>
                  ))}
                </select>
              </div>
              <ParamsPanel session={activeSession} onUpdate={handleParamsUpdate} />
            </div>

            <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
              {activeMessages.length === 0 ? (
                <div className="chat-welcome">
                  <Bot size={40} style={{ opacity: 0.3 }} />
                  <p>向 {activeModel?.name || '模型'} 提个问题吧</p>
                </div>
              ) : (
                activeMessages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    isStreaming={streamingId === m.id}
                  />
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-wrap">
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder={
                  streamingId
                    ? '正在生成，可发送新消息（将自动停止当前流）…'
                    : `给 ${activeModel?.name || '模型'} 发消息（Enter 发送，Shift+Enter 换行）`
                }
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                rows={1}
              />
              {streamingId ? (
                <>
                  <button className="btn btn-danger chat-send-btn" onClick={handleStop} title="停止生成">
                    <Square size={15} />
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-primary chat-send-btn"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="发送"
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="chat-header">
              <button
                className="chat-collapse-btn"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                title={sidebarCollapsed ? '展开会话列表' : '折叠会话列表'}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
            </div>
            <div className="chat-welcome">
              <MessageSquare size={48} style={{ opacity: 0.3 }} />
              <h3>选择左侧的会话，或点击「新建」开始</h3>
              <button className="btn btn-primary" onClick={handleNew}>
                <Plus size={15} /> 新建对话
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
