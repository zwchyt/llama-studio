export interface BrowserShowInput {
  type: 'file' | 'html' | 'url'
  /** type=file：工作区内已写好的 HTML 文件路径（与 Write 用的路径一致） */
  path?: string
  html?: string
  url?: string
  title?: string
}
