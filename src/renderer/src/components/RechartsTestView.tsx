import React, { useState, useCallback } from 'react'
import { ChartCard } from '../recharts'

const CHART_PRESETS: Array<{ label: string; code: string }> = [
  {
    label: 'line',
    code: JSON.stringify({
      type: 'line',
      title: '月度销售额',
      data: [
        { month: '1月', sales: 120, profit: 40 },
        { month: '2月', sales: 200, profit: 80 },
        { month: '3月', sales: 150, profit: 55 },
        { month: '4月', sales: 180, profit: 70 },
        { month: '5月', sales: 220, profit: 95 },
        { month: '6月', sales: 190, profit: 75 },
      ],
      xKey: 'month',
      series: [
        { key: 'sales', name: '销售额', color: 'var(--rc-c1)' },
        { key: 'profit', name: '利润', color: 'var(--rc-c2)' },
      ],
    }, null, 2),
  },
  {
    label: 'bar',
    code: JSON.stringify({
      type: 'bar',
      title: '季度对比',
      data: [
        { quarter: 'Q1', revenue: 400, cost: 240 },
        { quarter: 'Q2', revenue: 300, cost: 139 },
        { quarter: 'Q3', revenue: 500, cost: 300 },
        { quarter: 'Q4', revenue: 450, cost: 280 },
      ],
      xKey: 'quarter',
      series: [
        { key: 'revenue', name: '收入' },
        { key: 'cost', name: '成本' },
      ],
    }, null, 2),
  },
  {
    label: 'stacked bar',
    code: JSON.stringify({
      type: 'bar',
      title: '堆叠柱状图',
      stacked: true,
      data: [
        { month: '1月', desktop: 400, mobile: 240, tablet: 100 },
        { month: '2月', desktop: 300, mobile: 139, tablet: 80 },
        { month: '3月', desktop: 200, mobile: 180, tablet: 120 },
        { month: '4月', desktop: 278, mobile: 190, tablet: 90 },
      ],
      xKey: 'month',
      series: [
        { key: 'desktop', name: '桌面端' },
        { key: 'mobile', name: '移动端' },
        { key: 'tablet', name: '平板' },
      ],
    }, null, 2),
  },
  {
    label: 'area',
    code: JSON.stringify({
      type: 'area',
      title: '访问量趋势',
      data: [
        { date: '周一', uv: 400, pv: 2400 },
        { date: '周二', uv: 300, pv: 1398 },
        { date: '周三', uv: 200, pv: 9800 },
        { date: '周四', uv: 278, pv: 3908 },
        { date: '周五', uv: 189, pv: 4800 },
        { date: '周六', uv: 239, pv: 3800 },
        { date: '周日', uv: 349, pv: 4300 },
      ],
      xKey: 'date',
      series: [
        { key: 'pv', name: '页面访问' },
        { key: 'uv', name: '独立访客' },
      ],
    }, null, 2),
  },
  {
    label: 'pie',
    code: JSON.stringify({
      type: 'pie',
      title: '市场份额',
      data: [
        { name: 'Chrome', value: 65 },
        { name: 'Safari', value: 18 },
        { name: 'Firefox', value: 8 },
        { name: 'Edge', value: 5 },
        { name: '其他', value: 4 },
      ],
      xKey: 'name',
      yKey: 'value',
    }, null, 2),
  },
  {
    label: 'radar',
    code: JSON.stringify({
      type: 'radar',
      title: '能力评估',
      data: [
        { subject: '速度', A: 80, B: 60 },
        { subject: '可靠性', A: 90, B: 70 },
        { subject: '安全性', A: 70, B: 90 },
        { subject: '易用性', A: 85, B: 75 },
        { subject: '成本', A: 60, B: 85 },
      ],
      xKey: 'subject',
      series: [
        { key: 'A', name: '方案 A' },
        { key: 'B', name: '方案 B' },
      ],
    }, null, 2),
  },
  {
    label: 'scatter',
    code: JSON.stringify({
      type: 'scatter',
      title: '身高体重分布',
      data: [
        { height: 160, weight: 55 },
        { height: 165, weight: 60 },
        { height: 170, weight: 65 },
        { height: 175, weight: 72 },
        { height: 180, weight: 80 },
        { height: 185, weight: 85 },
        { height: 155, weight: 48 },
        { height: 168, weight: 58 },
      ],
      xKey: 'height',
      yKey: 'weight',
    }, null, 2),
  },
  {
    label: 'multi-series',
    code: JSON.stringify({
      type: 'line',
      title: '多指标监控',
      unit: '%',
      data: [
        { time: '00:00', cpu: 45, mem: 62, disk: 30 },
        { time: '04:00', cpu: 30, mem: 58, disk: 31 },
        { time: '08:00', cpu: 75, mem: 70, disk: 35 },
        { time: '12:00', cpu: 88, mem: 78, disk: 40 },
        { time: '16:00', cpu: 65, mem: 72, disk: 38 },
        { time: '20:00', cpu: 50, mem: 65, disk: 33 },
      ],
      xKey: 'time',
      series: [
        { key: 'cpu', name: 'CPU', color: 'var(--rc-c1)' },
        { key: 'mem', name: '内存', color: 'var(--rc-c2)' },
        { key: 'disk', name: '磁盘', color: 'var(--rc-c3)' },
      ],
    }, null, 2),
  },
]

export default function RechartsTestView() {
  const [activePreset, setActivePreset] = useState(0)
  const [jsonCode, setJsonCode] = useState(CHART_PRESETS[0].code)
  const [renderKey, setRenderKey] = useState(0)

  const handlePreset = useCallback((index: number) => {
    setActivePreset(index)
    setJsonCode(CHART_PRESETS[index].code)
    setRenderKey(k => k + 1)
  }, [])

  const handleRender = useCallback(() => {
    setRenderKey(k => k + 1)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Recharts 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          ChartSpec JSON 输入模式 | 点击预设自动填入，修改后点击渲染
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {CHART_PRESETS.map((preset, i) => (
            <button
              key={preset.label}
              onClick={() => handlePreset(i)}
              style={{
                padding: '4px 10px', borderRadius: 4, border: '1px solid',
                borderColor: activePreset === i ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
                background: activePreset === i ? 'var(--accent, #3b82f6)' : 'transparent',
                color: activePreset === i ? '#fff' : 'var(--text, #111827)',
                cursor: 'pointer', fontSize: 12, fontWeight: activePreset === i ? 600 : 400,
              }}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={handleRender}
            style={{
              padding: '4px 10px', borderRadius: 4, border: '1px solid var(--accent, #3b82f6)',
              background: 'var(--accent, #3b82f6)', color: '#fff',
              cursor: 'pointer', fontSize: 12, fontWeight: 600, marginLeft: 4,
            }}
          >
            渲染
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12, padding: '0 20px 16px' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <textarea
            value={jsonCode}
            onChange={e => setJsonCode(e.target.value)}
            style={{
              flex: 1, minHeight: 200, padding: 10, borderRadius: 4,
              border: '1px solid var(--border, #d1d5db)',
              background: 'var(--surface, #ffffff)', color: 'var(--text, #111827)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 13, lineHeight: 1.5, resize: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{
          flex: 1, minWidth: 0, overflow: 'auto', border: '1px solid var(--border, #d1d5db)',
          borderRadius: 8, background: 'var(--bg, #f5f5f5)', padding: 12,
        }}>
          {jsonCode ? (
            <ChartCard key={renderKey} code={jsonCode} title={CHART_PRESETS[activePreset]?.label} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              请输入 ChartSpec JSON 后点击渲染
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
