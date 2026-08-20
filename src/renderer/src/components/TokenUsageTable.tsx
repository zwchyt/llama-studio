import { useMemo, useState, type ReactNode } from 'react'

// ── Token 统计表格语言（移植自 local-studio 的 catalog-table-shell） ──
// 无边框表格立在页面底色上，行与行之间用空隙而非发丝线分隔；组头是贯通整行的
// 小字；数字右对齐、等宽数字。所有标签页共用同一套原语，改一处四处一起动。
// 特意不引入图表库：排序表里的无界计数就放在列里精确读数；
// 只有「一天中的时段」「45 天趋势」是真正的形状，用 div 画（见 TokenUsageBars）。

export type StatTone = 'default' | 'ok' | 'warn' | 'err'

export type Stat = {
  label: string
  value: ReactNode
  sub?: ReactNode
  /** 这个数字到底在数什么。每个可能被误读的统计都带一句说明。 */
  title?: string
  tone?: StatTone
}

const STAT_TONE_CLASS: Record<StatTone, string> = {
  default: 'ts-stat-value',
  ok: 'ts-stat-value ts-tone-ok',
  warn: 'ts-stat-value ts-tone-warn',
  err: 'ts-stat-value ts-tone-err',
}

/** StatStrip 的一个单元格；单独导出以便某个统计离开栅格独立存在。 */
export function StatCell({ label, value, sub, title, tone = 'default' }: Stat) {
  return (
    <div className="ts-stat" title={title}>
      <div className="ts-stat-label">{label}</div>
      <div className={STAT_TONE_CLASS[tone]}>{value}</div>
      {sub ? <div className="ts-stat-sub">{sub}</div> : null}
    </div>
  )
}

/**
 * 一个区块的统计条，由数组驱动——每个页面把数字当数据声明，
 * 而不是再抄一份这个标记。
 * 刻意绑在它正下方的表格上，而不是浮在页面顶部当全局仪表盘：
 * 一个追溯不到脚下可读行的数字，是没人相信的数字。
 */
export function StatStrip({ stats }: { stats: readonly Stat[] }) {
  return (
    <div className="ts-strip">
      {stats.map(stat => <StatCell key={stat.label} {...stat} />)}
    </div>
  )
}

export function TableFrame({ children, minWidth }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="ts-table-wrap">
      <table className="ts-table" style={minWidth ? { minWidth } : undefined}>{children}</table>
    </div>
  )
}

/**
 * 列头，可排序或纯展示。
 * 排序箭头在标签「之前」且始终占位，因此无论是否排序，
 * 表头文字都结束在下方数字完全相同的右缘上——点击时什么都不动。
 */
export function HeadCell({
  children, numeric, title, active, desc, onSort,
}: {
  children: string
  numeric?: boolean
  title?: string
  active?: boolean
  desc?: boolean
  onSort?: () => void
}) {
  const label = (
    <>
      <span aria-hidden className="ts-sort-arrow">{onSort && active ? (desc ? '↓' : '↑') : ''}</span>
      {children}
    </>
  )
  return (
    <th
      className={`ts-head ${numeric ? 'ts-num' : ''}`}
      aria-sort={onSort ? (active ? (desc ? 'descending' : 'ascending') : 'none') : undefined}
    >
      {onSort ? (
        <button type="button" onClick={onSort} title={title} className={`ts-head-btn${active ? ' active' : ''}`}>
          {label}
        </button>
      ) : (
        <span title={title} className="ts-head-span">{label}</span>
      )}
    </th>
  )
}

/** 表体内的区块分隔行：这一串行是什么，以及一个合计。 */
export function GroupRow({
  colSpan, label, blurb, right,
}: {
  colSpan: number
  label: string
  blurb?: string
  right?: ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="ts-group-cell">
        <div className="ts-group">
          <div className="ts-group-left">
            <span className="ts-group-label">{label}</span>
            {blurb ? <span className="ts-group-blurb">{blurb}</span> : null}
          </div>
          {right ? <span className="ts-group-right">{right}</span> : null}
        </div>
      </td>
    </tr>
  )
}

