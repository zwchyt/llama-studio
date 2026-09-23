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
import type { ChartSpec } from './types'
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
const AXIS_TICK = { fill: 'var(--text-muted)', fontSize: 11 }
const LEGEND_STYLE = { fontSize: 12, color: 'var(--text-secondary)' }

export default function ChartView({ spec }: { spec: ChartSpec }) {
  const series = resolveSeries(spec)
  const palette = spec.colors?.length ? spec.colors : PALETTE
  const colorAt = (i: number): string => palette[i % palette.length]
  const height = spec.height ?? 240

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
      <PieChart>
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
      <RadarChart data={spec.data} outerRadius="72%">
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
      <ScatterChart>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis type="number" dataKey={spec.xKey} stroke="var(--border)" tick={AXIS_TICK} />
        <YAxis type="number" stroke="var(--border)" tick={AXIS_TICK} />
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
        <YAxis stroke="var(--border)" tick={AXIS_TICK} />
        {tooltip}
        <Legend wrapperStyle={LEGEND_STYLE} />
      </>
    )
    // 堆叠只对 bar / area 有意义；line 忽略该标志
    const stackId = spec.stacked ? 'rc-stack' : undefined

    body =
      spec.type === 'bar' ? (
        <BarChart data={spec.data}>
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
        <AreaChart data={spec.data}>
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
        <LineChart data={spec.data}>
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
    <ResponsiveContainer width="100%" height={height}>
      {body}
    </ResponsiveContainer>
  )
}
