export function getFileEditPrompt(): string {
  return `# Edit 工具
替换已有文件中的文本，自动检测/保持编码（新建文件用 Write）。
- **流程**：先 Read 取 hashline → \`old_string\` 取 \`|\` 后的整行内容（不含行号/哈希）→ 可选 \`hashline\`（\`行号 哈希\`）交叉验证 → 若匹配失败则重新 Read 取最新内容，不要猜。
- \`old_string\` 须唯一且精确匹配（含缩进/空格/换行），只匹配要改的几行，避免误替换他处。
- \`replace_all\`（默认 false）：为 true 时替换所有匹配（如重命名变量）。
- 优先用本工具而非 sed/awk；特殊字符（引号、\`\${}\`）直接复制 Read 原文即可，工具会归一化引号匹配。`
}
