import type { ToolDefinition } from '../../utils/tools'
import { TODO_WRITE_TOOL_NAME } from './constants'
import type { TodoUpdate } from '../../../../shared/types'
import { getAgentSessionId } from '../agentSession'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: TODO_WRITE_TOOL_NAME,
  description: `Create and manage a structured task list. The user sees this list live — it is your primary way to show progress.

Use for any task with 3+ steps. Skip for trivial single-step work.

When merge=true (default), you can send partial updates — include only the items you need to add or change. Each item uses a stable 'id' for identification. To flip status without changing content, send just {id, status}. For new items, if you omit content the id will be used as a fallback. You can also record result notes via {id, notes: "..."} without touching the subject.

When merge=false, the provided list replaces the previous one entirely (use when initializing or restructuring).

Priority: high / medium / low (default medium). Status: pending / in_progress / completed / cancelled. Fields: id, content (subject), description, status, priority, activeForm, notes.

IMPORTANT: Do NOT mark tasks as 'completed' yourself — the system automatically flips the current 'in_progress' task to 'completed' and promotes the next 'pending' task to 'in_progress' after you successfully execute the corresponding tool. You only need to set a task to 'in_progress' to begin it (or leave it 'pending').

EXECUTION DISCIPLINE: After creating the plan, you MUST execute the tasks strictly IN ORDER, one by one — start from the first task, run the actual tool(s) it requires (Read/Write/Edit/Bash/...), and only move to the next task after the current one's work is genuinely done. NEVER skip a pending task, NEVER jump ahead, and DO NOT output a final answer until every task in the plan is completed. If a task turns out unnecessary, mark it cancelled explicitly rather than silently skipping it.`,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional overall title/summary for this plan (e.g. a one-line goal). Shown above the task list in the plan card, without a status badge. Omit if there is no meaningful plan title.'
      },
      merge: {
        type: 'boolean',
        description: 'Optional. When true (default), merge the provided todos into the existing list by id — send only the items you are changing. When false, replace the entire list.'
      },
      todos: {
        type: 'array',
        description: 'Array of todo items to write.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique stable identifier for the todo item. Omit to auto-generate.' },
            content: { type: 'string', description: 'The subject/content of the todo item. In merge mode, omit to keep the previous value.' },
            description: { type: 'string', description: 'Detailed context/description of the task.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Current status.' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Optional priority (default medium).' },
            activeForm: { type: 'string', description: 'Optional present-continuous form shown while in_progress.' },
            notes: { type: 'string', description: 'Result/summary notes. In merge mode, use to record outcomes without changing other fields.' }
          }
        }
      }
    },
    required: ['todos']
  }
}

// 计划总标题（plan 级别，区别于每条待办的 content）：仅用于 Agent Code 工作台内联卡片展示，
// 不随任务清单持久化。模型可在调用时附带，作为整批计划的概括标题显示在待办列表上方。
export interface TodoWriteArgs {
  title?: string
  merge?: boolean
  todos: TodoUpdate[]
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const sessionId = getAgentSessionId()
  if (!sessionId) return 'Error: 没有活动的 Agent 会话，无法写入任务清单。'

  const merge = args.merge !== false
  const todos = (args.todos as TodoUpdate[]) || []
  const res = await window.api.agentTodoWrite(sessionId, { merge, todos })
  if (!res.success) return `Error: ${res.error}`
  // 仅返回本次操作的计划项摘要，而非全量任务列表
  const summary = todos.map(t => {
    const status = t.status || 'pending'
    const content = t.content || t.id || '(unnamed)'
    return `- [${status}] ${content}${t.notes ? ` — ${t.notes}` : ''}`
  })
  return `计划更新（${todos.length} 项）：\n${summary.join('\n')}`
}
