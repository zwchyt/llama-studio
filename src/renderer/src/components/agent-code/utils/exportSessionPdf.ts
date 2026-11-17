// 通用模式的「导出 PDF」：整段会话重新排版成打印 HTML，交主进程 printToPDF 落盘。
// 与「导出图片」互补而非重复：消息区是虚拟滚动的，截屏只能截到当前一屏；
// 这里遍历会话的全部消息，长对话也能一次导完。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import type { AgentSession, AgentMessage } from '../../../../../shared/types'
import { parseThinkSegments } from '../agent-message'
import { TOOL_METAS } from '../../../utils/tools'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

type ToolCall = NonNullable<AgentMessage['toolCalls']>[number]

/** 工具结果/参数摘要上限：搜索返回动辄上万字符，截断避免把 PDF 撑爆 */
const TOOL_TEXT_CAP = 600
function clip(text: string): string {
  const t = text.trim()
  return t.length <= TOOL_TEXT_CAP ? t : `${t.slice(0, TOOL_TEXT_CAP)}\n…（已省略 ${t.length - TOOL_TEXT_CAP} 字符）`
}
/** 参数可能是压缩单行 JSON，展开成可读多行后再截断 */
function prettyArgs(raw: string): string {
  if (!raw) return ''
  try { return clip(JSON.stringify(JSON.parse(raw), null, 2)) } catch { return clip(raw) }
}

/** 把一条工具调用的「名称 + 参数 + 结果 + 状态」渲染成 PDF 里的一个小块 */
function renderToolCall(tc: ToolCall): string {
  const label = TOOL_METAS[tc.name]?.label ?? tc.name
  const args = prettyArgs(tc.args ?? '')
  const result = clip(tc.result ?? '')
  const flags = [
    tc.failed ? '失败' : '',
    tc.status === 'await_approval' ? '等待确认' : '',
    tc.truncated ? '结果已截断' : '',
  ].filter(Boolean).join('、')
  const status = flags ? ` <span class="tool-flag">（${escapeHtml(flags)}）</span>` : ''
  return `<div class="tool-call">
    <div class="tool-head">工具调用 · ${escapeHtml(label)} <span class="tool-name">${escapeHtml(tc.name)}</span>${status}</div>
    ${args ? `<div class="tool-section"><span class="tool-key">参数</span><pre class="tool-pre">${escapeHtml(args)}</pre></div>` : ''}
    ${result ? `<div class="tool-section"><span class="tool-key">结果</span><pre class="tool-pre">${escapeHtml(result)}</pre></div>` : ''}
  </div>`
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
  /* 思考链：与正文一眼分开的浅灰块，闭合成未闭合都按同一块呈现 */
  .think-block { border-left: 3px solid #cbd5e1; background: #f6f7f9; border-radius: 0 4px 4px 0; padding: 6pt 10pt; margin: 6pt 0; }
  .think-label { font-size: 9pt; font-weight: 700; color: #94a3b8; margin-bottom: 3pt; letter-spacing: .3pt; }
  .think-body { font-size: 9.5pt; line-height: 1.6; color: #6b7280; }
  .think-body p { margin: 3pt 0; }
  /* 工具调用：与正文分开的浅框，参数/结果用等宽小字，超长已截断 */
  .tool-call { border: 1px solid #e2e8f0; background: #fbfcfd; border-radius: 4px; padding: 5pt 9pt; margin: 6pt 0; page-break-inside: avoid; }
  .tool-head { font-size: 9.5pt; font-weight: 700; color: #475569; margin-bottom: 3pt; }
  .tool-name { font-weight: 400; color: #94a3b8; font-size: 8.5pt; }
  .tool-flag { color: #b45309; font-weight: 400; font-size: 8.5pt; }
  .tool-section { margin-top: 3pt; }
  .tool-key { font-size: 8.5pt; color: #64748b; font-weight: 700; }
  .tool-pre { background: #f1f5f9; border: none; margin: 2pt 0 0; padding: 5pt 7pt; font-size: 8.5pt; line-height: 1.45; white-space: pre-wrap; word-break: break-all; color: #475569; }
  @page { margin: 0; }
`

export async function buildSessionPdfHtml(session: AgentSession): Promise<string> {
  const modelLabel = [...session.messages].reverse().find(m => m.role === 'assistant' && m.modelLabel)?.modelLabel
  const body = await Promise.all(
    session.messages
      // continuation 是「继续生成」注入的接续指令，界面上不显示，导出的对话记录里也不该出现。
      // 空正文但有附件或纯工具调用也算一条消息，否则这类消息在导出里消失。
      .filter(m => !m.continuation && (m.content.trim() || (m.attachments?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0))
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
        // 按真实时间线渲染：有 segments 的消息直接用它交错输出「思考 / 正文 / 工具调用」，
        // 顺序与界面一致（思考→工具→再思考→再工具…）。旧消息无 segments 时回退到
        // <think> 标签解析，工具块附在正文后（旧数据没有顺序信息）。
        let timelineHtml = ''
        if (m.segments && m.segments.length > 0) {
          const parts = await Promise.all(m.segments.map(async s => {
            if (s.kind === 'tools') return s.toolCalls.map(renderToolCall).join('')
            const html = await markdownToHtml(s.content)
            return s.kind === 'think'
              ? `<div class="think-block"><div class="think-label">思考过程</div><div class="think-body">${html}</div></div>`
              : html
          }))
          timelineHtml = parts.join('')
        } else {
          const parts = await Promise.all(parseThinkSegments(m.content).map(async seg => {
            const html = await markdownToHtml(seg.value)
            return seg.type === 'think'
              ? `<div class="think-block"><div class="think-label">思考过程</div><div class="think-body">${html}</div></div>`
              : html
          }))
          timelineHtml = parts.join('') + (m.toolCalls ?? []).map(renderToolCall).join('')
        }
        return `<div class="msg ${m.role}"><span class="role">${roleLabel}${stopped}</span><div class="body">${timelineHtml}${attBlock}</div></div>`
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
