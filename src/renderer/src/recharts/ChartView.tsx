import { useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { ChartSeries, ChartSpec } from './types'
import { resolveSeries } from './parseChartSpec'

/**
 * 真正调用 Recharts 的渲染层。
 *
 * 这个文件只被 ChartCard 通过 React.lazy 动态引入 —— 所以 Recharts 会被 Vite
 * 单独切成按需 chunk，不进主包。实测（生产构建）：
 *
 *   BarChart-*.js    740 kB   ← recharts 主体，ChartView 与 BenchmarkView 共享
 *   ChartView-*.js   232 kB   ← 本文件 + 图表分支逻辑
 *   主包 index-*.js  少了约 941 kB，且 grep 'recharts-wrapper' 命中 0 次
 *
 * ⚠️ 有两个「前功尽弃」的坑，改代码时注意：
 *   1. 不要从别处直接 import 本文件（必须经过 ChartCard 的 React.lazy）。
 *   2. 不要在非懒加载模块里 import 'recharts'。Rollup 对共享依赖的处理是
 *      「只要有一个 eager 引入者，整条链就提到主包」—— 之前
 *      components/BenchmarkView.tsx 就是这么把 940 kB 拽回主包的，
 *      现已改成 lazy(() => import('./BenchmarkView'))。新增任何用 recharts
 *      的组件，都必须同样走懒加载。
 */

/** 调色板全部走 CSS 变量（定义在 chart.css 的 .rc-chart 上），因此自动跟随浅色 / 暗色主题。 */
const PALETTE = [
  'var(--rc-c1)',
  'var(--rc-c2)',
  'var(--rc-c3)',
  'var(--rc-c4)',
  'var(--rc-c5)',
  'var(--rc-c6)',
  'var(--rc-c7)',
  'var(--rc-c8)',
]

const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  padding: '6px 10px',
  boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0, 0, 0, .12))',
}
const TOOLTIP_ITEM_STYLE = { color: 'var(--text)' }
const TOOLTIP_LABEL_STYLE = { color: 'var(--text-secondary)', marginBottom: 2 }
/**
 * Y 轴宽度：**由数据算**，不用 recharts 的 width="auto"。
 *
 * 它默认是写死的 60px，而「200 / 150 / 0」这类刻度只要 20px 出头 —— 剩下 40px 全是空的，
 * 画在卡片左侧就是一条醒目的空白带。width="auto" 能按刻度实测收窄，但**不能用**：
 * 它靠 getBoundingClientRect 量刻度文字，而放大层（FigureFrame）是用 CSS transform
 * 缩放图形的 —— rect 会带上缩放倍率，于是放大层里算出来的轴宽跟着翻倍
 * （实测：卡片里 34px，放大 1.53 倍后变成 48px），放大后左边反而多出一块空白。
 *
 * 由数据算则卡片与放大层完全一致。口径：取最大刻度数量级，按字符数估宽，
 * 真实刻度是「好看的整数」可能比数据最大值多一位（980 → 刻度到 1000），故长度 +1 留余量；
 * 最后夹在 [34, 96] 之间，防止极端值把绘图区挤没。
 */
function yAxisWidthOf(spec: ChartSpec, series: ChartSeries[]): number {
  let maxAbs = 0
  let lo = 0
  let hi = 0
  let seen = false
  const keys = series.map((s) => s.key)
  for (const row of spec.data) {
    // 堆叠图的上界是每行的合计，不是单个值 —— 按单值算会把轴宽估小，刻度被裁掉
    const v = spec.stacked
      ? keys.reduce((sum, k) => sum + (Number(row[k]) || 0), 0)
      : keys.reduce((m, k) => Math.max(m, Math.abs(Number(row[k]) || 0)), 0)
    if (!Number.isFinite(v)) continue
    maxAbs = Math.max(maxAbs, Math.abs(v))
    if (!seen) {
      lo = v
      hi = v
      seen = true
    } else {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }

  // 刻度标签有多宽，主要取决于**小数位数**，而小数位数由**刻度间隔**决定：
  // 间隔越小，相邻刻度要靠越多位小数才区分得开。
  // recharts 默认把刻度分成约 5 段，且非负数据的下界默认取 0（domain [0, auto]），
  // 所以间隔 ≈ 上界 / 5。只按 Math.round(max) 取位数的话，小量级数据
  // （如 0.001 级别）会算出 0 位小数，刻度直接被裁掉。
  const span = lo >= 0 ? hi : hi - lo
  const step = span > 0 ? span / 5 : 0
  const decimals = step > 0 ? Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)))) : 0
  const len = String(Math.round(maxAbs)).length + (decimals > 0 ? decimals + 1 : 0) + 1
  return Math.min(96, Math.max(34, Math.round(len * 6.2) + 10))
}

