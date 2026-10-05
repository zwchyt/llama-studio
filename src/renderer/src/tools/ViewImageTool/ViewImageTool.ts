import type { ToolDefinition } from '../../utils/tools'
import { VIEW_IMAGE_TOOL_NAME } from './constants'
import type { ViewImageInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: VIEW_IMAGE_TOOL_NAME,
  description:
    '读取工作区里的一张图片文件（png / jpg / jpeg / webp / gif / bmp），图片会作为图片附件出现在聊天里，你可以直接看到画面内容。' +
    '只用于工作区磁盘上的图片；用户直接在消息里附加的图片已经内联可见，不要用本工具去读。' +
    '用于查看设计稿、已有截图、图片/图表/SVG 的导出结果。看 HTML 页面渲染效果请用 browser_screenshot；读文本文件请用 Read。',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '图片文件路径，相对工作区（如 "assets/logo.png"）或绝对路径。'
      }
    },
    required: ['file_path']
  }
}

// 真正把图片喂给模型的是主进程那份同名工具（它才能产出 images 块）；
// 这里的 execute 供渲染层这条通道使用，走同一份主进程实现。
export async function execute(args: Record<string, unknown>): Promise<string> {
  const input = args as unknown as ViewImageInput
  const res = await window.api.piAgent.readImage(String(input.file_path ?? ''))
  return JSON.stringify(res)
}
