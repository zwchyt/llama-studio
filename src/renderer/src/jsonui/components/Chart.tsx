import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

const PIE_COLORS = [
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  '#a78bfa',
  '#f472b6',
  '#34d399',
  '#fbbf24',
]

export function Chart({
  props,
}: {
  props: {
    type: 'line' | 'bar' | 'pie'
    title: string | null
    data: Array<Record<string, unknown>>
    xKey: string
    yKey: string
  }
}) {
  const { type, title, data: rawData, xKey, yKey } = props
  const data = rawData as Array<Record<string, string | number>>
  if (!data || data.length === 0) {
    return (
      <div className="jui-card jui-chart">
        {title && <div className="jui-card-title">{title}</div>}
        <div className="jui-chart-empty">无数据</div>
      </div>
    )
  }
  return (
    <div className="jui-card jui-chart">
      {title && <div className="jui-card-title">{title}</div>}
      <div className="jui-chart-body">
        <ResponsiveContainer width="100%" height={240}>
          {type === 'line' ? (
            <LineChart data={data}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey={xKey} stroke="var(--text-muted)" />
              <YAxis stroke="var(--text-muted)" />
              <Tooltip contentStyle={{ background: 'var(--surface)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)' }} />
              <Line type="monotone" dataKey={yKey} stroke="var(--accent)" dot={false} />
            </LineChart>
          ) : type === 'bar' ? (
            <BarChart data={data}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey={xKey} stroke="var(--text-muted)" />
              <YAxis stroke="var(--text-muted)" />
              <Tooltip contentStyle={{ background: 'var(--surface)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)' }} />
              <Bar dataKey={yKey} fill="var(--accent)" />
            </BarChart>
          ) : (
            <PieChart>
              <Tooltip contentStyle={{ background: 'var(--surface)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)' }} />
              <Legend />
              <Pie data={data} dataKey={yKey} nameKey={xKey} outerRadius={80} label>
                {data.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
