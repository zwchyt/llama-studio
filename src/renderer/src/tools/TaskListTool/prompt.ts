export function getTaskListPrompt(): string {
  return `# TaskList 工具
列出本会话全部任务摘要（id/status/priority/subject）。
- 用于看整体进度、找下一个可认领任务、避免重复；优先处理优先级高且 id 较小的。`
}
