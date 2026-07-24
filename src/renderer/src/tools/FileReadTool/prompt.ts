export function getFileReadPrompt(): string {
  return `# Read 工具
读取文件，每行返回 **Hashline 锚点**：\`行号 7位哈希|行内容\`（哈希由工具生成，禁止编造/篡改，用于 Edit 定位）。
- 查看文件内容一律用 Read（禁止用 Bash 的 type/cat）；Edit 前必须先 Read 取最新锚点（行变则哈希变，勿用旧锚点）。
- 参数：\`offset\`（1 起，负数从末尾，如 -50 读最后 50 行）、\`limit\`（最大行数）；约 25000 token 上限，超限改用 Grep。
- 自动识别 UTF-8/UTF-16；用绝对路径（\`/\` 或 \`\\\\\` 均可）。不确定路径先用 Glob，大文件分片读或用 Grep 定位。`
}
