export function getTaskGetPrompt(): string {
  return `# TaskGet 工具使用说明

按 id 获取单个任务的完整信息（主题、描述、状态、备注 notes、创建/更新时间）。

## 适用场景
- 开始某任务前，先读取其完整描述与上下文
- 需要确认任务当前状态、备注时
- 在更新任务前读取其最新内容

## 字段
- taskId（必填）: 任务 id（来自 TaskCreate 返回值或 TaskList）

## 提示
- 更新任务前建议先 TaskGet，避免覆盖他人/之前的修改`
}
