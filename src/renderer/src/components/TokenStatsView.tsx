import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Cpu, RefreshCw } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { TokenUsageEntry } from '../../../shared/types'
import { buildTokenStats, formatNumber } from '../utils/token-stats'
import type { TokenStats } from '../utils/token-stats'
import { TokenUsageActivityTab } from './TokenUsageActivityTab'
import { TokenUsageModelsTab } from './TokenUsageModelsTab'
import '../styles/token-stats.css'

// ── Token 使用统计（移植自 local-studio 的 Usage 页） ──────────
// 页面是「模型」与「活动」两个表格页签的并列：同一个标签页外壳、同一套表格
// 语言，每个标签页的统计条直接概括正下方的行，而不是漂浮在页面顶部。
// 数据源是本机记账簿（chats/_token-usage.jsonl），仅本地统计，
// 不涉及任何云端模型的 token 计数逻辑。

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
  const cards = useStore(s => s.cards)
  const [tab, setTab] = useState<UsageTab>('models')
  const [entries, setEntries] = useState<TokenUsageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
      const list = await window.api.listTokenUsage()
      if (requestId !== requestSequence.current) return
      setEntries(list)
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
    () => (entries.length > 0 ? buildTokenStats(entries, cardOf) : null),
    [entries, cardOf],
  )

  const heading = TAB_HEADINGS[tab]
  const scope: { scale: string; detail: string } = useMemo(() => {
    if (!stats) return { scale: '暂无记录', detail: '完成一次聊天后自动记账' }
    if (tab === 'models') {
      return {
        scale: `${stats.totals.models} 个模型`,
        detail: `${formatNumber(stats.totals.total_requests)} 次请求 · ${formatNumber(stats.totals.total_tokens)} tokens（输入新增量 + 输出实测）`,
      }
    }
    return {
      scale: `${stats.daily.length} 天记录`,
      detail: `最近 24 小时 ${formatNumber(stats.recent_activity.last_24h_requests)} 次请求`,
    }
  }, [stats, tab])

  return (
    <div className="token-stats">
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
            title="刷新用量"
            aria-label="刷新用量"
          >
            <RefreshCw size={14} className={loading ? 'ts-spin' : ''} />
          </button>
        </div>
      </header>

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

        <div className="ts-scope">
          <span className="ts-scope-scale">{scope.scale}</span>
          <span className="ts-scope-detail">{scope.detail}</span>
        </div>

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
            : <TokenUsageActivityTab stats={stats} entries={entries} />
        )}
      </section>
    </div>
  )
}