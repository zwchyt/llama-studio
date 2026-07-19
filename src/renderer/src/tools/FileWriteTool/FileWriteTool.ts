import type { ToolDefinition } from '../../utils/tools'
import { FILE_WRITE_TOOL_NAME } from './constants'
import type { FileWriteInput } from './types'
import { invalidateReadCache } from '../FileReadTool/FileReadTool'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_WRITE_TOOL_NAME,
  description: 'Write content to a file (overwrites existing!). Creates parent directories automatically. For partial edits use Edit, not Write. For file/directory deletion use Delete, not Write. Path is resolved relative to the project directory, so relative paths like "subdir/file.py" work (absolute paths also work).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      content: { type: 'string', description: 'The content to write to the file.' }
    },
    required: ['file_path', 'content']
  }
}

/** 格式化写入/编辑返回的错误（参考 grok-build 的结构化错误分类） */
function classifyFileError(err: string): string {
  if (/ENOENT|no such|does not exist/.test(err)) return `❌ 路径不存在：${err}`
  if (/EACCES|EPERM|permission|denied/.test(err)) return `🔒 权限不足：${err}`
  if (/EISDIR/i.test(err)) return `📁 路径是目录，无法写入`
  if (/EEXIST|already exists/.test(err)) return `⚠️ 文件已存在：${err}`
  if (/IsADirectory/i.test(err)) return `📁 路径是目录，无法写入`
  return `❌ 写入失败：${err}`
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, content } = args as unknown as FileWriteInput
  const res = await window.api.writeFile(file_path, content)
  if (res.success) { invalidateReadCache(file_path); return '✅ 文件写入成功。' }
  return classifyFileError(res.error || '')
}
