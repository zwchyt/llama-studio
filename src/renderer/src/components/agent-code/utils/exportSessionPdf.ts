// 通用模式的「导出 PDF」：整段会话重新排版成打印 HTML，交主进程 printToPDF 落盘。
// 与「导出图片」互补而非重复：消息区是虚拟滚动的，html2canvas 只能截到当前一屏；
// 这里遍历会话的全部消息，长对话也能一次导完。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import type { AgentSession } from '../../../../../shared/types'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  // rehype-katex 的类型与 unified 11 的插件签名不兼容（ChatView 时代即如此），沿用其绕过写法
  .use(rehypeKatex as never, { throwOnError: false })
  .use(rehypeStringify, { allowDangerousHtml: true })

async function markdownToHtml(text: string): Promise<string> {
  try {
    return String(await markdownProcessor.process(text))
  } catch {
    return escapeHtml(text)
  }
}

const PDF_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; padding: 20mm; font-size: 11pt; line-height: 1.7; color: #222; }
  h1 { font-size: 18pt; margin-bottom: 6pt; }
  .meta { font-size: 9pt; color: #888; margin-bottom: 4pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 10pt 0; }
  .msg { margin-bottom: 10pt; }
  .role { font-size: 10pt; display: block; margin-bottom: 2pt; }
  .user .role { color: #2563eb; font-weight: 700; }
  .user .body { color: #333; }
  .assistant .role { color: #000; font-weight: 700; }
  .assistant .body { color: #555; }
  .stopped { color: #b45309; font-size: 9pt; }
  .katex { font-size: 1.1em; }
  .katex-display { margin: 8pt 0; overflow-x: auto; overflow-y: hidden; }
  pre { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8pt; font-family: "Cascadia Code", "Fira Code", "Consolas", monospace; font-size: 9pt; line-height: 1.5; overflow-x: auto; margin: 6pt 0; }
  code { font-family: "Cascadia Code", "Fira Code", "Consolas", monospace; font-size: 9pt; }
  p code { background: #f0f0f0; padding: 1pt 4pt; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 4pt 8pt; text-align: left; }
  th { background: #f0f0f0; font-weight: 700; }
  tr:nth-child(even) { background: #fafafa; }
  .atts { display: flex; flex-wrap: wrap; gap: 6pt; margin-top: 6pt; }
  .atts img { max-width: 160pt; max-height: 120pt; border: 1px solid #ddd; border-radius: 3pt; object-fit: contain; }
  .att-file { font-size: 9pt; color: #666; border: 1px solid #ddd; border-radius: 9pt; padding: 2pt 7pt; }
  @page { margin: 0; }
`

export async function buildSessionPdfHtml(session: AgentSession): Promise<string> {
  const modelLabel = [...session.messages].reverse().find(m => m.role === 'assistant' && m.modelLabel)?.modelLabel
  const body = await Promise.all(
    session.messages
      // continuation 是「继续生成」注入的接续指令，界面上不显示，导出的对话记录里也不该出现。
      // 空正文要有附件也算一条消息（只发文件不打字），否则整条消息在导出里消失。
      .filter(m => !m.continuation && (m.content.trim() || (m.attachments?.length ?? 0) > 0))
      .map(async m => {
        const roleLabel = m.role === 'user' ? '用户' : '助手'
        const stopped = m.stopped ? ' <span class="stopped">（已停止，内容不完整）</span>' : ''
        // 图片用缩略图那一路 data URL（原图 base64 会把导出文件撑爆）；
        // 文件类附件只落名字——它的抽取文本是喂给模型的提示，不是对话内容
        const atts = (m.attachments ?? []).map(a =>
          a.type === 'image' && (a.dataUrl || a.fullDataUrl)
            ? `<img src="${a.dataUrl || a.fullDataUrl}" alt="${escapeHtml(a.name)}">`
            : `<span class="att-file">附件：${escapeHtml(a.name)}</span>`
        ).join('')
        const attBlock = atts ? `<div class="atts">${atts}</div>` : ''
        return `<div class="msg ${m.role}"><span class="role">${roleLabel}${stopped}</span><div class="body">${await markdownToHtml(m.content)}${attBlock}</div></div>`
      })
  )
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${PDF_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(session.title || '对话记录')}</h1>
<div class="meta">导出时间: ${new Date().toLocaleString()}</div>
${modelLabel ? `<div class="meta">模型: ${escapeHtml(modelLabel)}</div>` : ''}
<hr>
${body.join('')}
</body>
</html>`
}