const AXIS_TICK = { fill: 'var(--text-muted)', fontSize: 11 }
const LEGEND_STYLE = { fontSize: 12, color: 'var(--text-secondary)' }

/**
 * 容器尺寸变化的节流窗口（ms）。
 *
 * ResponsiveContainer 用 ResizeObserver 盯着容器，尺寸一变就 setState 重渲染整棵图表树。
 * 拖拽右侧面板 / 侧边栏 / 预览区时，宽度是**每帧**在变的（useResizablePanel 用 rAF 写 CSS 变量），
 * 于是图表每帧重渲染 + 重排一次 —— 会话里同时挂着 Mermaid / Recharts / SVG 几张图时，
 * 拖拽手柄会明显卡顿；把图表滚出可视区就流畅，正是这个原因。
 *
 * recharts 自带 debounce 开关（内部是 throttle(cb, ms, { trailing: true, leading: false })）：
 * 拖拽中每 120ms 最多重排一次（≈8 次/秒，而不是 60 次/秒），
 * trailing 保证松手后的最终尺寸一定会被应用，不会停在中间态。
 * 代价是普通窗口缩放时图表有 120ms 延迟跟上 —— 肉眼无感。
 */
const RESIZE_DEBOUNCE_MS = 120

/**
 * 面板拖拽期间，把 recharts 的尺寸响应挂起这么久（相当于「本次拖拽内不再响应」）。
 *
 * 为什么要挂起：拖拽时容器宽度每帧在变，而 chart.css 那边同时在用 CSS 把 svg
 * 按容器**等比缩放**（连续、零成本）。如果 recharts 照常每 120ms 重排一次，
 * 每次都会改掉 viewBox —— 内部布局变了，而 CSS 缩放还压在外面，
 * 两者叠加时点、线就会在「CSS 缩放」和「recharts 重排」之间来回跳，看着就是抖动
 * （折线图的点尤其明显，因为点位置每重排一次就变一次）。
 *
 * 挂起之后，拖拽期间画面只由 CSS 缩放驱动，是连续的；松手时 debounce 恢复原值，
 * ResponsiveContainer 的 effect 重跑（debounce 是它的依赖），立刻按最终尺寸量一次
 * 并重排，衔接无缝 —— 这也是为什么松手不需要额外等它。
 *
 * 取值要 < 2^31-1：setTimeout 对超过这个数的延迟会退化成 1ms（等于没挂起）。
 */
const RESIZE_SUSPEND_MS = 60_000

