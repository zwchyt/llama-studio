export function getBrowserShowPrompt(): string {
  return `# 网页预览工具
在应用内浏览器预览区打开页面：
- 展示网页：先 Write 出 .html 文件，再用 type:"file" + 同一个路径打开（不要把源码再传一遍）。
- 没落盘的一小段 HTML：type="html"。
- 用户明确要打开某个网站、或明确给出网址：type="url"（仅 http/https）。
- 只是显示页面，不能点击、填写、读取网页数据或操作网页。`
}
