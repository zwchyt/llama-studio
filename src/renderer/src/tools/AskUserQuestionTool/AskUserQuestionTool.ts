import type { ToolDefinition } from '../../utils/tools'
import { ASK_USER_QUESTION_TOOL_NAME } from './constants'
import type { AskUserQuestionInput } from './types'
import { askUserQuestionRegistry } from '../../utils/askUserQuestionRegistry'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: `Ask the user one or more multiple-choice questions.

- Every question automatically gets an "Other" choice where the user can type their own answer.
- Put your recommended option first and append "(Recommended)" to its label.`,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'The questions to ask, each with its own options.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask, phrased as a full question.' },
            options: {
              type: 'array',
              description: 'The choices for this question.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option text shown to the user. A few words at most.' },
                  description: { type: 'string', description: 'What picking this option means or implies.' },
                  preview: { type: 'string', description: 'Optional content shown while the option is focused — mockups, code snippets. Single-select only.' }
                },
                required: ['label', 'description']
              }
            },
            multi_select: { type: 'boolean', description: 'Let the user pick more than one option (default false).' }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const input = args as unknown as AskUserQuestionInput
  if (!input.questions || input.questions.length === 0) {
    return 'No questions provided. Continue with the task.'
  }

  // 同一调用内去重
  const seen = new Set<string>()
  for (const q of input.questions) {
    if (seen.has(q.question)) {
      return JSON.stringify({ error: `Duplicate question text: "${q.question}"` })
    }
    seen.add(q.question)
  }

  // 跨轮次内容去重：已问过的问题不再弹出面板，直接返回提示
  const alreadyAsked = input.questions.filter(q => askUserQuestionRegistry.wasAsked(q.question))
  if (alreadyAsked.length > 0) {
    const titles = alreadyAsked.map(q => `"${q.question}"`).join('、')
    return `问题 ${titles} 已在本次会话中问过，请不要重复提问。基于已有信息继续推进任务。`
  }

  // ask() 内部会记录问题文本，供后续去重
  const result = await askUserQuestionRegistry.ask(input.questions)
  return result
}
