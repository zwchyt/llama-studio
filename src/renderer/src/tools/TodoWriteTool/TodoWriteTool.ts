import type { ToolDefinition } from '../../utils/tools'
import { TODO_WRITE_TOOL_NAME } from './constants'
import type { TodoItem } from '../../../../shared/types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TODO_WRITE_TOOL_NAME,
  description: 'Write or replace the entire todo list for the current coding session. Call this to plan multi-step work and track progress. Each call replaces the previous list, so always pass the full, up-to-date list. Items: content, status (pending|in_progress|completed), optional activeForm.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list (replaces the previous one).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'A brief, actionable description (imperative form).' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status of the item.' },
            activeForm: { type: 'string', description: 'Optional present-continuous form shown while in_progress.' }
          },
          required: ['content', 'status']
        }
      }
    },
    required: ['todos']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话，无法写入任务清单。'
  const todos = (args.todos as TodoItem[]) || []
  const res = await window.api.agentTodoWrite(sessionId, todos)
  if (!res.success) return `Error: ${res.error}`
  const lines = (res.tasks ?? []).map(t => `- [${t.status}] ${t.subject}`)
  return `任务清单已更新（${res.tasks?.length ?? 0} 项）：\n${lines.join('\n')}`
}
