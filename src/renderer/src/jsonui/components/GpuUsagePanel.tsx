import { MetricView } from '../shared/MetricView'

export function GpuUsagePanel({
  props,
}: {
  props: {
    engine: string
    utilization: number | null
    memoryUsedMb: number | null
    memoryTotalMb: number | null
    temperature: number | null
  }
}) {
  return (
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
          <div
            className="jui-progress-fill"
            style={{ width: `${Math.min(100, props.utilization)}%`, background: 'var(--accent)' }}
          />
        </div>
      )}
    </div>
  )
}
