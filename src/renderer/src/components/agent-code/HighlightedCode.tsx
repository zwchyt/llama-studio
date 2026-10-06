// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：按行高亮的代码面（带行号）                                               ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 与 WindowedText 并列：思考文本 / 工具结果走 WindowedText（纯文本行窗口），
// 代码内容走本组件。样式复用既有的 .agent-tool-code*，行号走 CSS 计数器 + 内联偏移。
// 调用方负责「取哪一段」：流式期间传尾部窗口，完成态传全文。

import React, { useMemo } from 'react'
import { highlightLines } from './utils/highlightLines'

interface HighlightedCodeProps {
  code: string
  /** hljs 语言名（见 utils/highlightLines 的 langFromPath）；null 时退回纯文本 */
  language: string | null
  /** 首行行号。尾部窗口时 > 1，用 CSS 计数器偏移 */
  startLine?: number
  /** 流式态：关闭高亮缓存（每帧源码都是新的，缓存只会有害） */
  streaming?: boolean
  /** 附加到 .agent-tool-code 的类名（如 is-clipped / expanded / no-hash） */
  className?: string
}

export const HighlightedCode = React.memo(function HighlightedCode({
  code,
  language,
  startLine = 1,
  streaming = false,
  className,
}: HighlightedCodeProps) {
  // 高亮行与纯文本行必须行数一致，否则逐行配对会错位；不等就整体退回纯文本
  // （「错位的着色」比「不高亮」难看得多）。
  const { lines, htmlLines } = useMemo(() => {
    const ls = code.split('\n')
    const h = highlightLines(code, language, !streaming)
    return { lines: ls, htmlLines: h && h.length === ls.length ? h : null }
  }, [code, language, streaming])

  return (
    <div
      className={`agent-tool-code${className ? ` ${className}` : ''}`}
      // 行号计数器从 startLine 起：CSS 里 .agent-tool-code 声明了 counter-reset: ln
      style={startLine > 1 ? { counterReset: `ln ${startLine - 1}` } : undefined}
    >
      {lines.map((text, i) => (
        <div className="agent-tool-code-row" key={i}>
          <span className="agent-tool-code-num" />
          {htmlLines ? (
            <span className="agent-tool-code-text" dangerouslySetInnerHTML={{ __html: htmlLines[i] ?? '' }} />
          ) : (
            <span className="agent-tool-code-text">{text}</span>
          )}
        </div>
      ))}
    </div>
  )
})
