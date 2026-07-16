import type { ToolDefinition } from '../../utils/tools'
import { LIST_DIR_TOOL_NAME } from './constants'
import type { ListDirInput } from './types'
import { getWorkspaceRoot } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: LIST_DIR_TOOL_NAME,
  description: 'List files and directories in a given path. Returns a tree view with subdirectory file counts. Use this to explore the project structure before using other tools.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative or absolute directory path to list. Omit to list the project root.' }
    },
    required: []
  }
}

function formatFileCount(count: number): string {
  if (count === 0) return 'empty'
  return `${count} item${count === 1 ? '' : 's'}`
}

interface DirEntry {
  name: string
  isDir: boolean
  fileCount: number
}

function formatEntry(entry: DirEntry): string {
  if (entry.isDir) {
    let line = `  - ${entry.name}/`
    const summary = formatFileCount(entry.fileCount)
    if (summary !== 'empty') line += `  [${summary}]`
    return line
  }
  return `  - ${entry.name}`
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { path } = args as unknown as ListDirInput
  const targetPath = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRoot()
  if (!targetPath) return 'Error: 未设置路径（请先在项目中创建或选择目录）'

  const res = await window.api.listDir(targetPath)
  if (!res.success) return `Error: ${res.error}`
  const entries = res.entries ?? []
  if (entries.length === 0) return '(empty directory)'

  let output = ''
  if (path) {
    output += `- ${targetPath}/\n`
  }
  for (const e of entries) {
    output += formatEntry(e) + '\n'
  }
  if (res.truncated) {
    output += `\n(仅显示前 1000 项，共 ${res.total} 项)`
  }
  return output.trimEnd()
}
