import type { ToolDefinition } from '../../utils/tools'
import { GLOB_TOOL_NAME } from './constants'
import type { GlobInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: GLOB_TOOL_NAME,
  description: 'Find files (not directories) by name using glob patterns (e.g. "*.ts", "src/**/*.tsx"). Returns absolute paths. Does NOT match directories. Avoid bare "*" or "**" patterns. For directory listing / project structure overview, use the ListDir tool, NOT Bash.',
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
  const root = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRootForSession()
  if (!root) return '❌ 未设置搜索目录（请先在项目中创建或选择目录）'
  const res = await window.api.glob({ pattern, path: root })
  if (!res.success) return `❌ 搜索失败：${res.error}`
  const files = res.filenames ?? []
  if (files.length === 0) return '未找到匹配的文件。\n（注意：搜索结果已自动排除 .gitignore 中的文件、node_modules 及隐藏文件）'
  const note = '\n（注意：搜索结果已自动排除 .gitignore 中的文件与隐藏文件）'
  const truncated = res.truncated ? '\n(结果已截断，请使用更具体的 pattern)' : ''
  return `找到 ${files.length} 个文件：\n${files.join('\n')}${truncated}${note}`
}
