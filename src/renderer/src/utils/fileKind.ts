// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文件类型判定的单一真源（扩展名提取 / 分类集合 / kindOf）                 ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 此前 `\.([a-z0-9]+)$` 在 6 处各写一遍，IMG_EXT 集合有两份拷贝，isPdf 在
// extractText 里私有、预览里又手写一次。判定顺序（image > pdf > docx > doc > 文本）
// 一旦某处写反，表现是「PDF 被当文本读出一屏乱码」这类难查的错，所以收到一处。
//
// 只做「按名字判类型」，不读内容；Markdown 的正文嗅探（无扩展名时看内容）仍在调用方。

export const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cc', 'hh',
  'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'html', 'htm',
  'css', 'scss', 'less', 'sass', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'cmd', 'sql',
  'r', 'R', 'lua', 'pl', 'pm', 'dart', 'vue', 'svelte', 'gradle', 'makefile',
  'lock', 'log', 'csv', 'tsv', 'diff', 'patch',
])

export const MD_EXT = new Set(['md', 'markdown', 'mdx', 'mkd', 'mdwn', 'mkdn', 'text', 'txt', 'rst', 'adoc', 'asciidoc', 'ronn'])

export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

/** 取扩展名（小写、不含点）；无扩展名返回 ''。 */
export function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p || '')
  return m ? m[1]!.toLowerCase() : ''
}

export type FileKind = 'image' | 'pdf' | 'docx' | 'doc' | 'html' | 'markdown' | 'code' | 'other'

/** 按文件名判类型。判定顺序即优先级：image > pdf > docx > doc > html > markdown > code。 */
export function kindOf(p: string): FileKind {
  const ext = extOf(p)
  if (IMG_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (MD_EXT.has(ext)) return 'markdown'
  if (CODE_EXT.has(ext)) return 'code'
  return 'other'
}
