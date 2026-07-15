export function getTaskCreatePrompt(): string {
  return `# TaskCreate 工具使用说明

在当前会话的任务清单中创建一个结构化任务，返回新任务的 id。新任务默认状态为 pending。

## 适用场景
- 复杂多步任务需要拆分为多个子任务时
- 用户给出一组待办事项（编号 / 逗号分隔）时立即记录
- 接到新需求时，先把要求固化为任务

## 字段
- subject（必填）: 简短、可执行的标题（祈使句，如“修复登录鉴权 bug”）
- description（可选）: 需要完成的具体内容与上下文
- activeForm（可选）: 进行中时展示的现在分词形式（如“正在修复登录鉴权”）；省略则展示 subject

## 最佳实践
- 描述清晰具体，便于后续独立执行
- 创建后用 TaskUpdate 把任务标记为 in_progress 再开始
- 调用 TaskList 前先确认没有重复任务`
}
