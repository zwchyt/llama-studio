import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { useThemeStore } from '../store/themeStore'
import './colorStudio.css'

/* ══════════════════════════════════════════════════════════
   配色工作台（独立弹窗）
   完全自包含：不改任何既有样式文件，靠往 <head> 追加一个 <style> 覆盖
   CSS 变量来实现换色。关掉 / 恢复默认后与原来的样式系统零耦合。

   可调内容：
     · 整体调节 —— 色温 / 明度 / 文字对比，三个滑杆对全部颜色一起生效
     · 逐项取色 —— 每个变量一个取色器，直接点开调
   两个主题分开调，切换面板上的标签即切换应用主题，所见即所改。
   ══════════════════════════════════════════════════════════ */

type Mode = 'light' | 'dark'

const GROUPS: { title: string; keys: string[] }[] = [
  { title: '底色层', keys: ['--bg', '--surface', '--surface-hover'] },
  { title: '描边', keys: ['--border', '--border-strong'] },
  { title: '文字', keys: ['--text', '--text-secondary', '--text-muted'] },
  { title: '强调', keys: ['--accent', '--accent-fg'] },
  { title: '代码块', keys: ['--code-bg', '--code-header-bg', '--code-border', '--code-text'] },
  { title: '其它面', keys: ['--table-head-bg', '--quote-bg'] },
]

const LABELS: Record<string, string> = {
  '--bg': '页面底色',
  '--surface': '卡片面',
  '--surface-hover': '卡片悬停面',
  '--border': '边框',
  '--border-strong': '强边框',
  '--text': '正文',
  '--text-secondary': '次级文字',
  '--text-muted': '弱文字',
  '--accent': '强调色',
  '--accent-fg': '强调反白',
  '--code-bg': '代码块底',
  '--code-header-bg': '代码块头',
  '--code-border': '代码块边框',
  '--code-text': '代码文字',
  '--table-head-bg': '表头',
  '--quote-bg': '引用底',
}

const ALL_KEYS: string[] = GROUPS.flatMap((g) => g.keys)

// 「明度」滑杆作用于背景类颜色
const SURFACE_KEYS = new Set<string>([
  '--bg', '--surface', '--surface-hover', '--border', '--border-strong',
  '--code-bg', '--code-header-bg', '--code-border', '--table-head-bg', '--quote-bg',
])
// 「文字对比」滑杆作用于文字类颜色
const TEXT_KEYS = new Set<string>(['--text', '--text-secondary', '--text-muted', '--code-text'])

const LS_KEY = 'appColorStudio'
const STYLE_ID = 'color-studio-vars'

/* ── 颜色换算 ── */
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(normalizeHex(hex).slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function normalizeHex(raw: string): string {
  const v = (raw || '').trim()
  if (v.startsWith('#')) {
    const h = v.slice(1)
    if (h.length === 3) return '#' + h.split('').map((c) => c + c).join('').toLowerCase()
    if (h.length >= 6) return ('#' + h.slice(0, 6)).toLowerCase()
    return '#000000'
  }
  const m = v.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x))
    return rgbToHex(r, g, b)
  }
  return '#000000'
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  let h = 0, s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s * 100, l * 100]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360
  const ss = clamp(s, 0, 100) / 100
  const ll = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  let r = 0, g = 0, b = 0
  if (hh < 60) { r = c; g = x }
  else if (hh < 120) { r = x; g = c }
  else if (hh < 180) { g = c; b = x }
  else if (hh < 240) { g = x; b = c }
  else if (hh < 300) { r = x; b = c }
  else { r = c; b = x }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// 沿色轮最短路径把色相 a 往 b 拉 t（0~1）
function blendHue(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180
  return (a + d * t + 360) % 360
}

/* ── 数据结构 ── */
interface Adjust { tint: number; light: number; contrast: number }
const ZERO_ADJ: Adjust = { tint: 0, light: 0, contrast: 0 }

type Palette = Record<string, string>
interface ModeState { base: Palette; adj: Adjust }
interface StudioState { light: ModeState; dark: ModeState }

