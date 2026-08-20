import { useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { dayKeyOf, formatNumber, modelFileOf } from '../utils/token-stats'
import type { TokenModelDayRow, TokenModelRow } from '../utils/token-stats'
import { UsageBarRow, type UsageBar } from './TokenUsageBars'

/** 模型图标点：沿用 token-stats.ts 的固定色表（与表格行完全一致） */
function ModelDot({ color }: { color: string }) {
  return <span className="ts-drawer-dot" style={{ background: color }} />
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
 * 一个模型行，展开来看。
 * 表格可以容纳六列，但不能容纳十三列——所以描述一个数字「怎么来的」
 * 的字段（token 总量背后的输入/输出拆分、平均数背后的平均）住在这里，
 * 而不是为了某一行正在被追问的那一行把每一行都加宽。
 */
export function TokenUsageDrawer({
  model,
  daily,
  color,
  onClose,
}: {
  model: TokenModelRow
  daily: TokenModelDayRow[]
  color: string
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
  const identity = modelFileOf(model.modelPath)

  return (
    <div className="ts-drawer-backdrop" onClick={onClose}>
      <aside
        className="ts-drawer"
        role="dialog"
        aria-label={`${model.name} 使用详情`}
        onClick={event => event.stopPropagation()}
      >
        <header className="ts-drawer-head">
          <div className="ts-drawer-title-row">
            <ModelDot color={color} />
            <div className="ts-drawer-titles">
              <h3 className="ts-drawer-title">{model.name}</h3>
              <span className="ts-drawer-status">
                {formatNumber(model.requests)} 次请求 · {formatNumber(model.total_tokens)} tokens
              </span>
            </div>
            <button type="button" className="ts-drawer-close" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="ts-drawer-body">
          {model.modelPath && identity !== model.modelPath ? (
            <p className="ts-drawer-path">{identity}</p>
          ) : null}
          <p className="ts-drawer-path-sub">
            {model.modelPath ?? (model.templateName ? `模板 ${model.templateName}` : `端口（未知模型）`)}
          </p>

          <div className="ts-facts">
            <Fact label="输入（新增）" value={formatNumber(model.prompt_tokens)} />
            <Fact label="输出（实测）" value={formatNumber(model.completion_tokens)} />
            <Fact label="合计" value={formatNumber(model.total_tokens)} />
            <Fact label="平均每次请求" value={`${formatNumber(avg)} tokens`} />
          </div>

          <section className="ts-drawer-section">
            <h4 className="ts-drawer-section-title">日趋势</h4>
            <p className="ts-drawer-section-desc">
              该模型最近 45 天的每日 tokens。悬浮柱子看精确数字。
            </p>
            {trend.length > 0 && trend.some(bar => bar.value > 0) ? (
              <div className="ts-drawer-bars">
                <UsageBarRow bars={trend} height={80} />
                <div className="ts-drawer-bar-range">
                  <span>{trend[0]?.key}</span>
                  <span>{trend[trend.length - 1]?.key}</span>
                </div>
              </div>
            ) : (
              <p className="ts-drawer-section-desc">该模型还没有任何流量，暂无可绘制的趋势。</p>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}