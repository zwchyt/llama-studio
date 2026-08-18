import { defineRegistry } from '@json-render/react'
import { catalog } from './catalog'
import './jsonui.css'

const severityColor: Record<string, string> = {
  info: 'var(--success)',
  warning: 'var(--warning)',
  critical: 'var(--danger)',
}

const stepColor: Record<string, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--accent)',
  success: 'var(--success)',
  failed: 'var(--danger)',
}

export const { registry } = defineRegistry(catalog, {
  components: {
    Metric: ({ props }) => (
      <div className="jui-metric">
        <div className="jui-metric-label">{props.label}</div>
        <div className="jui-metric-value">{props.value}</div>
        {props.hint && <div className="jui-metric-hint">{props.hint}</div>}
      </div>
    ),
    InferenceMetrics: ({ props }) => (
      <div className="jui-card jui-metrics">
        <div className="jui-card-title">
          推理指标
          <span className={`jui-badge jui-badge-${props.status}`}>{props.status}</span>
        </div>
        <div className="jui-grid2">
          <MetricView label="Prompt tokens/s" value={props.promptTokensPerSec} />
          <MetricView label="Generation tokens/s" value={props.generationTokensPerSec} />
          <MetricView label="上下文占用" value={props.ctxTokens != null && props.ctxLimit != null ? `${props.ctxTokens} / ${props.ctxLimit}` : null} />
          <MetricView label="KV cache" value={props.kvCacheMb != null ? `${props.kvCacheMb} MB` : null} />
        </div>
        {props.gpuMemMb != null && (
          <div className="jui-metrics-footer">GPU 显存占用：{props.gpuMemMb} MB</div>
        )}
      </div>
    ),
    GpuUsagePanel: ({ props }) => (
      <div className="jui-card">
        <div className="jui-card-title">GPU 状态 · {props.engine}</div>
        <div className="jui-grid2">
          <MetricView label="利用率" value={props.utilization != null ? `${props.utilization}%` : null} />
          <MetricView
            label="显存"
            value={
              props.memoryUsedMb != null && props.memoryTotalMb != null
                ? `${props.memoryUsedMb} / ${props.memoryTotalMb} MB`
                : null
            }
          />
          <MetricView label="温度" value={props.temperature != null ? `${props.temperature}C` : null} />
        </div>
        {props.utilization != null && (
          <div className="jui-progress">
            <div className="jui-progress-fill" style={{ width: `${Math.min(100, props.utilization)}%`, background: 'var(--accent)' }} />
          </div>
        )}
      </div>
    ),
    ModelRuntimeStatus: ({ props }) => (
      <div className="jui-card">
        <div className="jui-card-title">
          {props.modelName}
          <span className={`jui-badge jui-badge-${props.status}`}>{props.status}</span>
        </div>
        <div className="jui-row">
          <span className="jui-label">引擎</span>
          <span className="jui-value">{props.engine}</span>
        </div>
        {props.port != null && (
          <div className="jui-row">
            <span className="jui-label">端口</span>
            <span className="jui-value">{props.port}</span>
          </div>
        )}
        {props.contextLength != null && (
          <div className="jui-row">
            <span className="jui-label">上下文</span>
            <span className="jui-value">{props.contextLength} tokens</span>
          </div>
        )}
        {props.uptimeSec != null && (
          <div className="jui-row">
            <span className="jui-label">运行时长</span>
            <span className="jui-value">{formatDuration(props.uptimeSec)}</span>
          </div>
        )}
      </div>
    ),
    ErrorDiagnosisCard: ({ props, emit, children }) => (
      <div className="jui-card jui-diagnosis" style={{ borderLeftColor: severityColor[props.severity] }}>
        <div className="jui-card-title">
          <span style={{ color: severityColor[props.severity] }}>{props.title}</span>
          <span className={`jui-badge jui-badge-${props.severity === 'critical' ? 'failed' : props.severity === 'warning' ? 'running' : 'success'}`}>
            {props.severity}
          </span>
        </div>
        <div className="jui-diagnosis-cause">{props.cause}</div>
        <ul className="jui-rec">
          {props.recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {children}
        <div className="jui-actions">
          <button className="jui-btn jui-btn-ghost" onClick={() => emit('copy')}>
            复制报告
          </button>
          <button className="jui-btn" onClick={() => emit('retry')}>
            重试模型加载
          </button>
          <button className="jui-btn jui-btn-ghost" onClick={() => emit('dismiss')}>
            关闭
          </button>
        </div>
      </div>
    ),
    LogExcerpt: ({ props }) => (
      <div className={`jui-card jui-log jui-log-${props.level}`}>
        <div className="jui-card-title">{props.title}</div>
        <pre className="jui-log-body">
          {props.lines.map((l, i) => (
            <div key={i} className={`jui-log-line${props.errorLine === i ? ' jui-log-line-error' : ''}`}>
              <span className="jui-log-line-no">{props.start + i}</span>
              <span className="jui-log-line-text">{l}</span>
            </div>
          ))}
        </pre>
      </div>
    ),
    AgentStepCard: ({ props }) => (
      <div className="jui-card jui-step">
        <div className="jui-step-head">
          <span className="jui-step-dot" style={{ background: stepColor[props.status] }} />
          <span className="jui-step-title">{props.title}</span>
          <span className={`jui-badge jui-badge-${props.status}`}>{props.status}</span>
        </div>
        {props.description && <div className="jui-step-desc">{props.description}</div>}
        {props.durationMs != null && <div className="jui-step-dur">{props.durationMs} ms</div>}
      </div>
    ),
    TaskTimeline: ({ props }) => (
      <div className="jui-card">
        {props.title && <div className="jui-card-title">{props.title}</div>}
        <div className="jui-timeline">
          {props.steps.map((s, i) => (
            <div key={i} className="jui-timeline-item">
              <div className="jui-timeline-marker" style={{ background: stepColor[s.status] }} />
              <div className="jui-timeline-body">
                <div className="jui-timeline-title">
                  {s.title}
                  <span className={`jui-badge jui-badge-${s.status}`}>{s.status}</span>
                </div>
                {s.detail && <div className="jui-timeline-detail">{s.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    ConfirmDangerousAction: ({ props, emit }) => (
      <div className="jui-card jui-confirm" style={{ borderLeftColor: props.dangerLevel === 'danger' ? 'var(--danger)' : 'var(--warning)' }}>
        <div className="jui-card-title" style={{ color: props.dangerLevel === 'danger' ? 'var(--danger)' : 'var(--warning)' }}>
          {props.title}
        </div>
        <div className="jui-confirm-msg">{props.message}</div>
        <div className="jui-actions">
          <button
            className="jui-btn jui-btn-danger"
            onClick={() => emit('confirm')}
            style={props.dangerLevel === 'danger' ? { background: 'var(--danger)' } : { background: 'var(--warning)' }}
          >
            {props.confirmLabel ?? '确认执行'}
          </button>
          <button className="jui-btn jui-btn-ghost" onClick={() => emit('cancel')}>
            取消
          </button>
        </div>
      </div>
    ),
    DownloadProgressCard: ({ props }) => (
      <div className="jui-card">
        <div className="jui-card-title">
          {props.fileName}
          <span className={`jui-badge jui-badge-${props.status}`}>{props.status}</span>
        </div>
        <div className="jui-progress">
          <div className="jui-progress-fill" style={{ width: `${props.progress}%` }} />
        </div>
        <div className="jui-dl-meta">
          <span>{props.progress.toFixed(1)}%</span>
          {props.sizeMb != null && <span>{props.sizeMb.toFixed(0)} MB</span>}
          {props.speedMbPerSec != null && <span>{props.speedMbPerSec.toFixed(1)} MB/s</span>}
        </div>
      </div>
    ),
    ConfigurationDiff: ({ props, emit }) => (
      <div className="jui-card">
        {props.title && <div className="jui-card-title">{props.title}</div>}
        <table className="jui-diff">
          <thead>
            <tr>
              <th>参数</th>
              <th>当前</th>
              <th>建议</th>
            </tr>
          </thead>
          <tbody>
            {props.changes.map((c, i) => (
              <tr key={i}>
                <td className="jui-diff-key">{c.key}</td>
                <td className="jui-diff-from">{c.from}</td>
                <td className="jui-diff-to">{c.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="jui-actions">
          <button className="jui-btn" onClick={() => emit('apply')}>
            应用建议
          </button>
        </div>
      </div>
    ),
    MessageCard: ({ props }) => (
      <div className="jui-card" style={{ borderLeftColor: severityColor[props.variant] }}>
        <div className="jui-card-title" style={{ color: severityColor[props.variant] }}>
          {props.title}
        </div>
        <div className="jui-confirm-msg">{props.message}</div>
      </div>
    ),
  },
  actions: {
    retryModelLoad: async () => {
      console.log('[jsonui] retryModelLoad')
    },
    openLogFile: async () => {
      console.log('[jsonui] openLogFile')
    },
    copySuggestedArgs: async () => {
      console.log('[jsonui] copySuggestedArgs')
    },
    applyRuntimePreset: async () => {
      console.log('[jsonui] applyRuntimePreset')
    },
    confirmDangerousAction: async () => {
      console.log('[jsonui] confirmDangerousAction')
    },
    dismissCard: async () => {
      console.log('[jsonui] dismissCard')
    },
  },
})

function MetricView({ label, value }: { label: string; value: number | string | null }) {
  return (
    <div className="jui-metric">
      <div className="jui-metric-label">{label}</div>
      <div className="jui-metric-value">{value ?? '—'}</div>
    </div>
  )
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}