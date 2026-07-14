import type { ToolDefinition } from '../../utils/tools'
import { GLOB_TOOL_NAME } from './constants'
import type { GlobInput } from './types'
import { getWorkspaceRoot } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: GLOB_TOOL_NAME,
  description: 'Find files (not directories) by name using glob patterns (e.g. "*.ts", "src/**/*.tsx"). Returns absolute paths. Does NOT match directories. Avoid bare "*" or "**" patterns. Use Bash "dir /b" for directory listing.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "*.ts", "src/**/*.tsx").' },
      path: { type: 'string', description: 'Directory to search in. Omit to use the project directory.' }
    },
    required: ['pattern']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { pattern, path } = args as unknown as GlobInput
  const root = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRoot()
  if (!root) return 'Error: 未设置搜索目录（请先在项目中创建或选择目录）'
  const res = await window.api.glob({ pattern, path: root })
  if (!res.success) return `Error: ${res.error}`
  const files = res.filenames ?? []
  if (files.length === 0) return 'No files found.'
  const truncated = res.truncated ? '\n(结果已截断，请使用更具体的 pattern)' : ''
  return `Found ${files.length} file(s):\n${files.join('\n')}${truncated}`
}
