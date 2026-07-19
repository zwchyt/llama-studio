import { ANALYZE_DIR_TOOL_NAME } from './constants'

export function getAnalyzeDirPrompt(): string {
  return `# ${ANALYZE_DIR_TOOL_NAME} 工具使用说明

一次性分析目录结构与功能，返回「目录树 + 入口文件 + 文件类型统计」，用于快速建立项目全貌。

## 使用场景
- 用户要求「分析目录 / 分析项目 / 了解这个项目是做什么的」
- 需要建立全局视图再决定下一步操作

## 输出内容
- 关键入口/约定文件（README、AGENTS.md、main.*、package.json、config.* 等）
- 缩进目录树（含每目录文件数，超大目录自动折叠）
- 文件类型统计（按扩展名分桶计数）

## 重要约束
- **只需调用一次即可得到完整概览**，随后直接回答用户。
- **严禁**改用 Bash \`dir\` / \`ls\` 逐子目录罗列（每个文件夹一条命令是错误的枚举行为）。
- **严禁**用 ListDir 的 \`recursive\` 参数一次性 dump 整棵树（会把超多文件灌入上下文）。
- 若需某部分细节，用 Grep/Glob 按关键词定位，或对具体文件 Read，不要重复遍历目录。
- path 省略时分析项目根目录；maxDepth 默认 3，可酌情调大但勿超过 6。`
}
