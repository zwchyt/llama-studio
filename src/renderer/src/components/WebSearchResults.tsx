import React, { useMemo } from 'react'
import { Search, CheckCircle2, Globe, ExternalLink, AlertCircle } from 'lucide-react'

interface SearchResultItem {
  title: string
  url: string
  snippet?: string
}

type Parsed =
  | { kind: 'items'; items: SearchResultItem[] }
  | { kind: 'error'; message: string }

/**
 * web_search 工具结果卡（对齐 WebSearch 演示设计的视觉语言）：
 * 执行中（loading）→ globe 旋转 + 流光「搜索中 “query”」+ 骨架行；
 * 完成 → 结构化结果列表（check + 标题 + snippet + URL），级联 fade-up 入场；
 * 失败 → 错误信息。
 * 数据来自主进程 handleWebSearch 返回的 JSON：{title,url,snippet}[] 或 {error}。
 */
export default function WebSearchResults({ result, query, loading }: { result?: string; query?: string; loading?: boolean }) {
  const data = useMemo<Parsed | null>(() => {
    if (!result) return null
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) {
        return { kind: 'items', items: parsed as SearchResultItem[] }
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).error === 'string') {
        return { kind: 'error', message: (parsed as any).error }
      }
    } catch { /* 非 JSON 结果按纯文本错误处理 */ }
    return { kind: 'error', message: result.slice(0, 300) }
  }, [result])

  const busy = !!loading && !result
  const items = data?.kind === 'items' ? data.items : []
  const failed = data?.kind === 'error'

  return (
    <div className="agent-ws">
      <div className="agent-ws-row">
        {busy ? <Globe size={13} className="agent-ws-globe" /> : <Search size={13} />}
        <span className="agent-ws-label">
          <span className={busy ? 'agent-ws-shimmer' : ''}>
            {busy ? '搜索中' : '搜索结果'}
            {query ? <span className="agent-ws-quote"> “{query}”</span> : null}
          </span>
        </span>
      </div>

      {busy && (
        <div className="agent-ws-skeleton">
          {[0, 1, 2].map(i => (
            <div className="agent-ws-skel-row" key={i}>
              <span className="agent-ws-skel-dot" />
              <span className="agent-ws-skel-bar" />
            </div>
          ))}
        </div>
      )}

      {failed && (
        <div className="agent-ws-error">
          <AlertCircle size={12} /> {data.message}
        </div>
      )}

      {items.length > 0 && (
        <ul className="agent-ws-list">
          {items.map((item, i) => (
            <li
              key={item.url || i}
              className="agent-ws-site"
              style={{ animation: `agentFadeUp 320ms cubic-bezier(.23,1,.32,1) ${i * 55}ms both` }}
            >
              <span className="agent-ws-bullet"><CheckCircle2 size={12} /></span>
              <span className="agent-ws-body">
                <a
                  className="agent-ws-title"
                  href={item.url}
                  title={item.url}
                  onClick={(e) => { e.preventDefault(); window.api.openExternal(item.url) }}
                >
                  {item.title}
                </a>
                {item.snippet ? <span className="agent-ws-snippet">{item.snippet}</span> : null}
                <span className="agent-ws-url">{item.url}</span>
              </span>
              <ExternalLink size={10} className="agent-ws-arrow" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
