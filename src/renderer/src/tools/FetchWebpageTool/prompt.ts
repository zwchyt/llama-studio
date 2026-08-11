export function getFetchWebpagePrompt(): string {
  return `# 抓取网页工具
抓取指定 URL 的网页正文（纯文本，截取前 8192 字符）。
- 配合 web_search 使用：先搜索得到 URL，再抓取正文。
- 仅支持 http/https，拒绝内网地址。`
}
