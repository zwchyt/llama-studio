import type { ToolDefinition } from '../../utils/tools'
import { REFLECT_TOOL_NAME } from './constants'
import type { ReflectInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: REFLECT_TOOL_NAME,
  description: 'Pause and self-reflect during a multi-step task: submit a structured assessment of current progress, blockers, and next steps. This tool has NO side effects (it does not read or modify files); it only records your reflection and echoes it back so you can recalibrate. Use sparingly — only when stuck, after repeated failures, or when switching phases; do NOT call it every turn or for routine progress updates.',
  parameters: {
    type: 'object',
    properties: {
      assessment: { type: 'string', description: '对当前进展/现状的判断：已完成什么、是否偏离目标。' },
      blockers: { type: 'string', description: '当前遇到的阻碍或不确定点（可选）。' },
      next_steps: { type: 'string', description: '据此得出的下一步具体计划。' }
    },
    required: ['assessment', 'next_steps']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { assessment, blockers, next_steps } = args as unknown as ReflectInput
  return [
    '已记录你的反思：',
    `- 现状：${assessment || '（未填写）'}`,
    `- 阻碍：${blockers && String(blockers).trim() ? blockers : '无'}`,
    `- 下一步：${next_steps || '（未填写）'}`,
    '请据此继续执行；若发现偏离目标，及时调整计划（可用 TodoWrite 更新任务）。'
  ].join('\n')
}
