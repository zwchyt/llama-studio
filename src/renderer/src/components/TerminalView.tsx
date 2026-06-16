import React, { useRef, useEffect, useState } from 'react'
import { createTerminal, attach, fitTerminal } from '../utils/terminalRegistry'
import { useTerminalStore } from '../store/terminalStore'
import { Terminal, FolderOpen, Plus } from 'lucide-react'

const CWD_KEY = 'terminal-last-cwd'

function TerminalToolbar({ onOpen }: { onOpen: (cwd?: string) => void }): JSX.Element {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) || '')

  async function handleBrowse() {
    const result = await window.api.selectDirectory()
    if (result.path) {
      setCwd(result.path)
      localStorage.setItem(CWD_KEY, result.path)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      localStorage.setItem(CWD_KEY, cwd)
      onOpen(cwd || undefined)
    }
  }

  function handleOpen() {
    localStorage.setItem(CWD_KEY, cwd)
    onOpen(cwd || undefined)
  }

  return (
    <div className="terminal-toolbar">
      <input
        className="terminal-cwd-input"
        type="text"
        placeholder="工作目录路径（留空使用默认目录）"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="terminal-toolbar-btn" onClick={handleBrowse} title="选择目录">
        <FolderOpen size={14} />
      </button>
      <button className="terminal-toolbar-btn terminal-toolbar-open" onClick={handleOpen} title="在此目录打开新终端">
        <Plus size={14} />
        打开
      </button>
    </div>
  )
}

function TerminalTabBar(): JSX.Element {
  const { sessions, activeId, setActive, close, open } = useTerminalStore()
  return (
    <div className="terminal-tabbar">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`terminal-tab ${s.id === activeId ? 'active' : ''} ${s.exited ? 'exited' : ''}`}
          onClick={() => setActive(s.id)}
        >
          <span>{s.title}</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => { e.stopPropagation(); close(s.id) }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="terminal-tab-add" onClick={() => open()} title="新建终端">
        +
      </button>
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
    const onData = term.onData((d) => window.api.terminalInput(id, d))
    const onResize = term.onResize(({ cols, rows }) => window.api.terminalResize(id, cols, rows))
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
      <TerminalToolbar onOpen={open} />
      <TerminalTabBar />
      {sessions.length === 0 ? (
        <div className="terminal-empty">
          <Terminal size={48} strokeWidth={1.5} />
          <p>没有打开的终端</p>
          <p style={{ fontSize: 12 }}>在上方输入目录路径并点击“打开”</p>
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
