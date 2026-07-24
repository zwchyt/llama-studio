import { LIST_DIR_TOOL_NAME } from './constants'

export function getListDirPrompt(): string {
  return `# ${LIST_DIR_TOOL_NAME} 工具
列出**单个目录单层**的文件/子目录（树状；目录以 \`/\` 结尾并示条目数；超 1000 项截断）。
- 用于确认/核对单个目录内容（如 Write/Read 前确认父目录）。path 省略为项目根，相对/绝对均可。
- 不递归；**别逐子目录调它来"分析项目"**——全局概览用 AnalyzeDir，找文件用 Glob。`
}
