import type { ToolDefinition } from '../../utils/tools'
import { FILE_DELETE_TOOL_NAME } from './constants'
import { invalidateReadCache } from '../FileReadTool/FileReadTool'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_DELETE_TOOL_NAME,
  description: 'Delete a file or directory. This is the ONLY tool for deletion — do NOT use Write/Bash for deletion. For files just supply the path; for directories set recursive: true if non-empty. The path is resolved relative to the project directory and validated against it for safety.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to delete, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      recursive: { type: 'boolean', description: 'Set to true when deleting a non-empty directory (default false, only empty dirs allowed without this).' }
    },
    required: ['path']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path || '')
  const recursive = !!args.recursive
  if (!path) return '❌ 删除失败：缺少路径参数 path'
  // 让主进程自动判断是文件还是目录，并执行相应删除
  const res = await window.api.deletePath(path, recursive)
  if (res.success) { invalidateReadCache(path); return res.message || '✅ 删除成功。' }
  const err = res.error || ''
  if (/ENOENT|no such|does not exist/.test(err)) return `❌ 删除失败：路径不存在\n${err}`
  if (/EACCES|EPERM|permission/.test(err)) return `🔒 删除失败：权限不足\n${err}`
  if (/not empty|directory not empty/i.test(err)) return `📁 删除失败：目录非空，请设置 recursive: true 后再试\n${err}`
  return `❌ 删除失败：${err}`
}
