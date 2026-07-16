import type { ToolDefinition } from '../../utils/tools'
import { GET_BACKGROUND_TASK_OUTPUT_TOOL_NAME } from './constants'
import type { GetBackgroundTaskOutputInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: GET_BACKGROUND_TASK_OUTPUT_TOOL_NAME,
  description: 'Retrieve the output of a background bash task started with is_background=true or auto-backgrounded on timeout.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID returned by the bash tool when the task was started in background.' }
    },
    required: ['task_id']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { task_id } = args as unknown as GetBackgroundTaskOutputInput
  if (!task_id) return 'Error: task_id is required'
  const res = await window.api.getBackgroundTask(task_id)
  if (!res.success) return `Error: ${res.error}`
  if (!res.status) return 'Error: task not found'
  let output = `Status: ${res.status}\n`
  if (res.stdout) output += `\n${res.stdout}`
  if (res.stderr) {
    if (res.stdout) output += '\n'
    output += `\nstderr:\n${res.stderr}`
  }
  output += `\n\nExit code: ${res.code ?? '(running)'}`
  if (res.truncated) {
    output += `\n(Output truncated: total ${res.totalBytes ?? '?'} bytes)`
  }
  return output
}
