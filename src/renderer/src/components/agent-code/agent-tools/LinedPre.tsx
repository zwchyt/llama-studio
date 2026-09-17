// ── 工具结果 / 写入内容的行窗口渲染 ──
// 带行号的等宽文本块。阈值以下沿用原先的逐行 DOM（保留折行与行号视觉，行为不变）；
// 超过阈值的长内容改用通用行窗口（WindowedText），只挂载视口附近的行。
// 完整原文仍在 DOM 之外（复制/展开不依赖已挂载行）。
import React, { useMemo } from 'react'
import { buildTextRows } from '../utils/textRows'
import { WindowedText } from '../WindowedText'

/**
 * 超过该字符数即切换为行窗口。
 * 取值理由：约等于 120 行 × 160 字符的常见工具结果规模；阈值以下的 split('\n')
 * 与逐行 DOM 成本可接受（且保留折行）。用字符数而非行数判断，是为了不必对
 * 超大文本调用 split——那正是要避免的一次性开销。
 */
export const LINED_PRE_WINDOW_CHARS = 20000

/** 与 .agent-tool-lined-window 的 11px × line-height 1.5 对齐（固定行高是窗口化的前提） */
const LINED_PRE_ROW_HEIGHT = 17

export function LinedPre({ text, maxHeight }: { text: string; maxHeight?: number }) {
  const windowed = text.length > LINED_PRE_WINDOW_CHARS
  const rows = useMemo(() => (windowed ? buildTextRows(text) : null), [text, windowed])
  if (windowed && rows) {
    // 行窗口用固定行高 + nowrap：超长行改为横向滚动（折行会让行高不定，无法窗口化）
    return (
      <WindowedText
        text={text}
        lineNumbers
        rowHeight={LINED_PRE_ROW_HEIGHT}
        viewHeight={maxHeight ?? 360}
        className="agent-window agent-tool-lined-window"
        rowAttr="data-tool-row"
        ariaLabel={`工具结果（窗口渲染，共 ${rows.length} 展示行）`}
      />
    )
  }
  const lines = text.split('\n')
  return (
    <div className="agent-tool-lined" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((line, i) => (
        <div className="agent-tool-lined-row" key={i}>
          <span className="agent-tool-lined-num">{i + 1}</span>
          <span className="agent-tool-lined-code">{line === '' ? ' ' : line}</span>
        </div>
      ))}
    </div>
  )
}
