export function getFileDeletePrompt(): string {
  return `# Delete 工具使用说明

删除文件或目录。这是**唯一**用于删除的工具——禁止用 Bash 的 del/rmdir/rm 或 Write 写删除脚本。

## 使用场景
- 删除文件：只需提供 \`path\`
- 删除空目录：只需提供 \`path\`（默认 recursive=false）
- 删除非空目录：\`path\` + \`recursive: true\`

## 核心规则（必须遵守）
1. ⚠️ **删除前必须 Read 确认路径正确**——误删无法恢复
2. **不要用其他工具替代**：禁止用 Bash 的 \`del\`/\`rmdir\`/\`rm\`，禁止用 Write 写 Python 删脚本
3. **路径安全校验**：系统会自动检查路径是否在项目目录范围内，越界删除会被拒绝
4. **路径**：使用绝对路径，正斜杠 \`/\` 或反斜杠 \`\\\\\` 均可

## 最佳实践
- 删除前先用 Read 或 Bash dir 确认目标存在
- 不确认是否文件还是目录直接传 \`path\` 即可，工具会自动判断`
}