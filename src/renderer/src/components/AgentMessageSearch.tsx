import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'

// 会话内消息搜索：Ctrl/Cmd+F 打开，支持上/下一个跳转 + 计数。
//
// 匹配来源是「数据层」而非 DOM：逐条扫 messages[i].content。旧实现用 TreeWalker 扫滚动容器内的
// 文本节点，屏外卸载后未挂载的消息直接漏结果、计数还会随挂载范围抖动。
// 高亮仍走 CSS Custom Highlight API，但 Range 只能指向真实文本节点，因此只对「已挂载」的匹配
// 消息建 Range；未挂载的匹配项跳转时先请求挂载（onEnsureMessage），挂载后补上 Range。
// 浏览器不支持 Highlight API 时退化为「滚动到匹配所在消息」（无底色）。

type Match = { msgIndex: number; nth: number }

export default function AgentMessageSearch({ containerRef, messages, onEnsureMessage }: {
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 当前已加载并参与渲染的消息，索引必须与消息节点的 data-message-index 对齐 */
  messages: readonly { content?: string }[]
  /** 匹配项所在消息尚未挂载时调用，请上层先把它挂上（屏外卸载接入后生效） */
  onEnsureMessage?: (index: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [active, setActive] = useState(0) // 1-based
  const matchesRef = useRef<Match[]>([])
  const rangesRef = useRef<(Range | null)[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // messages 用 ref 持有，避免把数组引用放进 compute 的依赖里——流式期间每次 commit
  // 都会换数组引用，那样会让 compute 每帧换新身份、防抖重算被反复重置。
  // 重算由下方 signature 驱动：只有「条数」或「末条内容」变化才认为需要重新统计。
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const tail = messages[messages.length - 1]?.content ?? ''
  const signature = `${messages.length}|${tail.length}|${tail.slice(-16)}`

  const supported = typeof (window as any).Highlight !== 'undefined' && !!(CSS as any).highlights

  const clearHighlights = useCallback(() => {
    try {
      ;(CSS as any).highlights?.delete('agent-search')
      ;(CSS as any).highlights?.delete('agent-search-active')
    } catch { /* ignore */ }
    matchesRef.current = []
    rangesRef.current = []
  }, [])

  // Ctrl/Cmd+F 打开搜索、Esc 关闭。监听器挂在 Agent 视图根节点上，避免影响其它页面。
  useEffect(() => {
    const target: HTMLElement | Window = containerRef.current?.closest('.agent-code-view') as HTMLElement | null ?? window
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent
      if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'f' || ke.key === 'F')) {
        ke.preventDefault()
        setOpen(true)
        setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
      } else if (ke.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    target.addEventListener('keydown', onKey)
    return () => target.removeEventListener('keydown', onKey)
  }, [open, containerRef])

  const compute = useCallback(() => {
    const root = containerRef.current
    const q = query.trim()
    if (!root || !open || !q) { clearHighlights(); setCount(0); setActive(0); return }
    const lower = q.toLowerCase()
    const list = messagesRef.current

    // 1) 数据层统计匹配：不依赖 DOM，屏外未挂载的消息同样计入。
    const matches: Match[] = []
    for (let i = 0; i < list.length; i += 1) {
      const text = list[i]?.content ?? ''
      if (!text) continue
      const hay = text.toLowerCase()
      let nth = 0
      let idx = hay.indexOf(lower)
      while (idx !== -1) {
        matches.push({ msgIndex: i, nth })
        nth += 1
        idx = hay.indexOf(lower, idx + lower.length)
      }
    }
    matchesRef.current = matches

    // 2) 已挂载的匹配消息补 Range，未挂载的留 null（Range 必须指向真实文本节点）。
    const ranges: (Range | null)[] = new Array(matches.length).fill(null)
    const byMsg = new Map<number, Range[]>()
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i]!
      let list2 = byMsg.get(m.msgIndex)
      if (!list2) {
        const node = root.querySelector<HTMLElement>(`[data-message-index="${m.msgIndex}"]`)
        list2 = node ? collectRanges(node, lower) : []
        byMsg.set(m.msgIndex, list2)
      }
      ranges[i] = list2[m.nth] ?? null
    }
    rangesRef.current = ranges

    setCount(matches.length)
    setActive(matches.length ? 1 : 0)
    if (supported) {
      try {
        const live = ranges.filter((r): r is Range => r !== null)
        ;(CSS as any).highlights.set('agent-search', new (window as any).Highlight(...live))
      } catch { /* ignore */ }
    }
  }, [query, open, containerRef, supported, clearHighlights])

  // query / 打开状态 / 会话内容（signature）变化时，防抖重算匹配
  useEffect(() => {
    const id = setTimeout(compute, 60)
    return () => clearTimeout(id)
  }, [compute, signature])

  // 高亮当前匹配并滚动到视图中央
  useEffect(() => {
    if (active < 1 || active > matchesRef.current.length) return
    const idx = active - 1
    const r = rangesRef.current[idx]
    if (supported) {
      try {
        if (r) (CSS as any).highlights.set('agent-search-active', new (window as any).Highlight(r))
        else (CSS as any).highlights?.delete('agent-search-active')
      } catch { /* ignore */ }
    }
    if (r) {
      r.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      return
    }
    // 该匹配项所在消息尚未挂载：请上层先挂载，同时尽量滚到它所在的消息节点。
    const m = matchesRef.current[idx]
    if (!m) return
    onEnsureMessage?.(m.msgIndex)
    containerRef.current?.querySelector<HTMLElement>(`[data-message-index="${m.msgIndex}"]`)?.scrollIntoView({ block: 'center' })
  }, [active, supported, count, onEnsureMessage, containerRef])

  useEffect(() => { if (!open) clearHighlights() }, [open, clearHighlights])
  useEffect(() => () => clearHighlights(), [clearHighlights])

  const go = (delta: number) => {
    if (count === 0) return
    setActive(a => ((a - 1 + delta + count) % count) + 1)
  }

  if (!open) return null
  return (
    <div className="agent-msg-search">
      <Search size={13} className="agent-msg-search-icon" />
      <input
        ref={inputRef}
        className="agent-msg-search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="在会话中搜索…"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
        }}
      />
      <span className="agent-msg-search-count">{count ? `${active}/${count}` : '0/0'}</span>
      <button className="agent-msg-search-btn" onClick={() => go(-1)} disabled={!count} title="上一个 (Shift+Enter)"><ChevronUp size={13} /></button>
      <button className="agent-msg-search-btn" onClick={() => go(1)} disabled={!count} title="下一个 (Enter)"><ChevronDown size={13} /></button>
      <button className="agent-msg-search-btn" onClick={() => setOpen(false)} title="关闭 (Esc)"><X size={13} /></button>
    </div>
  )
}

// 收集某个消息节点内的全部匹配 Range（跳过搜索框自身）。
// 注意：DOM 里的文本是渲染后的形态（Markdown / 工具卡），与数据层 content 的字符构成不完全
// 一致，所以这里的第 nth 个 Range 是「尽力对齐」，取不到时该匹配项就没有高亮底色。
function collectRanges(node: HTMLElement, lower: string): Range[] {
  const out: Range[] = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = (n as Text).parentElement
      if (!p || p.closest('.agent-msg-search')) return NodeFilter.FILTER_REJECT
      return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let t: Node | null
  while ((t = walker.nextNode())) {
    const hay = (t.nodeValue || '').toLowerCase()
    let idx = hay.indexOf(lower)
    while (idx !== -1) {
      const r = document.createRange()
      r.setStart(t, idx)
      r.setEnd(t, idx + lower.length)
      out.push(r)
      idx = hay.indexOf(lower, idx + lower.length)
    }
  }
  return out
}
