import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react'
import { EChartsCard } from '../echarts/EChartsCard'
import { useBubbleTip } from './useBubbleTip'

type Preset = { label: string; code: string }
type Category = { name: string; items: { preset: Preset; index: number }[] }

// 按预设文件名分类。顺序即显示顺序；矩形树图必须排在树图前面，否则会被树图规则抢先命中。
const CATEGORY_RULES: { name: string; pattern: RegExp }[] = [
  { name: '折线图', pattern: /折线|^line\b/i },
  { name: '柱状图', pattern: /柱状|bar/i },
  { name: '饼图', pattern: /饼图|pie/i },
  { name: '散点图', pattern: /散点|scatter/i },
  { name: 'K线图', pattern: /k线|candlestick/i },
  { name: '雷达图', pattern: /雷达|radar/i },
  { name: '热力图', pattern: /热力|heatmap/i },
  { name: '关系图', pattern: /关系|graph/i },
  { name: '路径图', pattern: /路径|^lines$/i },
  { name: '矩形树图', pattern: /矩形树|treemap/i },
  { name: '树图', pattern: /树图|^tree$/i },
  { name: '漏斗图', pattern: /漏斗|funnel/i },
  { name: '仪表盘', pattern: /仪表|gauge/i },
]

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px', borderRadius: 4, border: '1px solid',
    borderColor: active ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
    background: active ? 'var(--accent, #3b82f6)' : 'transparent',
    color: active ? '#fff' : 'var(--text, #111827)',
    cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
  }
}

// 按文件名前缀返回所属分类名；未命中任何规则进「其他」。
function categoryOf(label: string): string {
  return CATEGORY_RULES.find(r => r.pattern.test(label))?.name ?? '其他'
}

export default function EChartsTestView() {
  // 预设来自项目根目录 chart-presets/echarts 目录（一个 .json 一条，见主进程 get-chart-presets）；
  // 也可以直接「选择文件」挑磁盘上任意 Option JSON 读取渲染，不必复制粘贴。
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetsPath, setPresetsPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState(-1)
  const [activeCategory, setActiveCategory] = useState('')
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
        const list = res?.groups?.echarts ?? []
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

  // 把扁平预设按文件名归类；未命中任何规则的进「其他」。
  const categories = useMemo(() => {
    const map = new Map<string, Category>()
    presets.forEach((preset, index) => {
      const name = categoryOf(preset.label)
      const group = map.get(name) ?? { name, items: [] }
      group.items.push({ preset, index })
      map.set(name, group)
    })
    return [...map.values()].sort((a, b) => {
      const ai = CATEGORY_RULES.findIndex(r => r.name === a.name)
      const bi = CATEGORY_RULES.findIndex(r => r.name === b.name)
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
    })
  }, [presets])

  // 切换分类时自动选中该类第一个图表，省去再点一次图表按钮。
  const selectCategory = (name: string) => {
    setActiveCategory(name)
    const first = name
      ? categories.find(c => c.name === name)?.items[0]
      : (presets.length ? { preset: presets[0], index: 0 } : undefined)
    if (first) {
      setActivePreset(first.index)
      setCode(first.preset.code)
      setLabel(first.preset.label)
    }
  }

  const pickFile = useCallback(async () => {
    try {
      const res = await window.api.pickChartFile('echarts')
      if (!res || res.canceled) return
      if (res.error) { setError(res.error); return }
      if (typeof res.code === 'string') {
        // 选中的文件按文件名自动归入对应分类，临时追加进预设列表并直接选中渲染；
        // 同名同内容已存在时只选中，不重复堆积按钮。
        const label = (res.name ?? '').replace(/\.[^.]+$/, '').trim() || '未命名'
        const code = res.code
        const existing = presets.findIndex(p => p.label === label && p.code === code)
        if (existing < 0) {
          setPresets(prev => [...prev, { label, code }])
          setActivePreset(presets.length)
        } else {
          setActivePreset(existing)
        }
        setActiveCategory(categoryOf(label))
        setCode(res.code)
        setLabel(label)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [presets])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {tipNode}
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>ECharts 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          Option JSON 输入模式 | 预设来自 chart-presets/echarts 目录，或直接选择文件；填入即渲染，编辑即时生效
        </p>
        {error && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--danger, #dc2626)' }}>{error}</p>
        )}
        {presets.length === 0 && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
            未读取到 echarts 预设：在 <code>{presetsPath ? `${presetsPath}/echarts` : 'chart-presets/echarts'}</code> 目录里
            放入 <code>.json</code> 文件即可，文件内容就是 ECharts Option JSON，文件名即按钮标题（可选 <code>01-</code> 前缀用于排序）
          </p>
        )}
        {/* 顶部分类切换：点类型只显示该类型下的图表；「全部」恢复所有 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border, #e5e7eb)' }}>
          <button onClick={() => selectCategory('')} style={tabStyle(activeCategory === '')}>全部</button>
          {categories.map(c => (
            <button key={c.name} onClick={() => selectCategory(c.name)} style={tabStyle(activeCategory === c.name)}>
              {c.name} <span style={{ opacity: 0.7 }}>({c.items.length})</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {(activeCategory ? (categories.find(c => c.name === activeCategory)?.items ?? []) : presets.map((preset, index) => ({ preset, index }))).map(({ preset, index }) => (
            <button
              key={`${preset.label}-${index}`}
              onClick={() => { setActivePreset(index); setCode(preset.code); setLabel(preset.label) }}
              style={tabStyle(activePreset === index)}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={pickFile}
            {...tip('选择一个 ECharts Option JSON 文件直接渲染')}
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
            onChange={e => { setCode(e.target.value); setActivePreset(-1) }}
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
            // 与其他测试页同款：右侧渲染卡片，外壳（复制源码 / 下载 .svg / .png / 查看源码 / 放大）由 FigureFrame 提供。
            <EChartsCard key={code} code={code} title={label} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              请输入 ECharts Option JSON 或选择文件
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
