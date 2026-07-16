export function getTaskOutputPrompt(): string {
  return `# TaskOutput 工具使用说明

获取某个任务的输出 / 结果备注（notes）以及当前状态。

## 适用场景
- 任务完成后，读取你通过 TodoWrite 的 notes 字段记录的结果摘要
- 向用户汇报某任务的最终成果
- 确认任务当前进展

## 字段
- taskId（必填）: 任务 id

## 说明
本地单 Agent 环境没有后台实时输出流，因此本工具返回的是任务记录的 notes 字段与当前状态。若 notes 为空，说明尚未记录结果，可使用 TodoWrite 的 notes 字段写入。`
}