function applyAdjust(hex: string, key: string, adj: Adjust, mode: Mode): string {
  let [h, s, l] = rgbToHsl(...hexToRgb(hex))
  if (Math.abs(adj.tint) > 0.02) {
    const amt = Math.abs(adj.tint)
    h = blendHue(h, adj.tint > 0 ? 32 : 214, amt)
    s = s + amt * 10
  }
  if (SURFACE_KEYS.has(key)) l += adj.light
  if (TEXT_KEYS.has(key)) l += (mode === 'light' ? -1 : 1) * adj.contrast
  return rgbToHex(...hslToRgb(h, clamp(s, 0, 100), clamp(l, 0, 100)))
}

/* ── 兜底基准：万一样式表还没注入导致读不到变量，用这份顶上 ── */
const FALLBACK_BASE: Record<Mode, Palette> = {
  light: {
    '--bg': '#e5e5e5', '--surface': '#ececec', '--surface-hover': '#e8e8e8',
    '--border': '#d8d8d8', '--border-strong': '#d0d0d0',
    '--text': '#0a0a0a', '--text-secondary': '#6b6b6b', '--text-muted': '#a0a0a0',
    '--accent': '#0a0a0a', '--accent-fg': '#ffffff',
    '--code-bg': '#f7f7f8', '--code-header-bg': '#efeff1', '--code-border': '#e6e6e8', '--code-text': '#24292e',
    '--table-head-bg': '#f1f1f2', '--quote-bg': '#f4f4f5',
  },
  dark: {
    '--bg': '#202227', '--surface': '#2a2d33', '--surface-hover': '#33363d',
    '--border': '#383c44', '--border-strong': '#4b505b',
    '--text': '#ced2d9', '--text-secondary': '#9298a2', '--text-muted': '#71767f',
    '--accent': '#c6cad2', '--accent-fg': '#24262b',
    '--code-bg': '#26292f', '--code-header-bg': '#2b2e35', '--code-border': '#3a3e47', '--code-text': '#ccd2da',
    '--table-head-bg': '#2e3138', '--quote-bg': '#2c2f36',
  },
}

/* ── 读取当前生效的配色作为基准 ── */
function readLiveBase(): StudioState {
  const el = document.documentElement
  const wasDark = el.classList.contains('theme-dark')
  const grab = (fallback: Palette): Palette => {
    const cs = getComputedStyle(el)
    const out: Palette = { ...fallback }
    for (const k of ALL_KEYS) {
      const v = cs.getPropertyValue(k).trim()
      if (v && /^(#|rgba?\()/i.test(v)) out[k] = normalizeHex(v)
    }
    return out
  }
  el.classList.remove('theme-dark')
  const light = grab(FALLBACK_BASE.light)
  el.classList.add('theme-dark')
  const dark = grab(FALLBACK_BASE.dark)
  if (!wasDark) el.classList.remove('theme-dark')
  return {
    light: { base: light, adj: { ...ZERO_ADJ } },
    dark: { base: dark, adj: { ...ZERO_ADJ } },
  }
}

function loadState(): StudioState {
  const live = readLiveBase()
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return live
    const saved = JSON.parse(raw) as StudioState
    if (!saved?.light?.base || !saved?.dark?.base) return live
    // 基准里缺的键（例如后来新增的变量）用当前生效值补齐
    for (const m of ['light', 'dark'] as Mode[]) {
      for (const k of ALL_KEYS) if (!saved[m].base[k]) saved[m].base[k] = live[m].base[k]
      saved[m].adj = { ...ZERO_ADJ, ...saved[m].adj }
    }
    return saved
  } catch {
    return live
  }
}

function applyState(st: StudioState): void {
  let tag = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!tag) {
    tag = document.createElement('style')
    tag.id = STYLE_ID
    document.head.appendChild(tag)
  }
  const block = (sel: string, ms: ModeState, mode: Mode): string => {
    const decls = ALL_KEYS.map((k) => `${k}:${applyAdjust(ms.base[k], k, ms.adj, mode)}`).join(';')
    return `${sel}{${decls}}`
  }
  tag.textContent = block(':root', st.light, 'light') + '\n' + block('html.theme-dark', st.dark, 'dark')
}

/* ── 滑杆 ── */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div className="cs-slider">
      <div className="cs-slider-top">
        <span>{props.label}</span>
        <span className="cs-slider-val">{props.format(props.value)}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

