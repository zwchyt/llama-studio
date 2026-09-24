// ── 浏览器预览与截图（Agent 工具 browser_show / browser_screenshot）共享类型 ──
// main / preload / renderer 三侧共用，避免各处重复声明字面量类型。

/** 显示 HTML / 打开网址 / 打开项目里已写好的 HTML 文件 */
export type BrowserShowInput =
  | { type: 'html'; html: string; title?: string }
  | { type: 'url'; url: string; title?: string }
  | { type: 'file'; path: string; title?: string }

/** browser_show 返回（也是渲染进程导航回执的形状） */
export type BrowserShowResult = {
  ok: boolean
  type: 'html' | 'url' | 'file'
  title: string
  url?: string
  error?: string
}

/** browser_screenshot 返回：只含元数据与图片引用，不含 base64 */
export type BrowserScreenshotResult = {
  ok: boolean
  /** chatimg://<文件名> 引用，渲染端用 read-chat-image 读取显示 */
  imageId?: string
  mimeType?: 'image/png'
  width?: number
  height?: number
  fullPage?: boolean
  error?: string
}

/** 截图请求参数。withImage = 模型支持图像输入时附带 PNG，用于回灌上下文 */
export type BrowserCaptureOptions = { fullPage: boolean; withImage?: boolean }

/** 主进程截图结果：imageBase64 只在进程间使用，不会进工具文本结果 */
export type BrowserCaptureResult = BrowserScreenshotResult & { imageBase64?: string }

/** main → renderer 的导航指令：url 已由主进程校验/落盘生成 */
export type BrowserNavigateCommand = {
  kind: 'html' | 'url' | 'file'
  url: string
  title?: string
}
