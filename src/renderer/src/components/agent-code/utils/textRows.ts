// 长文本「行窗口」的共享纯函数：思考文本（ThinkTextContent）与工具结果（LinedPre）
// 共用同一套分行与可视范围计算，避免两处实现漂移。
//
// 关键设计：只记录原文偏移（start/end），不为每一行复制字符串——超长文本下
// split('\n') 会产生与行数同量的字符串对象，正是要避免的开销。

// 单行字符上限：无换行的巨大文本会被按此切成有界片段，防止一个超大文本节点
// 绕过行窗口（DOM 数量有界之外，还要保证单节点文本长度有界）。
export const TEXT_ROW_CHARS = 240

export type TextRow = { start: number; end: number }

// 切片是否劈开了 UTF-16 代理对（emoji 等补充平面字符）
function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

// 把文本切成展示行：优先在换行处断行，超长自然行按 TEXT_ROW_CHARS 软分段。
export function buildTextRows(text: string): TextRow[] {
  const rows: TextRow[] = []
  let start = 0
  while (start <= text.length) {
    let end = Math.min(text.length, start + TEXT_ROW_CHARS)
    const newline = text.slice(start, end).indexOf('\n')
    if (newline >= 0) end = start + newline
    else if (splitsSurrogate(text, end)) end--
    rows.push({ start, end })
    if (end === text.length) break
    start = text[end] === '\n' ? end + 1 : end
  }
  return rows
}

// 可视行范围（含 overscan 上下缓冲）。固定行高是前提：调用方以 nowrap 行渲染，
// 高度不随内容变化，因此首行索引可由 scrollTop 直接算出，无需逐行测量。
export function getTextRowWindow(count: number, scrollTop: number, height: number, rowHeight: number, overscan = 4) {
  const first = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(scrollTop / rowHeight)))
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + Math.ceil(height / rowHeight) + overscan),
  }
}
