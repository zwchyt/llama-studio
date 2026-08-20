import { useMemo, useState } from 'react'
import {
  BarCell, DataRow, EndCell, HeadCell, LeadCell, NumCell, StatStrip, TableFrame, TableNotice,
  useSortedRows, type Stat,
} from './TokenUsageTable'
import { TokenUsageDrawer } from './TokenUsageDrawer'
import { buildModelColors, fmtCompactTokens, formatNumber } from '../utils/token-stats'
import type { TokenModelRow, TokenStats } from '../utils/token-stats'

type SortKey = 'model' | 'requests' | 'tokens' | 'avg' | 'prompt' | 'completion'

const sortValue = (row: TokenModelRow, key: SortKey): number | string | null => {
  switch (key) {
    case 'model': return row.model
    case 'requests': return row.requests
    case 'avg': return row.avg_tokens
    case 'prompt': return row.prompt_tokens
    case 'completion': return row.completion_tokens
    default: return row.total_tokens
  }
}

export function TokenUsageModelsTab({ stats }: { stats: TokenStats }) {
  const [selected, setSelected] = useState<TokenModelRow | null>(null)
  const { sorted, head } = useSortedRows<TokenModelRow, SortKey>(stats.by_model, sortValue, {
    key: 'tokens',
    desc: true,
  })
  const peak = sorted.reduce((max, row) => Math.max(max, row.total_tokens), 0)
  const totals = stats.totals
  const avgPerReq = totals.total_requests > 0 ? Math.round(totals.total_tokens / totals.total_requests) : null
  // 模型 → 颜色：表格圆点与抽屉共用同一张首次出现序色表
  const colorOf = useMemo(
    () => buildModelColors(stats.by_model.map(m => m.model)),
    [stats.by_model],
  )

  const summary: Stat[] = [
    {
      label: 'Tokens',
      value: formatNumber(totals.total_tokens),
      sub: `${fmtCompactTokens(totals.prompt_tokens)} 入 · ${fmtCompactTokens(totals.completion_tokens)} 出`,
      title: '本机模型流过的全部 token，输入（新增量）与输出（实测）合计，整个记账周期。',
    },
    {
      label: '请求数',
      value: formatNumber(totals.total_requests),
      sub: `${totals.models} 个模型`,
      title: '通过本机完成的聊天请求次数。',
    },
    {
      label: '平均/次',
      value: avgPerReq === null ? '—' : formatNumber(avgPerReq),
      sub: '输入+输出合计',
      title: '平均每次请求消耗的 token 数。',
    },
    {
      label: '输入（新增）',
      value: fmtCompactTokens(totals.prompt_tokens),
      sub: '按同端口会话增量',
      title: '累计输入：按「同端口上一次请求相比的增长量」计，避免多轮对话把历史上下文反复计入。',
    },
    {
      label: '输出（实测）',
      value: fmtCompactTokens(totals.completion_tokens),
      sub: 'llama.cpp 实测',
      title: '累计输出，流结束时由 llama.cpp 实测上报。',
    },
    {
      label: '涉及模型',
      value: formatNumber(totals.models),
      sub: '按模型文件分组',
      title: '出现过的不同模型数，按模型文件路径分组。',
    },
  ]

  return (
    <div className="ts-tab-body">
      <StatStrip stats={summary} />

      {stats.by_model.length === 0 ? (
        <TableNotice
          title="暂无模型流量"
          body="完成一次聊天后，主进程会在流结束时自动记账。启动一个模型并发消息，然后刷新。"
        />
      ) : (
        <TableFrame minWidth={896}>
          <thead>
            <tr>
              <HeadCell {...head('model')}>模型</HeadCell>
              <HeadCell {...head('requests')} numeric>请求数</HeadCell>
              <HeadCell {...head('tokens')} numeric title="输入（新增量）与输出（实测）合计">Tokens</HeadCell>
              <HeadCell {...head('avg')} numeric>平均/次</HeadCell>
              <HeadCell {...head('prompt')} numeric title="新增输入：与同端口上一次请求相比的增长量">输入（新增）</HeadCell>
              <HeadCell {...head('completion')} numeric title="llama.cpp 实测输出">输出（实测）</HeadCell>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <ModelRow
                key={row.model}
                row={row}
                peak={peak}
                color={colorOf.get(row.model) ?? 'var(--accent)'}
                onOpen={() => setSelected(row)}
              />
            ))}
          </tbody>
        </TableFrame>
      )}

      {selected ? (
        <TokenUsageDrawer
          model={selected}
          daily={stats.daily_by_model}
          color={colorOf.get(selected.model) ?? 'var(--accent)'}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

function ModelRow({
  row, peak, color, onOpen,
}: {
  row: TokenModelRow
  peak: number
  color: string
  onOpen: () => void
}) {
  return (
    <DataRow onOpen={onOpen} ariaLabel={`打开 ${row.name} 的使用详情`}>
      <LeadCell>
        <div className="ts-model-id">
          <span className="ts-model-dot" style={{ background: color }} />
          <span className="ts-model-name" title={row.model}>{row.name}</span>
          {row.templateName ? (
            <span className="ts-model-sub" title={row.model}>
              {row.templateName}
            </span>
          ) : null}
        </div>
      </LeadCell>

      <NumCell>{formatNumber(row.requests)}</NumCell>

      <BarCell
        share={peak > 0 ? row.total_tokens / peak : 0}
        sub={`↑${fmtCompactTokens(row.prompt_tokens)} ↓${fmtCompactTokens(row.completion_tokens)}`}
        title={`${row.total_tokens.toLocaleString('zh-CN')} tokens`}
      >
        {formatNumber(row.total_tokens)}
      </BarCell>

      <NumCell>{formatNumber(Math.round(row.avg_tokens))}</NumCell>

      <NumCell>{formatNumber(row.prompt_tokens)}</NumCell>

      <EndCell>
        <span className="ts-cell-num-value">{formatNumber(row.completion_tokens)}</span>
      </EndCell>
    </DataRow>
  )
}