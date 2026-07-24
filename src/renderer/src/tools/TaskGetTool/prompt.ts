export function getTaskGetPrompt(): string {
  return `# TaskGet 工具
按 id 获取单个任务完整信息（主题/描述/状态/优先级/notes/时间）。
- 开始或更新任务前先读其完整描述与最新状态，避免覆盖。\`taskId\`（必填，来自 TodoWrite 返回值或 TaskList）。`
}
