export function getBingSearchPrompt(): string {
  return `# 必应网络搜索工具（国内版）
搜索网页，返回标题、URL 与摘要列表（最多 5 条）。基于 cn.bing.com，国内可直接访问。
- 用于需要实时/外部信息的问题（中文资料、国内新闻、文档、最新资料等）。
- 获取具体页面内容请用 fetch_webpage 工具。`
}
