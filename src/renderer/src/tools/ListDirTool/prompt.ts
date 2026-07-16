import { LIST_DIR_TOOL_NAME } from './constants'

export function getListDirPrompt(): string {
  return `# ${LIST_DIR_TOOL_NAME} 工具使用说明

列出指定目录下的文件和子目录，返回树状视图。

## 使用场景
- 了解项目目录结构
- 在操作前确认文件/目录是否存在
- 浏览目录内容以确定下一步操作

## 输出格式
- 目录以 \`/\` 结尾，并显示其中的条目数
- 文件直接显示文件名
- 超过 1000 项时会被截断

## 注意事项
- path 为可选参数，省略时默认为项目根目录
- 支持相对路径和绝对路径
- 不会递归展开子目录内容
- 如需查找特定文件，优先使用 Glob 工具`
}
