export function getFileWritePrompt(): string {
  return `# Write 工具
仅用于**新建文件**，自动创建父目录，写 UTF-8，绝对路径。
- **已存在文件禁止 Write 重写**（会被系统拒绝）：改文件一律用 **Edit**（先 Read 取 hashline 再改片段，勿整文件重写）。
- 删文件用 **Delete**，不要用 Write 写删除脚本；确需整体重建：先 Delete 再 Write。
- 优先用本工具而非 echo/重定向；每次只写一个文件。`
}
