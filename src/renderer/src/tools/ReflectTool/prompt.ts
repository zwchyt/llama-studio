export function getReflectPrompt(): string {
  return `# Reflect 工具
多步任务中主动暂停做一次结构化自省（无副作用，不读写文件，原样回执）。
- 仅用于：≥3 步任务中遇阻/卡壳/连续失败需重新规划，或阶段切换（如"排查"→"修复"）确认方向。
- 禁止每轮调用、禁止常规进度汇报，不代替 TodoWrite 的状态维护。
- 字段：assessment（必填，现状判断）、blockers（可选，阻碍）、next_steps（必填，下一步）；反思后立即据 next_steps 执行。`
}
