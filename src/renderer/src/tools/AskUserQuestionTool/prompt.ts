export function getAskUserQuestionPrompt(): string {
  return `# AskUserQuestion 工具使用说明

向用户提出一个或多个选择题，收集用户的偏好和决策。

## 适用场景
- 需要用户做出选择或决定时
- 澄清需求、消除歧义
- 在设计决策上获取用户意见

## 使用规则
- 每个问题自动附带"其他"选项（用户可自由输入）
- 将你推荐的选项放在第一位，并在标签后追加 "(Recommended)"
- 支持单选和多选（multi_select: true）
- 选项的 label 应保持简短（几个词），description 说明选择含义
- preview 字段可用于展示代码片段、原型等供用户对比的内容

## 最佳实践
- 一次只问 1-3 个问题，避免信息过载
- 问题要具体明确，不要含糊
- 为每个选项提供有意义的 description，帮助用户理解选择后果`
}
