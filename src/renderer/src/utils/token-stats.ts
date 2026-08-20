import type { TokenUsageEntry } from '../../../shared/types'

// ── Token 使用统计：本地账本聚合 ─────────────────────────────
// 移植自 local-studio 的 /usage 聚合口径（InferenceRequestStore.aggregate），
// 但数据源是本机的 chats/_token-usage.jsonl（每次流式请求结束主进程追加一行），
// 不涉及任何云端模型的 token 计数逻辑。
// 「输入」一律采用 promptDelta（与同端口上一次请求相比的增长量）口径：
// 避免工具循环/多轮对话把历史上下文反复计入消耗。

export interface TokenCardInfo {
  name: string
  modelPath: string | null
}
export type TokenCardLookup = (templateId: string) => TokenCardInfo | null

export interface TokenModelRow {
  model: string            // 分组键：modelPath || templateId || `port:N`
  name: string             // 展示名：模型文件名
  templateName: string | null
  modelPath: string | null
  requests: number
  total_tokens: number     // 输入(增量) + 输出(实测)
  prompt_tokens: number    // 输入（新增量）
  completion_tokens: number
  avg_tokens: number
}

export interface TokenDayRow {
  date: string             // 本地日期 YYYY-MM-DD
  requests: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
}

export interface TokenModelDayRow extends TokenDayRow {
  model: string
}

export interface TokenStats {
  totals: {
    total_requests: number
    total_tokens: number
    prompt_tokens: number
    completion_tokens: number
    models: number
  }
  recent_activity: {
    last_hour_requests: number
    last_24h_requests: number
    prev_24h_requests: number
    last_24h_tokens: number
    change_24h_pct: number | null
  }
  week_over_week: {
    this_week: { requests: number; tokens: number }
    last_week: { requests: number; tokens: number }
    change_pct: { requests: number | null; tokens: number | null }
  }
  peak_days: Array<{ date: string; requests: number; tokens: number }>
  by_model: TokenModelRow[]
  daily: TokenDayRow[]          // 首个记账日起，最多 366 天（含零流量的日子）
  daily_by_model: TokenModelDayRow[]
  hourly_pattern: Array<{ hour: number; requests: number; tokens: number }>
}

// ── 数字格式化 ──────────────────────────────────────────────
// 标题数字用 toLocaleString（可精确读数），次要行用紧凑格式（x.xk / x.xM）
export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

export function fmtCompactTokens(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`
  if (totalTokens < 1_000_000) {
    const v = totalTokens / 1000
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}k`
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`
}

/** "+12%" / "-3%" / "—"（无基数时无法计算） */
export function fmtSignedPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${Math.round(value)}%`
}

/** 变化方向 → 色调：增长对活跃度是好事（绿），回落是警示（橙） */
export function changeTone(value: number | null): 'default' | 'ok' | 'warn' {
  if (value === null) return 'default'
  if (value > 0) return 'ok'
  if (value < 0) return 'warn'
  return 'default'
}

// ── 日期工具（全部用本地时区：本地工具问的是「我的机器什么时候忙」） ──
const pad = (n: number): string => String(n).padStart(2, '0')

export function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString('zh-CN', {
    weekday: 'short', month: 'numeric', day: 'numeric',
  })
}

export function monthLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return '无日期'
  return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
}

