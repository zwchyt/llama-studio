export function getGlobPrompt(): string {
  return `# Glob 工具
按文件名模式（glob）查找**文件**（不匹配目录），返回绝对路径，默认搜项目根。
- 用于按名字/后缀定位文件（如 \`src/**/*.ts\`）或确认文件是否存在。
- ⚠️ 别用单独的 \`*\`/\`**\`（会海量列出并截断），用更具体的 pattern；结果可能截断，注意提示。
- 搜内容用 Grep；看内容用 Read；看目录结构用 ListDir/AnalyzeDir。`
}