export default function ChartView({ spec }: { spec: ChartSpec }) {
  const series = resolveSeries(spec)
  const palette = spec.colors?.length ? spec.colors : PALETTE
  const colorAt = (i: number): string => palette[i % palette.length]
  const height = spec.height ?? 240
  const yAxisWidth = yAxisWidthOf(spec, series)

  /**
   * 面板是否正在被拖拽（useResizablePanel 会在 <html> 上挂 is-panel-resizing）。
   * 只在开始/结束各变一次，拖拽过程中不会每帧触发 —— 所以这里用 DOM 观察而不是
   * 往 store 里塞一个每帧都可能被写的状态。
   */
  const [panelResizing, setPanelResizing] = useState(false)
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setPanelResizing(root.classList.contains('is-panel-resizing'))
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  /**
   * 图表边距：四周留白均匀，绘图区落在正中间。
   *
   * 两处不对称要一起处理：
   *  ① 左右 —— 直角坐标系的左侧必须留出 Y 轴刻度带（宽 yAxisWidth），右侧默认只有 5px。
   *     所以右侧补成 left + yAxisWidth，绘图区才水平居中。
   *  ② 上下 —— 默认上下都只有 5px，而上侧没有任何元素占位，看着就是「左右有留白、
   *     上下贴着边」，头重脚轻。上侧也补到和左右同一个值，四周才均匀。
   * 下侧不补：X 轴刻度与图例本来就在绘图区下方，它们自己就撑出了呼吸空间。
   *
   * 图例与 X 轴刻度都在绘图区宽度内居中，会跟着绘图区一起对齐，不会因为补宽而偏掉。
   */
  const CHART_PAD = 12
  /** 绘图区上 / 左 / 右三侧的统一留白（左侧那份含 Y 轴刻度带） */
  const FRAME = CHART_PAD + yAxisWidth
  const cartesianMargin = { top: FRAME, right: FRAME, bottom: CHART_PAD, left: CHART_PAD }
  // 饼图 / 雷达图没有 Y 轴刻度带，四边给同一个值
  const radialMargin = { top: FRAME, right: FRAME, bottom: FRAME, left: FRAME }

  // Recharts 的 formatter 泛型签名很长，而这里只用到 value 一个参数，故放开类型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const valueFormatter: any = spec.unit
    ? (value: unknown) => `${value}${spec.unit}`
    : undefined

  const tooltip = (
    <Tooltip
      contentStyle={TOOLTIP_CONTENT_STYLE}
      itemStyle={TOOLTIP_ITEM_STYLE}
      labelStyle={TOOLTIP_LABEL_STYLE}
      formatter={valueFormatter}
    />
  )

  let body: React.ReactElement

  if (spec.type === 'pie') {
    body = (
      <PieChart margin={radialMargin}>
        {tooltip}
        <Legend wrapperStyle={LEGEND_STYLE} />
        <Pie
          data={spec.data}
          dataKey={spec.yKey as string}
          nameKey={spec.xKey}
          outerRadius="72%"
          label={{ fill: 'var(--text)', fontSize: 11 }}
        >
          {spec.data.map((_, i) => (
            <Cell key={i} fill={colorAt(i)} />
          ))}
        </Pie>
      </PieChart>
    )
  } else if (spec.type === 'radar') {
    body = (
      <RadarChart data={spec.data} outerRadius="72%" margin={radialMargin}>
        <PolarGrid stroke="var(--border)" />
        <PolarAngleAxis dataKey={spec.xKey} tick={AXIS_TICK} />
        <PolarRadiusAxis tick={AXIS_TICK} stroke="var(--border)" />
        {tooltip}
        <Legend wrapperStyle={LEGEND_STYLE} />
        {series.map((s, i) => (
          <Radar
            key={s.key}
            name={s.name ?? s.key}
            dataKey={s.key}
            stroke={s.color ?? colorAt(i)}
            fill={s.color ?? colorAt(i)}
            fillOpacity={0.28}
          />
        ))}
      </RadarChart>
    )
  } else if (spec.type === 'scatter') {
    body = (
      <ScatterChart margin={cartesianMargin}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis type="number" dataKey={spec.xKey} stroke="var(--border)" tick={AXIS_TICK} />
        <YAxis type="number" width={yAxisWidth} stroke="var(--border)" tick={AXIS_TICK} />
        {tooltip}
        {series.map((s, i) => (
          <Scatter
            key={s.key}
            name={s.name ?? s.key}
            data={spec.data}
            dataKey={s.key}
            fill={s.color ?? colorAt(i)}
          />
        ))}
      </ScatterChart>
    )
  } else {
    // line / bar / area 共用同一套坐标轴，只是主体元素不同
    const axes = (
      <>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey={spec.xKey} stroke="var(--border)" tick={AXIS_TICK} />
        <YAxis width={yAxisWidth} stroke="var(--border)" tick={AXIS_TICK} />
        {tooltip}
        <Legend wrapperStyle={LEGEND_STYLE} />
      </>
    )
    // 堆叠只对 bar / area 有意义；line 忽略该标志
    const stackId = spec.stacked ? 'rc-stack' : undefined

    body =
      spec.type === 'bar' ? (
        <BarChart data={spec.data} margin={cartesianMargin}>
          {axes}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              name={s.name ?? s.key}
              dataKey={s.key}
              fill={s.color ?? colorAt(i)}
              stackId={stackId}
              radius={spec.stacked ? 0 : [3, 3, 0, 0]}
              animationDuration={400}
            />
          ))}
        </BarChart>
      ) : spec.type === 'area' ? (
        <AreaChart data={spec.data} margin={cartesianMargin}>
          {axes}
          {series.map((s, i) => (
            <Area
              key={s.key}
              name={s.name ?? s.key}
              dataKey={s.key}
              stroke={s.color ?? colorAt(i)}
              fill={s.color ?? colorAt(i)}
              fillOpacity={0.25}
              stackId={stackId}
              animationDuration={400}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={spec.data} margin={cartesianMargin}>
          {axes}
          {series.map((s, i) => (
            <Line
              key={s.key}
              name={s.name ?? s.key}
              dataKey={s.key}
              stroke={s.color ?? colorAt(i)}
              strokeWidth={2}
              dot={spec.data.length <= 30}
              activeDot={{ r: 4 }}
              animationDuration={400}
            />
          ))}
        </LineChart>
      )
  }

  return (
    <ResponsiveContainer
      width="100%"
      height={height}
      debounce={panelResizing ? RESIZE_SUSPEND_MS : RESIZE_DEBOUNCE_MS}
    >
      {body}
    </ResponsiveContainer>
  )
}
