import React, { useRef, useEffect, useState } from 'react'
import { createTerminal, attach, fitTerminal, disposeTerminal, updateTerminalTheme, getTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_SIZE_DEFAULT, detachTerminal, isTerminalReady, beginReplayGate, applyReplayAndFlush, endReplayGate } from '../utils/terminalRegistry'
import { useAgentTerminalStore, type TerminalStoreHook } from '../store/terminalStore'
import { Terminal } from 'lucide-react'
import { FolderOpenIcon, PlusIcon, MinusIcon, RefreshCwIcon } from '@animateicons/react/lucide'
import { safeCall } from '../utils/safeCall'
import { ansiToHtml } from '../utils/ansiToHtml'
import { matchTerminalAction, getTerminalKeybinds, subscribeTerminalStore } from '../utils/terminal-keybinds'
import '@xterm/xterm/css/xterm.css'
import '../styles/agent-terminal.css'

const CWD_KEY = 'terminal-last-cwd'

/** 内容定基 + 弹性伸缩的输入框：隐藏镜像量出文本像素宽，写到 wrapper 的
    flex-basis 作为「首选宽度」（内容多长就多宽）；最终宽度由父级 flex 按可用
    空间放大/收缩（CSS min-width 兜底）——右侧面板手柄拖动时跟随伸缩。
    （旧实现把像素宽度写死到 input.style.width 内联样式，宽度与面板完全无关。） */
function AutoInput({
  value,
  placeholder,
  title,
  onKeyDown,
  onChange,
}: {
  value: string
  placeholder?: string
  title?: string
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
    // 写到 wrapper 的 flex-basis（内容定基），不写死 input 宽度——
    // input 在 wrapper 内 width:100%，wrapper 在工具栏里随 flex 伸缩
    input.parentElement?.style.setProperty('flex-basis', `${mirror.offsetWidth + 20}px`)
  }, [value, placeholder])

  return (
    <span className="agent-terminal-auto-input">
      <span ref={mirrorRef} className="agent-terminal-auto-input-mirror" aria-hidden>{value}</span>
      <input
        ref={inputRef}
        className="agent-terminal-cwd-input"
        type="text"
        title={title}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </span>
  )
}

/** 统一标签栏：标签 + 目录输入 + 新建按钮 + 字号控制。
    workspaceDir：当前编码工作区目录（通用模式传空），用于解析 cwd 输入框的默认值。 */
