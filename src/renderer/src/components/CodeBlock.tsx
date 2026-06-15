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
}

export default function CodeBlock({ language, value }: CodeBlockProps) {
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

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{langLabel}</span>
        <button className="chat-code-copy" onClick={handleCopy} title="复制代码">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="chat-code-pre">
        <code ref={codeRef} className={`hljs language-${langLabel}`} />
      </pre>
    </div>
  )
}
