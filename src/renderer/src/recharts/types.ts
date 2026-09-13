/**
 * SVG 图表规格。
 *
 * 两个来源共用这一份类型：
 *   ① 模型在 ```chart 围栏里输出的 JSON（正文路径，见 parseContentToBlocks）
 *   ② jsonui spec 里 Chart 组件的 props（结构化 UI 路径，见 catalog.ts）
 *
 * 字段刻意保持扁平、可省略，方便模型一次写对；归一化的工作交给 parseChartSpec。
 */
export type ChartType = 'line' | 'bar' | 'area' | 'pie' | 'scatter' | 'radar'

export interface ChartSeries {
  /** data 里的字段名 */
  key: string
  /** 图例显示名，缺省用 key */
  name?: string
  /** 覆盖调色板，可写 CSS 变量，例如 var(--accent) */
  color?: string
}

export interface ChartSpec {
  type: ChartType
  title?: string | null
  /** 每行是一个数据点；值只保留 string | number */
  data: Array<Record<string, string | number>>
  /** 类目轴字段 */
  xKey: string
  /** 单序列时的取值字段；给了 series 可省略 */
  yKey?: string
  /** 多序列 */
  series?: ChartSeries[]
  /** bar / area 是否堆叠 */
  stacked?: boolean
  /** 绘图区高度，默认 240，解析时夹在 120~720 */
  height?: number
  /** 数值后缀，例如 % / ms / MB */
  unit?: string
  /** 覆盖默认调色板 */
  colors?: string[]
}