export function dateLabel(date: Date): string {
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export const DAY_MS = 86_400_000

/** 本地时区的「周一 00:00」：周统计的起点 */
export function startOfLocalWeek(ts: number): number {
  const d = new Date(ts)
  const day = (d.getDay() + 6) % 7 // 周一 = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime()
}

/** 从路径取文件名（如 D:\models\qwen2.5.gguf → qwen2.5.gguf） */
export function modelFileOf(modelPath: string | null | undefined): string | null {
  if (!modelPath) return null
  const parts = modelPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || modelPath
}

// ── 模型配色：按首次出现顺序分配（表格圆点与抽屉共用） ──
const MODEL_COLORS = [
  '#4f8cff', '#22c55e', '#f59e0b', '#e5484d', '#0ea5e9',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b',
]

export function buildModelColors(modelKeys: readonly string[]): Map<string, string> {
  const colorOf = new Map<string, string>()
  for (const key of modelKeys) {
    if (!colorOf.has(key)) {
      colorOf.set(key, MODEL_COLORS[colorOf.size % MODEL_COLORS.length])
    }
  }
  return colorOf
}

// ── 聚合 ────────────────────────────────────────────────────
export function buildTokenStats(
  entries: TokenUsageEntry[],
  cardOf: TokenCardLookup,
  now: number = Date.now(),
): TokenStats {
  const sorted = [...entries].filter(e => typeof e.ts === 'number').sort((a, b) => a.ts - b.ts)
  const EMPTY: TokenStats = {
    totals: { total_requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, models: 0 },
    recent_activity: {
      last_hour_requests: 0, last_24h_requests: 0, prev_24h_requests: 0,
      last_24h_tokens: 0, change_24h_pct: null,
    },
    week_over_week: {
      this_week: { requests: 0, tokens: 0 }, last_week: { requests: 0, tokens: 0 },
      change_pct: { requests: null, tokens: null },
    },
    peak_days: [],
    by_model: [],
    daily: [],
    daily_by_model: [],
    hourly_pattern: Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, tokens: 0 })),
  }
  if (sorted.length === 0) return EMPTY

  const modelMap = new Map<string, TokenModelRow>()
  const dayMap = new Map<string, TokenDayRow>()
  const dayModelMap = new Map<string, Map<string, TokenModelDayRow>>()
  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, tokens: 0 }))

  let totalRequests = 0
  let totalTokens = 0
  let totalPrompt = 0
  let totalCompletion = 0

  const ensureModel = (e: TokenUsageEntry, card: TokenCardInfo | null): TokenModelRow => {
    const key = e.modelPath || e.templateId || `port:${e.port}`
    let m = modelMap.get(key)
    if (!m) {
      m = {
        model: key,
        name: modelFileOf(e.modelPath) ?? card?.name ?? (e.templateId ? `模板 ${e.templateId.slice(0, 8)}` : `端口 ${e.port}`),
        templateName: card?.name ?? null,
        modelPath: e.modelPath ?? null,
        requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, avg_tokens: 0,
      }
      modelMap.set(key, m)
    }
    return m
  }

  const ensureDay = (key: string): TokenDayRow => {
    let row = dayMap.get(key)
    if (!row) {
      row = { date: key, requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }
      dayMap.set(key, row)
    }
    return row
  }

  const ensureDayModel = (date: string, modelKey: string): TokenModelDayRow => {
    let byModel = dayModelMap.get(date)
    if (!byModel) {
      byModel = new Map()
      dayModelMap.set(date, byModel)
    }
    let row = byModel.get(modelKey)
    if (!row) {
      row = { date, model: modelKey, requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }
      byModel.set(modelKey, row)
    }
    return row
  }

  for (const e of sorted) {
    const card = e.templateId ? cardOf(e.templateId) : null
    // 输入取「新增输入」：promptDelta（与同端口上一次请求相比的增长量）优先，
    // 无该字段（旧记录）或上下文重置时回退完整输入
    const inN = typeof e.promptDelta === 'number' && e.promptDelta > 0
      ? e.promptDelta
      : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)
    const outN = typeof e.completionTokens === 'number' ? e.completionTokens : 0
    const total = inN + outN

    totalRequests += 1
    totalTokens += total
    totalPrompt += inN
    totalCompletion += outN

    const m = ensureModel(e, card)
    m.requests += 1
    m.total_tokens += total
    m.prompt_tokens += inN
    m.completion_tokens += outN
    m.avg_tokens = m.requests > 0 ? m.total_tokens / m.requests : 0

    const day = ensureDay(dayKeyOf(e.ts))
    day.requests += 1
    day.total_tokens += total
    day.prompt_tokens += inN
    day.completion_tokens += outN

    const dm = ensureDayModel(day.date, m.model)
    dm.requests += 1
    dm.total_tokens += total
    dm.prompt_tokens += inN
    dm.completion_tokens += outN

    const hour = new Date(e.ts).getHours()
    hourBuckets[hour].requests += 1
    hourBuckets[hour].tokens += total
  }

  // ── 时间窗（全部按本地时钟） ──
  const hourAgo = now - 3_600_000
  const dayAgo = now - DAY_MS
  const twoDaysAgo = now - 2 * DAY_MS
  let lastHour = 0
  let last24h = 0
  let prev24h = 0
  let last24hTokens = 0
  for (const e of sorted) {
    if (e.ts >= hourAgo) lastHour += 1
    if (e.ts >= dayAgo) { last24h += 1; last24hTokens += (typeof e.promptDelta === 'number' && e.promptDelta > 0 ? e.promptDelta : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)) + (typeof e.completionTokens === 'number' ? e.completionTokens : 0) }
    else if (e.ts >= twoDaysAgo) prev24h += 1
  }
  const change_24h_pct = prev24h > 0 ? ((last24h - prev24h) / prev24h) * 100 : null

  // ── 周统计：本周（周一 00:00 起）与上周 ──
  const thisWeekStart = startOfLocalWeek(now)
  const lastWeekStart = thisWeekStart - 7 * DAY_MS
  let thisWeek: { requests: number; tokens: number } = { requests: 0, tokens: 0 }
  let lastWeek: { requests: number; tokens: number } = { requests: 0, tokens: 0 }
  for (const e of sorted) {
    if (e.ts < lastWeekStart) continue
    const inN = typeof e.promptDelta === 'number' && e.promptDelta > 0 ? e.promptDelta : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)
    const total = inN + (typeof e.completionTokens === 'number' ? e.completionTokens : 0)
    if (e.ts >= thisWeekStart) { thisWeek.requests += 1; thisWeek.tokens += total }
    else { lastWeek.requests += 1; lastWeek.tokens += total }
  }
  const weekChange: TokenStats['week_over_week']['change_pct'] = {
    requests: lastWeek.requests > 0 ? ((thisWeek.requests - lastWeek.requests) / lastWeek.requests) * 100 : null,
    tokens: lastWeek.tokens > 0 ? ((thisWeek.tokens - lastWeek.tokens) / lastWeek.tokens) * 100 : null,
  }

  // ── 逐日序列：首个记账日 → 今天，最多 366 天（含零流量日，表格与热力图共用） ──
  const firstDay = sorted[0] ? dayKeyOf(sorted[0].ts) : dayKeyOf(now)
  const lastDay = dayKeyOf(now)
  const daily: TokenDayRow[] = []
  const cursor = new Date(`${firstDay}T00:00:00`)
  const stop = new Date(`${lastDay}T00:00:00`)
  while (cursor.getTime() <= stop.getTime() && daily.length <= 366) {
    const key = dayKeyOf(cursor.getTime())
    daily.push(dayMap.get(key) ?? { date: key, requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }

  // ── 历史峰值：全部记录里 tokens 最高的 5 天 ──
  const peakDays = [...dayMap.values()]
    .filter(day => day.total_tokens > 0)
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 5)
    .map(day => ({ date: day.date, requests: day.requests, tokens: day.total_tokens }))

  const byModel = [...modelMap.values()].sort((a, b) => b.total_tokens - a.total_tokens)
  const dailyByModel = [...dayModelMap.values()]
    .flatMap(map => [...map.values()])
    .sort((a, b) => (a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date)))

  return {
    totals: {
      total_requests: totalRequests, total_tokens: totalTokens,
      prompt_tokens: totalPrompt, completion_tokens: totalCompletion,
      models: byModel.length,
    },
    recent_activity: {
      last_hour_requests: lastHour, last_24h_requests: last24h,
      prev_24h_requests: prev24h, last_24h_tokens: last24hTokens,
      change_24h_pct,
    },
    week_over_week: { this_week: thisWeek, last_week: lastWeek, change_pct: weekChange },
    peak_days: peakDays,
    by_model: byModel,
    daily,
    daily_by_model: dailyByModel,
    hourly_pattern: hourBuckets,
  }
}

// ── 单日的时段分布 ─────────────────────────────────────────
// 热力图点击某一天时，把它那一天里 24 个小时各自有多少请求算出来，
// 交给「一天中的时段」柱状图显示。口径与全局聚合完全一致（输入取增量）。
export function hourlyForDay(
  entries: TokenUsageEntry[],
  dayKey: string,
): Array<{ hour: number; requests: number; tokens: number }> {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, tokens: 0 }))
  for (const e of entries) {
    if (typeof e.ts !== 'number' || dayKeyOf(e.ts) !== dayKey) continue
    const inN = typeof e.promptDelta === 'number' && e.promptDelta > 0
      ? e.promptDelta
      : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)
    const total = inN + (typeof e.completionTokens === 'number' ? e.completionTokens : 0)
    const hour = new Date(e.ts).getHours()
    buckets[hour].requests += 1
    buckets[hour].tokens += total
  }
  return buckets
}