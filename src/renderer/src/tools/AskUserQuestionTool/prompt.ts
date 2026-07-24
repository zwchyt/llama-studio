export function getAskUserQuestionPrompt(): string {
  return `# AskUserQuestion 工具
向用户提 1-3 个选择题，收集偏好/决策、澄清需求、消除歧义。
- 每题自动附带"其他"选项；把推荐项放第一位并在 label 后加 "(Recommended)"；支持多选（multi_select: true）。
- label 简短（几个词），description 说明选择含义/后果；preview 可放代码片段/原型供对比。问题要具体明确。`
}
