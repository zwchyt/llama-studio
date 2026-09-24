import type { ToolDefinition } from '../../utils/tools'
import { BROWSER_SHOW_TOOL_NAME } from './constants'
import type { BrowserShowInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BROWSER_SHOW_TOOL_NAME,
  description:
    '在应用内浏览器预览区打开一个页面：type="file" 打开工作区里已写好的 HTML 文件（刚 Write 完就用这个，不要把源码再传一遍）；' +
    'type="html" 打开一段内联 HTML；type="url" 打开 http/https 网址。' +
    '此工具只显示页面，不能点击、填写、读取网页内容或执行网页操作；始终复用同一个预览区，不会开新标签页。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['file', 'html', 'url'], description: 'file = 工作区里的 HTML 文件（推荐）；html = 内联 HTML 文档；url = http/https 网址。' },
      path: { type: 'string', description: 'type=file 时的 HTML 文件路径，与 Write 用的路径一致（相对工作区或绝对路径均可）。' },
      html: { type: 'string', description: 'type=html 时的完整 HTML 文档（单文件、样式与脚本内联）。' },
      url: { type: 'string', description: 'type=url 时的网址，必须以 http:// 或 https:// 开头。' },
      title: { type: 'string', description: '可选，给预览页显示的名称。' }
    },
    required: ['type']
  }
}

// 真正执行在主进程：路径解析与安全边界、HTML 落盘、驱动右侧浏览器面板导航都在那里，
// 渲染层只负责把参数交出去并拿回结构化结果（校验不依赖调用方）。
export async function execute(args: Record<string, unknown>): Promise<string> {
  const input = args as unknown as BrowserShowInput
  const title = typeof input.title === 'string' ? { title: input.title } : {}
  const res = await window.api.piAgent.browserShow(
    input.type === 'file'
      ? { type: 'file', path: String(input.path ?? ''), ...title }
      : input.type === 'html'
        ? { type: 'html', html: String(input.html ?? ''), ...title }
        : { type: 'url', url: String(input.url ?? ''), ...title }
  )
  return JSON.stringify(res)
}
