import React, { useEffect, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { Check, Copy } from 'lucide-react'

/**
 * 代码块组件：用 highlight.js 高亮，带语言标签和复制按钮。
 * 供 react-markdown 的 code 渲染器使用。
 */
interface CodeBlockProps {
  language: string
  value: string
  showLineNumbers?: boolean
}

export default function CodeBlock({ language, value, showLineNumbers }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (codeRef.current) {
      try {
        if (language && hljs.getLanguage(language)) {
          const result = hljs.highlight(value, { language })
          codeRef.current.innerHTML = result.value
        } else {
          const result = hljs.highlightAuto(value)
          codeRef.current.innerHTML = result.value
        }
      } catch {
        if (codeRef.current) codeRef.current.textContent = value
      }
    }
  }, [value, language])

  const handleCopy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const langLabel = language || 'text'
  const lineCount = value.split('\n').length

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{langLabel}</span>
        {showLineNumbers && <span className="chat-code-line-count">{lineCount} 行</span>}
        <button className="chat-code-copy" onClick={handleCopy} title="复制代码">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className={`chat-code-body ${showLineNumbers ? 'with-lines' : ''}`}>
        {showLineNumbers && (
          <pre className="chat-code-line-nums" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </pre>
        )}
        <pre className="chat-code-pre">
          <code ref={codeRef} className={`hljs language-${langLabel}`} />
        </pre>
      </div>
    </div>
  )
}
