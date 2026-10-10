import React, { useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, Globe, Loader, ChevronRight } from 'lucide-react'
import { useBubbleTip } from './useBubbleTip'
import { SiteIcon, hostOf } from './SiteIcon'

/**
 * fetch_webpage 工具结果卡。
 *
 * 为什么需要它：主进程返回的是 JSON.stringify({ url, content })，content 里全是被
 * 转义的换行。落进通用 ToolResultView 后有两个连锁问题 ——
 *   ① 通用结果卡按 result.split('\n') 的行数判长短，而这个 JSON 是**一整行**，
 *      于是行数=1 → 判定为「短结果」→ 既不折叠也不走窗口，把整坨 JSON 原样铺开；
 *   ② 标题写「共 1 行」，既没信息量又误导。
 * 这里把两份信息拆开：来源单独一行（图标 + 域名 + 完整 URL），正文 JSON 解码后
 * 还原真实换行，再按「导航项 / 段落」分块排版，默认折叠。
 *
 * 数据来自主进程 handleFetchWebpage：{url, content} 或 {error}。
 */
type Parsed =
  | { kind: 'page'; url: string; content: string; truncated: boolean }
  | { kind: 'error'; message: string }

// 不超过这个长度的行视为导航项 / 标签项（导航栏原文一行一个词）
const CHIP_MAX = 14
// 折叠态正文的字符预算；至少显示 2 块，避免首块就是超长段落时只剩一块。
// 字符预算只决定「切在第几块」，真正的显示高度由 CSS 的 --fw-body-max 兜底 ——
// 导航项那一块换行几行是字符数算不出来的。
const COLLAPSE_CHARS = 200

type Block = { kind: 'chips'; items: string[] } | { kind: 'text'; text: string }

/** 把正文切成块：连续的短行合并成一行（导航栏逐行渲染会把正文彻底淹掉），长行各自成段。 */
function toBlocks(content: string): Block[] {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  const blocks: Block[] = []
  let chips: string[] = []
  const flush = () => { if (chips.length) { blocks.push({ kind: 'chips', items: chips }); chips = [] } }
  for (const line of lines) {
    if (line.length <= CHIP_MAX) { chips.push(line); continue }
    flush()
    blocks.push({ kind: 'text', text: line })
  }
  flush()
  return blocks
}

export default function FetchWebpageResult({ url, result, loading }: { url?: string; result?: string; loading?: boolean }) {
  const data = useMemo<Parsed | null>(() => {
    if (!result) return null
    try {
      const p = JSON.parse(result) as Record<string, unknown>
      if (p && typeof p === 'object') {
        if (typeof p.error === 'string') return { kind: 'error', message: p.error }
        const u = typeof p.url === 'string' ? p.url : ''
        const c = typeof p.content === 'string' ? p.content : ''
        // 截断与否取主进程给的结构化字段，不去认正文末尾那句「…（内容已截断）」——
        // 靠字符串匹配的话，主进程改文案这里会静默失效
        if (u || c) return { kind: 'page', url: u, content: c, truncated: p.truncated === true }
      }
    } catch { /* 非 JSON 结果按纯文本正文处理 */ }
    // 防御分支：fetch_webpage 正常总是返回 JSON，走不到这里，截断状态无从判断
    return { kind: 'page', url: url ?? '', content: result, truncated: false }
  }, [result, url])

  const busy = !!loading && !result
  const pageUrl = (data?.kind === 'page' && data.url) || url || ''
  const content = data?.kind === 'page' ? data.content : ''
  const blocks = useMemo(() => (content ? toBlocks(content) : []), [content])

  const [expanded, setExpanded] = useState(false)
  const visibleBlocks = useMemo(() => {
    if (expanded) return blocks
    let used = 0
    const out: Block[] = []
    for (const b of blocks) {
      const len = b.kind === 'text' ? b.text.length : b.items.join('').length
      if (out.length >= 2 && used + len > COLLAPSE_CHARS) break
      out.push(b)
      used += len
    }
    return out
  }, [blocks, expanded])
  const clipped = visibleBlocks.length < blocks.length

  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  const host = useMemo(() => hostOf(pageUrl), [pageUrl])
  const truncated = data?.kind === 'page' && data.truncated

  return (
    <div className="agent-fw">
      {tipNode}

      {/* 来源行：这条正文是从哪抓的 —— 图标 + 域名给「一眼认出来源」，完整 URL 可点外开 */}
      <div className="agent-fw-source">
        {host
          ? <SiteIcon url={pageUrl} size={20} showCheck={false} />
          : <Globe size={14} className="agent-fw-globe" />}
        <span className="agent-fw-host">{host || '未知来源'}</span>
        {pageUrl && (
          <a
            className="agent-fw-url"
            href={pageUrl}
            {...tip(pageUrl)}
            onClick={(e) => { e.preventDefault(); window.api.openExternal(pageUrl) }}
          >
            {pageUrl}
          </a>
        )}
        {pageUrl && <ExternalLink size={10} className="agent-fw-arrow" />}
      </div>

      {busy && (
        <div className="agent-fw-loading"><Loader size={12} className="spin" /> 正在抓取正文…</div>
      )}

      {data?.kind === 'error' && (
        <div className="agent-fw-error"><AlertCircle size={12} /> {data.message}</div>
      )}

      {!busy && data?.kind !== 'error' && (
        <>
          {blocks.length > 0 ? (
            <div className={`agent-fw-body${clipped ? ' is-clipped' : ''}`}>
              {visibleBlocks.map((b, i) => b.kind === 'chips'
                ? <p className="agent-fw-chips" key={i}>{b.items.map((t, j) => <span key={j}>{t}</span>)}</p>
                : <p className="agent-fw-p" key={i}>{b.text}</p>)}
            </div>
          ) : (
            <div className="agent-tool-note">（页面无文本内容）</div>
          )}

          {blocks.length > 0 && (
            <div className="agent-fw-foot">
              <span className="agent-fw-meta">
                共 {content.length.toLocaleString()} 字符{truncated ? ' · 已截断' : ''}
              </span>
              {(clipped || expanded) && (
                <button type="button" className="agent-tool-subtoggle" onClick={() => setExpanded((v) => !v)}>
                  <ChevronRight size={11} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
                  {expanded ? '收起' : `展开全文（${blocks.length} 段）`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
