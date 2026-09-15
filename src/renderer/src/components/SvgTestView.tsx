import React, { useState, useCallback } from 'react'
import { SvgCard } from '../svg/SvgCard'

const SVG_PRESETS: Array<{ label: string; code: string }> = [
  {
    label: 'bar chart',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" font-family="sans-serif">
  <text x="200" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">季度销售额</text>
  <g transform="translate(50,40)">
    <line x1="0" y1="200" x2="320" y2="200" stroke="#ccc" stroke-width="1"/>
    <rect x="20" y="80" width="50" height="120" fill="#3b82f6" rx="4"/>
    <text x="45" y="215" text-anchor="middle" font-size="11" fill="#666">Q1</text>
    <text x="45" y="75" text-anchor="middle" font-size="11" fill="#333">120</text>
    <rect x="95" y="40" width="50" height="160" fill="#10b981" rx="4"/>
    <text x="120" y="215" text-anchor="middle" font-size="11" fill="#666">Q2</text>
    <text x="120" y="35" text-anchor="middle" font-size="11" fill="#333">160</text>
    <rect x="170" y="60" width="50" height="140" fill="#f59e0b" rx="4"/>
    <text x="195" y="215" text-anchor="middle" font-size="11" fill="#666">Q3</text>
    <text x="195" y="55" text-anchor="middle" font-size="11" fill="#333">140</text>
    <rect x="245" y="20" width="50" height="180" fill="#ef4444" rx="4"/>
    <text x="270" y="215" text-anchor="middle" font-size="11" fill="#666">Q4</text>
    <text x="270" y="15" text-anchor="middle" font-size="11" fill="#333">180</text>
  </g>
</svg>`,
  },
  {
    label: 'line chart',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" font-family="sans-serif">
  <text x="200" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">温度变化</text>
  <g transform="translate(50,40)">
    <line x1="0" y1="200" x2="300" y2="200" stroke="#ccc" stroke-width="1"/>
    <line x1="0" y1="0" x2="0" y2="200" stroke="#ccc" stroke-width="1"/>
    <polyline points="0,160 60,120 120,140 180,80 240,100 300,40" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="0" cy="160" r="4" fill="#3b82f6"/>
    <circle cx="60" cy="120" r="4" fill="#3b82f6"/>
    <circle cx="120" cy="140" r="4" fill="#3b82f6"/>
    <circle cx="180" cy="80" r="4" fill="#3b82f6"/>
    <circle cx="240" cy="100" r="4" fill="#3b82f6"/>
    <circle cx="300" cy="40" r="4" fill="#3b82f6"/>
    <text x="0" y="215" text-anchor="middle" font-size="10" fill="#666">1月</text>
    <text x="60" y="215" text-anchor="middle" font-size="10" fill="#666">2月</text>
    <text x="120" y="215" text-anchor="middle" font-size="10" fill="#666">3月</text>
    <text x="180" y="215" text-anchor="middle" font-size="10" fill="#666">4月</text>
    <text x="240" y="215" text-anchor="middle" font-size="10" fill="#666">5月</text>
    <text x="300" y="215" text-anchor="middle" font-size="10" fill="#666">6月</text>
  </g>
</svg>`,
  },
  {
    label: 'pie chart',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" font-family="sans-serif">
  <text x="200" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">语言占比</text>
  <g transform="translate(200,160)">
    <circle cx="0" cy="0" r="100" fill="none" stroke="#3b82f6" stroke-width="40" stroke-dasharray="220 408" stroke-dashoffset="0" transform="rotate(-90)"/>
    <circle cx="0" cy="0" r="100" fill="none" stroke="#10b981" stroke-width="40" stroke-dasharray="113 515" stroke-dashoffset="-220" transform="rotate(-90)"/>
    <circle cx="0" cy="0" r="100" fill="none" stroke="#f59e0b" stroke-width="40" stroke-dasharray="63 565" stroke-dashoffset="-333" transform="rotate(-90)"/>
    <circle cx="0" cy="0" r="100" fill="none" stroke="#ef4444" stroke-width="40" stroke-dasharray="38 590" stroke-dashoffset="-396" transform="rotate(-90)"/>
    <text x="130" y="-60" font-size="12" fill="#3b82f6">● JavaScript 40%</text>
    <text x="130" y="-35" font-size="12" fill="#10b981">● Python 25%</text>
    <text x="130" y="-10" font-size="12" fill="#f59e0b">● TypeScript 15%</text>
    <text x="130" y="15" font-size="12" fill="#ef4444">● Go 8%</text>
    <text x="130" y="40" font-size="12" fill="#999">● 其他 12%</text>
  </g>
</svg>`,
  },
  {
    label: 'flowchart',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300" font-family="sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#666"/>
    </marker>
  </defs>
  <rect x="30" y="20" width="120" height="50" rx="8" fill="#dbeafe" stroke="#3b82f6" stroke-width="2"/>
  <text x="90" y="50" text-anchor="middle" font-size="13" fill="#1e40af">用户请求</text>
  <rect x="200" y="20" width="120" height="50" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="2"/>
  <text x="260" y="50" text-anchor="middle" font-size="13" fill="#065f46">API 网关</text>
  <rect x="370" y="20" width="120" height="50" rx="8" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>
  <text x="430" y="50" text-anchor="middle" font-size="13" fill="#92400e">数据库</text>
  <rect x="120" y="140" width="120" height="50" rx="8" fill="#ede9fe" stroke="#8b5cf6" stroke-width="2"/>
  <text x="180" y="170" text-anchor="middle" font-size="13" fill="#5b21b6">认证服务</text>
  <rect x="290" y="140" width="120" height="50" rx="8" fill="#fce7f3" stroke="#ec4899" stroke-width="2"/>
  <text x="350" y="170" text-anchor="middle" font-size="13" fill="#9d174d">业务逻辑</text>
  <line x1="150" y1="45" x2="198" y2="45" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="320" y1="45" x2="368" y2="45" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="260" y1="70" x2="180" y2="138" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="260" y1="70" x2="350" y2="138" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="250" y="260" text-anchor="middle" font-size="12" fill="#999">系统架构流程图</text>
</svg>`,
  },
  {
    label: 'gauge',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 220" font-family="sans-serif">
  <text x="150" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">CPU 使用率</text>
  <g transform="translate(150,130)">
    <path d="M -90 0 A 90 90 0 0 1 90 0" fill="none" stroke="#e5e7eb" stroke-width="18" stroke-linecap="round"/>
    <path d="M -90 0 A 90 90 0 0 1 54 -72" fill="none" stroke="#3b82f6" stroke-width="18" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="6" fill="#333"/>
    <text x="0" y="35" text-anchor="middle" font-size="28" font-weight="bold" fill="#3b82f6">72%</text>
    <text x="-85" y="20" font-size="10" fill="#999">0%</text>
    <text x="75" y="20" font-size="10" fill="#999">100%</text>
  </g>
</svg>`,
  },
  {
    label: 'progress',
    code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" font-family="sans-serif">
  <text x="200" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">下载进度</text>
  <g transform="translate(30,50)">
    <text x="0" y="15" font-size="13" fill="#333">模型文件 (4.2 GB)</text>
    <rect x="0" y="25" width="340" height="20" rx="10" fill="#e5e7eb"/>
    <rect x="0" y="25" width="238" height="20" rx="10" fill="#3b82f6"/>
    <text x="340" y="40" text-anchor="end" font-size="11" fill="#666">70%</text>
    <text x="0" y="65" font-size="13" fill="#333">权重文件 (1.8 GB)</text>
    <rect x="0" y="75" width="340" height="20" rx="10" fill="#e5e7eb"/>
    <rect x="0" y="75" width="136" height="20" rx="10" fill="#10b981"/>
    <text x="340" y="90" text-anchor="end" font-size="11" fill="#666">40%</text>
    <text x="0" y="115" font-size="13" fill="#333">配置文件 (12 KB)</text>
    <rect x="0" y="125" width="340" height="20" rx="10" fill="#e5e7eb"/>
    <rect x="0" y="125" width="340" height="20" rx="10" fill="#f59e0b"/>
    <text x="340" y="140" text-anchor="end" font-size="11" fill="#666">100%</text>
  </g>
</svg>`,
  },
]

export default function SvgTestView() {
  const [activePreset, setActivePreset] = useState(0)
  const [svgCode, setSvgCode] = useState(SVG_PRESETS[0].code)
  const [renderKey, setRenderKey] = useState(0)

  const handlePreset = useCallback((index: number) => {
    setActivePreset(index)
    setSvgCode(SVG_PRESETS[index].code)
    setRenderKey(k => k + 1)
  }, [])

  const handleRender = useCallback(() => {
    setRenderKey(k => k + 1)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>SVG 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          原始 SVG 代码输入模式 | 点击预设自动填入，修改后点击渲染
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {SVG_PRESETS.map((preset, i) => (
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
            value={svgCode}
            onChange={e => setSvgCode(e.target.value)}
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
          {svgCode ? (
            <SvgCard key={renderKey} code={svgCode} title={SVG_PRESETS[activePreset]?.label} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              请输入 SVG 代码后点击渲染
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
