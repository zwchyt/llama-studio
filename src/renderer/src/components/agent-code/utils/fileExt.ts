// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文件扩展名分类集合（预览模式判定 / 图片判定）                            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。
// 静态集合提升到模块作用域，避免每次渲染重建。

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
