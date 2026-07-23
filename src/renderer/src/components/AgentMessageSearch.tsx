import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'

// 会话内消息搜索：Ctrl/Cmd+F 打开，在消息滚动容器内查找文本，用 CSS Custom Highlight API
// 高亮所有匹配（不改动 React 的 DOM，安全），并支持上/下一个跳转 + 计数。
// 若浏览器不支持 Highlight API，则退化为「滚动到匹配所在位置」（无底色高亮）。
export default function AgentMessageSearch({ containerRef, revision }: {
  containerRef: React.RefObject<HTMLDivElement | null>
  revision: number
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [active, setActive] = useState(0) // 1-based
  const rangesRef = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const supported = typeof (window as any).Highlight !== 'undefined' && !!(CSS as any).highlights

  const clearHighlights = useCallback(() => {
    try {
      ;(CSS as any).highlights?.delete('agent-search')
      ;(CSS as any).highlights?.delete('agent-search-active')
    } catch { /* ignore */ }
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
    const ranges: Range[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = (n as Text).parentElement
        if (!p || p.closest('.agent-msg-search')) return NodeFilter.FILTER_REJECT
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || ''
      const hay = text.toLowerCase()
      let idx = hay.indexOf(lower)
      while (idx !== -1) {
        const r = document.createRange()
        r.setStart(node, idx)
        r.setEnd(node, idx + q.length)
        ranges.push(r)
        idx = hay.indexOf(lower, idx + q.length)
      }
    }
    rangesRef.current = ranges
    setCount(ranges.length)
    setActive(ranges.length ? 1 : 0)
    if (supported) {
      try { (CSS as any).highlights.set('agent-search', new (window as any).Highlight(...ranges)) } catch { /* ignore */ }
    }
  }, [query, open, containerRef, supported, clearHighlights])

  // query / 打开状态 / 会话内容（revision）变化时，防抖重算匹配
  useEffect(() => {
    const id = setTimeout(compute, 60)
    return () => clearTimeout(id)
  }, [compute, revision])

  // 高亮当前匹配并滚动到视图中央
  useEffect(() => {
    if (active < 1 || active > rangesRef.current.length) return
    const r = rangesRef.current[active - 1]!
    if (supported) {
      try { (CSS as any).highlights.set('agent-search-active', new (window as any).Highlight(r)) } catch { /* ignore */ }
    }
    const el = r.startContainer.parentElement
    el?.scrollIntoView({ block: 'center' })
  }, [active, supported, count])

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
