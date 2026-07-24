export function getFileDeletePrompt(): string {
  return `# Delete 工具
删除文件/目录的**唯一**工具（禁止用 Bash 的 del/rmdir/rm 或 Write 写删除脚本）。
- 文件/空目录：传 \`path\`；非空目录：\`path\` + \`recursive: true\`。
- ⚠️ 删除前先 Read 确认路径（误删不可恢复）；越界（项目外）删除会被拒绝；用绝对路径。`
}
