export function getWebSearchPrompt(): string {
  return `# 网络搜索工具
搜索网页，返回标题、URL 与摘要列表（最多 5 条）。
- 用于需要实时/外部信息的问题（新闻、文档、最新资料等）。
- 获取具体页面内容请用 fetch_webpage 工具。`
}
