import React, { useState, useEffect, useCallback } from 'react'
import { InfographicCard } from '../infographic/InfographicCard'
import { useBubbleTip } from './useBubbleTip'

type Preset = { label: string; code: string }

export default function InfographicTestView() {
  // 预设来自项目根目录 chart-presets/infographic 目录（一个文件一条，见主进程 get-chart-presets）；
  // 也可以直接「选择文件」挑磁盘上任意文本文件读取渲染，不必复制粘贴。
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetsPath, setPresetsPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState(-1)
  const [label, setLabel] = useState('')
  const [code, setCode] = useState('')
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.getChartPresets()
        if (cancelled) return
        const list = res?.groups?.infographic ?? []
        setPresets(list)
        setPresetsPath(res?.path ?? '')
        setError(res?.error ?? null)
        setActivePreset(list.length ? 0 : -1)
        setCode(list[0]?.code ?? '')
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
      const res = await window.api.pickChartFile('infographic')
      if (!res || res.canceled) return
      if (res.error) { setError(res.error); return }
      if (typeof res.code === 'string') {
        setCode(res.code)
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
      {tipNode}
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Infographic 信息图渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          AntV Infographic DSL 输入模式 | 预设来自 chart-presets/infographic 目录，或直接选择文件；填入即渲染，编辑即时生效
        </p>
        {error && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--danger, #dc2626)' }}>{error}</p>
        )}
        {presets.length === 0 && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
            未读取到 infographic 预设：在 <code>{presetsPath ? `${presetsPath}/infographic` : 'chart-presets/infographic'}</code> 目录里
            放入 <code>.txt</code> 或 <code>.info</code> 文件即可，内容是 Infographic DSL（第一行模板名，缩进表示层级），文件名即按钮标题（可选 <code>01-</code> 前缀用于排序）
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {presets.map((preset, i) => (
            <button
              key={`${preset.label}-${i}`}
              onClick={() => { setActivePreset(i); setCode(preset.code); setLabel(preset.label) }}
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
            {...tip('选择一个 Infographic DSL 文件直接渲染')}
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
            value={code}
            onChange={e => setCode(e.target.value)}
            spellCheck={false}
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
          {code ? (
            // key 跟随源码：InfographicCard 内部有失败锁存，源码变化时重新挂载才能重新尝试渲染
            <InfographicCard key={code} code={code} title={label} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              请输入 Infographic DSL 或选择文件
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
