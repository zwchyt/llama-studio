import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import { useChatStore } from '../store/chatStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { ENGINE_LABELS, paramSetOf } from '../utils/engine'
import { PlayIcon, CircleStopIcon, SettingsIcon, EllipsisVerticalIcon, CopyIcon, TrashIcon, DownloadIcon, GlobeIcon, ServerIcon, TerminalIcon, CheckIcon, MessageSquareIcon, ImageIcon, ScanIcon, RefreshCwIcon } from '@animateicons/react/lucide'
import type { CardState } from '../../../shared/types'
import ParamsModal from './ParamsModal'
interface Props { card: CardState; style?: React.CSSProperties }
export default function ModelCard({ card, style }: Props) {
  const { updateCard, setCardStatus, removeCard, backends, activeBackend, commandsSchema, setShowCreateModal, clearModelMetrics } = useStore(
    s => ({ updateCard: s.updateCard, setCardStatus: s.setCardStatus, removeCard: s.removeCard, backends: s.backends, activeBackend: s.activeBackend, commandsSchema: s.commandsSchema, setShowCreateModal: s.setShowCreateModal, clearModelMetrics: s.clearModelMetrics }),
    shallow
  )
  const [showMenu, setShowMenu] = useState(false)
  const [showParamsModal, setShowParamsModal] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const chatIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const apiIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const logsIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const runIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const chatBtnIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const actionIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const expandIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const menuIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const editIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const copyIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const exportIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const deleteIconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const isRunning = card.status === 'running'
  const launchMode = card.template.launchMode || 'chat'
  // 模型自定义 Logo（全局 store 共享，与 Agent Code 模型下拉同一份数据；有 Logo 时替换字母头像）
  const logos = useStore(s => s.modelLogos)
  const setModelLogoEntry = useStore(s => s.setModelLogoEntry)
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
  const POPOVER_W = 380
  const POPOVER_H = 460
  // 按日志按钮的当前位置计算弹窗坐标（优先贴在按钮下方，放不下则翻到上方，并限制在视口内）
  const computePopoverPos = useCallback(() => {
    const el = logsBtnRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    let left = r.left
    if (left + POPOVER_W > window.innerWidth - 8) left = window.innerWidth - 8 - POPOVER_W
    if (left < 8) left = 8
    let top = r.bottom + 6
    if (top + POPOVER_H > window.innerHeight - 8) {
      top = r.top - 6 - POPOVER_H
      if (top < 8) top = 8
    }
    return { top, left }
  }, [])
  function toggleLogs() {
    if (cardLogsExpanded) {
      setCardLogsExpanded(false)
      setPopoverPos(null)
      return
    }
    const pos = computePopoverPos()
    if (!pos) return
    setPopoverPos(pos)
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
    // 弹窗持续锚定在日志按钮旁：每帧重算位置，滚动/缩放/侧边栏收展等任何布局变化都跟随，
    // 仅当按钮完全滚出视口时才收起；位置无变化时不触发重渲染
    let rafId = 0
    const track = () => {
      const el = logsBtnRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
          setCardLogsExpanded(false)
          setPopoverPos(null)
          return
        }
        const pos = computePopoverPos()
        if (pos) {
          setPopoverPos(prev => (prev && prev.top === pos.top && prev.left === pos.left) ? prev : pos)
        }
      }
      rafId = requestAnimationFrame(track)
    }
    rafId = requestAnimationFrame(track)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(rafId)
    }
  }, [cardLogsExpanded, computePopoverPos])
  const [modelExists, setModelExists] = useState(true)
  useEffect(() => {
    if (!card.template.modelPath) { setModelExists(true); return }
    window.api.checkFileExists(card.template.modelPath).then(setModelExists).catch(() => setModelExists(false))
  }, [card.template.modelPath])
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
        setConfirmingDelete(false)
      }
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
    // 引擎类型归一化：'other' 视为 llama.cpp 行为
    const kind = paramSetOf(targetBackend.kind)
    // 参数集：模板里手动选择的优先，未选时按后端类型默认
    const paramSet = paramSetOf(card.template.paramSet ?? targetBackend.kind)
    const args: string[] = []
    const tArgs = card.template.args ?? {}
    // 模型参数：llama.cpp 用 -m，TensorSharp 用 --model（--model 在两个 schema 中都会被跳过，
    // 由这里显式追加）
    // stable-diffusion.cpp 的扩散模型必须用 --diffusion-model 加载（Z-Image 等 GGUF
    // tensor 名不带 model.diffusion_model. 前缀，用 -m 时 sd 识别不了架构）
    if (card.template.modelPath) {
      args.push(paramSet === 'tensorsharp' ? '--model' : paramSet === 'sdcpp' ? '--diffusion-model' : '-m', card.template.modelPath)
    }
    // 参数白名单按卡片自身参数集获取（TensorSharp 与 llama.cpp 的 schema 不同），
    // 不依赖全局 activeBackend 的 schema，否则另一引擎的参数会被静默丢弃
    const cardSchema = (await window.api.getCommands(targetBackend.name, paramSet).catch(() => null)) ?? commandsSchema
    if (cardSchema) {
      for (const cat of cardSchema.categories) {
        for (const cmd of cat.commands) {
          // --port / --listen-port / --model / --diffusion-model / --urls 由应用统一管理，不在高级参数里透传
          if (cmd.arg === '--port' || cmd.arg === '--listen-port' || cmd.arg === '--model' || cmd.arg === '--diffusion-model' || cmd.arg === '--urls') continue
          // 参数集按卡片自身后端加载（TensorSharp / llama.cpp 各自专属文件），无需再按引擎过滤
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true || val === 'true' || val === '1') args.push(cmd.arg) }
            else if (cmd.type === 'select' && cmd.options && !cmd.options.includes(String(val))) continue
            else args.push(cmd.arg, String(val))
          }
        }
      }
    } else {
      const fallbackAllowed = new Set(['--host', '--no-webui', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b', '--flash-attn', '-fa', '--mlock', '--mmap', '--verbose', '--listen-port', '--backend', '--steps', '--cfg-scale', '--diffusion-model'])
      for (const [k, v] of Object.entries(tArgs)) {
        if (!fallbackAllowed.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    // TensorSharp 监听地址官方硬编码为 http://0.0.0.0:5000（无端口参数，已实测 CLI/env 均无效），
    // 启动前检查 5000 端口是否已被其他正在运行的卡片占用（TensorSharp 卡互斥 / llama.cpp 卡端口冲突）
    const port = paramSet === 'tensorsharp' ? 5000 : (card.template.serverPort || 8080)
    if (paramSet === 'tensorsharp') {
      const conflict = useStore.getState().cards.find(c => {
        if (c.template.id === card.template.id || c.status !== 'running') return false
        const b = backends.find(x => x.name === c.template.backendVersion)
        return c.template.paramSet === 'tensorsharp' || b?.kind === 'tensorsharp' || c.template.serverPort === 5000
      })
      if (conflict) {
        notify(`TensorSharp 固定监听 5000 端口，与正在运行的「${conflict.template.name}」冲突`, 'error')
        return
      }
    } else if (card.template.serverPort) {
      // stable-diffusion.cpp 的 sd-server 端口参数是 --listen-port（默认 1234），llama.cpp 系列是 --port
      args.push(paramSet === 'sdcpp' ? '--listen-port' : '--port', String(card.template.serverPort))
    }
    const backendPath = targetBackend.path
    const exe = targetBackend.exe!
    const res = await safeCall(() => window.api.runModel({
      id: card.template.id,
      backendPath,
      exe,
      args,
      openBrowser: false,
      port,
      paramSet,
      kind
    }), '启动模型失败')
    if (res === null) { setCardStatus(card.template.id, 'error'); return }
    if (res.success) {
      clearModelLogs(card.template.id)
      setCardStatus(card.template.id, 'running', res.pid)
      if (launchMode === 'chat' && kind !== 'sdcpp') {
        // TensorSharp 的网页聊天 UI 在 /html（根路径返回 JSON），llama.cpp 在根路径
        const chatUrl = kind === 'tensorsharp' ? `http://127.0.0.1:${port}/html` : `http://127.0.0.1:${port}`
        useStore.getState().setActiveChat(chatUrl, port)
        useStore.getState().setView('llama')
      }
    } else { notify(`运行失败：${res.error}`, 'error'); setCardStatus(card.template.id, 'error') }
  }
  const handleDelete = useCallback(() => {
    if (isRunning) { notify('请先停止模型再删除。', 'error'); return }
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    safeCall(() => window.api.deleteTemplate(card.template.id), '删除模板失败').then((ok) => {
      if (ok === null) return
      removeCard(card.template.id)
    })
  }, [isRunning, confirmingDelete, card.template.id, removeCard])
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
  const cardBackend = backends.find(b => b.name === card.template.backendVersion)
  const effectiveParamSet = paramSetOf(card.template.paramSet ?? cardBackend?.kind)
  const engineLabel = ENGINE_LABELS[effectiveParamSet] ?? ''
  // 专门的 OCR 模型：llama.cpp 引擎且模板名包含 "ocr"（如 Baidu-OCR）→ 卡片主按钮跳转 OCR 界面。
  // 带 --mmproj 的通用视觉对话模型（如 Agents-A1-4B）不算 OCR 模型，保持「原生聊天」。
  const isOcrModel = effectiveParamSet === 'llamacpp' && /ocr/i.test(card.template.name)
  // 已有 Logo 时点击弹出的菜单（更换/移除）：固定定位坐标来自点击处
  const [logoMenu, setLogoMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const logoMenuRef = useRef<HTMLDivElement>(null)
  // 无 Logo → 直接选图；有 Logo → 弹出更换/移除菜单
  const toggleLogoMenu = useCallback((e: React.MouseEvent) => {
    if (!logos[card.template.id]) { void pickModelLogo(); return }
    if (logoMenu?.id === card.template.id) { setLogoMenu(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setLogoMenu({ id: card.template.id, x: rect.right, y: rect.bottom })
  }, [logos, logoMenu])
  // 选图：主进程弹选择框、复制进 logos/ 并更新映射 → 立即刷新图片
  const pickModelLogo = useCallback(async () => {
    const res = await window.api.setModelLogo(card.template.id)
    if (!res.success) {
      if (res.error !== '已取消') notify(`设置 Logo 失败：${res.error}`, 'error')
      return
    }
    const img = await window.api.getModelLogoImage(res.fileName!)
    setModelLogoEntry(card.template.id, img.success && img.dataUrl ? img.dataUrl : null)
    setLogoMenu(null)
  }, [card.template.id, setModelLogoEntry])
  // 移除：删文件 + 清映射记录 + 还原字母头像
  const removeCardLogo = useCallback(async () => {
    const res = await window.api.removeModelLogo(card.template.id)
    if (!res.success) { notify(`移除 Logo 失败：${res.error}`, 'error'); return }
    setModelLogoEntry(card.template.id, null)
    setLogoMenu(null)
  }, [card.template.id, setModelLogoEntry])
  // Logo 菜单外部点击收起
  useEffect(() => {
    if (!logoMenu) return
    const handler = (e: MouseEvent) => {
      if (logoMenuRef.current && !logoMenuRef.current.contains(e.target as Node)) setLogoMenu(null)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [logoMenu])
  return (
    <div className={`model-card ${isRunning ? 'running' : ''}`} style={style}>
      <div className="card-header">
        <div
          className={`card-icon${isRunning ? ' running' : ''}`}
          style={logos[card.template.id] ? undefined : { background: avatar.bg, color: avatar.fg }}
          title={logos[card.template.id] ? '模型 Logo（点击更换/移除）' : '设置模型 Logo'}
          onClick={e => { e.stopPropagation(); toggleLogoMenu(e) }}
        >
          {logos[card.template.id]
            ? <img src={logos[card.template.id]!} alt={card.template.name} className="card-icon-img" />
            : <span className="card-icon-letter">{avatar.letter}</span>}
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
          <button className="btn btn-ghost btn-icon" aria-label="更多操作" onClick={() => setShowMenu(p => !p)} onMouseEnter={() => menuIconRef.current?.startAnimation()} onMouseLeave={() => menuIconRef.current?.stopAnimation()}>
            <EllipsisVerticalIcon ref={menuIconRef} size={16} className="nav-animate-icon" />
          </button>
          {showMenu && (
            <div className="dropdown-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 500 }}>
              <button className="dropdown-item" onClick={handleEdit} onMouseEnter={() => editIconRef.current?.startAnimation()} onMouseLeave={() => editIconRef.current?.stopAnimation()}><SettingsIcon ref={editIconRef} size={14} className="nav-animate-icon" /> 编辑模板</button>
              <button className="dropdown-item" onClick={handleDuplicate} onMouseEnter={() => copyIconRef.current?.startAnimation()} onMouseLeave={() => copyIconRef.current?.stopAnimation()}><CopyIcon ref={copyIconRef} size={14} className="nav-animate-icon" /> 复制</button>
              <button className="dropdown-item" onClick={handleExport} onMouseEnter={() => exportIconRef.current?.startAnimation()} onMouseLeave={() => exportIconRef.current?.stopAnimation()}><DownloadIcon ref={exportIconRef} size={14} className="nav-animate-icon" /> 导出</button>
              <div className="dropdown-divider" />
              <button
                className={`dropdown-item danger ${confirmingDelete ? 'confirming' : ''}`}
                onClick={handleDelete}
                onMouseEnter={() => deleteIconRef.current?.startAnimation()}
                onMouseLeave={() => deleteIconRef.current?.stopAnimation()}
              >
                <TrashIcon ref={deleteIconRef} size={14} className="nav-animate-icon" />
                {confirmingDelete ? '确认删除？' : '删除'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="card-meta">
        {engineLabel && (
          <span className="card-tag card-tag--engine">
            <span className="card-tag-inner">{engineLabel}</span>
          </span>
        )}
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
          onMouseEnter={() => chatIconRef.current?.startAnimation()}
          onMouseLeave={() => chatIconRef.current?.stopAnimation()}
        >
          <GlobeIcon ref={chatIconRef} size={12} className="nav-animate-icon" /> 聊天界面
        </button>
        <button
          className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`}
          onClick={() => setLaunchMode('api')}
          disabled={isRunning}
          onMouseEnter={() => apiIconRef.current?.startAnimation()}
          onMouseLeave={() => apiIconRef.current?.stopAnimation()}
        >
          <ServerIcon ref={apiIconRef} size={12} className="nav-animate-icon" /> 仅 API
        </button>
        {(isRunning || card.status === 'error') && logs && logs.length > 0 && (
          <button
            ref={logsBtnRef}
            className={`launch-mode-btn logs-toggle-btn ${cardLogsExpanded ? 'active' : ''}`}
            onClick={toggleLogs}
            onMouseEnter={() => logsIconRef.current?.startAnimation()}
            onMouseLeave={() => logsIconRef.current?.stopAnimation()}
          >
            <TerminalIcon ref={logsIconRef} size={12} className="nav-animate-icon" /> 日志
          </button>
        )}
      </div>
      <div className="card-actions">
        <button
          className={`btn card-run-btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleRunToggle}
          disabled={!isRunning && !modelExists}
          onMouseEnter={() => runIconRef.current?.startAnimation()}
          onMouseLeave={() => runIconRef.current?.stopAnimation()}
        >
          {isRunning ? <><CircleStopIcon ref={runIconRef} size={14} className="nav-animate-icon" /> <span className="btn-label">停止</span></> : <><PlayIcon ref={runIconRef} size={14} className="nav-animate-icon" /> <span className="btn-label">启动</span></>}
        </button>
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ background: '#c1c1c1', color: '#1e0303' }}
            onClick={() => {
              const port = card.template.serverPort || 8080
              const chatUrl = effectiveParamSet === 'tensorsharp' ? `http://127.0.0.1:${port}/html` : `http://127.0.0.1:${port}`
              useStore.getState().setActiveChat(chatUrl, port)
              useStore.getState().setView('llama')
            }}
            onMouseEnter={() => chatBtnIconRef.current?.startAnimation()}
            onMouseLeave={() => chatBtnIconRef.current?.stopAnimation()}
          >
            <GlobeIcon ref={chatBtnIconRef} size={14} className="nav-animate-icon" /> <span className="btn-label">打开聊天</span>
          </button>
        )}
        {isRunning && (
          <button
            className="btn card-run-btn"
            style={{ background: 'rgb(98 157 69)', color: 'rgb(37 8 8)' }}
            onClick={() => {
              if (effectiveParamSet === 'sdcpp') {
                useStore.getState().setView('imagegen')
                return
              }
              if (isOcrModel) {
                useStore.getState().setView('ocr')
                return
              }
              const id = card.template.id
              const port = card.template.serverPort || 8080
              const name = card.template.name
              const st = useChatStore.getState()
              let session = st.sessions.find(s => s.templateId === id)
              if (!session) {
                const newId = st.createSession(id, port, name)
                session = st.sessions.find(s => s.id === newId)!
              } else {
                st.selectSession(session.id)
              }
              useStore.getState().setView('chat')
            }}
            onMouseEnter={() => actionIconRef.current?.startAnimation()}
            onMouseLeave={() => actionIconRef.current?.stopAnimation()}
          >
            {effectiveParamSet === 'sdcpp' ? <ImageIcon ref={actionIconRef} size={14} className="nav-animate-icon" /> : isOcrModel ? <ScanIcon ref={actionIconRef} size={14} className="nav-animate-icon" /> : <MessageSquareIcon ref={actionIconRef} size={14} className="nav-animate-icon" />}
            <span className="btn-label">{effectiveParamSet === 'sdcpp' ? '图像生成' : isOcrModel ? 'OCR 识别' : '原生聊天'}</span>
          </button>
        )}
        {!isRunning && (
          <button
            className="card-expand-btn"
            onClick={() => setShowParamsModal(true)}
            onMouseEnter={() => expandIconRef.current?.startAnimation()}
            onMouseLeave={() => expandIconRef.current?.stopAnimation()}
          >
            <SettingsIcon ref={expandIconRef} size={16} className="nav-animate-icon" />
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
              <TerminalIcon size={13} className="nav-animate-icon" />
              {logs?.length || 0} 行
            </span>
            <div className="card-logs-header-actions">
              <button className="card-logs-header-btn" onClick={handleCopyLogs}>
                {logCopied ? <CheckIcon size={12} className="nav-animate-icon" /> : <CopyIcon size={12} className="nav-animate-icon" />}
              </button>
              <button className="card-logs-header-btn" onClick={handleClearLogs}>
                <TrashIcon size={12} className="nav-animate-icon" />
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
      {showParamsModal && createPortal(
        <ParamsModal
          templateId={card.template.id}
          args={card.template.args}
          onClose={() => setShowParamsModal(false)}
          cardName={card.template.name}
        />,
        document.body
      )}
      {logoMenu && logoMenu.id === card.template.id && createPortal(
        <div ref={logoMenuRef} className="chat-model-logo-menu" style={{ left: logoMenu.x, top: logoMenu.y }} onClick={e => e.stopPropagation()}>
          <div className="chat-model-logo-menu-item" onClick={() => void pickModelLogo()}><RefreshCwIcon size={12} />更换图片</div>
          <div className="chat-model-logo-menu-item danger" onClick={() => void removeCardLogo()}><TrashIcon size={12} />移除 Logo</div>
        </div>,
        document.body
      )}
    </div>
  )
}
