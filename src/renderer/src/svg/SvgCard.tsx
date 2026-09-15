import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { looksLikeSvg } from './parseSvg'
import { FigureFrame } from '../figure/FigureFrame'
import { toSvgDataUri } from '../figure/serializeSvg'
import './svg.css'

/**
 * SVG 卡片：把模型输出的 ```svg 围栏内容渲染成一张图。
 *
 * 为什么必须走 <img src="data:...">：
 *   markdown 渲染已改为 markstream（见 ../markdown/markstream），默认 htmlPolicy="safe"：
 *   safe 的标签白名单（SAFE_ALLOWED_HTML_TAGS）里一个 SVG 标签都没有，模型内联写的 <svg>
 *   不会被解析成图形，而是原样显示成源码。
 *   包成 data URI 的 img 则是真正的图片节点，能正常渲染 —— **不需要放宽任何安全策略**。
 *   历史背景：旧管线（rehype-raw → rehype-sanitize）的 defaultSchema 白名单里同样没有任何 SVG
 *   标签（实测 53 个标签全是 HTML），内联 <svg> 会被整段剥掉、只漏出文字内容。
 *
 * 卡片外壳（标题 / 工具条 / 放大层 / 源码面板）全部由 FigureFrame 提供，
 * 本文件只负责「拿到 SVG 源码」和「把它变成一张图」。
 * 与 ChartCard 的分工差异：这里的两份源码**是同一份**（模型写的 SVG 原文，
 * 既能当图显示、也能当源码看），所以不必传 getSourceText；
 * ChartCard 的真 SVG 得现场序列化，可读源码才回落到模型原文。
 *
 * 降级策略与 MermaidCard / ChartCard 一致：校验不过或图片加载失败，
 * 一律交给调用方的 renderFallback 渲染成普通代码块，不摆错误卡给用户看。
 */

const MAX_ALT_LEN = 80

export type SvgCardProps = {
  code?: string | null
  props?: Record<string, unknown> | null
  state?: Record<string, unknown> | null
  title?: string | null
  children?: unknown
  renderFallback?: (code: string) => ReactNode
  /**
   * 流式实时预览：code 是还没输出完的半截 SVG，用 innerHTML 注入渐进渲染
   * （浏览器容错解析，写到一个标签画一个）。流结束（false）后走沙箱 img 全量渲染。
   */
  streaming?: boolean
}

/** 流式预览的轻量净化：剥 <script> 与内联事件处理器（innerHTML 注入的 SVG 不会跑 <script>，但事件属性会活）。 */
function sanitizeLiveSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

function pickCode(p: SvgCardProps): string {
  for (const c of [p.code, p.props?.code, p.state?.code]) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

export function SvgCard(input: SvgCardProps) {
  const code = useMemo(
    () => pickCode(input),
    [input.code, input.props, input.state]
  )
  const [broken, setBroken] = useState(false)

  /**
   * 下载 / 复制 / 查看源码取的都是**模型原文**，不经过任何运行时改写 ——
   * 所以这里直接返回字符串，零成本，也不必等 DOM 渲染完成。
   * （唯一的例外是下载：downloadSvg 会给根标签补 xmlns，否则存下来的 .svg
   *   是独立文档、双击打不开。见 figure/serializeSvg 的 ensureSvgNamespace。）
   * 引用要稳定（useCallback）：FigureFrame 拿它当依赖，每次渲染换新函数
   * 会让下游反复重新取值。
   */
  const getSvgSource = useCallback(() => (code ? code : null), [code])
  const fileName = typeof input.title === 'string' && input.title ? input.title : 'svg'

  /**
   * 流式实时预览：不经过 <img>（截断的 data URI 是一张破图），直接把半截 SVG
   * innerHTML 注入容器 —— 浏览器容错解析，已输出的标签立即成形，随流生长。
   * 注入前做轻量净化（剥 <script> 与内联事件）；流结束后换回沙箱 img 全量渲染。
   */
  if (input.streaming) {
    return (
      <FigureFrame
        title={input.title ?? null}
        getSvgSource={getSvgSource}
        fileName={fileName}
        invertible
        themeCanvas="var(--svg-canvas, var(--surface))"
      >
        <div
          className="svg-card-live"
          // 半截 SVG：innerHTML 的容错解析正好把它画到当前写到的标签为止。
          // 内容还没到时给空容器——卡片框架已占位，避免高度塌陷闪烁。
          dangerouslySetInnerHTML={code ? { __html: sanitizeLiveSvg(code) } : undefined}
        />
      </FigureFrame>
    )
  }

  const renderable = !!code && looksLikeSvg(code) && !broken

  if (!renderable) {
    // 校验不过（误标的普通 XML）或加载失败 → 退回普通代码块
    return <>{input.renderFallback && code ? input.renderFallback(code) : null}</>
  }

  const alt =
    typeof input.title === 'string' && input.title
      ? input.title.slice(0, MAX_ALT_LEN)
      : 'SVG 图形'

  return (
    <FigureFrame
      title={input.title ?? null}
      getSvgSource={getSvgSource}
      fileName={fileName}
      // 深色主题下自动反相。模型写的 SVG 用字面颜色（黑线、透明底），
      // 我们读不到它的语义，深色主题下只能靠 invert(1) hue-rotate(180deg)
      // 把它翻成「浅色线条」。卡片上没有背景开关 —— 跟随应用主题即可。
      // ChartCard 不传这个 prop：它的配色本来就是主题变量，翻一次反而坏掉。
      invertible
      // 画布底色由主题变量 --svg-canvas 决定，两个主题**都**取 --surface：
      //   与卡片同色 → 不出现「灰卡片套白框」的内框；
      //   深色下「看不看得见」由上面的反相保证，不再靠垫一层白底。
      // 变量没定义时兜底 var(--surface)，保证底色始终与卡片一致。
      themeCanvas="var(--svg-canvas, var(--surface))"
    >
      <img
        className="svg-card-img"
        src={toSvgDataUri(code)}
        alt={alt}
        // 加载失败（SVG 语法错误、编码异常）时退回代码块，让用户还能看到原文
        onError={() => setBroken(true)}
      />
    </FigureFrame>
  )
}

export default SvgCard
