import type { ToolDefinition } from '../../utils/tools'
import { FILE_READ_TOOL_NAME } from './constants'
import type { FileReadInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_READ_TOOL_NAME,
  description: 'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns content with line numbers (every 10 lines to save tokens). Supports offset/limit for reading specific line ranges. Negative offset counts from end (e.g. offset=-20 reads last 20 lines). Token budget ~25000; larger content suggests using Grep. Prefer over Bash type/cat.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      offset: { type: 'number', description: 'Starting line number (1-indexed). Negative counts from end (e.g. -20 = last 20 lines). Default: 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default: all lines.' }
    },
    required: ['file_path']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, offset, limit } = args as unknown as FileReadInput
  const res = await window.api.readFile(file_path, { offset, limit })
  if (!res.success) {
    let msg = `Error: ${res.error}`
    if (res.errorType === 'FileTooLarge' && res.suggestedCommand) {
      msg += `\n\n建议使用 Grep 搜索：${res.suggestedCommand}`
    }
    return msg
  }
  const lines = res.lines ?? res.content!.split('\n').length
  const startLine = res.startLine ?? 1
  const totalLines = res.totalLines ?? lines
  return `File: ${file_path}\nLines: ${startLine}-${startLine + lines - 1} of ${totalLines}\n\n${res.content}`
}
