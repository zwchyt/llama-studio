import React, { useState, useEffect, useMemo, Component } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { Activity, Database, HardDrive, Square, HardDrive as MemIcon, Zap, Clock, Gauge, Play, MessageSquare } from 'lucide-react'

// ── helpers ──────────────────────────────────────────────────────────────────
function fmt(n: unknown, digits = 1): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  return n.toFixed(digits)
}

function fmtInt(n: unknown): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  return Math.round(n).toLocaleString()
}

function fmtMs(n: unknown): string {
  if (typeof n !== 'number' || isNaN(n)) return '—'
  return `${Math.round(n)}`
}

function fmtMem(mb: unknown): string {
  if (typeof mb !== 'number' || isNaN(mb)) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

function sparkline(values: number[] | undefined, w = 120, h = 32): { path: string; color: string } {
  if (!values || values.length < 2) return { path: '', color: 'var(--accent)' }
  const safe = values.filter(v => !isNaN(v) && isFinite(v))
  if (safe.length < 2) return { path: '', color: 'var(--accent)' }
  const max = Math.max(...safe, 1)
  const step = w / (safe.length - 1)
  const path = safe.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${h - (v / max) * h}`).join(' ')
  const color = safe[safe.length - 1] >= safe[0] ? 'var(--success)' : 'var(--danger)'
  return { path, color }
}

// ── MetricCard ───────────────────────────────────────────────────────────────
interface MetricCardProps {
  label: string
  value: string
  unit?: string
  icon: React.ReactNode
  accentColor: string
  history?: number[]
  barMax?: number
}

function MetricCard({ label, value, unit, icon, accentColor, history, barMax }: MetricCardProps) {
  const spark = history ? sparkline(history) : { path: '', color: 'var(--accent)' }
  return (
    <div className="metric-card">
      <div className="metric-card-header">
        <div className="metric-icon" style={{ background: `${accentColor}18`, color: accentColor }}>{icon}</div>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value" style={{ color: accentColor }}>
        {value}<span className="metric-unit">{unit}</span>
      </div>
      {history && history.length > 1 && (
        <>
          {barMax && (
            <div className="metric-bar-wrap">
              <div className="metric-bar-fill" style={{ width: `${Math.min(100, (history[history.length - 1] / barMax) * 100)}%`, background: accentColor, opacity: 0.6 }} />
            </div>
          )}
          <svg className="metric-sparkline" width="100%" height="32" viewBox="0 0 120 32" preserveAspectRatio="none">
            <path d={spark.path} stroke={spark.color} />
          </svg>
        </>
      )}
    </div>
  )
}

// ── RunningCard ──────────────────────────────────────────────────────────────
function RunningCard({ card, metrics }: { card: import('../../../shared/types').CardState; metrics: import('../../../shared/types').ModelMetrics | null }) {
  const { toggleMonitorExpanded, setCardStatus, clearActiveChat } = useStore(s => ({
    toggleMonitorExpanded: s.toggleMonitorExpanded, setCardStatus: s.setCardStatus, clearActiveChat: s.clearActiveChat
  }), shallow)
  const isRunning = card.status === 'running'
  const statusInfo = card.status === 'running'
    ? { label: '运行中', color: 'var(--success)' }
    : card.status === 'error'
      ? { label: '错误', color: 'var(--danger)' }
      : { label: '空闲', color: 'var(--text-muted)' }

  const [uptime, setUptime] = useState(0)
  useEffect(() => {
    if (!isRunning) { setUptime(0); return }
    const start = Date.now()
    const iv = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [isRunning])

  async function handleStop() {
    // optimistic update: update UI immediately for zero-latency
    if (card.template.serverPort === useStore.getState().activeChatPort) clearActiveChat()
    setCardStatus(card.template.id, 'idle')
    try {
      const res = await window.api.stopModel(card.template.id)
      if (!res.success && res.error !== 'Not running') {
        notify(`停止失败：${res.error}`, 'error')
      }
    } catch (e) { console.error('Failed to stop model', e) }
  }

  const templateId = card?.template?.id
  const hasValidId = !!templateId
  const handleHeaderClick = () => {
    if (!hasValidId) return
    toggleMonitorExpanded(card.template.id)
  }

  const vramTotal = metrics?.vramTotalMb ?? 0
  const slotPredict = metrics?.nPredict
  const templatePredict = card.template.args?.['n_predict']
  const genMaxTokens = (slotPredict && slotPredict > 0) ? slotPredict : (typeof templatePredict === 'number' && templatePredict > 0 ? templatePredict : 0)
  const displayGenTokens = metrics?.nDecoded && metrics.nDecoded > 0 ? metrics.nDecoded : 0

  return (<div className={`monitoring-card ${isRunning ? 'running' : ''}`}>
    <div className="monitoring-card-header" onClick={handleHeaderClick}>
      <div className="monitoring-card-icon" style={{ background: isRunning ? 'rgba(22,163,74,.12)' : 'var(--surface-2)' }}>
        <HardDrive size={16} style={{ color: isRunning ? 'var(--success)' : 'var(--text-muted)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="monitoring-card-name">{card.template.name}</div>
        <div className="monitoring-card-meta">Port {card.template.serverPort} · {card.template.backendVersion || '默认后端'}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="monitoring-status-dot" style={{ background: statusInfo.color }} />
        <span className="monitoring-status-text" style={{ color: statusInfo.color }}>{statusInfo.label}</span>
        {card.pid && <span className="monitoring-pid">PID {card.pid}</span>}
        {isRunning && (
          <button className="btn btn-ghost btn-icon" onClick={(e) => { e.stopPropagation(); handleStop() }} title="停止">
            <Square size={13} />
          </button>
        )}
      </div>
    </div>

    {card.monitorExpanded && (
      <div className="monitoring-card-details">
        {/* Static info */}
        <div className="monitoring-detail-row"><span>端口</span><span>{card.template.serverPort}</span></div>
        <div className="monitoring-detail-row"><span>后端</span><span>{card.template.backendVersion || '默认'}</span></div>
        <div className="monitoring-detail-row"><span>启动模式</span><span>{card.template.launchMode === 'api' ? '仅 API' : 'Chat UI'}</span></div>
        {card.template.modelPath && (
          <div className="monitoring-detail-row"><span>模型</span><span style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.template.modelPath.split(/[\\/]/).pop()}</span></div>
        )}
        {isRunning && (
          <div className="monitoring-detail-row">
            <span>运行时长</span>
            <span style={{ fontFamily: 'monospace' }}>{Math.floor(uptime / 3600)}h {Math.floor((uptime % 3600) / 60)}m {uptime % 60}s</span>
          </div>
        )}
        {card.template.description && (
          <div className="monitoring-detail-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <span>描述</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.template.description}</span>
          </div>
        )}

        {/* ── 5 live metrics ── */}
        <div className="monitoring-metrics-section">
          <div className="monitoring-metrics-title">
            <Activity size={12} style={{ marginRight: 5 }} />
            实时指标
          </div>
          <div className="metrics-grid">
            <MetricCard
              label="Decode tok/s"
              value={fmt(metrics?.decodeTokS?.[metrics?.decodeTokS.length - 1])}
              unit="tok/s"
              icon={<Zap size={13} />}
              accentColor="var(--accent)"
            />
            <MetricCard
              label="TTFT"
              value={fmtMs(metrics?.ttftMs)}
              unit="ms"
              icon={<Clock size={13} />}
              accentColor="var(--warning)"
            />
            <MetricCard
              label="Prefill"
              value={fmtInt(metrics?.prefillTokS)}
              unit="tok/s"
              icon={<Gauge size={13} />}
              accentColor="#7c3aed"
            />
            <MetricCard
              label="REQ/s"
              value={fmt(metrics?.reqPerSec?.[metrics.reqPerSec.length - 1])}
              unit="req/s"
              icon={<Play size={13} />}
              accentColor="var(--success)"
            />
            <MetricCard
              label="VRAM"
              value={metrics?.vramUsedMb != null ? fmtMem(metrics?.vramUsedMb) : '—'}
              unit={metrics?.vramUsedMb != null ? `/ ${fmtMem(vramTotal)}` : ''}
              icon={<MemIcon size={13} />}
              accentColor="#0891b2"
              barMax={vramTotal || undefined}
            />
            <div className="metric-card" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="metric-icon" style={{ background: '#06b6d418', color: '#06b6d4' }}>
                  <Database size={13} />
                </div>
                <span className="metric-label">缓存命中</span>
                <span className="metric-value" style={{ color: '#06b6d4', fontSize: 16, marginLeft: 'auto' }}>
                  {fmtInt(metrics?.nPromptTokensCache ?? 0)}<span className="metric-unit"> / {fmtInt(metrics?.nPromptTokens ?? 0)} tokens ({fmt((((metrics?.nPromptTokensCache ?? 0) / (metrics?.nPromptTokens || 1)) * 100), 0)}%)</span>
                </span>
              </div>
              <div className="metric-bar-wrap" style={{ marginTop: 4 }}>
                <div className="metric-bar-fill" style={{ width: `${Math.min(100, ((metrics?.nPromptTokensCache ?? 0) / (metrics?.nPromptTokens || 1)) * 100)}%`, background: '#06b6d4', opacity: 0.6 }} />
              </div>
            </div>
            {(metrics?.nCtx ?? 0) > 0 && (
              <div className="metric-card" style={{ gridColumn: '1 / -1' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="metric-icon" style={{ background: '#f59e0b18', color: '#f59e0b' }}>
                    <MessageSquare size={13} />
                  </div>
                  <span className="metric-label">上下文</span>
                  <span className="metric-value" style={{ color: '#f59e0b', fontSize: 16, marginLeft: 'auto' }}>
                    {fmtInt(metrics?.nPromptTokens ?? 0)}<span className="metric-unit"> / {fmtInt(metrics?.nCtx ?? 0)} tokens</span>
                  </span>
                </div>
                <div className="metric-bar-wrap" style={{ marginTop: 4 }}>
                    <div className="metric-bar-fill" style={{ width: `${Math.min(100, ((metrics?.nPromptTokens ?? 0) / (metrics?.nCtx ?? 1)) * 100)}%`, background: '#f59e0b', opacity: 0.6 }} />
                </div>
              </div>
            )}
            <div className="metric-card" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="metric-icon" style={{ background: metrics?.isProcessing ? '#3b82f618' : '#22c55e18', color: metrics?.isProcessing ? '#3b82f6' : '#22c55e' }}>
                  <MessageSquare size={13} />
                </div>
                <span className="metric-label">生成进度</span>
                <span className="metric-value" style={{ color: metrics?.isProcessing ? '#3b82f6' : '#22c55e', fontSize: 16, marginLeft: 'auto' }}>
                  {fmtInt(displayGenTokens)}
                  <span className="metric-unit">
                    {genMaxTokens > 0 ? ` / ${fmtInt(genMaxTokens)} tokens` : ' tokens '}
                    {metrics?.isProcessing ? '(进行中)' : '(已完成)'}
                  </span>
                </span>
              </div>
              {genMaxTokens > 0 && (
                <div className="metric-bar-wrap" style={{ marginTop: 4 }}>
                  <div className="metric-bar-fill" style={{ width: `${Math.min(100, (displayGenTokens / genMaxTokens) * 100)}%`, background: metrics?.isProcessing ? '#3b82f6' : '#22c55e', opacity: 0.6 }} />
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    )}
  </div>
  )
}

// ── ErrorBoundary ────────────────────────────────────────────────────────────
class CardErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  state: { hasError: boolean; error: Error | null } = { hasError: false, error: null }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
  componentDidCatch(error: Error) {
    if (typeof window !== 'undefined') {
      console.error('[ModelMonitoringView crash]', error)
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, color: 'var(--danger)', textAlign: 'center' }}>
          <h3>渲染出错</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>请查看开发者工具控制台获取详细错误信息，然后刷新页面。</p>
          <pre style={{ textAlign: 'left', background: 'var(--bg)', padding: 12, borderRadius: 8, overflow: 'auto', fontSize: 11, marginTop: 12 }}>
            {this.state.error?.message || '未知错误'}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// ── View ─────────────────────────────────────────────────────────────────────
export default function ModelMonitoringView() {
  const { cards, modelMetrics } = useStore(s => ({ cards: s.cards, modelMetrics: s.modelMetrics }), shallow)

  const allRelevant = useMemo(
    () => cards.filter(c => c.status !== 'idle'),
    [cards]
  )

  return (
    <CardErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">模型运行数据</h1>
            <p className="page-subtitle">
              {allRelevant.length > 0
                ? `${allRelevant.filter(c => c.status === 'running').length} 个模型正在运行`
                : '暂无正在运行的模型'}
            </p>
          </div>
          <div className="page-actions">
            {allRelevant.length > 0 && (
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, color: 'var(--text-muted)',
                background: 'var(--surface-2)', padding: '4px 10px', borderRadius: 6
              }}>
                <Activity size={13} />
                {allRelevant.length} 个活动任务
              </span>
            )}
          </div>
        </div>

        {allRelevant.length > 0 && allRelevant.every(c => c?.template?.id) ? (
          <div className="monitoring-cards-list">
            {allRelevant.map(card => {
              const tid = card?.template?.id
              const m = tid ? modelMetrics[tid] : undefined
              return (
                <CardErrorBoundary key={tid}>
                  <RunningCard card={card} metrics={m ?? null} />
                </CardErrorBoundary>
              )
            })}
          </div>
        ) : allRelevant.length > 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Activity size={28} /></div>
            <h3>数据加载中</h3>
            <p>模型模板数据尚未加载完成，请稍后重试。</p>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon"><Activity size={28} /></div>
            <h3>无运行数据</h3>
            <p>目前没有正在运行或近期运行的模型任务。</p>
          </div>
        )}
      </div>
    </CardErrorBoundary>
  )
}
