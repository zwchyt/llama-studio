/**
 * Markstream 生产渲染层 —— react-markdown 的统一替代入口。
 *
 * 全库只有这一处直接依赖 markstream-react，其余组件只消费 <Markdown>。
 *
 * ── 统一配置（来自 1-7 号闸门实测结论，逐条都有据可依）──
 *   不传 htmlPolicy                走 markstream 的默认值 "safe"：原生 HTML（README 里的
 *                                  `<div align="center">`、徽章 `<img>`、`<p align="center">`）
 *                                  经 tokenizeHtml + sanitizeHtmlAttrs 清洗后真实渲染。
 *                                  safe 的两点代价：① style 属性会被丢弃；② 其 HTML 分词器把
 *                                  `/` 当属性分隔符，`<img/src=x/onerror=y>` 这类畸形写法会残留一个
 *                                  名为 `/onerror` 的属性 —— 但 React 的 setValueForAttribute 会
 *                                  拒绝非法属性名，不会落到 DOM 上。
 *   deferNodesUntilVisible={false} 关掉「首屏只挂 initialRenderBatchSize=40 块、其余留
 *                                  .node-placeholder」的延迟挂载。25KB 样本下默认值会永久留下
 *                                  242 个占位符（282 块 − 40），滚动也补不回来。
 *   不传 maxLiveNodes              保留默认 320：超过 320 个块自动切虚拟化分支，对超长文档
 *                                  反而是保护。传 0 会同时关掉虚拟化与 defer（测试里只用来
 *                                  对照「平滑/批渲染」开关，生产不用）。
 *   final={!streaming}             流结束才让解析器停止产出 loading 节点，未闭合的围栏/公式
 *                                  在流式期间由解析器自己保持在 mid-state。
 *   codeBlockStream={!final}       默认 true。它透传给 code_block 覆写组件的 `stream` 属性：
 *                                  流式实例 → CodeBlock 走逐行 span（跳 hljs）；结束实例 → false
 *                                  → 一次性 hljs 高亮。与旧实现 isStreaming 翻转语义一致。
 *   fade={false}                   与 react-markdown 现状一致，不引入进入动画。
 *   isDark={theme==='dark'}        跟随应用主题，而不是 markstream 默认的 prefers-color-scheme。
 *   customMarkdownIt               打开 markdown-it 的 linkify，等价旧实现里的 remarkLinkifyUrls
 *                                  （裸 URL 自动成链）。validateLink 拦掉 javascript: 等危险协议。
 *   数学公式                       解析器侧默认开启（`enableMath ?? true`，定界符 $$ / $ / \(），
 *                                  节点一定会产出；但 markstream 自带的 Math 组件要把 TeX 送进
 *                                  Web Worker（dist/workers/katexRenderer.worker.js）渲染，而这个
 *                                  worker 必须由使用方调 setKaTeXWorker() 手动注入，它自己不建。
 *                                  未注入时会退回主线程 `await import("katex")`，而那条路径的失败
 *                                  标志是模块级、一旦置位就永久缓存 —— 之后所有公式都直接把原始
 *                                  LaTeX 文本塞进 DOM。本层因此直接覆写 math_block / math_inline，
 *                                  用 katex.renderToString 同步渲染（见下方「数学公式」小节）；
 *                                  流式期间半截的非法 TeX 会被冻结、而不是把源码红字回显出来
 *                                  （useKatexHtml）。
 *
 * ── 节点覆写 ──
 * markstream 在渲染每个节点前会先查 `setCustomComponents(customId, map)[node.type]`
 * （code_block 走它自己的分支，键名同样取自 map）。键名 = 解析器节点类型：
 *   code_block / inline_code / link / image / mermaid
 * 覆写组件收到的 props 里，`node` 是该节点的解析结果，`renderNode` 是渲染器的递归入口
 * （渲染 link 的子节点——比如徽章图片——时必须用它），`stream` 仅 code_block 有。
 *
 * 样式：markstream 自带样式由 `markstream-react/index.css` 提供，全部作用域在根元素
 * `.markstream-react` 下；本层额外引一张 `styles/markstream.css`，只放「多了一层根元素」
 * 造成的外边距补丁，不重写既有排版。
 */
import React, { useEffect, useState } from 'react'
import MarkdownRender, { setCustomComponents } from 'markstream-react'
import 'markstream-react/index.css'
// KaTeX 样式：ChatView / AgentCodeView 各自也引了一次，这里再引一次是为了让本层自洽
// （数学公式的排版完全依赖这张表，缺了就会渲染成一堆错位的 span）。打包器会去重。
import 'katex/dist/katex.min.css'
import katex from 'katex'
import '../styles/markstream.css'
import { useThemeStore } from '../store/themeStore'
import CodeBlock from '../components/CodeBlock'
// 直接进具体模块而不是 '../mermaid' barrel：barrel 会顺带拉进 parseContentToBlocks（及其 ChartCard 依赖）
import { MermaidCard } from '../mermaid/MermaidCard'

