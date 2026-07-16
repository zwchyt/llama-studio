import type { ToolDefinition } from '../../utils/tools'
import { TASK_GET_TOOL_NAME } from './constants'
import type { TaskGetInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_GET_TOOL_NAME,
  description: 'Get a single task by id, including its full subject, description, status, and notes. Use before starting or updating a task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The id of the task to retrieve.' }
    },
    required: ['taskId']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话。'
  const { taskId } = args as unknown as TaskGetInput
  const res = await window.api.agentTaskGet(sessionId, taskId)
  if (!res.success || !res.task) return `Error: ${res.error ?? '任务不存在'}`
  const t = res.task
  return [
    `任务 #${t.id}`,
    `- 主题：${t.subject}`,
    `- 状态：${t.status}`,
    `- 优先级：${t.priority || 'medium'}`,
    `- 描述：${t.description || '（无）'}`,
    t.activeForm ? `- 进行中展示：${t.activeForm}` : '',
    `- 备注：${t.notes || '（无）'}`
  ].filter(Boolean).join('\n')
}
