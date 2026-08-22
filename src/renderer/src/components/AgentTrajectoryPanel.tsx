// ── 轨迹台账面板：pi 会话事件流落盘（trajectory/<sessionId>.jsonl）的只读视图 ──
// UI 布局移植自 deepseek-harness ui-trajectory 的三段式设计：
//   工具栏（折叠控件 + 搜索）→ 时间线条带（按来源着色的时段块，可点击定位）→
//   台账（粘性 Turn 表头 + 卡片式行：#序号 · 来源标签 · 预览文本 · 指标 · 相对耗时）
// 数据获取走独立的 trajectory-read IPC + 1.5s 增量轮询（fromSeq 游标），
// 不占用 pi-agent-event 单监听事件通道（preload onEvent 会 removeAllListeners）。
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ChevronDownIcon, SearchIcon, Trash2Icon } from '@animateicons/react/lucide'

interface TrajEntry {
  seq: number
  ts: number
  type: string
  src: 'flow' | 'assistant' | 'tool' | 'user' | 'system' | 'llm'
  payload: unknown
}

const POLL_MS = 1500
const RENDER_LIMIT = 200 // 默认只渲染最近 N 条，避免长会话一次性渲染阻塞界面
const MEMORY_CAP = 5000 // 面板内存中的条目上限保护
const TL_MAX_SEGS = 400 // 时间线最多渲染的时段块数（更早的合并为一个占位段）

const SRC_LABELS: Record<string, string> = {
  flow: '流程',
  assistant: '模型',
  tool: '工具',
  user: '用户',
  system: '系统',
  llm: 'LLM'
}

const SRC_ORDER: Array<TrajEntry['src']> = ['flow', 'llm', 'assistant', 'tool', 'user', 'system']

const TYPE_LABELS: Record<string, string> = {
  session_header: '会话头',
  agent_start: '开始运行',
  agent_end: '运行结束',
  turn_start: '轮次开始',
  turn_end: '轮次完成',
  agent_settled: '回合稳定',
  message_start: '消息开始',
  message_update: '流式输出',
  message_end: '消息完成',
  tool_execution_start: '工具开始',
  tool_execution_update: '工具输出',
  tool_execution_end: '工具结束',
  entry_appended: '条目入账',
  queue_update: '队列更新',
  compaction_start: '压缩开始',
  compaction_end: '压缩结束',
  session_info_changed: '会话信息',
  thinking_level_changed: '思考级别',
  llm_request: 'LLM 请求',
  llm_response: 'LLM 响应'
}

