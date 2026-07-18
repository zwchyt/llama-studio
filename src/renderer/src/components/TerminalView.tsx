import React, { useRef, useEffect, useState } from 'react'
import { createTerminal, attach, fitTerminal, disposeTerminal } from '../utils/terminalRegistry'
import { useTerminalStore } from '../store/terminalStore'
import { Terminal, FolderOpen, Plus } from 'lucide-react'
import { safeCall } from '../utils/safeCall'
import '../styles/terminal.css'

const CWD_KEY = 'terminal-last-cwd'

/** 自适应宽度输入框：用隐藏镜像测量文本像素宽度 */
function AutoInput({
  value,
  placeholder,
  onKeyDown,
  onChange,
}: {
  value: string
  placeholder?: string
  onKeyDown?: (e: React.KeyboardEvent) => void
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const mirror = mirrorRef.current
    const input = inputRef.current
    if (!mirror || !input) return
    const text = value || placeholder || ''
    mirror.textContent = text || '\u2003' // em-space 保证至少有宽度
    input.style.width = `${mirror.offsetWidth + 20}px`
  }, [value, placeholder])

  return (
    <span className="terminal-auto-input">
      <span ref={mirrorRef} className="terminal-auto-input-mirror" aria-hidden>{value}</span>
      <input
        ref={inputRef}
        className="terminal-cwd-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </span>
  )
}

/** 统一标签栏：标签 + 目录输入 + 新建按钮 */
function TerminalTabBar(): React.JSX.Element {
  const { sessions, activeId, setActive, close, open } = useTerminalStore()
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) || '')

  async function handleBrowse(): Promise<void> {
    const result = await safeCall(() => window.api.selectDirectory(), '选择目录失败')
    if (result?.path) {
      setCwd(result.path)
      try { localStorage.setItem(CWD_KEY, result.path) } catch { /* quota exceeded */ }
    }
  }

  function handleNew(): void {
    try { localStorage.setItem(CWD_KEY, cwd) } catch { /* quota exceeded */ }
    open(cwd || undefined)
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleNew()
    }
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
      <div className="terminal-cwd-bar">
        <AutoInput
          value={cwd}
          placeholder="工作目录（留空使用默认目录）"
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="terminal-tabbar-btn" onClick={handleBrowse} title="选择目录">
          <FolderOpen size={13} />
        </button>
        <button className="terminal-tabbar-btn primary" onClick={handleNew} title="新建终端">
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}

function TermScreen({ id, visible }: { id: string; visible: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = createTerminal(id)
    // 先注册 onResize，再 attach（attach 内部会 fit 触发 onResize），避免首帧 resize 丢失
    const onResize = term.onResize(({ cols, rows }) => { window.api.terminalResize(id, cols, rows).catch(() => {}) })
    attach(id, el)
    const onData = term.onData((d) => { window.api.terminalInput(id, d).catch(() => {}) })
    const ro = new ResizeObserver(() => fitTerminal(id))
    ro.observe(el)
    return () => {
      onData.dispose()
      onResize.dispose()
      ro.disconnect()
      // 切换走终端视图 / 会话关闭时销毁实例，避免对已 open 的实例重复调用 term.open（重挂载会传入新容器）
      disposeTerminal(id)
    }
  }, [id])

  return <div ref={ref} className="terminal-screen" style={{ display: visible ? '' : 'none' }} />
}

export default function TerminalView(): React.JSX.Element {
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
          {/* 所有未退出的终端保持挂载，仅通过 display 切换可见性，
            以保留各自的滚动历史与活动 PTY（参考 local-studio 的 PersistentTerminals）。
            TermScreen 仅在会话被关闭/退出（从列表移除）时才卸载并释放实例。 */}
          {sessions.filter((s) => !s.exited).map((s) => (
            <TermScreen key={s.id} id={s.id} visible={s.id === activeId} />
          ))}
          {active && active.exited && (
            <div className="terminal-exited-overlay">
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
