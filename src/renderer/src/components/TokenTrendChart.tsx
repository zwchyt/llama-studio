import React, { useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, usePlotArea
} from 'recharts'
import '../styles/token-stats.css'

/** 图表点：按时间顺序的请求记录 */
export interface TrendPoint {
  x: string            // 完整时间标识（用于悬浮提示）
  ts: number           // 请求时间戳（x 轴定位，一天内按 24h 分布）
  modelKey: string     // 模型分组键（modelPath）
  modelName: string    // 模型展示名（文件名）
  total: number        // 该次请求消耗 token 合计
}

/** 每个模型固定的颜色（按出现顺序取色，超出循环） */
const MODEL_COLORS = [
  '#4f8cff', '#22c55e', '#f59e0b', '#e5484d', '#0ea5e9',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b',
]

/**
 * 按模型键的「首次出现顺序」分配固定颜色。
 * 趋势图曲线与「按模型汇总」进度条共享同一映射，保证两处颜色一致。
 */
export function buildModelColors(modelKeys: string[]): Map<string, string> {
  const colorOf = new Map<string, string>()
  for (const key of modelKeys) {
    if (!colorOf.has(key)) {
      colorOf.set(key, MODEL_COLORS[colorOf.size % MODEL_COLORS.length])
    }
  }
  return colorOf
}

function fmtAxisTokens(v: number): string {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}k`
  return `${v}`
}

/** x 轴刻度显示：只显示日期（月/日，跨年补年份），不显示时分 */
function fmtDayShort(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  return d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/${md}` : md
}

