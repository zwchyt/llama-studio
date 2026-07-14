import type { ToolDefinition } from '../../utils/tools'
import { FILE_READ_TOOL_NAME } from './constants'
import type { FileReadInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_READ_TOOL_NAME,
  description: 'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns content with line numbers. Max 128KB; larger files are truncated. Prefer over Bash type/cat. Always uses absolute paths.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to read.' }
    },
    required: ['file_path']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path } = args as unknown as FileReadInput
  const res = await window.api.readFile(file_path)
  if (!res.success) return `Error: ${res.error}`
  const lines = res.lines ?? res.content!.split('\n').length
  return `File: ${file_path}\nLines: ${res.startLine ?? 1}-${lines} of ${res.totalLines ?? lines}\n\n${res.content}`
}
