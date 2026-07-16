import type { TodoUpdate } from '../../../../shared/types'

export interface TodoWriteInput {
  merge?: boolean
  todos: TodoUpdate[]
}
