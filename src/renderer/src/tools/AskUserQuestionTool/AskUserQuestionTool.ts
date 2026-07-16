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

  const seen = new Set<string>()
  for (const q of input.questions) {
    if (seen.has(q.question)) {
      return JSON.stringify({ error: `Duplicate question text: "${q.question}"` })
    }
    seen.add(q.question)
  }

  const result = await askUserQuestionRegistry.ask(input.questions)
  return result
}
