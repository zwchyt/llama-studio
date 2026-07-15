export function getTaskStopPrompt(): string {
  return `# TaskStop 工具使用说明

停止 / 取消一个任务（将其标记为 cancelled）。

## 适用场景
- 任务不再需要或已被其它方式完成
- 任务被取代、或发现方向错误需要放弃
- 需要中止进行中的任务

## 字段
- taskId（必填）: 要停止的任务 id

## 说明
本地单 Agent 环境没有后台执行引擎，因此“停止”等价于把任务标记为 cancelled（放弃），而非终止进程。若想彻底删除，请改用 TaskUpdate 并将 status 设为 deleted。`
}
