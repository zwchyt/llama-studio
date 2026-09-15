import type { ChartSeries, ChartSpec, ChartType } from './types'

const CHART_TYPES: readonly ChartType[] = ['line', 'bar', 'area', 'pie', 'scatter', 'radar']
/**
 * `{"type": "Chart", ...}`（只给组件名、没给图表种类）时的兜底种类。
 * 选 bar 而不是 line：这类数据多是「类目 + 数值」（季度 / 月份 / 机型…）的对比，
 * 柱状比折线更贴近模型想表达的东西。要改只动这一个常量。
 */
const DEFAULT_CHART_TYPE: ChartType = 'bar'
/** 上限是为了挡住模型偶发的「几千个点」输出：Recharts 逐点建 DOM，过量会直接卡住渲染。 */
const MAX_POINTS = 2000
const MAX_SERIES = 8
const MAX_CODE_LEN = 200_000

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 只认「自身属性」。
 *
 * 这里必须用 hasOwnProperty 而不是 `in`：`in` 会沿原型链查找，于是
 * constructor / toString / valueOf / hasOwnProperty / __proto__ 这几个名字
 * 即使数据里根本没有，也会被判为「存在」而通过校验。随后 Recharts 会拿
 * `row.toString` 去当坐标值——取到的是一个函数而不是数字，整条轴的刻度
 * 直接算成 NaN，图变成空白。用 `in` 等于把校验让给了 Object.prototype。
 */
function hasKey(obj: Record<string, string | number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * 数据点清洗：只保留有限 number 与 string。
 * null / undefined / NaN / Infinity / 嵌套对象一律丢弃——它们会让 Recharts 的
 * 坐标计算出 NaN，整张图变成空白或直接抛错，不如在入口挡掉。
 */
function normalizeData(raw: unknown): Array<Record<string, string | number>> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_POINTS) return null
  const out: Array<Record<string, string | number>> = []
  for (const row of raw) {
    if (!isPlainObject(row)) return null
    const clean: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'number') {
        if (Number.isFinite(v)) clean[k] = v
      } else if (typeof v === 'string') {
        clean[k] = v
      } else if (typeof v === 'boolean') {
        clean[k] = String(v)
      }
    }
    if (Object.keys(clean).length === 0) return null
    out.push(clean)
  }
  return out
}

function normalizeSeries(raw: unknown): ChartSeries[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ChartSeries[] = []
  for (const s of raw) {
    // 允许简写成字符串数组：series: ["cpu", "mem"]
    if (typeof s === 'string') {
      if (s) out.push({ key: s })
    } else if (isPlainObject(s) && typeof s.key === 'string' && s.key) {
      out.push({
        key: s.key,
        name: typeof s.name === 'string' ? s.name : undefined,
        color: typeof s.color === 'string' && s.color ? s.color : undefined,
      })
    } else {
      continue
    }
    if (out.length >= MAX_SERIES) break
  }
  return out.length ? out : undefined
}

function normalizeStringArray(raw: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '').slice(0, limit)
  return out.length ? out : undefined
}

/**
 * 把「已经是对象」的候选值归一化成 ChartSpec。
 *
 * jsonui 那条路径（模型直接给结构化 props）拿到的就是对象，不需要过 JSON.parse；
 * 围栏路径则先 parse 再走这里。两条路共用同一套校验，避免规则漂移。
 *
 * **任何异常都返回 null，绝不抛。** 调用方据此静默降级为普通代码块——
 * 这与 MermaidCard 的降级策略一致：模型偶尔会把普通代码误标成 ```chart，
 * 那种情况下不该给用户看一张「渲染失败」的错误卡。
 */
export function normalizeChartSpec(input: unknown): ChartSpec | null {
  if (!isPlainObject(input)) return null
  // 显式标注类型：下面会把 raw 重新指向 raw.chart / raw.spec，
  // 若让它保持 unknown，后续所有属性访问都会丢收窄。
  let raw: Record<string, unknown> = input

  // 有些模型会多包一层：{"chart": {...}} / {"spec": {...}} / {"data": {"chart": ...}}
  if (isPlainObject(raw.chart)) raw = raw.chart
  else if (isPlainObject(raw.spec)) raw = raw.spec

  const typeRaw = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  // 兼容几个常见别名
  const alias: Record<string, ChartType> = {
    column: 'bar',
    linechart: 'line',
    barchart: 'bar',
    piechart: 'pie',
    areachart: 'area',
    donut: 'pie',
  }
  // `{"type": "Chart", ...}`：模型把 jsonui 的**组件名**当成了图表种类。
  // 这种对象除了「图表种类」一项之外与 ChartSpec 完全同构（data / xKey / series
  // 都在），不认它等于把一整份数据当源码摊在正文里。给它一个默认种类，
  // 比退化成代码块好得多 —— 卡片工具条本来就能查看源码。
  // 只在 type 明确等于组件名时才兜底：type 缺失或写错（如 "piee"）仍旧判失败，
  // 免得把任意带 data/xKey 的 JSON 都误当图表。
  const type: ChartType | undefined = CHART_TYPES.includes(typeRaw as ChartType)
    ? (typeRaw as ChartType)
    : (alias[typeRaw] ?? (typeRaw === 'chart' ? DEFAULT_CHART_TYPE : undefined))
  if (!type) return null

  const data = normalizeData(raw.data)
  if (!data) return null

  const xKey = typeof raw.xKey === 'string' ? raw.xKey.trim() : ''
  if (!xKey) return null

  const yKey = typeof raw.yKey === 'string' && raw.yKey.trim() ? raw.yKey.trim() : undefined
  const series = normalizeSeries(raw.series)

  // 至少要有一个取值字段，否则画不出任何东西
  if (!yKey && !series) return null
  // 饼图靠「类目 + 数值」两列成图，必须有 yKey
  if (type === 'pie' && !yKey) return null
  // xKey / yKey 必须在数据里真实存在，否则 Recharts 会画出一条空线
  const sample = data[0]
  if (!hasKey(sample, xKey)) return null
  if (yKey && !hasKey(sample, yKey)) return null
  if (series && !series.some((s) => hasKey(sample, s.key))) return null

  const height =
    typeof raw.height === 'number' && Number.isFinite(raw.height)
      ? Math.min(720, Math.max(120, Math.round(raw.height)))
      : undefined

  return {
    type,
    title: typeof raw.title === 'string' ? raw.title : null,
    data,
    xKey,
    yKey,
    series,
    stacked: raw.stacked === true,
    height,
    unit: typeof raw.unit === 'string' && raw.unit ? raw.unit : undefined,
    colors: normalizeStringArray(raw.colors, MAX_SERIES),
  }
}

/** 围栏路径入口：把 ```chart 里的 JSON 文本解析成 ChartSpec，失败返回 null。 */
export function parseChartSpec(code: string): ChartSpec | null {
  if (typeof code !== 'string' || !code || code.length > MAX_CODE_LEN) return null
  try {
    return normalizeChartSpec(JSON.parse(code))
  } catch {
    return null
  }
}

/** 把 spec 展开成「一条序列一项」的列表，渲染层和调色板都按这个顺序取色。 */
export function resolveSeries(spec: ChartSpec): ChartSeries[] {
  if (spec.series?.length) return spec.series
  if (spec.yKey) return [{ key: spec.yKey, name: spec.yKey }]
  return []
}