/**
 * 一行数据。不可操作的行用压暗而不是变红——视线应该落在可用之物上，
 * 而不是落在坏掉的东西上。
 */
export function DataRow({
  children, onOpen, ariaLabel, dimmed,
}: {
  children: ReactNode
  onOpen?: () => void
  ariaLabel?: string
  dimmed?: boolean
}) {
  return (
    <tr
      onClick={onOpen}
      onKeyDown={onOpen
        ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen()
            }
          }
        : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={ariaLabel}
      className={`ts-row${onOpen ? ' clickable' : ''}${dimmed ? ' dimmed' : ''}`}
    >
      {children}
    </tr>
  )
}

/** 最左单元格：身份。圆角让 hover 的底色有个有形状的左缘。 */
export function LeadCell({ children }: { children: ReactNode }) {
  return <td className="ts-cell ts-cell-lead">{children}</td>
}

/** 右对齐的值单元格，可带一行更安静的副行。 */
export function NumCell({
  children, sub, strong, title,
}: {
  children: ReactNode
  sub?: ReactNode
  strong?: boolean
  title?: string
}) {
  return (
    <td className="ts-cell ts-cell-num" title={title}>
      <div className={strong ? 'ts-cell-num-strong' : 'ts-cell-num-value'}>{children}</div>
      {sub ? <div className="ts-cell-sub">{sub}</div> : null}
    </td>
  )
}

/**
 * 带排名的 NumCell。
 * 规则是 2px，垫在数字下面并出血到单元格右缘：看列时先读到的是数字，
 * 条形只是不另开一张图就能看出分布形状的方式。share 取值 0–1。
 */
export function BarCell({
  children, sub, share, title,
}: {
  children: ReactNode
  sub?: ReactNode
  share: number
  title?: string
}) {
  const width = Math.min(100, Math.max(share > 0 ? 2 : 0, share * 100))
  return (
    <td className="ts-cell ts-cell-num" title={title}>
      <div className="ts-cell-num-value">{children}</div>
      <div className="ts-bar-track">
        <div className="ts-bar-fill" style={{ width: `${width}%` }} />
      </div>
      {sub ? <div className="ts-cell-sub">{sub}</div> : null}
    </td>
  )
}

/** 最右单元格：状态文字。 */
export function EndCell({ children }: { children: ReactNode }) {
  return <td className="ts-cell ts-cell-end">{children}</td>
}

/** 空状态，和它代替的表格一样安静。 */
export function TableNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="ts-notice">
      <div className="ts-notice-title">{title}</div>
      <p className="ts-notice-body">{body}</p>
    </div>
  )
}

export type SortState<K extends string> = { key: K; desc: boolean }

/**
 * Usage 表格的排序，只写一次。
 * 每个表都是「若干行、一个排序键、一个方向」，替代方案是三个渐渐走样的
 * 比较器。accessor 以模块级函数传入，memo 才能真的记住而不是被每次渲染的
 * 新对象字面量击穿。
 * null 无论方向都排最后：一个没上报 TTFT 的模型既不是最快的，
 * 也不是最慢的。
 */
export function useSortedRows<T, K extends string>(
  rows: readonly T[],
  accessor: (row: T, key: K) => number | string | null,
  initial: SortState<K>,
) {
  const [sort, setSort] = useState<SortState<K>>(initial)

  const sorted = useMemo(() => {
    const direction = sort.desc ? -1 : 1
    return [...rows].sort((a, b) => {
      const left = accessor(a, sort.key)
      const right = accessor(b, sort.key)
      if (left === null && right === null) return 0
      if (left === null) return 1
      if (right === null) return -1
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left).localeCompare(String(right)) * direction
      }
      return (left - right) * direction
    })
  }, [rows, accessor, sort])

  const head = (key: K) => ({
    active: sort.key === key,
    desc: sort.desc,
    onSort: () =>
      setSort((current) =>
        current.key === key ? { key, desc: !current.desc } : { key, desc: true },
      ),
  })

  return { sorted, head }
}