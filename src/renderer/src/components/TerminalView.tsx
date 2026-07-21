import React, { useRef, useEffect, useState } from 'react'
import { createTerminal, attach, fitTerminal, disposeTerminal, updateTerminalTheme, getTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_SIZE_DEFAULT, detachTerminal, isTerminalReady, writeDirectToTerminal } from '../utils/terminalRegistry'
import { useTerminalStore } from '../store/terminalStore'
import { Terminal, FolderOpen, Plus, Minus, RotateCcw } from 'lucide-react'
import { safeCall } from '../utils/safeCall'
import { matchTerminalAction, getTerminalKeybinds, subscribeTerminalStore } from '../utils/terminal-keybinds'
import '@xterm/xterm/css/xterm.css'
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

/** 统一标签栏：标签 + 目录输入 + 新建按钮 + 字号控制 */
function TerminalTabBar(): React.JSX.Element {
  const { sessions, activeId, setActive, close, open } = useTerminalStore()
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) || '')
  const [fontSize, setFontSize] = useState(getTerminalFontSize())

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
        <button className="terminal-tabbar-btn" onClick={handleBrowse}>
          <FolderOpen size={13} />
        </button>
        <button className="terminal-tabbar-btn primary" onClick={handleNew}>
          <Plus size={13} />
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
        <button className="terminal-tabbar-btn" onClick={() => { setTerminalFontSize(fontSize - 1); setFontSize(getTerminalFontSize()) }} title="缩小字号 (Ctrl+-)">
          <Minus size={13} />
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 22, textAlign: 'center', userSelect: 'none' }}>{fontSize}</span>
        <button className="terminal-tabbar-btn" onClick={() => { setTerminalFontSize(fontSize + 1); setFontSize(getTerminalFontSize()) }} title="放大字号 (Ctrl+=)">
          <Plus size={13} />
        </button>
        <button className="terminal-tabbar-btn" onClick={() => { setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT); setFontSize(getTerminalFontSize()) }} title="重置字号">
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  )
}

function TermScreen({ id, visible }: { id: string; visible: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const session = useTerminalStore(s => s.sessions.find(ss => ss.id === id))
  const setPtyReady = useTerminalStore(s => s.setPtyReady)
  const setFallback = useTerminalStore(s => s.setFallback)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let ptyReady = false

    const term = createTerminal(id, el)
    const onResize = term.onResize(({ cols, rows }) => {
      if (!ptyReady) return
      window.api.terminalResize(id, cols, rows).catch(() => {})
    })
    attach(id, el)

    // 创建 PTY（传入 fit 后的正确尺寸，避免 80×24 再 resize 导致闪烁）
    if (!session?.fallback) {
      window.api.terminalCreate({ id, cwd: session?.cwd, ownerKey: session?.ownerKey, cols: term.cols, rows: term.rows })
        .then((result) => {
          ptyReady = true
          if (result.success) {
            if (result.reused && result.replay) writeDirectToTerminal(id, result.replay)
            setPtyReady(id)
          } else {
            setFallback(id)
          }
        })
        .catch(() => {
          ptyReady = true
          setFallback(id)
        })
    } else {
      ptyReady = true
    }

    const onData = term.onData((d) => { window.api.terminalInput(id, d).catch(() => {}) })

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const action = matchTerminalAction(event, getTerminalKeybinds())
      if (!action) return true
      event.preventDefault()
      event.stopPropagation()
      if (action === 'clearTerminal') term.clear()
      return false
    })

    const ro = new ResizeObserver(() => {
      if (ptyReady) fitTerminal(id)
    })
    ro.observe(el)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onThemeChange = () => updateTerminalTheme(id)
    mq.addEventListener('change', onThemeChange)
    const unsubKeybinds = subscribeTerminalStore(() => {})
    return () => {
      unsubKeybinds()
      mq.removeEventListener('change', onThemeChange)
      onData.dispose()
      onResize.dispose()
      ro.disconnect()
      disposeTerminal(id)
    }
  }, [id, session?.fallback, session?.cwd, session?.ownerKey])

  return <div ref={ref} className="terminal-screen" style={{ display: visible ? '' : 'none' }} />
}

