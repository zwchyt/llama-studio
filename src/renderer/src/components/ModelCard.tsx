import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { useChatStore } from '../store/chatStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { Play, Square, Settings, ChevronDown, MoreVertical, Copy, Trash, Download, Globe, Server, Terminal, Check, MessageSquare } from 'lucide-react'
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
  const logsEndRef = useRef<HTMLDivElement>(null)
  const logsBodyRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
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
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true || val === 'true' || val === '1') args.push(cmd.arg) }
            else if (cmd.type === 'select' && cmd.options && !cmd.options.includes(String(val))) continue
            else args.push(cmd.arg, String(val))
          }
        }
      }
    } else {
      const fallbackAllowed = new Set(['--model', '-m', '--port', '--host', '--no-webui', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b', '--flash-attn', '-fa', '--mlock', '--mmap', '--verbose'])
      for (const [k, v] of Object.entries(tArgs)) {
        if (!fallbackAllowed.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    if (!args.includes('--port') && card.template.serverPort) {
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
        <div className="card-icon">
          {isRunning ? (
            <div className="spin"><Settings size={20} className="text-success" /></div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          )}
        </div>
        <div className="card-info">
          <h3 className="card-name" title={card.template.name} style={isRunning ? { color: 'var(--success)' } : {}}>{card.template.name}</h3>
          <p className="card-desc" title={card.template.description}>{card.template.description || '暂无描述'}</p>
        </div>
        <div className="card-menu-btn" ref={menuRef} style={{ position: 'relative', zIndex: 10 }}
          onMouseEnter={() => {
            clearTimeout(hideTimerRef.current)
            setShowMenu(true)
          }}
          onMouseLeave={() => {
            hideTimerRef.current = setTimeout(() => setShowMenu(false), 150)
          }}
        >
          <button className="btn btn-ghost btn-icon" aria-label="更多操作">
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
        <span className="card-tag" title={card.template.modelPath}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
          {!modelExists ? <span style={{ color: 'var(--danger)' }}>文件缺失</span> : (card.template.modelPath?.split(/[/\\]/).pop() || '无模型')}
        </span>
        <span className="card-tag">
          <span className={`status-dot ${isRunning ? 'running' : 'idle'}`} />
          {isRunning ? `端口 ${card.template.serverPort}` : '就绪'}
        </span>
      </div>
      <div className="card-launch-mode">
        <button
          className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`}
          onClick={() => setLaunchMode('chat')}
          title="启动时打开聊天网页界面"
          disabled={isRunning}
        >
          <Globe size={12} /> 聊天界面
        </button>
        <button
          className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`}
          onClick={() => setLaunchMode('api')}
          title="仅提供 API 服务，不打开网页界面"
          disabled={isRunning}
        >
          <Server size={12} /> 仅 API
        </button>
      </div>
      <div className="card-actions">
        <button
          className={`btn card-run-btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleRunToggle}
          disabled={!isRunning && !modelExists}
          style={isRunning ? { flex: 0.5 } : {}}
          title={!isRunning && !modelExists ? '无法启动：模型文件缺失' : ''}
        >
          {isRunning ? <><Square size={14} /> 停止</> : <><Play size={14} /> 启动</>}
        </button>
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ flex: 0.5, background: 'var(--accent)', color: 'var(--accent-fg)' }}
            onClick={() => {
              const port = card.template.serverPort || 8080
              useStore.getState().setActiveChat(`http://127.0.0.1:${port}`, port)
              useStore.getState().setView('llama')
            }}
            title="在主窗口打开聊天"
          >
            <Globe size={14} /> 打开聊天
          </button>
        )}
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ flex: 0.5, background: 'var(--success)', color: '#fff' }}
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
            title="跳转到原生聊天界面"
          >
            <MessageSquare size={14} /> 原生聊天
          </button>
        )}
        <button
          className="card-expand-btn"
          onClick={() => setShowParamsModal(true)}
          title="配置命令行参数"
        >
          <Settings size={16} />
        </button>
      </div>
      {(isRunning || card.status === 'error') && logs && logs.length > 0 && (
        <div className={`card-logs-section ${cardLogsExpanded ? 'open' : ''}`}>
          <div className="card-logs-header">
            <button
              className="card-logs-toggle"
              onClick={() => setCardLogsExpanded(!cardLogsExpanded)}
            >
              <Terminal size={13} />
              <span>{logs?.length || 0} 行</span>
              <ChevronDown size={13} className="card-logs-chevron" />
            </button>
            <div className="card-logs-header-actions">
              <button className="card-logs-header-btn" onClick={handleCopyLogs} title="复制全部日志">
                {logCopied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <button className="card-logs-header-btn" onClick={handleClearLogs} title="清空日志">
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
        </div>
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
