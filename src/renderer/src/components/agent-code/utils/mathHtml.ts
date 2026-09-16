// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：HTML 预览的数学公式预渲染（KaTeX）                                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

import katex from 'katex'

// HTML 预览数学公式预渲染：扫描 HTML 内容中的数学公式，用 KaTeX 渲染为 HTML。
// 支持分隔符：$$...$$、$...$、\[...\]、\(...\)
// 跳过 <script>/<style>/<code>/<pre> 块内的内容。
export function renderMathInHtml(html: string): string {
  const SKIP_RE = /<(script|style|code|pre|textarea)[\s\S]*?<\/\1>/gi
  const protected_: string[] = []
  let work = html.replace(SKIP_RE, (m) => { protected_.push(m); return `\x00SKIP${protected_.length - 1}\x00` })
  // 块级公式 $$...$$ 和 \[...\]
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }) }
    catch { return `$$${tex}$$` }
  })
  work = work.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }) }
    catch { return `\\[${tex}\\]` }
  })
  // 行内公式 $...$ 和 \(...\)
  work = work.replace(/\$([^$\n]+?)\$/g, (full, tex) => {
    if (/^\d/.test(tex.trim())) return full
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }) }
    catch { return full }
  })
  work = work.replace(/\\\((.+?)\\\)/g, (full, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }) }
    catch { return full }
  })
  // 还原保护块
  work = work.replace(/\x00SKIP(\d+)\x00/g, (_, i) => protected_[Number(i)])
  return work
}
