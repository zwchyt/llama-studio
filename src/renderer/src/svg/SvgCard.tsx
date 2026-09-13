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
 *   AgentCodeView 的 markdown 管线是 rehype-raw → rehype-sanitize → rehype-katex，
 *   而 SANITIZE_SCHEMA 继承的 defaultSchema 白名单里**没有任何 SVG 标签**
 *   （实测 53 个标签全是 HTML：a/b/div/img/span/table…，svg/path/circle 一个不在）。
 *   所以模型内联写的 <svg> 会被整段剥掉，只留下文字内容漏出来。
 *   而 img 标签本身、以及 src 上的 data 协议都在白名单里（见 AgentCodeView.tsx
 *   的 SANITIZE_SCHEMA），所以包成 data URI 就能过——**不需要放宽 sanitizer**。
 *
 * 卡片外壳（标题 / 工具条 / 放大层 / 源码面板）全部由 FigureFrame 提供，
 * 本文件只负责「拿到 SVG 源码」和「把它变成一张图」。
 * 这是 SvgCard 与 ChartCard 唯一的分工差异：本文件给的是模型原文，
 * ChartCard 给的是运行时序列化结果。
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
   * 引用要稳定（useCallback）：FigureFrame 拿它当依赖，每次渲染都换新函数
   * 会让下游反复重新取值。
   */
  const getSvgSource = useCallback(() => (code ? code : null), [code])

  const renderable = !!code && looksLikeSvg(code) && !broken

  if (!renderable) {
    // 校验不过（误标的普通 XML）或加载失败 → 退回普通代码块
    return <>{input.renderFallback && code ? input.renderFallback(code) : null}</>
  }

  const alt =
    typeof input.title === 'string' && input.title
      ? input.title.slice(0, MAX_ALT_LEN)
      : 'SVG 图形'
  const fileName = typeof input.title === 'string' && input.title ? input.title : 'svg'

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
