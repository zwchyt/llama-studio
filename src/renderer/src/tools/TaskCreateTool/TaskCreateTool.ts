import type { ToolDefinition } from '../../utils/tools'
import { TASK_CREATE_TOOL_NAME } from './constants'
import type { TaskCreateInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_CREATE_TOOL_NAME,
  description: 'Create a new task in the task list for the current session. Returns the new task id. Tasks start as pending. Use for multi-step or complex work. Fields: subject (required), description, activeForm.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'A brief, actionable title (imperative form).' },
      description: { type: 'string', description: 'What needs to be done, with context.' },
      activeForm: { type: 'string', description: 'Optional present-continuous form shown while in_progress.' }
    },
    required: ['subject']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话，无法创建任务。'
  const { subject, description, activeForm } = args as unknown as TaskCreateInput
  const res = await window.api.agentTaskCreate(sessionId, { subject, description, activeForm })
  if (!res.success) return `Error: ${res.error}`
  const t = res.task!
  return `已创建任务 #${t.id}：\n- 主题：${t.subject}\n- 状态：${t.status}${t.description ? '\n- 描述：' + t.description : ''}`
}
