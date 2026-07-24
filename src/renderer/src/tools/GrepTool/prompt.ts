export function getGrepPrompt(): string {
  return `# Grep 工具
按正则搜文件内容，返回绝对路径，默认搜项目根。搜内容必须用本工具（禁止 Bash/findstr）。
- 正则为 JS 风格（注意转义，如 \`\\d\`、\`\\.\`）；默认区分大小写，\`-i: true\` 忽略。
- \`output_mode\`：\`files_with_matches\`（默认，只列文件）/ \`content\`（带行号）/ \`count\`（计数）。
- 过滤：\`glob\`（如 \`"*.ts"\`）或 \`type\`（如 \`"ts"\`/\`"py"\`）；范围大时务必加，避免超时（20s）/截断（默认 250 行，\`head_limit\` 调整）。
- 常用：查定义 \`class X\`/\`function X\`/\`def X\`，查引用 \`X(\`；先 files_with_matches 再针对性 Read。`
}
