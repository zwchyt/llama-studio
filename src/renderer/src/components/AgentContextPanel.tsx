import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { Gauge, Clock, Activity, Hash } from 'lucide-react'

interface AgentContextPanelProps {
  templateId: string | null   // 正在运行的模型模板 id（用于查 metrics）；未启动为 null
  startedAt?: number         // 模型启动时间，用于运行时间统计
  requests: number           // 本会话累计请求数
  cumTokens: number          // 本会话累计 tokens（prompt + completion）
}

// 运行时间格式化为 HH:MM:SS
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':')
}

const COMPRESS_THRESHOLD = 0.8   // 设计稿中的「压缩阈值」参考线（本地 LLM 仅作警告，不改变行为）

export default function AgentContextPanel({ templateId, startedAt, requests, cumTokens }: AgentContextPanelProps) {
  const metrics = useStore(s => (templateId ? s.modelMetrics[templateId] : undefined))
  // 仅用 setter 每秒触发一次重渲染以刷新运行时间；tick 值本身不参与渲染，故跳过声明
  const [, setTick] = useState(0)

  // 运行时间需要每秒刷新
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  const nCtx = metrics?.nCtx || 0
  const used = metrics?.nPromptTokens || 0
  const cache = metrics?.nPromptTokensCache || 0
  const hitRate = used > 0 ? (cache / used) * 100 : 0
  const pct = nCtx > 0 ? Math.min(100, (used / nCtx) * 100) : 0
  const warning = pct >= COMPRESS_THRESHOLD * 100
  const toCompress = Math.max(0, Math.floor(nCtx * COMPRESS_THRESHOLD) - used)
  const uptime = startedAt ? fmtDuration(Date.now() - startedAt) : '—'
  const noModel = !templateId

  return (
    <div className="agent-ctx-panel">
      <div className="agent-ctx-head">
        <span className="agent-ctx-title">上下文窗口</span>
      </div>

      <div className="agent-ctx-bar-row">
        <span className={`agent-ctx-status ${warning ? 'warn' : 'ok'}`}>
          {noModel ? '未启动' : warning ? '上下文紧张' : '上下文充足'}
        </span>
        <span className="agent-ctx-used">{used.toLocaleString()} / {nCtx.toLocaleString()}</span>
      </div>

      <div className="agent-ctx-bar">
        <div
          className="agent-ctx-bar-fill"
          style={{ width: `${pct}%`, background: warning ? 'linear-gradient(90deg,#f59e0b,#ef4444)' : 'linear-gradient(90deg,#3b82f6,#10b981)' }}
        />
        <div className="agent-ctx-bar-mark" style={{ left: `${COMPRESS_THRESHOLD * 100}%` }} />
      </div>

      <div className="agent-ctx-bar-foot">
        <span>{pct.toFixed(0)}%</span>
        <span>
          {noModel ? '请先启动模型'
            : warning ? '已超阈值'
              : `距压缩 ${toCompress.toLocaleString()}`}
        </span>
      </div>

      <div className="agent-ctx-divider">会话指标</div>

      <div className="agent-ctx-metrics">
        <div className="agent-ctx-metric">
          <span className="agent-ctx-metric-label"><Gauge size={11} /> 平均命中</span>
          <span className="agent-ctx-metric-val">{used > 0 ? `${hitRate.toFixed(1)}%` : '—'}</span>
        </div>
        <div className="agent-ctx-metric">
          <span className="agent-ctx-metric-label"><Clock size={11} /> 运行时间</span>
          <span className="agent-ctx-metric-val">{uptime}</span>
        </div>
        <div className="agent-ctx-metric">
          <span className="agent-ctx-metric-label"><Activity size={11} /> 请求数</span>
          <span className="agent-ctx-metric-val">{requests}</span>
        </div>
        <div className="agent-ctx-metric">
          <span className="agent-ctx-metric-label"><Hash size={11} /> 累计 tokens</span>
          <span className="agent-ctx-metric-val">{cumTokens.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}