/** 无 PTY 时的回退终端：逐行执行命令 */
function FallbackTermScreen({ id: _id, cwd, visible }: { id: string; cwd: string; visible: boolean }): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [running, setRunning] = useState(false)
  const [currentCwd, setCurrentCwd] = useState(cwd || '')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!visible) return
    inputRef.current?.focus()
  }, [visible])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  useEffect(() => {
    if (lines.length === 0 && currentCwd) {
      setLines([`\x1b[90m回退模式 — 无 PTY 桥接，逐行执行命令\x1b[0m`, ''])
    }
  }, [currentCwd])

  async function handleCommand(): Promise<void> {
    const cmd = input.trim()
    if (!cmd) return
    setInput('')
    setHistory((h) => [...h, cmd])
    setHistIdx(-1)
    setLines((l) => [...l, `\x1b[32m$\x1b[0m ${cmd}`])

    // 处理 cd
    if (/^cd(\s|$)/.test(cmd)) {
      const target = cmd.slice(2).trim() || '~'
      // cd 由前端模拟（更新 cwd 状态）
      setCurrentCwd((prev) => `${prev}/${target}`.replace(/\/+/g, '/'))
      setLines((l) => [...l, ''])
      return
    }

    setRunning(true)
    try {
      const result = await window.api.terminalExec({ command: cmd, cwd: currentCwd || undefined })
      if (result.stdout) setLines((l) => [...l, ...result.stdout!.split('\n').filter(Boolean)])
      if (result.stderr) setLines((l) => [...l, ...result.stderr!.split('\n').filter(Boolean)])
      if (result.exitCode !== 0 && result.exitCode !== null) {
        setLines((l) => [...l, `\x1b[31mexit ${result.exitCode}\x1b[0m`])
      }
    } catch (err) {
      setLines((l) => [...l, `\x1b[31m${String(err)}\x1b[0m`])
    } finally {
      setRunning(false)
      setLines((l) => [...l, ''])
    }
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!running) void handleCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(idx)
      setInput(history[idx]!)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx < 0) return
      if (histIdx === history.length - 1) {
        setHistIdx(-1)
        setInput('')
      } else {
        const idx = histIdx + 1
        setHistIdx(idx)
        setInput(history[idx]!)
      }
    }
  }

  const display = (
    <div className="terminal-screen" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', background: 'var(--color-terminal-bg, #1e1e1e)' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', fontFamily: 'Consolas, monospace', fontSize: 13, color: 'var(--color-terminal-fg, #d4d4d4)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {lines.map((line, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', borderTop: '1px solid var(--border, #333)', gap: 4 }}>
        <span style={{ color: 'var(--color-terminal-green, #85df7b)', fontFamily: 'Consolas, monospace', fontSize: 13, flexShrink: 0 }}>$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--color-terminal-fg, #d4d4d4)', fontFamily: 'Consolas, monospace', fontSize: 13 }}
        />
      </div>
    </div>
  )

  return display
}

/** 简易 ANSI 转 HTML（仅支持颜色/加粗/重置） */
function ansiToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const ansiMap: Record<string, string> = {
    '0': '',
    '1': 'font-weight:bold',
    '30': 'color:#363636', '31': 'color:#f67576', '32': 'color:#85df7b',
    '33': 'color:#fa994c', '34': 'color:#3d8dff', '35': 'color:#b06dff',
    '36': 'color:#6dcbf4', '37': 'color:#d4d4d4',
    '90': 'color:#747474', '91': 'color:#f99', '92': 'color:#87d9a4',
    '93': 'color:#ffb26b', '94': 'color:#55a2ff', '95': 'color:#a888f2',
    '96': 'color:#8ee5e5', '97': 'color:#f8f8f8',
  }
  return escaped.replace(/\x1b\[([\d;]+)m/g, (_, codes) => {
    const styles = (codes as string).split(';').map((c) => ansiMap[c] || '').filter(Boolean)
    return styles.length ? `<span style="${styles.join(';')}">` : '</span>'
  })
}

const MAX_MOUNTED_TERMINALS = 6

export default function TerminalView(): React.JSX.Element {
  const { sessions, activeId, open } = useTerminalStore()
  const active = sessions.find((s) => s.id === activeId)

  // MRU 顺序：仅保持最近 N 个 xterm 实例在 DOM 中，其余通过 detachTerminal 释放 xterm 内存
  // PTY 进程通过 ownerKey 保留在 main 进程，切回时自动重连 + replay
  const [mountedKeys, setMountedKeys] = useState<string[]>([])

  useEffect(() => {
    const alive = sessions.filter((s) => !s.exited).map((s) => s.id)
    if (alive.length === 0) { setMountedKeys([]); return }

    // 维护 MRU 列表：保留 alive 中的 key，将 activeId 移至末尾
    let next = mountedKeys.filter((k) => alive.includes(k))
    for (const id of alive) {
      if (!next.includes(id)) next.push(id)
    }
    if (activeId && next[next.length - 1] !== activeId) {
      const idx = next.indexOf(activeId)
      if (idx >= 0) { next.splice(idx, 1); next.push(activeId) }
    }
    const keep = next.slice(-MAX_MOUNTED_TERMINALS)
    // 释放被移出 MRU 的 xterm 实例（PTY 仍存活）
    for (const key of next.slice(0, -MAX_MOUNTED_TERMINALS)) {
      if (isTerminalReady(key)) detachTerminal(key)
    }
    if (mountedKeys.length !== keep.length || !mountedKeys.every((k, i) => k === keep[i])) {
      setMountedKeys(keep)
    }
  }, [sessions, activeId])

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
          {sessions.filter((s) => !s.exited && mountedKeys.includes(s.id)).map((s) => (
            s.fallback
              ? <FallbackTermScreen key={s.id} id={s.id} cwd={s.cwd} visible={s.id === activeId} />
              : <TermScreen key={s.id} id={s.id} visible={s.id === activeId} />
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
