import type { ToolDefinition } from '../../utils/tools'
import { LIST_BACKGROUND_TASKS_TOOL_NAME } from './constants'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: LIST_BACKGROUND_TASKS_TOOL_NAME,
  description: 'List all background bash tasks (running and completed) started during this session.',
  parameters: {
    type: 'object',
    properties: {}
  }
}

export async function execute(): Promise<string> {
  const tasks = await window.api.listBackgroundTasks()
  if (tasks.length === 0) return 'No background tasks.'
  const lines = tasks.map(t => {
    const elapsed = Math.round((Date.now() - t.startTime) / 1000)
    return `  ${t.id} | ${t.status} | ${elapsed}s ago | PID: ${t.pid}${t.autoBackgrounded ? ' (auto-bg)' : ''} | ${t.command.slice(0, 80)}`
  })
  return `Background tasks (${tasks.length}):\n${lines.join('\n')}`
}
