import React, { useRef, useEffect, useState, useCallback } from 'react'
import { createTerminal, attach, fitTerminal } from '../utils/terminalRegistry'
import { useTerminalStore } from '../store/terminalStore'
import { Terminal, FolderOpen, Plus, ChevronDown, X } from 'lucide-react'
import { safeCall } from '../utils/safeCall'

const CWD_KEY = 'terminal-last-cwd'

/** 新建终端弹出层：cwd 输入 + 浏览 + 打开 */
function NewTerminalPopover({
  anchorRef,
  onOpen,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onOpen: (cwd?: string) => void
  onClose: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}): JSX.Element {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 弹出后自动聚焦输入框
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    // 点击外部关闭
    function handleClickOutside(e: MouseEvent): void {
      const target = e.target as Node
      if (anchorRef.current?.contains(target)) return
      const popEl = document.querySelector('.terminal-new-popover')
      if (popEl && !popEl.contains(target)) onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [anchorRef, onClose])

  async function handleBrowse(): Promise<void> {
    const result = await safeCall(() => window.api.selectDirectory(), '选择目录失败')
    if (result?.path) {
      setCwd(result.path)
      inputRef.current?.focus()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      try { localStorage.setItem(CWD_KEY, cwd) } catch { /* quota exceeded */ }
      onOpen(cwd || undefined)
      onClose()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  function handleOpen(): void {
    try { localStorage.setItem(CWD_KEY, cwd) } catch { /* quota exceeded */ }
    onOpen(cwd || undefined)
    onClose()
  }

  return (
    <div className="terminal-new-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="terminal-popover-header">
        <span>新建终端</span>
        <button className="terminal-popover-close" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="terminal-popover-body">
        <input
          ref={inputRef}
          className="terminal-cwd-input"
          type="text"
          placeholder="工作目录路径（留空使用默认目录）"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="terminal-popover-actions">
          <button className="terminal-popover-btn" onClick={handleBrowse} title="选择目录">
            <FolderOpen size={13} />
            <span>浏览</span>
          </button>
          <button className="terminal-popover-btn terminal-popover-btn-primary" onClick={handleOpen}>
            <Plus size={13} />
            <span>打开</span>
          </button>
        </div>
      </div>
    </div>
  )
}

/** 统一标签栏：标签 + 新建按钮（含弹出层） */
function TerminalTabBar(): JSX.Element {
  const { sessions, activeId, setActive, close, open } = useTerminalStore()
  const [showPopover, setShowPopover] = useState(false)
  const dropdownRef = useRef<HTMLButtonElement>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

  function handleQuickNew(e: React.MouseEvent): void {
    if (e.shiftKey) {
      setShowPopover(v => !v)
      return
    }
    open()
  }

  const handleClosePopover = useCallback(() => setShowPopover(false), [])

  function handleDropdownEnter(): void {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    setShowPopover(true)
  }

  function handleDropdownLeave(): void {
    hoverTimeoutRef.current = setTimeout(() => {
      setShowPopover(false)
    }, 300)
  }

  function handlePopoverEnter(): void {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
  }

  function handlePopoverLeave(): void {
    hoverTimeoutRef.current = setTimeout(() => {
      setShowPopover(false)
    }, 300)
  }

  return (
    <div className="terminal-tabbar">
      <div className="terminal-tabs-scroll">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`terminal-tab ${s.id === activeId ? 'active' : ''} ${s.exited ? 'exited' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="terminal-tab-title">{s.title}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); close(s.id) }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="terminal-tabbar-actions">
        <button
          className={`terminal-tab-add ${showPopover ? 'active' : ''}`}
          onClick={handleQuickNew}
          title="新建终端（Shift+点击指定目录）"
        >
          <Plus size={15} strokeWidth={2} />
        </button>
        <button
          ref={dropdownRef}
          className={`terminal-tab-dropdown-toggle ${showPopover ? 'active' : ''}`}
          onClick={() => setShowPopover(v => !v)}
          onMouseEnter={handleDropdownEnter}
          onMouseLeave={handleDropdownLeave}
          title="指定工作目录新建终端"
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
        {showPopover && (
          <NewTerminalPopover
            anchorRef={dropdownRef}
            onOpen={open}
            onClose={handleClosePopover}
            onMouseEnter={handlePopoverEnter}
            onMouseLeave={handlePopoverLeave}
          />
        )}
      </div>
    </div>
  )
}

function TermScreen({ id, visible }: { id: string; visible: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = createTerminal(id)
    attach(id, el)
    const onData = term.onData((d) => { window.api.terminalInput(id, d).catch(() => {}) })
    const onResize = term.onResize(({ cols, rows }) => { window.api.terminalResize(id, cols, rows).catch(() => {}) })
    const ro = new ResizeObserver(() => fitTerminal(id))
    ro.observe(el)
    return () => {
      onData.dispose()
      onResize.dispose()
      ro.disconnect()
    }
  }, [id])

  return <div ref={ref} className="terminal-screen" style={{ display: visible ? '' : 'none' }} />
}

export default function TerminalView(): JSX.Element {
  const { sessions, activeId, open } = useTerminalStore()
  const active = sessions.find((s) => s.id === activeId)

  return (
    <div className="terminal-view">
      <TerminalTabBar />
      {sessions.length === 0 ? (
        <div className="terminal-empty">
          <Terminal size={48} strokeWidth={1.5} />
          <p>没有打开的终端</p>
          <p style={{ fontSize: 12 }}>点击右上角 + 新建终端</p>
        </div>
      ) : (
        <div className="terminal-screens">
          {sessions.map((s) =>
            s.exited ? null : <TermScreen key={s.id} id={s.id} visible={s.id === activeId} />
          )}
          {(!active || active.exited) && (
            <div className="terminal-empty">
              <p>终端已退出</p>
              <button className="terminal-new-btn" onClick={() => open()}>
                新建终端
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
