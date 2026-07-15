import type { ToolDefinition } from '../../utils/tools'
import { TASK_UPDATE_TOOL_NAME } from './constants'
import type { TaskUpdateInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_UPDATE_TOOL_NAME,
  description: 'Update a task in the task list. Change status (pending->in_progress->completed, or deleted to remove, cancelled to abandon), subject, description, activeForm, or append notes (result/summary readable via TaskOutput). Always read latest state with TaskGet before updating.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The id of the task to update.' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled', 'deleted'], description: 'New status. deleted removes the task.' },
      subject: { type: 'string', description: 'New subject/title.' },
      description: { type: 'string', description: 'New description.' },
      activeForm: { type: 'string', description: 'New present-continuous form shown while in_progress.' },
      notes: { type: 'string', description: 'Result/summary notes; readable via TaskOutput.' }
    },
    required: ['taskId']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话。'
  const { taskId, status, subject, description, activeForm, notes } = args as unknown as TaskUpdateInput
  const updates: Record<string, unknown> = {}
  if (status !== undefined) updates.status = status
  if (subject !== undefined) updates.subject = subject
  if (description !== undefined) updates.description = description
  if (activeForm !== undefined) updates.activeForm = activeForm
  if (notes !== undefined) updates.notes = notes
  const res = await window.api.agentTaskUpdate(sessionId, taskId, updates)
  if (!res.success) return `Error: ${res.error ?? '更新失败'}`
  if (!res.task) return `任务 #${taskId} 已删除。`
  const t = res.task
  return `已更新任务 #${t.id}：\n- 主题：${t.subject}\n- 状态：${t.status}${t.notes ? '\n- 备注：' + t.notes : ''}`
}
