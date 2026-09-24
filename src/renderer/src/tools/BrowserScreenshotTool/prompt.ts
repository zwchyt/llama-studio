export function getBrowserScreenshotPrompt(): string {
  return `# 页面截图工具
截取当前正在预览的页面，截图会作为图片出现在聊天里：
- 查看页面效果、核对 HTML 渲染结果时用。
- 默认只截当前可视区域；要整页长图传 fullPage:true。
- 当前没有预览页面时不要调用（先用 browser_show 打开页面，并保持浏览器面板可见）。`
}
