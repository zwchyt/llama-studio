import type { ToolDefinition } from '../../utils/tools'
import { TASK_OUTPUT_TOOL_NAME } from './constants'
import type { TaskOutputInput } from './types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TASK_OUTPUT_TOOL_NAME,
  description: 'Get a task output / result notes (the notes you recorded via TodoWrite notes field) and its current status. In the local single-agent environment this returns the task notes rather than a live process stream.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The id of the task to get output for.' }
    },
    required: ['taskId']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话。'
  const { taskId } = args as unknown as TaskOutputInput
  const res = await window.api.agentTaskOutput(sessionId, taskId)
  if (!res.success) return `Error: ${res.error ?? '读取失败'}`
  const t = res.task
  return [
    `任务 #${taskId} 状态：${t?.status ?? '未知'}`,
    `结果备注：`,
    res.output || '（暂无结果备注，可用 TodoWrite 的 notes 字段写入）'
  ].join('\n')
}