const ROLE_LABELS: Record<string, string> = {
  user: '用户消息',
  assistant: '助手消息',
  toolResult: '工具结果',
  developer: '系统消息',
  system: '系统消息'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return String(value)
  }
}

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 相对时长：+0.8s / +12s / +2m05s */
function fmtDelta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '+0s'
  const s = ms / 1000
  if (s < 10) return `+${s.toFixed(1)}s`
  if (s < 60) return `+${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return `+${m}m${String(rest).padStart(2, '0')}s`
}

/** 从 pi message.content（字符串或分块数组）提取纯文本 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
        parts.push((b as { text: string }).text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

function clip(text: string, n = 110): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 紧凑数字：1234 → 1.2k */
function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

interface PayloadShape {
  message?: { role?: string; content?: unknown; usage?: { input?: number; output?: number; reasoning?: number } }
  turnIndex?: number
  toolName?: string
  toolCallId?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  entry?: { message?: { role?: string; content?: unknown } }
  assistantMessageEvent?: { type?: string; deltaLen?: number }
  cwd?: string
  port?: number
  model?: string
  messageCount?: number
  promptChars?: number
  toolCount?: number
  toolsChanged?: boolean
}

/** 行预览文本：按事件类型提取一句人话摘要 */
function previewOf(type: string, p: PayloadShape): string {
  switch (type) {
    case 'session_header': {
      const base = typeof p.cwd === 'string' ? p.cwd.split(/[\\/]/).filter(Boolean).pop() : ''
      return `会话初始化${base ? ` · ${base}` : ''}${typeof p.port === 'number' ? ` :${p.port}` : ''}`
    }
    case 'agent_start':
      return '开始运行'
    case 'agent_end':
      return '运行结束'
    case 'agent_settled':
      return '回合稳定'
    case 'turn_start':
      return typeof p.turnIndex === 'number' ? `第 ${p.turnIndex + 1} 轮开始` : '轮次开始'
    case 'turn_end':
      return '轮次完成'
    case 'message_start':
    case 'message_end': {
      const role = ROLE_LABELS[p.message?.role ?? ''] ?? (p.message?.role ?? '消息')
      const text = textFromContent(p.message?.content)
      return text ? `${role} · ${clip(text)}` : role
    }
    case 'message_update':
      return '流式输出中'
    case 'tool_execution_start': {
      let args = ''
      try {
        args = clip(JSON.stringify(p.args ?? '') ?? '', 90)
      } catch {
        args = ''
      }
      return `${p.toolName ?? 'tool'}${args ? ` ${args}` : ''}`
    }
    case 'tool_execution_update':
      return `${p.toolName ?? 'tool'} · 输出中`
    case 'tool_execution_end':
      return `${p.toolName ?? 'tool'} · ${p.isError ? '执行失败' : '执行完成'}`
    case 'entry_appended': {
      const msg = p.entry?.message
      const role = msg?.role
      const text = textFromContent(msg?.content)
      if (text) {
        if (role === 'user') return `用户输入 · ${clip(text)}`
        if (role === 'developer' || role === 'system') return `系统消息 · ${clip(text, 80)}`
      }
      return '条目入账'
    }
    case 'llm_request':
      return [
        `→ ${p.model ?? '?'}`,
        `${p.messageCount ?? '?'} 条消息`,
        typeof p.promptChars === 'number' ? `${p.promptChars.toLocaleString()} 字符` : '',
        typeof p.toolCount === 'number' ? `${p.toolCount} 工具` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    default:
      return TYPE_LABELS[type] ?? type
  }
}

/** 显示层条目：连续 message_update 已聚合（落盘仍是全量，仅台账展示合并） */
interface DisplayEntry extends TrajEntry {
  run?: { count: number; chars?: number; ms: number }
}

interface TurnGroup {
  key: string
  label: string
  items: DisplayEntry[]
}

export function AgentTrajectoryPanel({ piSessionId }: { piSessionId: string | null }) {
  const [entries, setEntries] = useState<TrajEntry[]>([])
  const [srcFilter, setSrcFilter] = useState<'all' | TrajEntry['src']>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [clearing, setClearing] = useState(false)
  const cursorRef = useRef(0)
  const ledgerRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)

  // 会话切换：重置本地状态与增量游标
  useEffect(() => {
    setEntries([])
    cursorRef.current = 0
    setSelected(null)
    setCollapsedTurns(new Set())
    setShowAll(false)
    followRef.current = true
  }, [piSessionId])

  // 增量轮询：面板打开期间每 1.5s 从 main 进程按 fromSeq 拉新
  useEffect(() => {
    if (!piSessionId) return
    let alive = true
    const pull = async (): Promise<void> => {
      try {
        const res = await window.api.piAgent.trajectoryRead(piSessionId, cursorRef.current)
        if (!alive || !res) return
        if (res.entries.length > 0) {
          setEntries(prev => [...prev, ...res.entries].slice(-MEMORY_CAP))
          cursorRef.current = res.nextSeq
        } else if (typeof res.nextSeq === 'number' && res.nextSeq < cursorRef.current) {
          // 文件被外部清空：游标回退并丢弃本地缓存
          cursorRef.current = res.nextSeq
          setEntries([])
        }
      } catch {
        /* 拉取失败静默，下个周期重试 */
      }
    }
    void pull()
    const timer = setInterval(pull, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [piSessionId])

  // 跟随滚动：用户在底部附近时新数据自动滚到最新；向上翻阅时不打扰
  useEffect(() => {
    const el = ledgerRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [entries.length, showAll])

  const onLedgerScroll = useCallback(() => {
    const el = ledgerRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56
  }, [])

  const doClear = async (): Promise<void> => {
    if (!piSessionId) return
    setClearing(true)
    try {
      await window.api.piAgent.trajectoryClear(piSessionId)
      cursorRef.current = 0
      setEntries([])
      setSelected(null)
      setCollapsedTurns(new Set())
      followRef.current = true
    } finally {
      setClearing(false)
    }
  }

  const scrollToRow = useCallback((seq: number) => {
    document.getElementById(`traj-row-${seq}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      if (srcFilter !== 'all' && e.src !== srcFilter) return false
      if (!q) return true
      if (e.type.toLowerCase().includes(q)) return true
      try {
        return JSON.stringify(e.payload ?? '').toLowerCase().includes(q)
      } catch {
        return false
      }
    })
  }, [entries, srcFilter, search])

  // 连续 message_update 聚合：流式期间每个增量都触发一条事件，逐行展示噪音过大。
  // 显示层把连续 update 合并为一行「流式输出中 ×N」（数据层全量保留，展开看末次 payload）。
  const displayed = useMemo<DisplayEntry[]>(() => {
    const out: DisplayEntry[] = []
    let pending: TrajEntry[] = []
    const flush = (): void => {
      if (pending.length === 0) return
      const first = pending[0]
      const last = pending[pending.length - 1]
      const chars = (last.payload as PayloadShape)?.assistantMessageEvent?.deltaLen
      out.push({
        ...last,
        run: {
          count: pending.length,
          chars: typeof chars === 'number' ? chars : undefined,
          ms: last.ts - first.ts
        }
      })
      pending = []
    }
    for (const e of filtered) {
      if (e.type === 'message_update') pending.push(e)
      else {
        flush()
        out.push(e)
      }
    }
    flush()
    return out
  }, [filtered])

  // 工具耗时配对：tool_execution_start/end 按 toolCallId 配对计算执行时长
  const toolDurations = useMemo(() => {
    const starts = new Map<string, number>()
    const durations = new Map<number, number>()
    for (const e of displayed) {
      const p = e.payload as PayloadShape
      const id = typeof p?.toolCallId === 'string' ? p.toolCallId : null
      if (!id) continue
      if (e.type === 'tool_execution_start') starts.set(id, e.ts)
      else if (e.type === 'tool_execution_end' && starts.has(id)) {
        durations.set(e.seq, e.ts - (starts.get(id) as number))
        starts.delete(id)
      }
    }
    return durations
  }, [displayed])

  // turn 分组：以 turn_start 为边界（用事件自带 turnIndex）；首个之前的归「会话初始化」
  const groups = useMemo<TurnGroup[]>(() => {
    const out: TurnGroup[] = []
    let current: TurnGroup = { key: 'init', label: '会话初始化', items: [] }
    for (const e of displayed) {
      if (e.type === 'turn_start') {
        const idx = (e.payload as PayloadShape)?.turnIndex
        if (current.items.length > 0) out.push(current)
        current =
          typeof idx === 'number'
            ? { key: `t${idx}`, label: `Turn ${idx + 1}`, items: [e] }
            : { key: `ts${e.seq}`, label: 'Turn ?', items: [e] }
      } else {
        current.items.push(e)
      }
    }
    if (current.items.length > 0) out.push(current)
    return out
  }, [displayed])

  const allTurnKeys = useMemo(() => groups.map(g => g.key), [groups])
  const allTurnsCollapsed =
    allTurnKeys.length > 0 && allTurnKeys.every(k => collapsedTurns.has(k))

  const toggleAllTurns = (): void => {
    setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(allTurnKeys))
  }

  const toggleTurn = (key: string): void => {
    setCollapsedTurns(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 主从布局：点击行=在右侧详情面板查看（不再向下展开撑长列表）
  const select = (seq: number): void => {
    setSelected(prev => (prev === seq ? null : seq))
  }

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copySelected = (entry: TrajEntry): void => {
    void navigator.clipboard.writeText(safeJson(entry.payload)).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1400)
    })
  }

  // 渲染上限：未点「显示全部」时只渲染尾部（最新）RENDER_LIMIT 条
  const hiddenCount = Math.max(0, displayed.length - RENDER_LIMIT)
  const visibleLimit = showAll ? Number.MAX_SAFE_INTEGER : RENDER_LIMIT
  let renderedCount = 0
  const shownGroups: TurnGroup[] = []
  for (let i = groups.length - 1; i >= 0 && renderedCount < visibleLimit; i--) {
    const g = groups[i]
    const take = Math.min(g.items.length, visibleLimit - renderedCount)
    shownGroups.unshift({
      key: g.key,
      label: g.label,
      items: g.items.slice(g.items.length - take)
    })
    renderedCount += take
  }

  // 时间线段：宽度按时段间隔比例（封顶防止单块独占），超出上限的早期块并为一个占位段
  const tlSegs = useMemo(() => {
    const list = displayed.map((e, i) => ({
      e,
      grow: i + 1 < displayed.length ? Math.min(displayed[i + 1].ts - e.ts, 30000) + 60 : 60
    }))
    if (list.length <= TL_MAX_SEGS) return { fillerGrow: 0, segs: list }
    const cut = list.length - TL_MAX_SEGS
    return {
      fillerGrow: list.slice(0, cut).reduce((acc, x) => acc + x.grow, 0),
      segs: list.slice(cut)
    }
  }, [displayed])

  const srcCounts = useMemo(() => {
    const counts = new Map<TrajEntry['src'], number>()
    for (const e of displayed) counts.set(e.src, (counts.get(e.src) ?? 0) + 1)
    return counts
  }, [displayed])

  if (!piSessionId) return <div className="traj-empty">暂无活动会话。</div>

  const selectedEntry = selected !== null ? (displayed.find(e => e.seq === selected) ?? null) : null

  return (
    <div className="agent-traj">
      {/* 工具栏：折叠控件 + 搜索（对齐参考项目 TrajectoryToolbar） */}
      <div className="traj-toolbar">
        <button
          type="button"
          className={`traj-fold ${allTurnsCollapsed ? 'on' : ''}`}
          onClick={toggleAllTurns}
          disabled={allTurnKeys.length === 0}
          title={allTurnsCollapsed ? '展开全部轮次' : '折叠全部轮次'}
        >
          <span className="traj-fold-icon">{allTurnsCollapsed ? '⊞' : '⊟'}</span>
          轮次
        </button>
        <div className="traj-searchbox">
          <SearchIcon size={11} className="traj-search-icon" />
          <input
            type="search"
            className="traj-search"
            placeholder="搜索轨迹…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="traj-clear"
          onClick={() => void doClear()}
          disabled={clearing}
          title="清空轨迹"
        >
          <Trash2Icon size={12} />
        </button>
      </div>

      {/* 来源筛选（带计数的小胶囊） */}
      <div className="traj-chips">
        <button
          className={`traj-chip ${srcFilter === 'all' ? 'active' : ''}`}
          onClick={() => setSrcFilter('all')}
        >
          全部 <em>{displayed.length}</em>
        </button>
        {SRC_ORDER.map(src => (
          <button
            key={src}
            className={`traj-chip src-${src} ${srcFilter === src ? 'active' : ''}`}
            onClick={() => setSrcFilter(src)}
          >
            <i className="dot" />
            {SRC_LABELS[src]} <em>{srcCounts.get(src) ?? 0}</em>
          </button>
        ))}
      </div>

      {displayed.length > 0 && (
        <div className="traj-timeline">
          {tlSegs.fillerGrow > 0 && (
            <div
              className="traj-tl-seg dim"
              style={{ flexGrow: tlSegs.fillerGrow }}
              title={`更早的 ${displayed.length - TL_MAX_SEGS} 条`}
            />
          )}
          {tlSegs.segs.map(({ e, grow }) => (
            <button
              key={e.seq}
              type="button"
              className={`traj-tl-seg src-${e.src}`}
              style={{ flexGrow: grow }}
              title={`${TYPE_LABELS[e.type] ?? e.type} · #${e.seq} · ${fmtClock(e.ts)}`}
              onClick={() => scrollToRow(e.seq)}
            />
          ))}
        </div>
      )}

      {displayed.length === 0 ? (
        <div className="traj-empty">{entries.length === 0 ? '暂无轨迹记录。' : '无匹配条目。'}</div>
      ) : (
        <div className="traj-main">
          <div className="traj-ledger" ref={ledgerRef} onScroll={onLedgerScroll}>
          {hiddenCount > 0 && !showAll && (
            <button className="traj-more" onClick={() => setShowAll(true)}>
              显示更早的 {hiddenCount} 条记录
            </button>
          )}
          {shownGroups.map(g => {
            const collapsed = collapsedTurns.has(g.key)
            const span =
              g.items.length > 1 ? g.items[g.items.length - 1].ts - g.items[0].ts : 0
            return (
              <div className="traj-turn" key={g.key}>
                <button
                  type="button"
                  className="traj-turn-head"
                  onClick={() => toggleTurn(g.key)}
                  title={collapsed ? '展开该轮次' : '折叠该轮次'}
                >
                  <ChevronDownIcon size={11} className={`traj-caret ${collapsed ? '' : 'open'}`} />
                  <span className="traj-turn-title">{g.label}</span>
                  <span className="traj-turn-meta">
                    {g.items.length} 条{span > 0 ? ` · ${fmtDelta(span).slice(1)}` : ''}
                  </span>
                  {/* 列标签行（参考 TrajectoryTurnHeader 的 Input/Output/Time 粘性列头） */}
                  <span className="traj-turn-cols" aria-hidden="true">
                    <i className="w1">字符</i>
                    <i className="w2">Token</i>
                    <i className="w3">用时</i>
                  </span>
                </button>
                {!collapsed &&
                  g.items.map(e => {
                    const open = selected === e.seq
                    const p = (e.payload ?? {}) as PayloadShape
                    const sub =
                      e.type === 'tool_execution_update' || e.type === 'tool_execution_end'
                    const dur = toolDurations.get(e.seq)
                    const usage = e.type === 'message_end' ? p.message?.usage : undefined
                    const elapsed = e.ts - g.items[0].ts
                    const isCompact = e.type.startsWith('compaction')
                    return (
                      <div
                        id={`traj-row-${e.seq}`}
                        className={`traj-cell${sub ? ' sub' : ''}${open ? ' sel' : ''}`}
                        key={e.seq}
                      >
                        <button
                          type="button"
                          className="traj-row-head"
                          onClick={() => select(e.seq)}
                          title={`${TYPE_LABELS[e.type] ?? e.type} · #${e.seq} · ${fmtClock(e.ts)}`}
                        >
                          <span className="traj-idx">#{e.seq}</span>
                          <span className={`traj-tag ${isCompact ? 'compacted' : `src-${e.src}`}`}>
                            {isCompact ? '压缩' : SRC_LABELS[e.src] ?? e.src}
                          </span>
                          {(e.type === 'message_start' || e.type === 'message_end') && (
                            <span className={`traj-phase ${e.type === 'message_start' ? 'ph-start' : 'ph-end'}`}>
                              {e.type === 'message_start' ? '开始' : '结束'}
                            </span>
                          )}
                          <span className={`traj-text${p.isError ? ' err' : ''}`}>
                            {previewOf(e.type, p)}
                            {e.run && <em className="traj-run">×{e.run.count}</em>}
                            {p.toolsChanged && <em className="traj-tc">工具变更</em>}
                          </span>
                          <span className="traj-trail">
                            <span className="traj-slot w1">
                              {e.type === 'llm_request' && typeof p.messageCount === 'number' ? (
                                <span className="traj-metric">{p.messageCount} msg</span>
                              ) : e.run && typeof e.run.chars === 'number' ? (
                                <span className="traj-metric">{e.run.chars} 字</span>
                              ) : typeof dur === 'number' ? (
                                <span className="traj-metric">{fmtDelta(dur)}</span>
                              ) : null}
                            </span>
                            <span className="traj-slot w2">
                              {e.type === 'llm_request' && typeof p.promptChars === 'number' ? (
                                <span className="traj-metric">{fmtK(p.promptChars)} 字</span>
                              ) : usage &&
                                typeof usage.input === 'number' &&
                                typeof usage.output === 'number' ? (
                                <span className="traj-metric" title={typeof usage.reasoning === 'number' ? `思考 ${usage.reasoning} tokens` : undefined}>
                                  ↑{usage.input} ↓{usage.output}
                                  {typeof usage.reasoning === 'number' && usage.reasoning > 0 ? ` ✦${usage.reasoning}` : ''}
                                </span>
                              ) : null}
                            </span>
                            <span className="traj-slot w3">
                              <span className="traj-elapsed">{fmtDelta(elapsed)}</span>
                            </span>
                            <ChevronDownIcon size={10} className={`traj-caret sm ${open ? 'open' : ''}`} />
                          </span>
                        </button>
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
        {/* 右侧详情面板（主从布局：详情不再撑长列表） */}
        {selectedEntry && (
          <aside className="traj-detail">
            <div className="traj-detail-head">
              <span className="traj-detail-title">
                #{selectedEntry.seq} · {TYPE_LABELS[selectedEntry.type] ?? selectedEntry.type}
              </span>
              <span className="traj-detail-actions">
                <button type="button" className="traj-detail-btn" onClick={() => copySelected(selectedEntry)}>
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  className="traj-detail-btn"
                  onClick={() => setSelected(null)}
                  title="关闭详情"
                >
                  ×
                </button>
              </span>
            </div>
            <pre className="traj-detail-body">{safeJson(selectedEntry.payload)}</pre>
          </aside>
        )}
        </div>
      )}
    </div>
  )
}
