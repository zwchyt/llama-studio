export interface TaskUpdateInput {
  taskId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'deleted'
  subject?: string
  description?: string
  activeForm?: string
  notes?: string
}
