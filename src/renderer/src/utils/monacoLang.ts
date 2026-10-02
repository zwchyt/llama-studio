// 扩展名 → Monaco 语言 id。
//
// ⚠️ 刻意独立成文件，不要合并回 components/MonacoEditor.tsx。
// MonacoEditor.tsx 静态引入了 monaco-editor（editor.api.js + 9 个语言定义，约 2~3MB），
// 而 AgentPreviewSlot 需要 extToMonacoLang 只是为了给 <MonacoEditor language={…}> 传个字符串。
// 那句 `import { extToMonacoLang } from '../../MonacoEditor'` 是**静态具名导入**——它会把这个
// 模块整条依赖链拉进 AgentCodeView 的 chunk，于是同文件里的 `React.lazy(() => import('MonacoEditor'))`
// 完全失效（模块已在同一 chunk 里，lazy 拿到的就是它）。
// 拆出来之后 MonacoEditor 只剩 lazy 一条引用路径，monaco 才真正变成按需 chunk。

const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', svg: 'xml', vue: 'html', php: 'php', lua: 'lua',
  kt: 'kotlin', swift: 'swift', dart: 'dart', r: 'r',
}

export function extToMonacoLang(path: string): string | undefined {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase()
  return EXT_LANG[ext]
}
