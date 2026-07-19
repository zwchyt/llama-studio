import type { ToolDefinition } from '../../utils/tools'
import { FILE_EDIT_TOOL_NAME } from './constants'
import type { FileEditInput } from './types'
import { invalidateReadCache } from '../FileReadTool/FileReadTool'

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
  if (res.success) { invalidateReadCache(file_path); return '✅ 文件编辑成功。' }
  const err = res.error || ''
  if (/not found|no match|unable to locate/.test(err)) return `❌ 编辑失败：未找到匹配的 old_string，请对照 Read 返回的 hashline 重新检查。\n${err}`
  if (/ENOENT|no such|does not exist/.test(err)) return `❌ 编辑失败：文件不存在\n${err}`
  return `❌ 编辑失败：${err}`
}
