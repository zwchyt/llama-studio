import { useMemo, useState } from 'react'
import {
  DataRow, EndCell, GroupRow, HeadCell, LeadCell, NumCell, StatStrip, TableFrame, TableNotice,
  useSortedRows, type Stat,
} from './TokenUsageTable'
import { UsageBarRow, type UsageBar } from './TokenUsageBars'
import {
  changeTone, dayLabel, fmtCompactTokens, fmtSignedPct, formatNumber, hourlyForDay, monthLabel,
} from '../utils/token-stats'
import type { TokenDayRow, TokenStats } from '../utils/token-stats'
import type { TokenUsageEntry, TokenUsageRollupRow } from '../../../shared/types'
import { useBubbleTip } from './useBubbleTip'

type SortKey = 'date' | 'requests' | 'tokens' | 'prompt' | 'completion'

/** 逐日表默认最多摊多少行；超出的折进「展开其余 N 天」 */
const DAY_ROW_LIMIT = 30

const sortValue = (row: TokenDayRow, key: SortKey): number | string | null => {
  switch (key) {
    case 'requests': return row.requests
    case 'tokens': return row.total_tokens
    case 'prompt': return row.prompt_tokens
    case 'completion': return row.completion_tokens
    default: return row.date
  }
}

/** 连续的同月段并组，让组头成为真正的断点 */
function byMonth(rows: readonly TokenDayRow[]): Array<{ label: string; rows: TokenDayRow[] }> {
  const groups: Array<{ label: string; rows: TokenDayRow[] }> = []
  for (const row of rows) {
    const label = monthLabel(row.date)
    const current = groups[groups.length - 1]
    if (current?.label === label) current.rows.push(row)
    else groups.push({ label, rows: [row] })
  }
  return groups
}

