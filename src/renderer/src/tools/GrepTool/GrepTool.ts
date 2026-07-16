import type { ToolDefinition } from '../../utils/tools'
import { GREP_TOOL_NAME } from './constants'
import type { GrepInput } from './types'
import { getWorkspaceRoot } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: GREP_TOOL_NAME,
  description: 'Search file contents by regex. Supports content/files_with_matches/count output modes, glob filter, type filter (py/js/ts/rs/go/java/…), context lines, case-insensitive mode. Long lines are truncated at 1000 chars. 20s timeout returns partial results. Default search root = project directory. Returns absolute paths. Prefer over Bash findstr.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for in file contents.' },
      path: { type: 'string', description: 'File or directory to search in. Omit to use the project directory.' },
      glob: { type: 'string', description: 'Glob filter for files (e.g. "*.ts", "*.{ts,tsx}").' },
      type: { type: 'string', description: 'File type shortcut — sets glob automatically. Common types: py, js, ts, rs, rust, go, java, c, cpp, md, json, yaml, sh, html, css, sql.' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
      head_limit: { type: 'number', description: 'Max lines/entries to return (default 250, 0 = unlimited).' },
      '-i': { type: 'boolean', description: 'Case insensitive search.' },
      context: { type: 'number', description: 'Lines of context before/after each match (content mode).' },
      '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' }
    },
    required: ['pattern']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { pattern, path, glob, type, output_mode, head_limit, '-i': ci, context, '-n': lineNumbers } = args as unknown as GrepInput
  const root = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRoot()
  if (!root) return 'Error: 未设置搜索目录（请先在项目中创建或选择目录）'
  const res = await window.api.grep({
    pattern,
    path: root,
    glob,
    type,
    output_mode: output_mode ?? 'files_with_matches',
    head_limit: head_limit,
    '-i': ci,
    context,
    '-n': lineNumbers
  })
  if (!res.success) return `Error: ${res.error}`
  let result = res.content || 'No matches found.'
  if (res.timedOut) {
    result += '\n(搜索超时，结果不完整。请缩小搜索范围或使用更具体的参数)'
  }
  return result
}
