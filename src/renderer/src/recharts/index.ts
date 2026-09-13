/**
 * recharts/ —— SVG 图表渲染模块（独立，不依赖 jsonui / mermaid）。
 *
 * 对外只暴露三样东西：
 *   ChartCard      卡片组件，围栏路径与 jsonui 路径共用
 *   parseChartSpec 从 JSON 文本解析（失败返回 null，不抛）
 *   normalizeChartSpec 从已解析对象归一化（jsonui 路径用）
 *
 * 注意：本 barrel **不会**把 recharts 库拉进静态依赖图 ——
 * ChartCard 内部用 React.lazy 动态引入 ChartView，Vite 会把 Recharts 单独切 chunk。
 * 如果哪天改成静态 import ChartView，主包会立刻多出约 2.3MB。
 */
export { ChartCard, default as ChartCardDefault } from './ChartCard'
export type { ChartCardProps } from './ChartCard'
export { parseChartSpec, normalizeChartSpec, resolveSeries } from './parseChartSpec'
export type { ChartSpec, ChartSeries, ChartType } from './types'