function TerminalTabBar({ store, workspaceDir = '' }: { store: TerminalStoreHook; workspaceDir?: string }): React.JSX.Element {
  const { sessions, activeId, setActive, close, open } = store()
  // 手动值：用户显式输入/浏览选择过的「下次新建终端」目录；null = 未手动指定 → 走下方自动链
  const [manualCwd, setManualCwd] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(getTerminalFontSize())
  const activeSession = sessions.find(s => s.id === activeId) ?? null

  // 每工作区一份记忆：旧实现用全局 key（terminal-last-cwd），在 A 项目填过的路径会泄漏到
  // B 项目，一键新建终端就落错目录。通用模式没有工作区，退回全局 key。
  const memKey = workspaceDir ? `${CWD_KEY}:${workspaceDir}` : CWD_KEY
  const readMem = (k: string): string => { try { return localStorage.getItem(k) || '' } catch { return '' } }
  const [memCwd, setMemCwd] = useState(() => readMem(memKey))

  // 切换工作区：清掉手动值（上一个项目里填的路径不能带过来），并重读本工作区的记忆
  useEffect(() => {
    setManualCwd(null)
    setMemCwd(readMem(memKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memKey])

  // ── 默认值优先级链 ──
  // 活动终端标签的 cwd（仅当该标签就开在当前工作区里）→ 当前工作区目录 → 本工作区记忆
  // → 空（留空＝系统默认目录）。终端会话跨工作区共享（单 store），切工作区后旧标签仍在，
  // 用 meta.ws（创建时所属工作区）判定作用域，避免旧标签把新工作区的默认值带偏；
  // 旧数据无 ws → 只在通用模式（workspaceDir 为空）下视为同域。
  const tabCwd = activeSession?.cwd || ''
  const tabCwdInScope = !!tabCwd && (activeSession?.ws ?? '') === workspaceDir
  const autoCwd = (tabCwdInScope ? tabCwd : '') || workspaceDir || memCwd
  const cwd = manualCwd ?? autoCwd

  async function handleBrowse(): Promise<void> {
    const result = await safeCall(() => window.api.selectDirectory(), '选择目录失败')
    if (result?.path) {
      setManualCwd(result.path)
      try { localStorage.setItem(memKey, result.path) } catch { /* quota exceeded */ }
    }
  }

  function handleNew(): void {
    try { localStorage.setItem(memKey, cwd) } catch { /* quota exceeded */ }
    // 一并把「所属工作区」记进终端 meta：cwd 输入框默认值靠它判定作用域
    open(cwd.trim() || undefined, workspaceDir)
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleNew()
    }
  }

  return (
    <div className="agent-terminal-tabbar">
      <div className="agent-terminal-tabs-scroll">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`agent-terminal-tab ${s.id === activeId ? 'active' : ''} ${s.exited ? 'exited' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="agent-terminal-tab-title">{s.title}</span>
            <button
              className="agent-terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); close(s.id) }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {/* cwd 输入框是独立 flex 子项：随手柄拖动伸缩（标签区可缩可滚、按钮组固定钉右）。
          值 = 下一次「+」新建终端的工作目录；默认按优先级链解析（见 TerminalTabBar）。 */}
      <AutoInput
        value={cwd}
        placeholder="工作目录（留空使用默认目录）"
        title={
          activeSession
            ? `新建终端的工作目录（当前终端：${activeSession.cwd || '默认目录'}）`
            : '新建终端的工作目录（默认取当前工作区目录）'
        }
        onChange={(e) => setManualCwd(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="agent-terminal-cwd-bar">
        <button className="agent-terminal-tabbar-btn" onClick={handleBrowse}>
          <FolderOpenIcon size={13} />
        </button>
        <button className="agent-terminal-tabbar-btn primary" onClick={handleNew}>
          <PlusIcon size={13} />
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
        <button className="agent-terminal-tabbar-btn" onClick={() => { setTerminalFontSize(fontSize - 1); setFontSize(getTerminalFontSize()) }}>
          <MinusIcon size={13} />
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 22, textAlign: 'center', userSelect: 'none' }}>{fontSize}</span>
        <button className="agent-terminal-tabbar-btn" onClick={() => { setTerminalFontSize(fontSize + 1); setFontSize(getTerminalFontSize()) }}>
          <PlusIcon size={13} />
        </button>
        <button className="agent-terminal-tabbar-btn" onClick={() => { setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT); setFontSize(getTerminalFontSize()) }}>
          <RefreshCwIcon size={12} />
        </button>
      </div>
    </div>
  )
}

function TermScreen({ id, visible, store }: { id: string; visible: boolean; store: TerminalStoreHook }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const session = store(s => s.sessions.find(ss => ss.id === id))
  const setPtyReady = store(s => s.setPtyReady)
  const setFallback = store(s => s.setFallback)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let ptyReady = false

    // 进入 (re)attach：先挂起 pending 刷写，待 terminalCreate 返回后再决定用 replay 还是照常刷写，
    // 避免切回终端时先刷写 backlog、随后又写 replay 造成 cat 大文件内容重复显示
    beginReplayGate(id)
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
            if (result.reused && result.replay) {
              // 复用会话：丢弃门控期间累积的 backlog，仅回放 replay（权威历史），避免重复
              applyReplayAndFlush(id, result.replay)
            } else {
              // 新建会话：无 replay，解除门控并刷写首屏缓冲
              endReplayGate(id)
            }
            setPtyReady(id)
          } else {
            endReplayGate(id)
            setFallback(id)
          }
        })
        .catch(() => {
          ptyReady = true
          endReplayGate(id)
          setFallback(id)
        })
    } else {
      endReplayGate(id)
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

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (!ptyReady) return
      if (fitTimer !== null) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        fitTerminal(id)
      }, 250)
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

  return <div ref={ref} className="agent-terminal-screen" style={{ display: visible ? '' : 'none' }} />
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
    <div className="agent-terminal-screen" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', background: 'var(--color-terminal-bg, #1e1e1e)' }}>
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

// ansiToHtml 已抽至 utils/ansiToHtml.ts（纯函数，供单元测试回归锁定转义行为）

const MAX_MOUNTED_TERMINALS = 6

/** Agent Code 工作台内嵌终端（项目唯一的终端界面）。
    workspaceDir：当前编码工作区目录（通用模式为空）——cwd 输入框默认值取自它。 */
export default function TerminalView({ store, workspaceDir = '' }: { store?: TerminalStoreHook | null; workspaceDir?: string }): React.JSX.Element {
  const activeStore = store ?? useAgentTerminalStore
  const { sessions, activeId, open } = activeStore()
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
    <div className="agent-terminal-view">
      <TerminalTabBar store={activeStore} workspaceDir={workspaceDir} />
      {sessions.length === 0 ? (
        <div className="agent-terminal-empty">
          <Terminal size={48} strokeWidth={1.5} />
          <p>没有打开的终端</p>
          <p style={{ fontSize: 12 }}>点击右上角 + 新建终端</p>
        </div>
      ) : (
        <div className="agent-terminal-screens">
          {sessions.filter((s) => !s.exited && mountedKeys.includes(s.id)).map((s) => (
            s.fallback
              ? <FallbackTermScreen key={s.id} id={s.id} cwd={s.cwd} visible={s.id === activeId} />
              : <TermScreen key={s.id} id={s.id} visible={s.id === activeId} store={activeStore} />
          ))}
          {active && active.exited && (
            <div className="agent-terminal-exited-overlay">
              <p>终端已退出</p>
              <button className="agent-terminal-new-btn" onClick={() => open()}>
                新建终端
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
