export function MetricView({ label, value }: { label: string; value: number | string | null }) {
  return (
    <div className="jui-metric">
      <div className="jui-metric-label">{label}</div>
      <div className="jui-metric-value">{value ?? '—'}</div>
    </div>
  )
}
