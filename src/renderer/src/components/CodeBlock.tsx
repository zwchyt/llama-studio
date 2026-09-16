import React, { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { Check, Copy, ChevronDown } from 'lucide-react'

/**
 * 代码块组件：用 highlight.js 高亮，带语言标签、复制按钮和折叠/展开。
 * 供 markstream 的 code_block 节点覆写使用（见 ../markdown/markstream）。
 *
 * isStreaming 的语义由覆写组件按 `stream`（= <MarkdownRender> 的 codeBlockStream）透传：
 * 流式实例 true / 结束实例 false。
 *
 * 流式显示优化（isStreaming=true）：
 * 代码输出是「一卡一卡」的显示层根源——旧实现每次值变化都 textContent 全文替换 +
 * 整块 <pre> 重绘（几百行的块 × 每秒 25 次更新 = 每帧重绘整个块）。
 * 流式期间改为「逐行 span」渲染：稳定 key 让 React 只更新最后一行文本节点，
 * 浏览器 paint 区域收缩到最后一行；hljs 高亮推迟到值稳定（isStreaming 翻转）后
 * 一次性执行，避免流式中反复整块 innerHTML 替换。
 */
interface CodeBlockProps {
  language: string
  value: string
  showLineNumbers?: boolean
  isStreaming?: boolean
}

export default function CodeBlock({ language, value, showLineNumbers, isStreaming }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // 收尾高亮推迟到「本块进入视口」再做。
  // 长回答里同时存在几十个代码块，流结束的那一次 commit 会让它们的 useEffect 全部同步
  // 执行——实测 30KB / 36 个块时 hljs 计算 19.0ms + innerHTML 整体替换（jsdom 下 75ms，
  // 真实 Chromium 约 8~15ms），合计一次 30~100ms 的主线程阻塞，正是「输出结束瞬间白一下」。
  // 只高亮视口附近的块：视口内通常 2~3 块，其余留纯文本，滚动到时再补。
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (isStreaming) return
    const el = rootRef.current
    if (!el) return
    // 无 IntersectionObserver（测试环境）时退化为立即高亮，保持旧行为
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) { setInView(true); io.disconnect() }
      },
      // 上下各留 300px 预取带：滚动到附近时高亮已就绪，不会看到「先纯文本后变色」
      { rootMargin: '300px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [isStreaming])

  // 完成态：单次 hljs 高亮（值已稳定，无需防抖）。流式态：跳过（逐行 span 已保证可见）。
  useEffect(() => {
    if (isStreaming || !inView) return
    const el = codeRef.current
    if (!el) return
    const t0 = performance.now()
    try {
      if (language && hljs.getLanguage(language)) {
        el.innerHTML = hljs.highlight(value, { language }).value
      } else {
        // 未知语言不再回退 highlightAuto：它会逐个尝试全部内置语法，实测比指定语言慢
        // 10~20 倍（683 字符 4.04ms vs 0.41ms），对 5KB 以上的块更甚；而它给 mermaid /
        // svg / 图表降级内容（这些块的语言标记本就是空串或非 hljs 语言）猜出来的结果
        // 也不准确。直接纯文本，省掉这次全语言试探。
        el.textContent = value
      }
    } catch {
      /* 高亮失败保持纯文本 */
      el.textContent = value
    }
    const dt = performance.now() - t0
    if (dt > 10) console.debug(`[stream-diag] hljs ${dt.toFixed(1)}ms lang=${language || 'auto'} chars=${value.length}`)
  }, [value, language, isStreaming, inView])

  const lines = useMemo(() => value.split('\n'), [value])

  const handleCopy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const langLabel = language || 'text'
  const lineCount = lines.length

  return (
    <div ref={rootRef} className={`chat-code-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="chat-code-header">
        <div className="chat-code-head-left">
          <button
            className="chat-code-toggle"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? '展开代码' : '收起代码'}
            aria-label={collapsed ? '展开代码' : '收起代码'}
          >
            <ChevronDown size={13} className={`agent-tool-chev ${collapsed ? '' : 'open'}`} />
          </button>
          <span className="chat-code-lang">{langLabel}</span>
          {showLineNumbers && <span className="chat-code-line-count">{lineCount} 行</span>}
        </div>
        <button className="chat-code-copy" onClick={handleCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className={`chat-code-body ${showLineNumbers ? 'with-lines' : ''} ${collapsed ? 'hidden' : ''}`}>
        {showLineNumbers && (
          <pre className="chat-code-line-nums" aria-hidden="true">
            {lines.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </pre>
        )}
        <pre className="chat-code-pre">
          {isStreaming ? (
            <code className={`code-streaming language-${langLabel}`}>
              {lines.map((ln, i) => (
                <span key={i}>{ln || '\u00A0'}</span>
              ))}
            </code>
          ) : (
            <code ref={codeRef} className={`hljs language-${langLabel}`} />
          )}
        </pre>
      </div>
    </div>
  )
}
