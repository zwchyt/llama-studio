import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Cpu, RefreshCw } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { TokenUsageLedger } from '../../../shared/types'
import {
  buildTokenStats, dayLabel, fmtCompactTokens, fmtHeroTokens, formatNumber,
} from '../utils/token-stats'
import type { TokenStats } from '../utils/token-stats'
import { StatStrip, type Stat } from './TokenUsageTable'
import { TokenActivityHeatmap } from './TokenActivityHeatmap'
import { TokenUsageActivityTab } from './TokenUsageActivityTab'
import { TokenUsageModelsTab } from './TokenUsageModelsTab'
import { useBubbleTip } from './useBubbleTip'
import '../styles/token-stats.css'

// ── Token 使用统计（移植自 local-studio 的 Usage 页） ──────────
// 页面按「先总览、后明细」分两段：
//   ① 总览区（页头之下、页签之上）——总量大数字、分类统计条、全年热力图。
//      一打开页面就先看到「用了多少、用在哪、什么时候用」，不必先点页签。
//   ② 页签区——「模型 / 活动」两张明细表，页签之下才是各自的表格与区块。
// 热力图挪到页签之上，所以它「选中的那一天」提升到本组件持有：
// 点热力图上某一天会自动切到「活动」页，把那天 24 小时的分布亮出来。
// 数据源是本机记账簿（chats/state/token-usage/：按月分片的明细 + _rollup.json 聚合），
// 仅本地统计，不涉及任何云端模型的 token 计数逻辑。

type UsageTab = 'models' | 'activity'

const TABS: Array<{ id: UsageTab; label: string; icon: ReactNode }> = [
  { id: 'models', label: '模型', icon: <Cpu size={13} /> },
  { id: 'activity', label: '活动', icon: <Activity size={13} /> },
]

const TAB_HEADINGS: Record<UsageTab, { title: string; description: string }> = {
  models: {
    title: '按模型',
    description: '每个模型被请求了什么、消耗了多少 token——输入增量、输出实测、平均每次，以及它在全部流量里的占比。',
  },
  activity: {
    title: '活动',
    description: '流量什么时候到达：一天里的时段分布、逐日趋势，以及这台机器处理过的历史峰值。',
  },
}

export default function TokenStatsView() {
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  const cards = useStore(s => s.cards)
  // 默认落在「活动」：进来第一眼要看到「一天中的时段」图表（上方总览区还带着全年热力图），
  // 而不是先看模型排行表。
  const [tab, setTab] = useState<UsageTab>('activity')
  const [ledger, setLedger] = useState<TokenUsageLedger>({ entries: [], rollup: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 热力图选中的日子：热力图在页签之上，选中态得由本组件持有，
  // 才能既喂给热力图（高亮），又喂给「活动」页（那天的时段分布）。
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const requestSequence = useRef(0)

  const cardOf = useMemo(() => {
    const map = new Map<string, { name: string; modelPath: string | null }>()
    for (const c of cards) {
      map.set(c.template.id, { name: c.template.name, modelPath: c.template.modelPath ?? null })
    }
    return (templateId: string) => map.get(templateId) ?? null
  }, [cards])

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current
    try {
      setLoading(true)
      setError(null)
      const data = await window.api.listTokenUsage()
      if (requestId !== requestSequence.current) return
      setLedger(data ?? { entries: [], rollup: [] })
    } catch (cause) {
      if (requestId === requestSequence.current) {
        setError((cause as Error).message || String(cause))
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const stats: TokenStats | null = useMemo(
    () => (ledger.entries.length > 0 || ledger.rollup.length > 0
      ? buildTokenStats(ledger.entries, ledger.rollup, cardOf)
      : null),
    [ledger, cardOf],
  )

  // 总览区的分类统计条：整本账的口径，与下方页签无关
  const overview: Stat[] = useMemo(() => {
    if (!stats) return []
    const totals = stats.totals
    const avgPerReq = totals.total_requests > 0
      ? Math.round(totals.total_tokens / totals.total_requests)
      : null
    return [
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
  }, [stats])

  // 热力图选日：选中后自动切到「活动」页，让那天的时段分布立刻可见
  const pickDay = useCallback((key: string | null) => {
    setSelectedDay(key)
    if (key) setTab('activity')
  }, [])

  const heading = TAB_HEADINGS[tab]

  return (
    <div className="token-stats">
      {tipNode}
      <header className="page-header ts-header">
        <div>
          <h1 className="page-title">Token 使用记录</h1>
          <p className="page-subtitle">
            本机模型流量的完整账本——按模型、随时间，以及这台机器最忙的时刻。仅统计本地消耗，不涉及云端。
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="ts-refresh"
            onClick={() => void load()}
            aria-label="刷新用量"
            {...tip('刷新用量')}
          >
            <RefreshCw size={14} className={loading ? 'ts-spin' : ''} />
          </button>
        </div>
      </header>

      {/* ① 总览区：首次打开页面先看到的顺序 —— 总量 → 分类统计 → 全年热力图。
             往下才是页签，所以这里不依赖 tab 状态。 */}
      {stats ? (
        <div className="ts-overview">
          <div className="ts-hero">
            <div className="ts-hero-value">{fmtHeroTokens(stats.totals.total_tokens)}</div>
            <div className="ts-hero-caption">
              本机模型累计流过的 token —— {formatNumber(stats.totals.total_requests)} 次请求，全部本地记账。
            </div>
          </div>

          <StatStrip stats={overview} />

          <section className="ts-section">
            <div className="ts-section-head">
              <h3 className="ts-section-title">今年</h3>
              <span className="ts-section-note">
                {selectedDay
                  ? `已选 ${dayLabel(selectedDay)} · 见下方「活动」页`
                  : '1–12 月每日 tokens'}
              </span>
              {selectedDay ? (
                <button
                  type="button"
                  className="ts-chip-btn"
                  onClick={() => pickDay(null)}
                  {...tip('取消选中，回到全年视图')}
                >
                  取消选中
                </button>
              ) : null}
            </div>
            <div className="ts-section-body">
              <TokenActivityHeatmap daily={stats.daily} value={selectedDay} onChange={pickDay} />
            </div>
          </section>
        </div>
      ) : null}

      {/* ② 页签区：明细表格 */}
      <nav className="ts-tabs" aria-label="Token 统计标签页">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`ts-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <section className="ts-tab-panel">
        <h2 className="ts-tab-title">{heading.title}</h2>
        <p className="ts-tab-desc">{heading.description}</p>

        {error && !stats ? (
          <div className="ts-error">
            <p>读取记账簿失败：{error}</p>
            <button type="button" className="ts-retry" onClick={() => void load()}>重试</button>
          </div>
        ) : loading && !stats ? (
          <div className="ts-loading">加载本地记账簿…</div>
        ) : !stats ? (
          <div className="ts-notice">
            <div className="ts-notice-title">暂无记账记录</div>
            <p className="ts-notice-body">
              完成一次聊天后，主进程会在流结束时自动记账（含实测 token 数与模型文件），无需手动任何操作。
            </p>
          </div>
        ) : (
          tab === 'models'
            ? <TokenUsageModelsTab stats={stats} />
            : (
              <TokenUsageActivityTab
                stats={stats}
                entries={ledger.entries}
                rollup={ledger.rollup}
                selectedDay={selectedDay}
                onSelectDay={pickDay}
              />
            )
        )}
      </section>
    </div>
  )
}
