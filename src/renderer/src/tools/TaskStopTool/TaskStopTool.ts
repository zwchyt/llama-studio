import type { ToolDefinition } from '../../utils/tools'
import { TASK_STOP_TOOL_NAME } from './constants'
import type { TaskStopInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_STOP_TOOL_NAME,
  description: 'Stop / cancel a task by id (marks it cancelled). Use when a task is no longer needed, was superseded, or you abandon it. In the local single-agent environment this marks the task cancelled rather than terminating a process.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The id of the task to stop.' }
    },
    required: ['taskId']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话。'
  const { taskId } = args as unknown as TaskStopInput
  const res = await window.api.agentTaskStop(sessionId, taskId)
  if (!res.success) return `Error: ${res.error ?? '停止失败'}`
  const t = res.task!
  return `已取消任务 #${t.id}（${t.subject}），状态：${t.status}。`
}