// ── 节点数据类型（对应 stream-markdown-parser 的节点定义，只声明用得到的字段）──
interface MsCodeBlockNode { code?: string; content?: string; language?: string; loading?: boolean }
interface MsInlineCodeNode { code?: string; content?: string }
interface MsLinkChild { type: string; raw?: string }
interface MsLinkNode { href?: string; text?: string; title?: string | null; children?: MsLinkChild[] }
interface MsImageNode { src?: string; alt?: string; title?: string | null }

/** 覆写组件收到的公共 props（渲染器实际只传这几个，其余字段用不到） */
interface MsNodeProps<N> {
  node?: N
  indexKey?: number | string
  ctx?: unknown
  /** 渲染器自身的递归入口，签名 (node, key, ctx) => ReactNode */
  renderNode?: (node: any, key: React.Key, ctx: any) => React.ReactNode
  /** 仅 code_block：= <MarkdownRender> 的 codeBlockStream */
  stream?: boolean
}

function pickCode(node?: MsCodeBlockNode | MsInlineCodeNode): string {
  if (!node) return ''
  return typeof node.code === 'string' ? node.code : (node.content ?? '')
}

// ── 代码块 ─────────────────────────────────────────────────
// 不做 <pre> 包裹：markstream 的 code_block 节点直接渲染成组件，天然没有
// react-markdown 那种「<pre> 里塞 <div>」的非法嵌套问题。
function MsCodeBlock({ node, stream }: MsNodeProps<MsCodeBlockNode>) {
  return <CodeBlock language={node?.language ?? ''} value={pickCode(node)} isStreaming={!!stream} />
}

function MsInlineCode({ node }: MsNodeProps<MsInlineCodeNode>) {
  return <code className="chat-code-in-line">{pickCode(node)}</code>
}

// ── 链接 ───────────────────────────────────────────────────
// 与旧 MarkdownLink 一致：只放行 http(s)/mailto，其余一律不触发外开；
// 子节点交给渲染器递归（README 里的 [![badge](img)](url) 必须这样才渲染得出徽章）。
const SAFE_URL_RE = /^(https?:|mailto:)/i

function MsLink({ node, ctx, renderNode, indexKey }: MsNodeProps<MsLinkNode>) {
  const href = typeof node?.href === 'string' ? node.href : ''
  const hasChildren = Array.isArray(node?.children) && node.children.length > 0
  const label = hasChildren && renderNode && ctx
    ? node!.children!.map((child, i) => renderNode(child, `${String(indexKey)}-a-${i}`, ctx))
    : (node?.text ?? href)
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        if (SAFE_URL_RE.test(href)) window.api.openExternal(href)
      }}
    >
      {label}
    </a>
  )
}

// ── 图片 ───────────────────────────────────────────────────
// README 相对路径 → 远端 resolve 基址。基址随 ReadmeMarkdown 的 id/isHF 变化，
// 而覆写组件是全局注册的、拿不到实例闭包，故用模块级当前值承载
// （与旧 ChatView 的 _fileBaseDirs / _previewFileIdx 同一套路）。
let _hfBase = ''
export function setHfImageBase(base: string): void { _hfBase = base }

function resolveHfSrc(src: string | undefined, base: string): string {
  if (!src) return ''
  if (/^https?:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('#')) return src
  return base.replace(/\/+$/, '') + '/' + src.replace(/^[./]+/, '')
}

function MsHfImage({ node }: MsNodeProps<MsImageNode>) {
  const src = resolveHfSrc(node?.src, _hfBase)
  if (!src) return null
  return <img src={src} alt={node?.alt ?? ''} loading="lazy" />
}

// Markdown 文件预览的图片：本地相对路径经主进程读成 data URL 再显示。
let _fileBaseDirs = new Map<number, string>()
let _previewFileIdx = 0
export function setPreviewFileBaseDirs(dirs: Map<number, string>, idx: number): void {
  _fileBaseDirs = dirs
  _previewFileIdx = idx
}

function MsPreviewImage({ node }: MsNodeProps<MsImageNode>) {
  const src = node?.src
  const [dataSrc, setDataSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!src || /^(https?:|data:|file:\/\/|\/)/.test(src)) { setDataSrc(src); return }
    const dir = _fileBaseDirs.get(_previewFileIdx)
    if (!dir) { setDataSrc(src); return }
    const abs = (dir + '/' + src).replace(/\\/g, '/').replace(/\/+/g, '/')
    window.api.readFileBase64(abs).then(r => {
      setDataSrc(r.success ? r.dataUrl : src)
    }).catch(() => setDataSrc(src))
  }, [src])
  return <img src={dataSrc || src || ''} alt={node?.alt ?? ''} style={{ maxWidth: '100%', height: 'auto' }} />
}

