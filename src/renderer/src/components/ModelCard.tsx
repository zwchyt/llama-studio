import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import { useChatStore } from '../store/chatStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { Play, Square, Settings, MoreVertical, Copy, Trash, Download, Globe, Server, Terminal, Check, MessageSquare } from 'lucide-react'
import type { CardState } from '../../../shared/types'
import ParamsModal from './ParamsModal'
import ConfirmModal from './ConfirmModal'
interface Props { card: CardState }
export default function ModelCard({ card }: Props) {
  const { updateCard, setCardStatus, removeCard, backends, activeBackend, commandsSchema, setShowCreateModal, clearModelMetrics } = useStore(
    s => ({ updateCard: s.updateCard, setCardStatus: s.setCardStatus, removeCard: s.removeCard, backends: s.backends, activeBackend: s.activeBackend, commandsSchema: s.commandsSchema, setShowCreateModal: s.setShowCreateModal, clearModelMetrics: s.clearModelMetrics }),
    shallow
  )
  const [showMenu, setShowMenu] = useState(false)
  const [showParamsModal, setShowParamsModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isRunning = card.status === 'running'
  const launchMode = card.template.launchMode || 'chat'
  const logs = useStore(s => s.modelLogs[card.template.id])
  const clearModelLogs = useStore(s => s.clearModelLogs)
  const [cardLogsExpanded, setCardLogsExpanded] = useState(false)
  const [logCopied, setLogCopied] = useState(false)
  const logCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const nameRef = useRef<HTMLHeadingElement>(null)
  const [nameOverflow, setNameOverflow] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const modelTagRef = useRef<HTMLSpanElement>(null)
  const [modelTagOverflow, setModelTagOverflow] = useState(false)
  const avatar = useMemo(() => {
    const key = card.template.name || '?'
    let h = 0
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360
    return {
      bg: `hsl(${h}, 65%, 88%)`,
      fg: `hsl(${h}, 45%, 32%)`,
      letter: (key.trim()[0] || '?').toUpperCase(),
    }
  }, [card.template.name])
  const logsBodyRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const logsBtnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (cardLogsExpanded && logsBodyRef.current && !userScrolledRef.current) {
      logsBodyRef.current.scrollTop = logsBodyRef.current.scrollHeight
    }
  }, [(logs?.length ?? 0), cardLogsExpanded])
  useEffect(() => {
    const el = logsBodyRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      userScrolledRef.current = !atBottom
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [cardLogsExpanded])
  function checkOverflow(
    ref: React.RefObject<HTMLElement | null>,
    setter: (v: boolean) => void,
    varName: string
  ) {
    const el = ref.current
    if (!el) return
    const overflow = el.scrollWidth > el.clientWidth + 1
    setter(overflow)
    if (overflow) el.style.setProperty(varName, `${el.scrollWidth - el.clientWidth}px`)
  }
  useEffect(() => { checkOverflow(nameRef, setNameOverflow, '--name-slide') }, [card.template.name])
  useEffect(() => { checkOverflow(modelTagRef, setModelTagOverflow, '--tag-slide') }, [card.template.modelPath])
  function handleCopyLogs() {
    const text = (logs ?? []).map(e => e.text).join('\n')
    safeCall(() => navigator.clipboard.writeText(text), '复制失败').then((ok) => {
      if (ok !== null) {
        setLogCopied(true)
        clearTimeout(logCopiedTimeoutRef.current)
        logCopiedTimeoutRef.current = setTimeout(() => setLogCopied(false), 2000)
      }
    })
  }
  function handleClearLogs() {
    clearModelLogs(card.template.id)
  }
  function toggleLogs() {
    if (cardLogsExpanded) {
      setCardLogsExpanded(false)
      setPopoverPos(null)
      return
    }
    const el = logsBtnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const PW = 380
    const PH = 460
    let left = r.left
    if (left + PW > window.innerWidth - 8) left = window.innerWidth - 8 - PW
    if (left < 8) left = 8
    let top = r.bottom + 6
    if (top + PH > window.innerHeight - 8) {
      top = r.top - 6 - PH
      if (top < 8) top = 8
    }
    setPopoverPos({ top, left })
    setCardLogsExpanded(true)
  }
  useEffect(() => {
    if (!cardLogsExpanded) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (popoverRef.current && popoverRef.current.contains(t)) return
      if (logsBtnRef.current && logsBtnRef.current.contains(t)) return
      setCardLogsExpanded(false)
      setPopoverPos(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setCardLogsExpanded(false); setPopoverPos(null) }
    }
    function onScroll(e: Event) {
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      setCardLogsExpanded(false)
      setPopoverPos(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [cardLogsExpanded])
  const [modelExists, setModelExists] = useState(true)
  useEffect(() => {
    if (!card.template.modelPath) { setModelExists(true); return }
    window.api.checkFileExists(card.template.modelPath).then(setModelExists).catch(() => setModelExists(false))
  }, [card.template.modelPath])
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      clearTimeout(logCopiedTimeoutRef.current)
      clearTimeout(hideTimerRef.current)
    }
  }, [])
  async function handleRunToggle() {
    if (isRunning) {
      // optimistic update: update UI immediately for zero-latency
      setCardStatus(card.template.id, 'idle')
      clearModelMetrics(card.template.id)
      const { activeChatPort, clearActiveChat } = useStore.getState()
      if (activeChatPort === card.template.serverPort) clearActiveChat()
      const res = await safeCall(() => window.api.stopModel(card.template.id), '停止模型失败')
      if (res === null) { setCardStatus(card.template.id, 'running'); return }
      if (!res.success) notify(`停止失败：${res.error}`, 'error')
      return
    }
    let targetBackend = backends.find(b => b.name === card.template.backendVersion)
    if (!targetBackend && activeBackend) targetBackend = activeBackend
    if (!targetBackend || !targetBackend.exe) {
      notify('未找到后端或无可执行文件。', 'error')
      return
    }
    const args: string[] = []
    const tArgs = card.template.args
    if (card.template.modelPath) args.push('-m', card.template.modelPath)
    if (commandsSchema) {
      for (const cat of commandsSchema.categories) {
        for (const cmd of cat.commands) {
          if (cmd.arg === '--port' || cmd.arg === '--model') continue
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true || val === 'true' || val === '1') args.push(cmd.arg) }
            else if (cmd.type === 'select' && cmd.options && !cmd.options.includes(String(val))) continue
            else args.push(cmd.arg, String(val))
          }
        }
      }
    } else {
      const fallbackAllowed = new Set(['--host', '--no-webui', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b', '--flash-attn', '-fa', '--mlock', '--mmap', '--verbose'])
      for (const [k, v] of Object.entries(tArgs)) {
        if (!fallbackAllowed.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    if (card.template.serverPort) {
      args.push('--port', String(card.template.serverPort))
    }
    const port = card.template.serverPort || 8080
    const backendPath = targetBackend.path
    const exe = targetBackend.exe!
    const res = await safeCall(() => window.api.runModel({
      id: card.template.id,
      backendPath,
      exe,
      args,
      openBrowser: false,
      port
    }), '启动模型失败')
    if (res === null) { setCardStatus(card.template.id, 'error'); return }
    if (res.success) {
      clearModelLogs(card.template.id)
      setCardStatus(card.template.id, 'running', res.pid)
      if (launchMode === 'chat') {
        useStore.getState().setActiveChat(`http://127.0.0.1:${port}`, port)
        useStore.getState().setView('llama')
      }
    } else { notify(`运行失败：${res.error}`, 'error'); setCardStatus(card.template.id, 'error') }
  }
  const handleDelete = useCallback(async () => {
    if (isRunning) { notify('请先停止模型再删除。', 'error'); return }
    setShowMenu(false)
    setShowDeleteConfirm(true)
  }, [isRunning])
  const confirmDelete = useCallback(async () => {
    const ok = await safeCall(() => window.api.deleteTemplate(card.template.id), '删除模板失败')
    if (ok === null) return
    removeCard(card.template.id)
    setShowDeleteConfirm(false)
  }, [card.template.id, removeCard])
  const handleExport = useCallback(async () => { await safeCall(() => window.api.exportTemplate(card.template), '导出模板失败'); setShowMenu(false) }, [card.template])
  const handleEdit = useCallback(() => { setShowCreateModal(true, card.template); setShowMenu(false) }, [card.template, setShowCreateModal])
  const handleDuplicate = useCallback(async () => {
    const t = { ...card.template, id: crypto.randomUUID(), name: `${card.template.name} (Copy)` }
    const res = await safeCall(() => window.api.saveTemplate(t), '复制模板失败')
    if (res && res.success) useStore.getState().addCard({ ...t, id: res.id })
    setShowMenu(false)
  }, [card.template])
  const setLaunchMode = useCallback(async (mode: 'chat' | 'api') => {
    const res = await safeCall(() => window.api.saveTemplate({ ...card.template, launchMode: mode }), '设置启动模式失败')
    if (res && res.success) {
      updateCard(card.template.id, { launchMode: mode })
    }
  }, [card.template.id, updateCard])
  return (
    <div className={`model-card ${isRunning ? 'running' : ''}`}>
      <div className="card-header">
        <div
          className={`card-icon${isRunning ? ' running' : ''}`}
          style={{ background: avatar.bg, color: avatar.fg }}
        >
          <span className="card-icon-letter">{avatar.letter}</span>
          {isRunning && <span className="card-icon-spin" />}
        </div>
        <div className="card-info">
          <h3
            ref={nameRef}
            className={`card-name${nameOverflow ? ' card-name--slide' : ''}`}
            style={isRunning ? { color: 'var(--success)' } : card.status === 'error' ? { color: 'var(--danger)' } : {}}
          >
            <span className="card-name-text">{card.template.name}</span>
          </h3>
          {card.template.description?.trim() && (
            <p className="card-desc">{card.template.description}</p>
          )}
        </div>
        <div className="card-menu-btn" ref={menuRef} style={{ position: 'relative', zIndex: 10 }}>
          <button className="btn btn-ghost btn-icon" aria-label="更多操作" onClick={() => setShowMenu(p => !p)}>
            <MoreVertical size={16} />
          </button>
          {showMenu && (
            <div className="dropdown-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 500 }}>
              <button className="dropdown-item" onClick={handleEdit}><Settings size={14} /> 编辑模板</button>
              <button className="dropdown-item" onClick={handleDuplicate}><Copy size={14} /> 复制</button>
              <button className="dropdown-item" onClick={handleExport}><Download size={14} /> 导出</button>
              <div className="dropdown-divider" />
              <button className="dropdown-item danger" onClick={handleDelete}><Trash size={14} /> 删除</button>
            </div>
          )}
        </div>
      </div>
      <div className="card-meta">
        <span
          ref={modelTagRef}
          className={`card-tag card-tag--model${modelTagOverflow ? ' card-tag--slide' : ''}`}
        >
          <span className="card-tag-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
            {!modelExists ? <span style={{ color: 'var(--danger)' }}>文件缺失</span> : (card.template.modelPath?.split(/[/\\]/).pop() || '无模型')}
          </span>
        </span>
        <span className="card-tag card-tag--status">
          <span className={`status-dot ${card.ready ? 'ready' : isRunning ? 'running' : card.status === 'error' ? 'error' : 'idle'}`} />
          {card.ready ? '就绪' : isRunning ? '启动中' : card.status === 'error' ? '错误' : '未启动'}
        </span>
      </div>
      <div className="card-launch-mode">
        <button
          className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`}
          onClick={() => setLaunchMode('chat')}
          disabled={isRunning}
        >
          <Globe size={12} /> 聊天界面
        </button>
        <button
          className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`}
          onClick={() => setLaunchMode('api')}
          disabled={isRunning}
        >
          <Server size={12} /> 仅 API
        </button>
        {(isRunning || card.status === 'error') && logs && logs.length > 0 && (
          <button
            ref={logsBtnRef}
            className={`launch-mode-btn logs-toggle-btn ${cardLogsExpanded ? 'active' : ''}`}
            onClick={toggleLogs}
          >
            <Terminal size={12} /> 日志
          </button>
        )}
      </div>
      <div className="card-actions">
        <button
          className={`btn card-run-btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleRunToggle}
          disabled={!isRunning && !modelExists}
        >
          {isRunning ? <><Square size={14} /> <span className="btn-label">停止</span></> : <><Play size={14} /> <span className="btn-label">启动</span></>}
        </button>
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ background: '#c1c1c1', color: '#1e0303' }}
            onClick={() => {
              const port = card.template.serverPort || 8080
              useStore.getState().setActiveChat(`http://127.0.0.1:${port}`, port)
              useStore.getState().setView('llama')
            }}
          >
            <Globe size={14} /> <span className="btn-label">打开聊天</span>
          </button>
        )}
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ background: 'rgb(98 157 69)', color: 'rgb(37 8 8)' }}
            onClick={() => {
              const id = card.template.id
              const port = card.template.serverPort || 8080
              const name = card.template.name
              const st = useChatStore.getState()
              // 查找是否已有此模型的会话
              let session = st.sessions.find(s => s.templateId === id)
              if (!session) {
                const newId = st.createSession(id, port, name)
                session = st.sessions.find(s => s.id === newId)!
              } else {
                st.selectSession(session.id)
              }
              useStore.getState().setView('chat')
            }}
          >
            <MessageSquare size={14} /> <span className="btn-label">原生聊天</span>
          </button>
        )}
        {!isRunning && (
          <button
            className="card-expand-btn"
            onClick={() => setShowParamsModal(true)}
          >
            <Settings size={16} />
          </button>
        )}
      </div>
      {(isRunning || card.status === 'error') && logs && logs.length > 0 && cardLogsExpanded && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="card-logs-section logs-popover open"
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <div className="card-logs-header">
            <span className="card-logs-count">
              <Terminal size={13} />
              {logs?.length || 0} 行
            </span>
            <div className="card-logs-header-actions">
              <button className="card-logs-header-btn" onClick={handleCopyLogs}>
                {logCopied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <button className="card-logs-header-btn" onClick={handleClearLogs}>
                <Trash size={12} />
              </button>
            </div>
          </div>
          <div className="card-logs-body" ref={logsBodyRef}>
            <div className="card-logs-scroll">
              {logs?.map((entry, i) => (
                <div key={i} className={`log-entry ${entry.className}`}>
                  {entry.text}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>,
        document.body
      )}
      {showParamsModal && (
        <ParamsModal
          templateId={card.template.id}
          args={card.template.args}
          onClose={() => setShowParamsModal(false)}
          cardName={card.template.name}
        />
      )}
      <ConfirmModal
        open={showDeleteConfirm}
        title="删除模板"
        message={`确定要删除「${card.template.name}」吗？此操作不可撤销。`}
        confirmLabel="删除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}
