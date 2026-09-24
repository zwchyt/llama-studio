import type { ToolDefinition } from '../../utils/tools'
import { BROWSER_SCREENSHOT_TOOL_NAME } from './constants'
import type { BrowserScreenshotInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BROWSER_SCREENSHOT_TOOL_NAME,
  description:
    '截取当前正在预览的页面，截图作为图片附件显示在聊天里。默认截当前可视区域；需要整页长图传 fullPage:true。' +
    '若当前没有预览页面，不要调用该工具。',
  parameters: {
    type: 'object',
    properties: {
      fullPage: { type: 'boolean', description: 'true = 截取完整可滚动页面；默认 false（仅当前可视区域）。' }
    }
  }
}

// 截图由主进程对 webview guest 执行（渲染层拿不到 capturePage），
// 返回值只有 chatimg:// 引用与尺寸，PNG 不进聊天 JSON、也不从这条路回传 base64。
export async function execute(args: Record<string, unknown>): Promise<string> {
  const input = args as unknown as BrowserScreenshotInput
  const res = await window.api.piAgent.browserCapture({ fullPage: input.fullPage === true })
  return JSON.stringify(res)
}