// ── mermaid ────────────────────────────────────────────────
// Agent 正文：能画就画，画不出来由 MermaidCard 静默降级成代码块；
// 围栏还没闭合（node.loading）时保持代码块，避免拿半截代码去 render。
function MsMermaidCard({ node }: MsNodeProps<MsCodeBlockNode>) {
  const code = pickCode(node)
  if (node?.loading) return <CodeBlock language="mermaid" value={code} isStreaming />
  return <MermaidCard code={code} renderFallback={(c) => <CodeBlock language="" value={c} />} />
}

// Chat 正文：与 react-markdown 现状一致，```mermaid 就当普通代码块显示。
function MsMermaidAsCode({ node }: MsNodeProps<MsCodeBlockNode>) {
  return <CodeBlock language="mermaid" value={pickCode(node)} isStreaming={!!node?.loading} />
}

// ── 数学公式 ───────────────────────────────────────────────
// 为什么不用 markstream 自带的 Math 组件：它把 TeX 送进 Web Worker 渲染，而那个 worker 必须由
// 使用方自己 new 出来再调 setKaTeXWorker() 注入（markstream 不提供默认实例）。没注入时它退回
// 主线程 `await import("katex")`，而这条路径用模块级变量记住「导入失败过」——一旦置位就永久
// 返回 null，于是公式被降级成 `textContent = node.raw`，页面上看到的就是原始 LaTeX 源码。
// 这里改用 katex.renderToString 同步渲染：不依赖 worker、不依赖动态导入，结果可预测。
// throwOnError:false 让语法错误以红色文字就地显示，而不是抛异常炸掉整段
// （与 AgentCodeView 的 renderMathInHtml 保持同一套参数）。
interface MsMathNode { content?: string; raw?: string; loading?: boolean }

function renderKatex(tex: string, displayMode: boolean): string {
  const src = tex.trim()
  if (!src) return ''
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, strict: 'ignore' })
  } catch {
    return ''
  }
}

// KaTeX 在 throwOnError:false 下不抛异常，而是把**源码本身**渲染成红字回显：
//   <span class="katex-error" style="color:#cc0000">\frac{1}{2</span>
// 用这个类名判断本次结果是不是「错误回显」。
function isKatexError(html: string): boolean {
  return html.includes('katex-error')
}

/**
 * 流式友好的公式 HTML。
 *
 * 流式期间解析器会为「定界符尚未闭合」的公式照样产出 math 节点，并打上 node.loading = true
 * （解析器 mathInline 规则里的 `token.loading = true` 分支），此时 content 是半截 TeX
 * （如 `\frac{1}{2`）。KaTeX 对这种输入会走错误回显分支，把源码渲染成红字 ——
 * 视觉上就是「实时渲染时公式源码一闪」。
 *
 * 处理方式：
 *   · 半截但合法的 TeX（如 `a+b`）照常渲染 → 公式跟着流式实时生长，这是想要的效果；
 *   · 半截且非法的，冻结在上一次成功的结果（没有就留空）→ 不再闪源码；
 *   · 流结束（loading=false）后一律以本次结果为准 → 真写错的公式仍显示红字，便于定位。
 */
function useKatexHtml(tex: string, displayMode: boolean, loading: boolean): string {
  const [html, setHtml] = React.useState(() => {
    const first = renderKatex(tex, displayMode)
    return loading && isKatexError(first) ? '' : first
  })
  React.useEffect(() => {
    const next = renderKatex(tex, displayMode)
    const usable = next !== '' && !(loading && isKatexError(next))
    // 值相同则 React 会跳过重渲染，不必额外做 memo
    setHtml(prev => (usable ? next : prev))
  }, [tex, displayMode, loading])
  return html
}

// 块级：交给 markstream 的 .math-block（居中 / 可横向滚动 / min-height:40px 防抖动），
// 内部是 KaTeX 的 .katex-display。
function MsMathBlock({ node }: MsNodeProps<MsMathNode>) {
  const tex = node?.content ?? ''
  const loading = !!node?.loading
  const html = useKatexHtml(tex, true, loading)
  if (html) return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />
  // 流式期间留空壳：.math-block 自带 min-height，不会塌陷，也不会闪源码
  if (loading) return <div className="math-block" />
  // 流结束后仍渲染不出内容，才退回原始文本，至少不丢内容
  return <pre className="ms-math-fallback">{node?.raw ?? tex}</pre>
}

