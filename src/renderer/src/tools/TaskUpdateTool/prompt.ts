export function getTaskUpdatePrompt(): string {
  return `# TaskUpdate 工具使用说明

更新任务清单中的任务。

## 适用场景
- 开始某项任务前：status → in_progress
- 完成某项任务后：status → completed（务必真正完成再标记）
- 任务不再需要：status → deleted（永久移除）
- 放弃 / 中止某项任务：status → cancelled
- 需求变化：更新 subject / description / activeForm
- 记录执行结果或产出：写入 notes（供 TaskOutput 读取）

## 可更新字段
- status: pending → in_progress → completed；deleted 删除；cancelled 取消
- subject / description / activeForm / notes

## 最佳实践
- 只有真正完成时再标记 completed（测试未过、实现不全、仍有报错时不要标记）
- 更新前先 TaskGet 读取最新状态，避免覆盖
- 完成后用 TaskList 找下一个任务`
}