/** 单日数据时 x 轴刻度只显示时分（24 小时制） */
function fmtClock(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 悬浮提示的完整时间：日期 + 时分 */
function fmtFullTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

/**
 * 生成裁剪区域：把 0 值线（= 绘图区底部，Y 轴 domain 从 0 开始）以下的曲线
 * 全部裁掉，让 natural 样条过冲造成的“下滑”部分彻底消失。
 * 必须在 AreaChart 内部渲染（依赖图表 context 提供 plotArea）；
 * plotArea 尚未就绪时兜底为不裁剪（高度取极大值），避免曲线短暂消失。
 */
function ZeroBaselineClip() {
  const plotArea = usePlotArea()
  const plotBottom = plotArea ? plotArea.y + plotArea.height : 9999
  return (
    <defs>
      <clipPath id="ts-zero-clip">
        <rect x={0} y={0} width={9999} height={Math.max(plotBottom, 0)} />
      </clipPath>
    </defs>
  )
}

/**
 * Token 使用趋势面积图（recharts）：
 * 每个请求一个数据点，x 轴为等间距请求序号（刻度标注真实日期/时间，避免请求
 * 集中在同一时段时挤成一团、自然样条过冲），纵轴为「该次请求的 token 消耗量」
 * （有峰有谷的波浪，类似 Chart.js tension 平滑效果）；
 * 每个模型一条平滑曲线（线下带颜色填充、不堆叠，natural 样条经过每个数据点，
 * 峰谷与请求时刻对齐、波浪起伏明显；0 值线以下区域用 SVG clipPath 精确裁剪，
 * 样条过冲的下滑部分彻底消失），无请求的模型在该时刻值为 0。
 */
export default function TokenTrendChart({ points, colorOf }: { points: TrendPoint[]; colorOf: Map<string, string> }) {
  const { rows, models, ticks, isSingleDay } = useMemo(() => {
    const sorted = [...points].filter(p => !Number.isNaN(p.ts)).sort((a, b) => a.ts - b.ts)
    if (sorted.length === 0) return { rows: [], models: [], ticks: [] as number[], isSingleDay: true }

    // 模型 → 颜色（沿用汇总表共享的同一张映射表）
    const modelOrder: string[] = []
    for (const p of sorted) {
      if (!modelOrder.includes(p.modelKey)) modelOrder.push(p.modelKey)
    }

    // 每行 = 一次请求；各模型值为「该次请求的消耗量」（无请求的时刻为 0，曲线回落
    // 到底部是正常形态，配合平滑插值呈现波浪起伏）。保持 0 值连续：若用 null 断开，
    // 请求稀疏的模型曲线会碎成多段，反而失去时间线的连续性。
    // x 轴改用等间距序号 i（而非真实时间戳）：同一时段请求密集时不会挤成一团，
    // 波浪均匀平滑；刻度再从序号映射回真实日期/时间标注。
    const rows = sorted.map((p, i) => {
      const row: Record<string, string | number> = { i, ts: p.ts, full: p.x }
      for (const key of modelOrder) row[key] = 0
      row[p.modelKey] = p.total
      return row
    })

    // x 轴刻度：每个出现过的日期取「当天首个请求的序号」作为刻度位置
    const daySet = new Map<string, number>()
    sorted.forEach((p, i) => {
      const d = new Date(p.ts)
      if (Number.isNaN(d.getTime())) return
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      if (!daySet.has(key)) daySet.set(key, i)
    })
    const dayTicks = [...daySet.values()].sort((a, b) => a - b)
    // 单日数据：刻度太稀疏（只有一个日期），补首/中/尾三个位置并显示时分
    const isSingleDay = dayTicks.length <= 1
    const ticks = isSingleDay
      ? rows.length > 1 ? [0, Math.floor((rows.length - 1) / 2), rows.length - 1] : [0]
      : dayTicks

    const models = modelOrder.map(key => ({
      key,
      name: sorted.find(p => p.modelKey === key)?.modelName ?? key,
      color: colorOf.get(key) ?? MODEL_COLORS[0],
    }))
    return { rows, models, ticks, isSingleDay }
  }, [points, colorOf])

  if (rows.length === 0) {
    return <div className="ts-chart-empty">暂无趋势数据（需要至少一条记账记录）</div>
  }

  return (
    <div className="ts-chart">
      <div className="ts-chart-body">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: -13, left: 0 }}>
          <ZeroBaselineClip />
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(127,127,127,.18)" vertical={false} />
          <XAxis
            dataKey="i"
            type="number"
            domain={[-0.5, Math.max(rows.length - 0.5, 1)]}
            ticks={ticks.length > 0 ? ticks : undefined}
            tickFormatter={(v: number) => {
              const row = rows[Math.round(Number(v))]
              if (!row) return ''
              return isSingleDay ? fmtClock(Number(row.ts)) : fmtDayShort(Number(row.ts))
            }}
            tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
            tickLine={false}
            // 底部贯穿时间线的 X 轴轴线：透明（用户确认——只改这条轴线的颜色，
            // 不影响任何模型曲线的波浪/颜色）
            axisLine={false}
          />
          <YAxis
            domain={[0, (dataMax: number) => Math.max(dataMax * 1.12, 100)]}
            tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={fmtAxisTokens}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'var(--text-primary)', marginBottom: 4 }}
            formatter={(value, name) => [`${Number(value || 0).toLocaleString()} tokens`, String(name)]}
            content={({ active, payload }: any) => {
              // 只显示「该次请求实际有 token 消耗」的模型，值为 0 的不显示
              if (!active || !Array.isArray(payload)) return null
              const items = (payload as any[]).filter(
                (p: any) => p.dataKey !== 'full' && Number(p.value) > 0
              )
              if (items.length === 0) return null
              // 时间从当前行的真实时间戳取（x 轴已改为等间距序号，不能再拿 label 当时间戳）
              const row = (payload as any[])[0]?.payload
              const time = row && typeof row.ts === 'number' ? fmtFullTime(Number(row.ts)) : ''
              return (
                <div className="ts-tooltip">
                  <div className="ts-tooltip-time">{time}</div>
                  {items.map(p => (
                    <div key={p.dataKey} className="ts-tooltip-row">
                      <span className="ts-tooltip-dot" style={{ background: p.color }} />
                      <span className="ts-tooltip-name">{String(p.name)}</span>
                      <span className="ts-tooltip-val">{Number(p.value).toLocaleString()} tokens</span>
                    </div>
                  ))}
                </div>
              )
            }}
          />
          {models.map(m => (
            <Area
              key={m.key}
              type="natural"
              dataKey={m.key}
              name={m.name}
              stroke={m.color}
              strokeWidth={2}
              fill={m.color}
              // 填充透明度压低：多个模型的半透明填充都会在 0 基线处收口成一条贴底边，
              // 叠加混合后形成一条贯穿底部的杂色带（如蓝+红混合成紫色），观感像一条
              // 无意义的横线。0.08 下叠加带基本不可见，曲线仍清晰。
              fillOpacity={0.08}
              activeDot={{ r: 4 }}
              clipPath="url(#ts-zero-clip)"
            />
          ))}
        </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}