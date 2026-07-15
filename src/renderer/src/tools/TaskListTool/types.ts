export interface TaskListInput {
  // 当前实现仅列出当前会话全部任务；保留扩展位以便后续支持过滤。
  status?: string
}
