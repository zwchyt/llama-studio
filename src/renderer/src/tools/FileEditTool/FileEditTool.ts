import type { ToolDefinition } from '../../utils/tools'
import { FILE_EDIT_TOOL_NAME } from './constants'
import type { FileEditInput } from './types'
import { invalidateReadCache } from '../FileReadTool/FileReadTool'

// ③ 生成紧凑的变更摘要（± 行 diff）：去掉 old/new 的公共前后缀行，只展示真正变化的
// 中间片段，并在新文件中定位起始行号。使模型无需重新 Read 即可确认改对了什么、改在哪里，
// 比重读全文更省 token（对本地小上下文尤其友好）。
function buildEditDiff(oldStr: string, newStr: string, fullContent?: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length - 1
  let endNew = newLines.length - 1
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) { endOld--; endNew-- }
  const removed = oldLines.slice(start, endOld + 1)
  const added = newLines.slice(start, endNew + 1)
  const CAP = 12
  const clip = (arr: string[], sign: string): string[] => {
    const shown = arr.slice(0, CAP).map(l => `${sign} ${l}`)
    if (arr.length > CAP) shown.push(`${sign} …（另有 ${arr.length - CAP} 行）`)
    return shown
  }
  const body: string[] = []
  if (removed.length) body.push(...clip(removed, '-'))
  if (added.length) body.push(...clip(added, '+'))
  if (!body.length) return ''
  let locNote = ''
  if (typeof fullContent === 'string') {
    const idx = fullContent.indexOf(newStr)
    if (idx >= 0) locNote = `（起始第 ${fullContent.slice(0, idx).split('\n').length} 行）`
  }
  return `\n变更摘要${locNote}：\n${body.join('\n')}`
}

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_EDIT_TOOL_NAME,
  description: 'Edit a file by replacing text. Requires exact old_string match (quote-normalized). Use replace_all for bulk. Always Read the file first to get fresh hashline anchors, then use old_string matching the line content. Returns error if no match found. Path is resolved relative to the project directory.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      old_string: { type: 'string', description: 'The exact content to replace (来自 Read 的 hashline 中 | 后面的部分，不含行号和哈希前缀)。' },
      new_string: { type: 'string', description: 'The replacement string.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string when true (default false).' },
      hashline: { type: 'string', description: '可选的 hashline 锚点（如 "42 abc1234"），用于交叉验证 old_string 定位的行是否正确。Read 时每行格式为 "行号 哈希|内容"，此参数填 "行号 哈希" 部分。' }
    },
    required: ['file_path', 'old_string', 'new_string']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, old_string, new_string, replace_all } = args as unknown as FileEditInput & { replace_all?: boolean }
  const res = await window.api.editFile(file_path, old_string, new_string, replace_all)
  if (res.success) {
    invalidateReadCache(file_path)
    // 轻量回读校验：editFile 成功时已返回完整新内容，直接校验 new_string 是否已写入；
    // 缺失时回退到一次 readFile。仅追加提示，不改变成功语义。
    let note = ''
    const checkIncludes = (full: string) => full.includes(new_string)
      ? '（已回读校验：new_string 已写入）'
      : '（提醒：回读未发现 new_string，请重新 Read 确认）'
    if (typeof res.content === 'string') {
      note = checkIncludes(res.content)
    } else {
      try {
        const rb = await window.api.readFile(file_path, { raw: true })
        if (rb.success && typeof rb.content === 'string' && !rb.truncated) note = checkIncludes(rb.content)
      } catch { /* 回读失败则跳过校验，不影响主结果 */ }
    }
    const bulk = replace_all ? '（replace_all：所有匹配处均已替换）' : ''
    const diff = buildEditDiff(String(old_string ?? ''), String(new_string ?? ''), typeof res.content === 'string' ? res.content : undefined)
    return `✅ 文件编辑成功。${note}${bulk}${diff}`
  }
  const err = res.error || ''
  if (/not found|no match|unable to locate|未找到|找不到/.test(err)) return `❌ 编辑失败：未找到匹配的 old_string，请对照 Read 返回的 hashline 重新检查。\n${err}`
  if (/ENOENT|no such|does not exist/.test(err)) return `❌ 编辑失败：文件不存在\n${err}`
  return `❌ 编辑失败：${err}`
}
