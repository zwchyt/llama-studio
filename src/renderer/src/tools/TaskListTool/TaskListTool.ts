import type { ToolDefinition } from '../../utils/tools'
import { TASK_LIST_TOOL_NAME } from './constants'
import type { TaskListInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_LIST_TOOL_NAME,
  description: 'List all tasks in the current session with their id, subject, and status (pending|in_progress|completed|cancelled). Use to check progress and find the next task.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Optional filter by status.' }
    }
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话。'
  const { status } = args as unknown as TaskListInput
  const res = await window.api.agentTaskList(sessionId)
  if (!res.success) return `Error: 读取任务失败`
  let tasks = res.tasks ?? []
  if (status) tasks = tasks.filter(t => t.status === status)
  if (tasks.length === 0) return '任务清单为空。'
  const lines = tasks.map(t => `#${t.id} [${t.status}] ${t.subject}`)
  const summary = `共 ${tasks.length} 个任务：`
  return summary + '\n' + lines.join('\n')
}
