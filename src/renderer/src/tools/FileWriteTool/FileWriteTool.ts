import type { ToolDefinition } from '../../utils/tools'
import { FILE_WRITE_TOOL_NAME } from './constants'
import type { FileWriteInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_WRITE_TOOL_NAME,
  description: 'Write content to a file (overwrites existing!). Creates parent directories automatically. For partial edits use Edit, not Write. For file/directory deletion use Delete, not Write. Always uses absolute paths.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to write.' },
      content: { type: 'string', description: 'The content to write to the file.' }
    },
    required: ['file_path', 'content']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, content } = args as unknown as FileWriteInput
  const res = await window.api.writeFile(file_path, content)
  if (res.success) return 'File written successfully.'
  return `Error: ${res.error}`
}
