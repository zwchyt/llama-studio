export function getViewImagePrompt(): string {
  return `# 查看图片工具
把工作区里的一张图片读进上下文，模型可以直接看到画面内容：
- 用途：看设计稿、看已有截图、核对图片/图表/SVG 的导出结果、读带文字说明的图片。
- 用户在本轮消息里直接附加 / 粘贴 / 拖入的图片已经内联可见，直接看即可，不要再用本工具去读它。
- 只读工作区磁盘上的图片（png / jpg / jpeg / webp / gif / bmp）；工作区外的路径会直接失败。
- 看「HTML 页面渲染出来的效果」请用 browser_screenshot，不要用本工具。
- 只传路径，不要把图片内容转成 base64 塞进参数。`
}
