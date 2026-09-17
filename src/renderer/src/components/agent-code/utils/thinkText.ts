// 思考文本的显示层边界（预览截断）。分行与行窗口的通用实现已下沉到 utils/textRows.ts
// （工具结果 LinedPre 共用同一套），此处保留 re-export 以免调用方改变导入路径。
export { TEXT_ROW_CHARS, buildTextRows, getTextRowWindow } from './textRows'
export type { TextRow } from './textRows'

// 显示层边界，不改写模型原文。先按字符限幅，再拆行，避免预览扫描全部历史。
export const THINK_PREVIEW_CHARS = 4000
export const THINK_PREVIEW_LINES = 24

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export function getThinkPreview(text: string, tail = false): { text: string; truncated: boolean } {
  let start = tail ? Math.max(0, text.length - THINK_PREVIEW_CHARS) : 0
  let end = tail ? text.length : Math.min(text.length, THINK_PREVIEW_CHARS)
  if (splitsSurrogate(text, start)) start++
  if (splitsSurrogate(text, end)) end--
  const lines = text.slice(start, end).split('\n')
  const shown = tail ? lines.slice(-THINK_PREVIEW_LINES) : lines.slice(0, THINK_PREVIEW_LINES)
  return { text: shown.join('\n'), truncated: start > 0 || end < text.length || lines.length > THINK_PREVIEW_LINES }
}

