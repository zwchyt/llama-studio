import type { ToolDefinition } from '../../utils/tools'
import { FILE_DELETE_TOOL_NAME } from './constants'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_DELETE_TOOL_NAME,
  description: 'Delete a file or directory. This is the ONLY tool for deletion — do NOT use Write/Bash for deletion. For files just supply the path; for directories set recursive: true if non-empty. The path is validated against the project root for safety.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file or directory to delete.' },
      recursive: { type: 'boolean', description: 'Set to true when deleting a non-empty directory (default false, only empty dirs allowed without this).' }
    },
    required: ['path']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path || '')
  const recursive = !!args.recursive
  if (!path) return 'Error: path is required.'
  // 让主进程自动判断是文件还是目录，并执行相应删除
  const res = await window.api.deletePath(path, recursive)
  if (res.success) return res.message || 'Deleted successfully.'
  return `Error: ${res.error}`
}