export function TokenUsageActivityTab({
  stats, entries, rollup, selectedDay, onSelectDay,
}: {
  stats: TokenStats
  entries: TokenUsageEntry[]
  rollup: TokenUsageRollupRow[]
  /** 热力图选中的日子：热力图在页签之上（见 TokenStatsView 的总览区），选中态由父级持有 */
  selectedDay: string | null
  onSelectDay: (dateKey: string | null) => void
}) {
  const { sorted, head } = useSortedRows<TokenDayRow, SortKey>(stats.daily, sortValue, {
    key: 'date',
    desc: true,
  })
  const activeDays = stats.daily.filter(day => day.total_tokens > 0).length

  // 逐日表只列「有流量」的日子：零流量的空行整行都是 0，留着只会把表拉成一条
  // 读不出形状的流水账（那些日子在热力图上已经有位置了）。
  // 再按 DAY_ROW_LIMIT 行封顶，超出的折进「展开其余 N 天」，默认不把整本账摊开。
  const activeRows = useMemo(
    () => sorted.filter(row => row.total_tokens > 0 || row.requests > 0),
    [sorted],
  )
  const [showAllDays, setShowAllDays] = useState(false)
  const visibleRows = showAllDays ? activeRows : activeRows.slice(0, DAY_ROW_LIMIT)
  const hiddenDays = activeRows.length - visibleRows.length
  const activity = stats.recent_activity
  const wow = stats.week_over_week

  const summary: Stat[] = [
    {
      label: '最近 1 小时',
      value: formatNumber(activity.last_hour_requests),
      sub: '次请求',
      title: '最近六十分钟内的请求次数。',
    },
    {
      label: '最近 24 小时',
      value: formatNumber(activity.last_24h_requests),
      sub: `${fmtCompactTokens(activity.last_24h_tokens)} tokens`,
      title: '最近一天的请求次数与 token 消耗。',
    },
    {
      label: '24h 变化',
      value: fmtSignedPct(activity.change_24h_pct),
      sub: `前 24h ${formatNumber(activity.prev_24h_requests)} 次`,
      title: '最近 24 小时相对之前 24 小时的请求变化。',
      tone: changeTone(activity.change_24h_pct),
    },
    {
      label: '本周 Tokens',
      value: formatNumber(wow.this_week.tokens),
      sub: `${formatNumber(wow.this_week.requests)} 次请求`,
      title: '自本周一 00:00 以来的 token 消耗。',
    },
    {
      label: '周环比',
      value: fmtSignedPct(wow.change_pct.tokens),
      sub: `请求 ${fmtSignedPct(wow.change_pct.requests)}`,
      title: '本周相对上周的 token 与请求变化。',
      tone: changeTone(wow.change_pct.tokens),
    },
    {
      label: '活跃天数',
      value: formatNumber(activeDays),
      sub: `共 ${formatNumber(stats.daily.length)} 天记录`,
      title: '记账窗口内有至少 1 个 token 的天数。',
    },
  ]

  const hourly: UsageBar[] = stats.hourly_pattern.map(bucket => ({
    key: String(bucket.hour),
    label: String(bucket.hour).padStart(2, '0'),
    value: bucket.requests,
    title: `${String(bucket.hour).padStart(2, '0')}:00 — ${formatNumber(bucket.requests)} 次请求 · ${formatNumber(bucket.tokens)} tokens`,
  }))
  const hasHourly = hourly.some(bar => bar.value > 0)

  // 选中某一天时，把该日 24 个小时的分布算出来交给下方的柱状图
  const dayHourly: UsageBar[] | null = useMemo(
    () =>
      selectedDay
        ? hourlyForDay(entries, rollup, selectedDay).map(bucket => ({
            key: String(bucket.hour),
            label: String(bucket.hour).padStart(2, '0'),
            value: bucket.requests,
            title: `${String(bucket.hour).padStart(2, '0')}:00 — ${formatNumber(bucket.requests)} 次请求 · ${formatNumber(bucket.tokens)} tokens`,
          }))
        : null,
    [entries, rollup, selectedDay],
  )
  const hasDayHourly = dayHourly?.some(bar => bar.value > 0) ?? false
  const selectedDayRecord = selectedDay ? stats.daily.find(day => day.date === selectedDay) : undefined
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()

  return (
    <div className="ts-tab-body">
      {tipNode}
      <StatStrip stats={summary} />

      {selectedDay ? (
        <section className="ts-section">
          <div className="ts-section-head">
            <h3 className="ts-section-title">{dayLabel(selectedDay)} 的时间分布</h3>
            <span className="ts-section-note">
              {selectedDayRecord && selectedDayRecord.total_tokens > 0
                ? `${formatNumber(selectedDayRecord.requests)} 次请求 · ${formatNumber(selectedDayRecord.total_tokens)} tokens`
                : '当日无流量'}
            </span>
            <button
              type="button"
              className="ts-chip-btn"
              onClick={() => onSelectDay(null)}
              {...tip('回到全部历史时段')}
            >
              显示全部时段
            </button>
          </div>
          {hasDayHourly ? (
            <UsageBarRow bars={dayHourly ?? []} labels height={96} />
          ) : (
            <p className="ts-section-desc">这一天没有任何请求记录，所以没有可画的时段分布。</p>
          )}
        </section>
      ) : hasHourly ? (
        <section className="ts-section">
          <div className="ts-section-head">
            <h3 className="ts-section-title">一天中的时段</h3>
            <span className="ts-section-note">请求按本地小时，全部历史</span>
          </div>
          <p className="ts-section-desc">
            这台机器真正在忙的时刻——想安排跑分或重启，就挑平坦的那一段。
          </p>
          <UsageBarRow bars={hourly} labels height={96} />
        </section>
      ) : null}

      {activeRows.length === 0 ? (
        <TableNotice
          title="暂无逐日历史"
          body="还没有记录到完整的一天流量。随着请求积累，这张表会逐渐填充。"
        />
      ) : (
        <TableFrame minWidth={640}>
          <thead>
            <tr>
              <HeadCell {...head('date')}>日期</HeadCell>
              <HeadCell {...head('requests')} numeric>请求</HeadCell>
              <HeadCell {...head('tokens')} numeric>Tokens</HeadCell>
              <HeadCell {...head('prompt')} numeric title="当日新增输入 token">输入（新增）</HeadCell>
              <HeadCell {...head('completion')} numeric title="当日实测输出 token">输出（实测）</HeadCell>
            </tr>
          </thead>
          {byMonth(visibleRows).map(group => (
            <tbody key={group.label}>
              <GroupRow
                colSpan={5}
                label={group.label}
                right={`${formatNumber(group.rows.reduce((sum, row) => sum + row.total_tokens, 0))} tokens`}
              />
              {group.rows.map(row => (
                <DataRow key={row.date}>
                  <LeadCell>
                    <span className="ts-day-label" {...tip(row.date)}>{dayLabel(row.date)}</span>
                  </LeadCell>
                  <NumCell>{formatNumber(row.requests)}</NumCell>
                  <NumCell strong>{formatNumber(row.total_tokens)}</NumCell>
                  <NumCell>{fmtCompactTokens(row.prompt_tokens)}</NumCell>
                  <NumCell>{fmtCompactTokens(row.completion_tokens)}</NumCell>
                </DataRow>
              ))}
            </tbody>
          ))}
          {hiddenDays > 0 || showAllDays ? (
            <tbody>
              <tr>
                <td colSpan={5} className="ts-more-cell">
                  {hiddenDays > 0 ? (
                    <button
                      type="button"
                      className="ts-more-btn"
                      onClick={() => setShowAllDays(true)}
                    >
                      展开其余 {formatNumber(hiddenDays)} 天（共 {formatNumber(activeRows.length)} 天有流量）
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ts-more-btn"
                      onClick={() => setShowAllDays(false)}
                    >
                      收起，只留前 {DAY_ROW_LIMIT} 天
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          ) : null}
          {stats.peak_days.length > 0 ? (
            <tbody>
              <GroupRow colSpan={5} label="历史峰值" blurb="这台机器实际扛过的天花板" />
              {stats.peak_days.map(day => (
                <DataRow key={`peak-${day.date}`}>
                  <LeadCell>
                    <span className="ts-day-label">{dayLabel(day.date)}</span>
                  </LeadCell>
                  <NumCell>{formatNumber(day.requests)}</NumCell>
                  <NumCell strong>{formatNumber(day.tokens)}</NumCell>
                  <NumCell>—</NumCell>
                  <EndCell>
                    <span className="ts-cell-sub">峰值</span>
                  </EndCell>
                </DataRow>
              ))}
            </tbody>
          ) : null}
        </TableFrame>
      )}
    </div>
  )
}