// 行内：KaTeX 的 .katex 自带字号与基线，外层 span 只做定位，不加额外样式避免错位。
function MsMathInline({ node }: MsNodeProps<MsMathNode>) {
  const tex = node?.content ?? ''
  const loading = !!node?.loading
  const html = useKatexHtml(tex, false, loading)
  if (html) return <span dangerouslySetInnerHTML={{ __html: html }} />
  if (loading) return null
  return <code className="chat-code-in-line">{node?.raw ?? tex}</code>
}

// ── 可信自定义标签 <thinking> ──────────────────────────────
// 生产正文的思考链由 parseThinkSegments 在进 Markdown 之前就按 <think> 切走了，
// 所以这里处理的是 <thinking>（部分模型模板用长标签）。旧管线（rehype-raw）把它当成
// 未知 HTML 元素：标签本身不可见、内部按原文显示。htmlPolicy="safe" 只放行
// SAFE_ALLOWED_HTML_TAGS 里的标准标签，<thinking> 不在其中 → 会被软屏蔽、连尖括号一起
// 按文本漏出来——所以必须显式声明为可信标签，并把内部原文按纯文本渲染
// （旧行为也不解析其中的 Markdown）。
function MsThinking({ node }: MsNodeProps<{ content?: string }>) {
  return <span style={{ whiteSpace: 'pre-wrap' }}>{node?.content ?? ''}</span>
}

// ── customId 注册表 ────────────────────────────────────────
// 模块加载时各注册一次。customId 同时决定覆写集合与 CodeBlock 的流式/结束语义。
setCustomComponents('ls-chat', {
  code_block: MsCodeBlock,
  inline_code: MsInlineCode,
  link: MsLink,
  mermaid: MsMermaidAsCode,
  thinking: MsThinking,
  math_block: MsMathBlock,
  math_inline: MsMathInline,
})

setCustomComponents('ls-chat-preview', {
  link: MsLink,
  image: MsPreviewImage,
  thinking: MsThinking,
  math_block: MsMathBlock,
  math_inline: MsMathInline,
})

setCustomComponents('ls-agent', {
  code_block: MsCodeBlock,
  inline_code: MsInlineCode,
  link: MsLink,
  mermaid: MsMermaidCard,
  thinking: MsThinking,
  math_block: MsMathBlock,
  math_inline: MsMathInline,
})

setCustomComponents('ls-hf', {
  link: MsLink,
  image: MsHfImage,
  thinking: MsThinking,
  math_block: MsMathBlock,
  math_inline: MsMathInline,
})

// ── markdown-it 配置：裸 URL 自动成链 ──────────────────────
// 两个模块级常量，保证引用稳定（渲染器拿它们当依赖，每次渲染换新引用会触发重建）。
const configureMarkdownIt = (md: any): any => md.set({ linkify: true, validateLink: (url: string) => !/^\s*(javascript|vbscript|data):/i.test(url) })
const CUSTOM_HTML_TAGS: readonly string[] = ['thinking']

export type MarkdownVariant = 'chat' | 'chat-preview' | 'agent' | 'hf'

const VARIANT_ID: Record<MarkdownVariant, string> = {
  chat: 'ls-chat',
  'chat-preview': 'ls-chat-preview',
  agent: 'ls-agent',
  hf: 'ls-hf',
}

/**
 * 生产渲染入口。`final` 语义 = 「本段内容已经输出完」：
 *   true  → 解析器收敛，code_block 覆写收到 stream=false（一次性高亮）
 *   false → 流式中间态，未闭合围栏/公式保持 mid-state，代码块逐行更新
 */
export const Markdown = React.memo(function Markdown({
  content,
  final,
  variant,
}: {
  content: string
  final?: boolean
  variant: MarkdownVariant
}) {
  // 应用主题由 themeStore 用根节点 .theme-dark 类驱动；markstream 的 isDark 若不给，
  // 它会回退到 window.matchMedia('(prefers-color-scheme: dark)')——跟操作系统而不是跟应用，
  // 应用设浅色而系统是深色时两者会错配。这里显式对齐。
  // 当前 markstream 的暗色规则只作用于 mermaid-block / admonition / code-block-container，
  // 后两者已被本层的覆写组件接管，所以这是防御性对齐（将来若撤掉某个覆写就靠它兜底）。
  const isDark = useThemeStore(s => s.theme === 'dark')
  return (
    <MarkdownRender
      content={content}
      final={final}
      customId={VARIANT_ID[variant]}
      deferNodesUntilVisible={false}
      codeBlockStream={!final}
      fade={false}
      customMarkdownIt={configureMarkdownIt}
      customHtmlTags={CUSTOM_HTML_TAGS}
      isDark={isDark}
    />
  )
})
