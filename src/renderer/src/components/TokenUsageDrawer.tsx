import { useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { useBubbleTip } from './useBubbleTip'
import { dayKeyOf, formatNumber } from '../utils/token-stats'
import type { TokenModelDayRow, TokenModelRow } from '../utils/token-stats'
import { UsageBarRow, type UsageBar } from './TokenUsageBars'

/** 模型图标点：沿用 token-stats.ts 的固定色表（与表格行完全一致） */
function ModelDot({ color }: { color: string }) {
  return <span className="ts-detail-dot" style={{ background: color }} />
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ts-fact">
      <div className="ts-fact-label">{label}</div>
      <div className="ts-fact-value">{value}</div>
    </div>
  )
}

/**
 * 模型行的展开详情。
 *
 * 作为**表格里的一行**（colSpan 贯通整表）就地展开，而不是从右侧滑出的抽屉：
 * 抽屉要一层全屏遮罩，会把左侧导航一起压暗；固定 460px 也装不下 45 根柱
 * （柱体被压到 6px 以下）。行内展开没有遮罩问题，还能拿到整张表的宽度。
 *
 * 描述一个数字「怎么来的」的字段住在这里，而不是把表格每一行都加宽 ——
 * 表格能容纳六列，容不下十三列。
 */
export function TokenUsageDetail({
  model,
  daily,
  color,
  colSpan,
  onClose,
}: {
  model: TokenModelRow
  daily: TokenModelDayRow[]
  color: string
  colSpan: number
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 最近 45 天（含零流量日）：柱与柱之间保持连续，才能看出「在涨还是在跌」
  const trend = useMemo<UsageBar[]>(() => {
    const rows = daily
      .filter(row => row.model === model.model)
      .sort((a, b) => a.date.localeCompare(b.date))
    const byDate = new Map(rows.map(row => [row.date, row]))
    const today = dayKeyOf(Date.now())
    const first = new Date(`${today}T00:00:00`)
    first.setDate(first.getDate() - 44)
    const bars: UsageBar[] = []
    const cursor = new Date(first)
    while (cursor.getTime() <= new Date(`${today}T00:00:00`).getTime()) {
      const key = dayKeyOf(cursor.getTime())
      const row = byDate.get(key)
      bars.push({
        key,
        label: key.slice(8),
        value: row?.total_tokens ?? 0,
        title: `${key} — ${formatNumber(row?.total_tokens ?? 0)} tokens · ${formatNumber(row?.requests ?? 0)} 次请求`,
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    return bars
  }, [daily, model.model])

  const avg = model.requests > 0 ? Math.round(model.total_tokens / model.requests) : 0
  // 峰值：给柱状图一个量级参照，否则只能靠悬停才知道柱高对应多少
  const peak = trend.reduce((max, bar) => Math.max(max, bar.value), 0)
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()

  return (
    <tr className="ts-detail-row">
      <td colSpan={colSpan} className="ts-detail-cell">
        {tipNode}
        <div className="ts-detail">
          <header className="ts-detail-head">
            <ModelDot color={color} />
            <h3 className="ts-detail-title">{model.name}</h3>
            {/* 只放请求数：token 合计在下方 facts 里已有，不重复 */}
            <span className="ts-detail-status">{formatNumber(model.requests)} 次请求</span>
            <button type="button" className="ts-detail-close" onClick={onClose} aria-label="收起" {...tip('收起')}>
              <X size={16} />
            </button>
          </header>

          {/* 文件名已在标题里，这里只补完整路径 */}
          <p className="ts-detail-path">
            {model.modelPath ?? (model.templateName ? `模板 ${model.templateName}` : '端口（未知模型）')}
          </p>

          <div className="ts-facts">
            <Fact label="输入（新增）" value={formatNumber(model.prompt_tokens)} />
            <Fact label="输出（实测）" value={formatNumber(model.completion_tokens)} />
            <Fact label="合计" value={formatNumber(model.total_tokens)} />
            <Fact label="平均每次请求" value={`${formatNumber(avg)} tokens`} />
          </div>

          <section>
            <h4 className="ts-detail-section-title">日趋势</h4>
            <p className="ts-detail-section-desc">
              该模型最近 45 天的每日 tokens。悬浮柱子看精确数字。
            </p>
            {trend.length > 0 && trend.some(bar => bar.value > 0) ? (
              <div className="ts-detail-bars">
                <UsageBarRow bars={trend} height={80} />
                <div className="ts-detail-bar-range">
                  <span>{trend[0]?.key}</span>
                  <span className="ts-detail-bar-peak">峰值 {formatNumber(peak)}</span>
                  <span>{trend[trend.length - 1]?.key}</span>
                </div>
              </div>
            ) : (
              <p className="ts-detail-section-desc">该模型还没有任何流量，暂无可绘制的趋势。</p>
            )}
          </section>
        </div>
      </td>
    </tr>
  )
}
