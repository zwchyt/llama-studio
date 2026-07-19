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
  if (!task_id) return '❌ 缺少参数：task_id'
  const res = await window.api.getBackgroundTask(task_id)
  if (!res.success) return `❌ 查询失败：${res.error}`
  if (!res.status) return '❌ 任务不存在'
  const statusEmoji = res.status === 'running' ? '🔄' : res.status === 'completed' ? '✅' : res.status === 'killed' ? '🛑' : '⏳'
  let output = `${statusEmoji} 状态：${res.status}\n`
  if (res.stdout) output += `\n${res.stdout}`
  if (res.stderr) {
    if (res.stdout) output += '\n'
    output += `\nstderr:\n${res.stderr}`
  }
  output += `\n\n退出码：${res.code !== null && res.code !== undefined ? res.code : '(运行中)'}`
  if (res.truncated) {
    output += `\n(输出已被截断：共 ${res.totalBytes ?? '?'} 字节)`
  }
  return output
}
