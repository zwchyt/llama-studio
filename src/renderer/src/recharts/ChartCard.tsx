import { Component, Suspense, lazy, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { normalizeChartSpec, parseChartSpec } from './parseChartSpec'
import type { ChartSpec } from './types'
import { FigureFrame } from '../figure/FigureFrame'
import { serializeSvg } from '../figure/serializeSvg'
import './chart.css'

/**
 * SVG 图表卡片。两条路径共用这一个入口：
 *   ① 围栏路径 —— 模型在正文里写 ```chart 加一段 JSON，code 是那段 JSON 文本
 *   ② jsonui 路径 —— 模型直接给结构化 props，props 本身就是 spec 对象
 *
 * 渲染失败一律静默降级（交给调用方传进来的 renderFallback 渲染成普通代码块），
 * 与 MermaidCard 的策略保持一致：不把「渲染失败」的错误卡摆到用户面前。
 *
 * 卡片外壳（标题 / 工具条 / 放大层 / 源码面板）由 figure/FigureFrame 提供，
 * 与 SvgCard 共用同一份实现。两者都要交两份「源码」，只是来源不同：
 *   · 真 SVG（下载 / 放大）—— SvgCard 直接返回模型原文；本文件必须序列化 DOM。
 *   · 可读源码（面板 / 复制）—— 都是模型原文；本文件在围栏路径下就是那段 JSON，
 *     只有 jsonui 路径（props 直接给对象）没有原文，才回落到序列化 SVG。
 */

// 懒加载：ChartView 静态 import 'recharts'，隔一层 React.lazy 之后 Vite 会把它
// 切成按需 chunk（实测主包因此少约 941 kB）。代价是首屏多一个异步 chunk 请求，
// 换来的是聊天首屏不用背 recharts —— 值得。
//
// ⚠️ 这个边界很容易被无意间打穿：只要**任何一个**非懒加载的模块也静态引用了
// recharts（曾经是 components/BenchmarkView.tsx），Rollup 就会把整条共享依赖链
// 提回主包，这里的 lazy 变成纯粹的空转。改动依赖图后务必回头确认主包里
// grep 不到 'recharts-wrapper'。
const ChartView = lazy(() => import('./ChartView'))

type LooseObject = Record<string, unknown> | null | undefined

export type ChartCardProps = {
  props?: LooseObject
  state?: LooseObject
  // 兼容扁平传入
  code?: string | null
  title?: string | null
  children?: unknown
  emit?: (event: string, data?: unknown) => void
  renderFallback?: (code: string) => ReactNode
  fallbackLang?: string
  /**
   * 是否提供「放大查看」。默认 true（直连的 ```chart 围栏照常）。
   * jsonui 路径传 false：FigureFrame 只保留 复制 / 下载 / 查看源码。
   */
  zoomable?: boolean
}

function pickCode(p: ChartCardProps): string {
  for (const c of [p.code, p.props?.code, p.state?.code]) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

function resolveSpec(p: ChartCardProps): ChartSpec | null {
  const code = pickCode(p)
  if (code) {
    const fromCode = parseChartSpec(code)
    if (fromCode) return fromCode
  }
  // jsonui 路径：props / state 本身就是 spec 对象，不需要过 JSON.parse
  return normalizeChartSpec(p.props ?? p.state)
}

/**
 * 懒加载 chunk 拉取失败时的兜底。没有它的话，import 抛错会一路上抛把整条消息
 * 的渲染树掀掉 —— 一张图画不出来不该让整条回复消失。
 */
class ChartBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function ChartCard(input: ChartCardProps) {
  const spec = useMemo(
    () => resolveSpec(input),
    [input.code, input.props, input.state]
  )

  /** 图表所在的容器。序列化时从它里面找活的 <svg>。 */
  const hostRef = useRef<HTMLDivElement | null>(null)

  const code = pickCode(input)

  /**
   * 下载 .svg / 放大层要的是**真 SVG**：Recharts 的图是运行时用 React 建出来的
   * DOM，模型给的是数据 spec，所以必须现场把活的 <svg> 序列化出来 ——
   * 见 serializeSvg 的注释，两件必须做的事（补 xmlns、把 var(--x) 解析成实时计算值），
   * 少一件导出的文件就是坏的。
   *
   * 尺寸没问题：ChartView 外层是 ResponsiveContainer，它会量出像素值再传下去，
   * 所以 svg 上带的是数值 width/height 加 viewBox，脱离文档也能正常打开。
   *
   * ⚠️ 已知限制：Recharts 的 Legend 渲染的是 HTML（<ul class="recharts-default-legend">），
   * 不在 <svg> 里，所以导出的 .svg **不含图例**。要在导出件里也保留图例，
   * 得另外用 spec 里的 series/颜色合成一段 SVG 图例拼进去 —— 那是独立一件事，
   * 没有顺手做，免得把「序列化」这个纯函数搞成半懂业务的东西。
   *
   * 引用必须稳定：FigureFrame 拿它当依赖。序列化会遍历上千个节点，
   * 每次渲染换新函数等于把这份开销挂在无谓的重渲染上。
   */
  const getSvgSource = useCallback(() => serializeSvg(hostRef.current), [])

  /**
   * 「查看源码 / 复制」要的是**模型原文**：围栏路径下 code 就是那段 JSON
   * （```chart / ```json 都是），那才是用户想看的「这段图表的代码」。
   *
   * 这两件事曾经也走 getSvgSource，于是源码面板里显示的是序列化出来的 SVG ——
   * 用户会以为「我的 JSON 被改写成 SVG 了」。jsonui 路径（props 直接给对象、
   * 没有原文）才回落到序列化 SVG。
   */
  const getSourceText = useCallback(() => code || serializeSvg(hostRef.current), [code])

  const degrade = (): ReactNode =>
    input.renderFallback && code ? input.renderFallback(code) : null

  if (!spec) return <>{degrade()}</>

  const title = spec.title ?? (typeof input.title === 'string' ? input.title : null)
  const height = spec.height ?? 240

  return (
    <FigureFrame
      title={title}
      getSvgSource={getSvgSource}
      getSourceText={getSourceText}
      fileName={title || 'chart'}
      zoomable={input.zoomable}
    >
      {/* 外层写死高度：图表 chunk 是异步加载的，占位若不留足高度，
          加载完成的瞬间容器会从几十 px 猛增到 240px+ → 聊天区 scrollHeight 突变
          → 滚动条跳变。这与 MermaidCard 里处理加载占位是同一个问题。 */}
      <div className="rc-chart" ref={hostRef} style={{ height }}>
        <ChartBoundary fallback={<div className="rc-chart-failed">图表加载失败</div>}>
          <Suspense fallback={<div className="rc-chart-loading" />}>
            <ChartView spec={spec} />
          </Suspense>
        </ChartBoundary>
      </div>
    </FigureFrame>
  )
}

export default ChartCard
