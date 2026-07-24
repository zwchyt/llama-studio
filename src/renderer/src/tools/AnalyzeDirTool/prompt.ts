import { ANALYZE_DIR_TOOL_NAME } from './constants'

export function getAnalyzeDirPrompt(): string {
  return `# ${ANALYZE_DIR_TOOL_NAME} 工具
一次性返回「目录树 + 入口文件 + 文件类型统计」，用于快速建立项目全貌。
- 用户要求"分析目录/项目"或需先建全局视图时使用；**只需调一次**即得完整概览，随后直接回答。
- 严禁改用 Bash dir/ls 逐子目录罗列，也别用 ListDir 的 recursive dump 整树；细节用 Grep/Glob 定位或 Read 具体文件。
- path 省略为项目根；maxDepth 默认 3（勿超 6）。`
}
