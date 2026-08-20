// ── Token 统计页面唯一的「图表」，而且刻意是一排 div ──────────────
// 移植自 local-studio 的 usage-bars：页面其余一切都是无界的计数，属于表格的
// 一列，可以在列里精确读数。只有两样东西是真正的形状而不是数字——
// 「一天里哪个时段机器在忙」和「一个模型的流量在涨还是在跌」——
// 两者都由相对柱高回答，所以它们用柱。引入图表库只会买到我们不要的
// 坐标轴和提示框，以及每次页面加载都要付的包体。

export type UsageBar = {
  key: string
  /** 开 labels 时显示在柱子下面；保持两三个字符。 */
  label: string
  value: number
  /** 悬浮时的完整句子——精确数字在这里。 */
  title: string
}

export function UsageBarRow({
  bars,
  labels = false,
  height = 96,
}: {
  bars: readonly UsageBar[]
  labels?: boolean
  height?: number
}) {
  const peak = bars.reduce((max, bar) => Math.max(max, bar.value), 0)
  return (
    <div className="ts-bars">
      <div className="ts-bars-axis" style={{ height }}>
        {bars.map(bar => (
          <div key={bar.key} className="ts-bar-slot" title={bar.title} aria-label={bar.title}>
            <div
              className={`ts-bar${bar.value > 0 ? '' : ' zero'}`}
              // 零柱仍然画出 2px 地板：空时段也是数据，
              // 行中出现缺口反而像渲染故障
              style={{ height: peak > 0 ? `${Math.max(2, (bar.value / peak) * 100)}%` : '2px' }}
            />
          </div>
        ))}
      </div>
      {labels ? (
        <div className="ts-bar-labels">
          {bars.map((bar, index) => (
            <span key={bar.key} className="ts-bar-label">
              {index % 3 === 0 ? bar.label : ''}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}