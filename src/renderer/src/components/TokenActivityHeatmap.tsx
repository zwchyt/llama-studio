import { useState } from 'react'
import { DAY_MS, dateLabel, dayKeyOf, formatNumber } from '../utils/token-stats'
import type { TokenDayRow } from '../utils/token-stats'

// ── 当年完整 12 个月的每日 token 热力图（GitHub 风格日历） ─────
// 移植自 local-studio 的 token-activity-heatmap，但范围改为**当年自然年全年**
// （当年 1 月 1 日 → 当年 12 月 31 日）：一整年 12 个月完整显示，
// 今天之后尚未到来的日子以占位格空出，不伪造读数。
// 量化阈值（p25/p50/p75）分 5 档，不按线性色阶——只有用相对强度才能让
// 「稀疏但都有量的本地账本」也读得出形状。
// 着色用主题色 --accent 而非固定色板，让它跟随亮/暗主题。

const LEVEL_CLASSES = ['ts-hm-l0', 'ts-hm-l1', 'ts-hm-l2', 'ts-hm-l3', 'ts-hm-l4']
const ROWS = 7

const quantile = (values: number[], fraction: number): number =>
  values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0

const thresholds = (values: number[]): number[] => {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b)
  return [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)]
}

const activityLevel = (value: number, limits: number[]): number => {
  if (value <= 0) return 0
  if (value <= (limits[0] ?? 0)) return 1
  if (value <= (limits[1] ?? 0)) return 2
  if (value <= (limits[2] ?? 0)) return 3
  return 4
}

type HeatmapCell = {
  date: Date
  usage: TokenDayRow | undefined
  level: number
  future: boolean
} | null

/**
 * 当年完整的每日 token 热力图。
 * 网格从 1 月 1 日所在的列开始（月初的星期偏移先用占位补齐），
 * 到当年 12 月 31 日结束——一个月不少地画满十二个月。
 * 今天之后的未来格子用占位样式空出，不参与配色，也不假装读出 0。
 * 悬停/键盘聚焦只做虚线预览；点击某一天才真正选中它（回调 onChange 通知父级，
 * 例如让「一天中的时段」联动显示那一天），再点一次同为取消选中。
 */
export function TokenActivityHeatmap({
  daily,
  value,
  onChange,
}: {
  daily: TokenDayRow[]
  value: string | null
  onChange: (dateKey: string | null) => void
}) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yearStart = new Date(today.getFullYear(), 0, 1)
  const yearEnd = new Date(today.getFullYear(), 11, 31)
  const leading = yearStart.getDay() // 0=周日；1月1日前的空槽
  const daysInYear = Math.round((yearEnd.getTime() - yearStart.getTime()) / DAY_MS) + 1
  const weeks = Math.ceil((leading + daysInYear) / ROWS)

  const byDate = new Map(daily.map(day => [day.date, day]))

  // 当年已过去的时间内出现过流量的值，用于量化阈值（只看今年数据）
  const yearValues: number[] = []
  const cells: HeatmapCell[] = Array.from({ length: weeks * ROWS }, (_, index) => {
    if (index < leading) return null
    const date = new Date(yearStart.getTime() + (index - leading) * DAY_MS)
    const future = date.getTime() > today.getTime()
    const usage = future ? undefined : byDate.get(dayKeyOf(date.getTime()))
    if (!future && usage && usage.total_tokens > 0) yearValues.push(usage.total_tokens)
    return { date, usage, level: 0, future }
  })
  const limits = thresholds(yearValues)
  for (const cell of cells) {
    if (cell?.usage && cell.usage.total_tokens > 0) {
      cell.level = activityLevel(cell.usage.total_tokens, limits)
    }
  }

  // 悬停/聚焦的临时预览；选中的持久状态在 value 里由父级持有
  const [hovered, setHovered] = useState<string | null>(null)
  const activeKey = hovered ?? value

  // 每列顶部一个月份标签：列里第一个有数据的日期所属月份，月份变化才写
  const monthLabels = Array.from({ length: weeks }, (_, col) => {
    for (let row = 0; row < ROWS; row += 1) {
      const cell = cells[col * ROWS + row]
      if (cell) {
        return cell.date.toLocaleDateString('zh-CN', { month: 'short' })
      }
    }
    return null
  })
  // 连续相同的月份只标一次
  const displayed = monthLabels.map((label, col) =>
    col > 0 && label === monthLabels[col - 1] ? null : label,
  )

  const hoveredCell = cells.find(cell => cell && dayKeyOf(cell.date.getTime()) === activeKey) ?? null

  return (
    <div className="ts-hm-scroll">
      <div className="ts-hm">
        <div className="ts-hm-months">
          {displayed.map((label, index) => (
            <span key={index} className="ts-hm-month">{label ?? ''}</span>
          ))}
        </div>
        <div className="ts-hm-grid" aria-label={`${today.getFullYear()} 年全年的每日 token 活动`}>
          {cells.map((cell, index) => {
            if (!cell) {
              return <span key={`pad-${index}`} className="ts-hm-pad" />
            }
            if (cell.future) {
              return <span key={`fut-${index}`} className="ts-hm-future" />
            }
            const key = dayKeyOf(cell.date.getTime())
            const selected = value === key
            return (
              <button
                key={key}
                type="button"
                onFocus={() => setHovered(key)}
                onMouseEnter={() => setHovered(key)}
                onClick={() => onChange(selected ? null : key)}
                aria-label={`${dateLabel(cell.date)}：${formatNumber(cell.usage?.total_tokens ?? 0)} tokens，${formatNumber(cell.usage?.requests ?? 0)} 次请求${selected ? '（已选中）' : ''}`}
                className={`ts-hm-cell ${LEVEL_CLASSES[cell.level]}${selected ? ' ts-hm-selected' : ''}`}
              />
            )
          })}
        </div>
        <div className="ts-hm-legend">
          <span className="ts-hm-active">
            {hoveredCell
              ? `${dateLabel(hoveredCell.date)} · ${formatNumber(hoveredCell.usage?.total_tokens ?? 0)} tokens · ${formatNumber(hoveredCell.usage?.requests ?? 0)} 次请求`
              : value
                ? `${dateLabel(new Date(`${value}T00:00:00`))} · 已选中（再次点击取消）`
                : null}
          </span>
          <div className="ts-hm-scale">
            <span>少</span>
            {LEVEL_CLASSES.map(className => <span key={className} className={`ts-hm-swatch ${className}`} />)}
            <span>多</span>
          </div>
        </div>
      </div>
    </div>
  )
}