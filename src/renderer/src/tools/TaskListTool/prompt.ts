export function getTaskListPrompt(): string {
  return `# TaskList 工具使用说明

列出当前会话任务清单中的全部任务（摘要形式：id、状态、优先级、主题）。

## 适用场景
- 查看还有哪些待办、整体进度
- 完成一项后，查找下一个可认领的任务
- 确认没有重复任务

## 输出
每条任务显示：
- id: 任务标识（配合 TaskGet / TodoWrite 使用）
- status: pending / in_progress / completed / cancelled
- priority: high / medium / low
- subject: 主题

## 提示
- 优先处理优先级高且 id 较小的任务`
}
