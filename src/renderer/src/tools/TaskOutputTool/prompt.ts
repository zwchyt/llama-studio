export function getTaskOutputPrompt(): string {
  return `# TaskOutput 工具使用说明

获取某个任务的输出 / 结果备注（notes）以及当前状态。

## 适用场景
- 任务完成后，读取你通过 TaskUpdate 写入的 notes（结果摘要 / 产出）
- 向用户汇报某任务的最终成果
- 确认任务当前进展

## 字段
- taskId（必填）: 任务 id

## 说明
本地单 Agent 环境没有后台实时输出流，因此本工具返回的是任务记录的 notes 字段（你在 TaskUpdate 中写入的结果）与当前状态。若 notes 为空，说明尚未记录结果。`
}
