import React, { useState, useEffect, useCallback } from 'react'
import { ChartCard } from '../recharts'

type Preset = { label: string; code: string }

export default function RechartsTestView() {
  // 预设来自项目根目录 chart-presets/recharts 目录（一个 .json 一条，见主进程 get-chart-presets）；
  // 也可以直接「选择文件」挑磁盘上任意 ChartSpec JSON 读取渲染，不必复制粘贴。
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetsPath, setPresetsPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState(-1)
  const [label, setLabel] = useState('')
  const [jsonCode, setJsonCode] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.getChartPresets()
        if (cancelled) return
        const list = res?.groups?.recharts ?? []
        setPresets(list)
        setPresetsPath(res?.path ?? '')
        setError(res?.error ?? null)
        setActivePreset(list.length ? 0 : -1)
        setJsonCode(list[0]?.code ?? '')
        setLabel(list[0]?.label ?? '')
      } catch (e) {
        if (cancelled) return
        setPresets([])
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const pickFile = useCallback(async () => {
    try {
      const res = await window.api.pickChartFile('recharts')
      if (!res || res.canceled) return
      if (res.error) { setError(res.error); return }
      if (typeof res.code === 'string') {
        setJsonCode(res.code)
        setActivePreset(-1)
        setLabel(res.name ?? '')
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Recharts 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          ChartSpec JSON 输入模式 | 预设来自 chart-presets/recharts 目录，或直接选择文件；填入即渲染，编辑即时生效
        </p>
        {error && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--danger, #dc2626)' }}>{error}</p>
        )}
        {presets.length === 0 && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
            未读取到 recharts 预设：在 <code>{presetsPath ? `${presetsPath}/recharts` : 'chart-presets/recharts'}</code> 目录里
            放入 <code>.json</code> 文件即可，文件内容就是 ChartSpec JSON，文件名即按钮标题（可选 <code>01-</code> 前缀用于排序）
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {presets.map((preset, i) => (
            <button
              key={`${preset.label}-${i}`}
              onClick={() => { setActivePreset(i); setJsonCode(preset.code); setLabel(preset.label) }}
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
            onClick={pickFile}
            title="选择一个 ChartSpec JSON 文件直接渲染"
            style={{
              padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border, #d1d5db)',
              background: 'transparent', color: 'var(--text, #111827)',
              cursor: 'pointer', fontSize: 12, marginLeft: 4,
            }}
          >
            选择文件
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
            // key 跟随源码：ChartCard 内的错误边界有 failed 锁存，源码变化时重新挂载才能重新尝试渲染
            <ChartCard key={jsonCode} code={jsonCode} title={label} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              请输入 ChartSpec JSON 或选择文件
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
