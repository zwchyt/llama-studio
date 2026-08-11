import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore'
import type { TokenUsageEntry } from '../../../shared/types'
import {
  Bot, Cpu, Database, Layers, Mail, MessageSquare, Sigma, TrendingUp
} from 'lucide-react'
import TokenTrendChart, { buildModelColors } from './TokenTrendChart'
import type { TrendPoint } from './TokenTrendChart'
import '../styles/token-stats.css'

// ── 数字格式化：移植 t3code formatSubagentTokenCount 的显示规约 ──────────
// <1k 原样；<1M → x.xk / 整数 k；其余 → x.xM
function fmtCompact(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`
  if (totalTokens < 1_000_000) {
    const v = totalTokens / 1000
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}k`
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`
}

// 一条记账 = 一次聊天请求（流结束时主进程自动入账）
interface UsageRecord {
  key: string            // 唯一键：ts + port + index
  ts: number
  port: number
  templateId: string | null
  templateName: string | null   // 模板卡名（当前仍存在的模板）
  modelPath: string | null      // 模型文件路径（记录当时实际加载的模型）
  outTokens: number     // 输出 token：实测（usage.completion_tokens）
  inTokens: number      // 输入 token：实测（usage.prompt_tokens）
}

interface ModelSummary {
  modelKey: string        // 分组键：modelPath（无则 templateId）
  name: string            // 展示名：模型文件名
  requests: number
  outTokens: number
  inTokens: number
  totalTokens: number     // 累计消耗（输出+输入，用于排序与占比）
  currentTokens: number   // 当前消耗：图表中该模型最近一次请求的 token 数
}

/** 从路径取文件名（如 D:\models\qwen2.5.gguf → qwen2.5.gguf） */
function modelFileOf(modelPath: string | null | undefined): string | null {
  if (!modelPath) return null
  const parts = modelPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || modelPath
}

// ── 汇总：从主进程 Token 记账簿构建统计 ──
// 记账簿在每次聊天流式结束时由主进程追加（含当时的模型文件路径与实测 usage）；
// 与持久化聊天会话完全解耦——删除会话、清空聊天记录均不影响累计。
function buildEntries(
  entries: TokenUsageEntry[],
  cardOf: (templateId: string) => { name: string; modelPath: string | null } | null
):
  { records: UsageRecord[]; byModel: ModelSummary[]; total: number; totalOut: number; totalIn: number } {

  const modelMap = new Map<string, ModelSummary>()
  const ensureModel = (templateId: string | null, modelPath: string | null, card: { name: string; modelPath: string | null } | null): ModelSummary => {
    const key = modelPath || templateId || 'unknown'
    let m = modelMap.get(key)
    if (!m) {
      m = {
        modelKey: key,
        name: modelFileOf(modelPath) ?? card?.name ?? (templateId ? `模板 ${templateId.slice(0, 8)}` : '未知模型'),
        requests: 0, outTokens: 0, inTokens: 0, totalTokens: 0, currentTokens: 0
      }
      modelMap.set(key, m)
    }
    return m
  }

  const records: UsageRecord[] = []
  let totalOut = 0
  let totalIn = 0
  // 每模型最近一次请求的消耗（图表纵轴口径：单次请求 token 数）
  const latestByModel = new Map<string, { ts: number; total: number }>()

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const out = typeof e.completionTokens === 'number' ? e.completionTokens : 0
    // 输入取「新增输入」：promptDelta（与同端口上一次请求相比的增长量）优先，
    // 无该字段（旧记录）或上下文重置时回退完整输入
    const inN = typeof e.promptDelta === 'number' && e.promptDelta > 0
      ? e.promptDelta
      : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)
    totalOut += out
    totalIn += inN
    const card = e.templateId ? cardOf(e.templateId) : null
    records.push({
      key: `${e.ts}:${e.port}:${i}`,
      ts: e.ts,
      port: e.port,
      templateId: e.templateId ?? null,
      templateName: card?.name ?? null,
      modelPath: e.modelPath ?? null,
      outTokens: out,
      inTokens: inN
    })
    const m = ensureModel(e.templateId ?? null, e.modelPath ?? null, card)
    m.requests += 1
    m.outTokens += out
    m.inTokens += inN
    m.totalTokens += out + inN
    // 记录该模型最新一次请求（按 ts 取最大），对应图表曲线的当前值
    const latest = latestByModel.get(m.modelKey)
    if (!latest || e.ts > latest.ts) {
      latestByModel.set(m.modelKey, { ts: e.ts, total: out + inN })
    }
  }

  for (const [key, l] of latestByModel) {
    const m = modelMap.get(key)
    if (m) m.currentTokens = l.total
  }

  records.sort((a, b) => b.ts - a.ts)
  const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  return { records, byModel, total: totalOut + totalIn, totalOut, totalIn }
}

// ── 顶部 KPI 卡 ──
function KpiCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="ts-kpi">
      <div className="ts-kpi-ico">{icon}</div>
      <div>
        <div className="ts-kpi-value">{value}</div>
        <div className="ts-kpi-label">{label}</div>
      </div>
    </div>
  )
}

// ── 模型维度汇总行 ──
function ModelRow({ m, max, color }: { m: ModelSummary; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (m.totalTokens / max) * 100) : 0
  return (
    <div className="ts-model-row">
      <span className="ts-model-ico"><Cpu size={13} color={color} /></span>
      <span className="ts-model-name" title={m.name}>{m.name}</span>
      <span className="ts-model-total ts-mono">
        <span className="ts-model-total-label">当前消耗</span>{fmtCompact(m.currentTokens)} tokens
      </span>
      <span className="ts-model-total ts-mono ts-model-total-cum">
        <span className="ts-model-total-label">累计</span>{fmtCompact(m.totalTokens)} tokens
      </span>
      <div className="ts-model-bar">
        <div className="ts-model-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// ── 记账流水行：每次请求一行，可展开 ──
export default function TokenStatsView() {
  const cards = useStore(s => s.cards)
  const [entries, setEntries] = useState<TokenUsageEntry[]>([])
  const runningCards = cards.filter(c => c.status === 'running')

  const cardOf = useMemo(() => {
    const map = new Map<string, { name: string; modelPath: string | null }>()
    for (const c of cards) {
      map.set(c.template.id, { name: c.template.name, modelPath: c.template.modelPath ?? null })
    }
    return (templateId: string) => map.get(templateId) ?? null
  }, [cards])

  useEffect(() => {
    let alive = true
    window.api.listTokenUsage()
      .then(list => { if (alive) setEntries(list) })
      .catch(err => console.error('[listTokenUsage]', err))
    return () => { alive = false }
  }, [])

  const { records, byModel, total, totalOut, totalIn } = useMemo(
    () => buildEntries(entries, cardOf),
    [entries, cardOf]
  )

  const maxModel = byModel.length > 0 ? byModel[0].totalTokens : 0
  const hasData = records.length > 0

function fmtFullTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

// 趋势图数据：每次请求一个点（total = 该次请求消耗）；TokenTrendChart 画成平滑波浪面积图
const trendPoints = useMemo<TrendPoint[]>(() =>
    [...records]
      .sort((a, b) => a.ts - b.ts)
      .map(r => ({
        x: `${modelFileOf(r.modelPath) ?? r.templateName ?? '未知模型'} · ${fmtFullTime(r.ts)}`,
        ts: r.ts,
        // modelKey 与「按模型汇总」的 ensureModel 完全一致（modelPath || templateId || 'unknown'），
        // 否则缺失模型信息的记录在图表里显示为 port-xxx、汇总里是 unknown，颜色对不上
        modelKey: r.modelPath || r.templateId || 'unknown',
        modelName: modelFileOf(r.modelPath) ?? r.templateName ?? '未知模型',
        total: r.outTokens + r.inTokens
      }))
      // 过滤零消耗请求：total=0 的记录画不出有效趋势，只会让该模型的曲线贴底拉成一条
      // 水平直线（如界面里那条贯穿时间线的紫色线——它对应的是一个 0 token 的"幽灵"模型）
      .filter(p => p.total > 0),
    [records]
  )

  // 模型 → 颜色：趋势曲线与「按模型汇总」进度条共享同一张色表（按首次出现顺序分配）
  const colorOf = useMemo(() => buildModelColors(trendPoints.map(p => p.modelKey)), [trendPoints])

  return (
    <div className="token-stats">
      <header className="ts-header">
        <div className="ts-header-left">
          <h1 className="ts-title">Token 使用记录</h1>
        </div>
        <div className="ts-header-right">
          <span className="ts-header-chip"><Layers size={13} /> {entries.length} 条记录</span>
          <span className="ts-header-chip"><Cpu size={13} /> {runningCards.length} 个模型运行中</span>
        </div>
      </header>

      <div className="ts-kpis">
        <KpiCard icon={<Sigma size={15} />} label="累计输出（实测）" value={fmtCompact(totalOut)} />
        <KpiCard icon={<Mail size={15} />} label="累计输入（新增量）" value={fmtCompact(totalIn)} />
        <KpiCard icon={<Database size={15} />} label="合计消耗" value={fmtCompact(total)} />
        <KpiCard icon={<MessageSquare size={15} />} label="涉及模型" value={String(byModel.length)} />
      </div>

      {!hasData ? (
        <div className="ts-empty">
          <Bot size={34} className="ts-empty-ico" />
          <p className="ts-empty-title">暂无记账记录</p>
          <p className="ts-empty-sub">完成一次聊天后，主进程会在流结束时自动记账（含实测 token 数与模型文件），无需手动任何操作。</p>
        </div>
      ) : (
        <>
          <section className="ts-section ts-section-chart">
            <h2 className="ts-section-title"><TrendingUp size={14} /> Token 使用趋势</h2>
            <TokenTrendChart points={trendPoints} colorOf={colorOf} />
          </section>

          <section className="ts-section">
            <h2 className="ts-section-title"><Cpu size={14} /> 按模型汇总</h2>
            <div className="ts-model-rows">
              {byModel.map(m => <ModelRow key={m.modelKey} m={m} max={maxModel} color={colorOf.get(m.modelKey) ?? 'var(--accent)'} />)}
            </div>
          </section>
        </>
      )}
    </div>
  )
}