function ColorStudio() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<StudioState>(() => loadState())
  const [copied, setCopied] = useState(false)

  const mode: Mode = theme
  const ms = state[mode]

  useEffect(() => { applyState(state) }, [state])
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch { /* ignore */ }
  }, [state])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const patchBase = (key: string, value: string): void =>
    setState((s) => ({ ...s, [mode]: { ...s[mode], base: { ...s[mode].base, [key]: value } } } as StudioState))

  const patchAdj = (key: keyof Adjust, value: number): void =>
    setState((s) => ({ ...s, [mode]: { ...s[mode], adj: { ...s[mode].adj, [key]: value } } } as StudioState))

  const resetAdj = (): void =>
    setState((s) => ({ ...s, [mode]: { ...s[mode], adj: { ...ZERO_ADJ } } } as StudioState))

  const resetMode = (): void => {
    const live = readLiveBase()
    setState((s) => ({ ...s, [mode]: live[mode] } as StudioState))
  }

  const resetAll = (): void => setState(readLiveBase())

  const copyCss = async (): Promise<void> => {
    const text = document.getElementById(STYLE_ID)?.textContent ?? ''
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // 非安全上下文下 clipboard API 不可用，退回 execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { ok = false }
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <>
      <button
        className={open ? 'cs-trigger on' : 'cs-trigger'}
        onClick={() => setOpen((o) => !o)}
        title="配色工作台"
        aria-label="配色工作台"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
      </button>

      {open && (
        <div className="cs-panel">
          <div className="cs-head">
            <span className="cs-title">配色工作台</span>
            <button className="cs-x" onClick={() => setOpen(false)} title="关闭">×</button>
          </div>

          <div className="cs-tabs">
            <button className={mode === 'light' ? 'cs-tab on' : 'cs-tab'} onClick={() => setTheme('light')}>浅色</button>
            <button className={mode === 'dark' ? 'cs-tab on' : 'cs-tab'} onClick={() => setTheme('dark')}>黑暗</button>
          </div>

          <div className="cs-body">
            <div className="cs-sec">
              <div className="cs-sec-head">
                <span>整体调节</span>
                <button className="cs-mini" onClick={resetAdj}>归零</button>
              </div>
              <Slider
                label="色温" value={ms.adj.tint} min={-1} max={1} step={0.02}
                onChange={(v) => patchAdj('tint', v)}
                format={(v) => (Math.abs(v) < 0.02 ? '中性' : (v > 0 ? '暖 ' : '冷 ') + Math.round(Math.abs(v) * 100))}
              />
              <Slider
                label="整体明度" value={ms.adj.light} min={-14} max={14} step={0.5}
                onChange={(v) => patchAdj('light', v)}
                format={(v) => (v > 0 ? '+' : '') + v.toFixed(1)}
              />
              <Slider
                label="文字对比" value={ms.adj.contrast} min={-25} max={25} step={1}
                onChange={(v) => patchAdj('contrast', v)}
                format={(v) => (v > 0 ? '+' : '') + v.toFixed(0)}
              />
            </div>

            {GROUPS.map((g) => (
              <div className="cs-sec" key={g.title}>
                <div className="cs-sec-head"><span>{g.title}</span></div>
                {g.keys.map((k) => (
                  <div className="cs-row" key={k}>
                    <input
                      className="cs-swatch"
                      type="color"
                      value={ms.base[k]}
                      title={`${LABELS[k]}（${k}）`}
                      onChange={(e) => patchBase(k, e.target.value)}
                    />
                    <span className="cs-name">{LABELS[k]}</span>
                    <span className="cs-hex">{applyAdjust(ms.base[k], k, ms.adj, mode)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="cs-foot">
            <button onClick={resetMode}>重置本主题</button>
            <button onClick={resetAll}>全部恢复默认</button>
            <button onClick={copyCss}>{copied ? '已复制' : '复制 CSS'}</button>
          </div>

          <div className="cs-hint">
            滑杆叠加在下面的取色之上；改动实时生效并自动记住。绿色 / 琥珀 / 红等语义色与白色悬停叠加刻意不随主题色变化。
          </div>
        </div>
      )}
    </>
  )
}

/* ── 自挂载：只需在入口 import 一次，无需改动任何既有组件 ── */
const host = document.createElement('div')
host.id = 'color-studio-root'
document.body.appendChild(host)
ReactDOM.createRoot(host).render(<ColorStudio />)

export default ColorStudio
