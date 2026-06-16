import React, { useRef, useEffect } from 'react'
import { createTerminal, attach, detach, fitTerminal } from '../utils/terminalRegistry'
import { useTerminalStore } from '../store/terminalStore'
import { Terminal } from 'lucide-react'

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

  if (sessions.length === 0) {
    return (
      <div className="terminal-view">
        <TerminalTabBar />
        <div className="terminal-empty">
          <Terminal size={48} strokeWidth={1.5} />
          <p>没有打开的终端</p>
          <button className="terminal-new-btn" onClick={() => open()}>
            新建终端
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-view">
      <TerminalTabBar />
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
    </div>
  )
}
