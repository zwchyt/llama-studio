import type { ToolDefinition } from '../../utils/tools'
import { FILE_EDIT_TOOL_NAME } from './constants'
import type { FileEditInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_EDIT_TOOL_NAME,
  description: 'Edit a file by replacing text. Requires exact old_string match (quote-normalized). Use replace_all for bulk. Always Read the file first to ensure old_string is unique. Returns error if no match found. Path is resolved relative to the project directory, so relative paths like "subdir/file.py" work (absolute paths also work).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      old_string: { type: 'string', description: 'The string to be replaced (quote-normalized matching).' },
      new_string: { type: 'string', description: 'The replacement string.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string when true (default false).' }
    },
    required: ['file_path', 'old_string', 'new_string']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, old_string, new_string, replace_all } = args as unknown as FileEditInput & { replace_all?: boolean }
  const res = await window.api.editFile(file_path, old_string, new_string, replace_all)
  if (res.success) return 'File edited successfully.'
  return `Error: ${res.error}`
}
