import React, { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { Check, Copy, ChevronDown } from 'lucide-react'

/**
 * 代码块组件：用 highlight.js 高亮，带语言标签、复制按钮和折叠/展开。
 * 供 react-markdown 的 code 渲染器使用。
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
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // 完成态：单次 hljs 高亮（值已稳定，无需防抖）。流式态：跳过（逐行 span 已保证可见）。
  useEffect(() => {
    if (isStreaming) return
    const el = codeRef.current
    if (!el) return
    el.textContent = value
    const t0 = performance.now()
    try {
      if (language && hljs.getLanguage(language)) {
        el.innerHTML = hljs.highlight(value, { language }).value
      } else {
        el.innerHTML = hljs.highlightAuto(value).value
      }
    } catch {
      /* 高亮失败保持纯文本 */
    }
    const dt = performance.now() - t0
    if (dt > 10) console.debug(`[stream-diag] hljs ${dt.toFixed(1)}ms lang=${language || 'auto'} chars=${value.length}`)
  }, [value, language, isStreaming])

  const lines = useMemo(() => value.split('\n'), [value])

  const handleCopy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const langLabel = language || 'text'
  const lineCount = lines.length

  return (
    <div className={`chat-code-block ${collapsed ? 'collapsed' : ''}`}>
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
