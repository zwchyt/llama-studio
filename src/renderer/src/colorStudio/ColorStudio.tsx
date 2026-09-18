import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { useThemeStore } from '../store/themeStore'
import './colorStudio.css'

/* ══════════════════════════════════════════════════════════
   配色工作台（独立弹窗）
   完全自包含：不改任何既有样式文件，靠往 <head> 追加一个 <style> 覆盖
   CSS 变量来实现换色。关掉 / 恢复默认后与原来的样式系统零耦合。

   可调内容：
     · 整体调节 —— 色温 / 明度 / 文字对比 / 亮色提亮 / 暗色压暗，滑杆对一批颜色一起生效
     · 逐项取色 —— 每个变量一个取色器，直接点开调
     · 底色层联动 —— 页面底色与卡片面绑成一对，改一个另一个按同样增量跟随、差异不变
   两个主题分开调，切换面板上的标签即切换应用主题，所见即所改。
   ══════════════════════════════════════════════════════════ */

type Mode = 'light' | 'dark'

const GROUPS: { title: string; keys: string[]; linkable?: boolean }[] = [
  // 页面底色与卡片面是决定整体观感的一对：可联动，改一个另一个按同样增量跟随
  { title: '底色层', keys: ['--bg', '--surface', '--surface-hover'], linkable: true },
  { title: '描边', keys: ['--border', '--border-strong'] },
  { title: '文字', keys: ['--text', '--text-secondary', '--text-muted'] },
  { title: '强调', keys: ['--accent', '--accent-fg'] },
  { title: '代码块', keys: ['--code-bg', '--code-header-bg', '--code-border', '--code-text'] },
  { title: '其它面', keys: ['--table-head-bg', '--quote-bg'] },
]

/** 联动的一对：[页面底色, 卡片面] */
const LINK_PAIR: [string, string] = ['--bg', '--surface']

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
const LS_LINK_KEY = 'appColorStudioLink'
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

/** 把 toHex 按「from → newFrom」的 HSL 增量整体平移过去，返回这一对的最终色。
    用于底色层联动：卡片面是给页面底色做层次的，两者必须始终差着一档，
    所以传的是增量而不是直接套用同一个颜色——套用同一个值会把两层压成一个颜色。

    明度增量会被夹到「可行范围」内，这是保住层次的关键：
    如果只对跟随色单独 clamp，把页面底色拖到纯白时卡片面会一起撞到 100，
    两层就变成一模一样的 #ffffff 了。改成先算出让两个颜色都不越界的增量区间，
    再把这个增量同时加到两边，差值（l2 - l0）就恒等保留——代价是源色在边界处
    会被轻轻拉回来一点，这是刻意的：宁可拖不到纯白，也不能让两层重合。 */
function shiftLike(fromHex: string, toHex: string, newFromHex: string): { from: string; to: string } {
  const [h0, s0, l0] = rgbToHsl(...hexToRgb(fromHex))
  const [h1, s1, l1] = rgbToHsl(...hexToRgb(newFromHex))
  const [h2, s2, l2] = rgbToHsl(...hexToRgb(toHex))
  // 色相取最短路径增量，避免绕远路（0° → 210° 应该走 -150° 而不是 +210°）
  const dh = ((h1 - h0 + 540) % 360) - 180
  const dl = clamp(l1 - l0, Math.max(-l0, -l2), Math.min(100 - l0, 100 - l2))
  const ds = s1 - s0
  return {
    // 源色用用户挑的色相/饱和度，明度取夹过增量的结果（可能被拉回一点）
    from: rgbToHex(...hslToRgb(h1, clamp(s1, 0, 100), clamp(l0 + dl, 0, 100))),
    to: rgbToHex(...hslToRgb((h2 + dh + 360) % 360, clamp(s2 + ds, 0, 100), clamp(l2 + dl, 0, 100)))
  }
}

/* ── 数据结构 ── */
interface Adjust {
  tint: number
  light: number
  contrast: number
  /** 亮色提亮：基准明度高于阈值的颜色统一提亮（两个主题下都按各自基准判定） */
  brightUp: number
  /** 暗色压暗：基准明度不高于阈值的颜色统一压暗 */
  darkDown: number
}
const ZERO_ADJ: Adjust = { tint: 0, light: 0, contrast: 0, brightUp: 0, darkDown: 0 }

/** 亮 / 暗的分界（HSL 明度百分比）。
    按「明度」而不是按变量名分组：同一个变量在两个主题里的明暗位置是相反的——
    --text 在浅色主题里是最暗的，在暗色主题里是最亮的，按语义分组一定会做反。
    固定阈值一刀切，两个主题下的行为都符合直觉：提亮总是让亮的更亮、压暗总是让暗的更暗。 */
const LIGHT_SIDE_THRESHOLD = 50

type Palette = Record<string, string>
interface ModeState { base: Palette; adj: Adjust }
interface StudioState { light: ModeState; dark: ModeState }

function applyAdjust(hex: string, key: string, adj: Adjust, mode: Mode): string {
  const [h0, s0, l0] = rgbToHsl(...hexToRgb(hex))
  let h = h0
  let s = s0
  let l = l0
  if (Math.abs(adj.tint) > 0.02) {
    const amt = Math.abs(adj.tint)
    h = blendHue(h, adj.tint > 0 ? 32 : 214, amt)
    s = s + amt * 10
  }
  if (SURFACE_KEYS.has(key)) l += adj.light
  if (TEXT_KEYS.has(key)) l += (mode === 'light' ? -1 : 1) * adj.contrast
  // 亮色提亮 / 暗色压暗：按「基准明度」判定归属，而不是叠加后的 l。
  // 否则整体明度把某个颜色推过阈值时它会中途换边，滑杆拖到一半画面会跳一下。
  //
  // 用「按剩余空间的比例推进」而不是直接加固定明度值：浅色主题的背景类颜色本来就在
  // L 82~97，直接 +10 会让 --bg / --surface / --surface-hover / --code-bg 一起撞到
  // 纯白，底色层与卡片面的层次当场消失（实测过）。按 (100-l) 的比例推进则永远不会
  // 越界，且各档之间的相对间距只会等比收缩、不会塌成同一个值。
  if (l0 > LIGHT_SIDE_THRESHOLD) l += (100 - l) * (adj.brightUp / 100)
  else l -= l * (adj.darkDown / 100)
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
  // 底色层联动开关。默认开：页面底色与卡片面本来就该一起动，
  // 单独存在 localStorage 而不是塞进 StudioState —— 它是操作偏好不是颜色，
  // 混进去会被「全部恢复默认」一起清掉。
  const [linked, setLinked] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_LINK_KEY) !== '0' } catch { return true }
  })

  useEffect(() => {
    try { localStorage.setItem(LS_LINK_KEY, linked ? '1' : '0') } catch { /* ignore */ }
  }, [linked])

  const mode: Mode = theme
  const ms = state[mode]

  // 亮 / 暗两侧各含多少个变量：让「提亮 / 压暗」这两根滑杆的作用范围看得见。
  // 不给出来用户只能靠拖完观察画面变化去猜，等于又回到「一个一个试」。
  const sideSplit = ALL_KEYS.reduce(
    (acc, k) => {
      if (rgbToHsl(...hexToRgb(ms.base[k]))[2] > LIGHT_SIDE_THRESHOLD) acc.bright++
      else acc.dark++
      return acc
    },
    { bright: 0, dark: 0 }
  )

  // 卡片面与页面底色的明度差 = 层次感。联动时这个值恒定不变，直接显示出来，
  // 用户才能一眼确认两层没被压成同一个颜色。
  const surfaceGap = ((): number => {
    const l = (k: string): number => rgbToHsl(...hexToRgb(ms.base[k]))[2]
    return l('--surface') - l('--bg')
  })()

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

  // 联动开启时，改「页面底色」或「卡片面」任意一个，另一个按同样的 HSL 增量跟随，
  // 两者的明度差恒等保留——这是「一起变、但始终差着一档」的实现。
  // 源色也要用返回值覆盖：边界处它会被拉回来一点，不覆盖的话界面显示的和实际生效的会不一致。
  const patchBase = (key: string, value: string): void =>
    setState((s) => {
      const cur = s[mode].base
      const base: Palette = { ...cur }
      if (linked && LINK_PAIR.includes(key)) {
        const other = key === LINK_PAIR[0] ? LINK_PAIR[1] : LINK_PAIR[0]
        const r = shiftLike(cur[key], cur[other], value)
        base[key] = r.from
        base[other] = r.to
      } else {
        base[key] = value
      }
      return { ...s, [mode]: { ...s[mode], base } } as StudioState
    })

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
              {/* 亮暗两侧各一根：不用逐个取色器去调，一拖就把整套配色的明暗分布拉开。
                  数值是「往白/往黑推进的百分比」，不是绝对明度增量——见 applyAdjust 里的说明。 */}
              <Slider
                label="亮色提亮" value={ms.adj.brightUp} min={0} max={100} step={2}
                onChange={(v) => patchAdj('brightUp', v)}
                format={(v) => (v === 0 ? '不变' : `推向白 +${v}%`)}
              />
              <Slider
                label="暗色压暗" value={ms.adj.darkDown} min={0} max={100} step={2}
                onChange={(v) => patchAdj('darkDown', v)}
                format={(v) => (v === 0 ? '不变' : `推向黑 -${v}%`)}
              />
              <div className="cs-split">
                按基准明度划分：亮色 {sideSplit.bright} 个 · 暗色 {sideSplit.dark} 个（分界 {LIGHT_SIDE_THRESHOLD}%）
              </div>
            </div>

            {GROUPS.map((g) => (
              <div className="cs-sec" key={g.title}>
                <div className="cs-sec-head">
                  <span>{g.title}</span>
                  {g.linkable && (
                    <button
                      className={linked ? 'cs-mini on' : 'cs-mini'}
                      onClick={() => setLinked((v) => !v)}
                      title="联动：改「页面底色」或「卡片面」任意一个，另一个按同样的色相 / 明度增量跟随，两者的差异保持不变"
                    >
                      联动{linked ? '开' : '关'}
                    </button>
                  )}
                </div>
                {g.keys.map((k) => (
                  <div className="cs-row" key={k}>
                    <input
                      className="cs-swatch"
                      type="color"
                      value={ms.base[k]}
                      title={`${LABELS[k]}（${k}）`}
                      onChange={(e) => patchBase(k, e.target.value)}
                    />
                    <span className="cs-name">
                      {LABELS[k]}
                      {linked && LINK_PAIR.includes(k) && (
                        <span className="cs-link-mark" title="与另一个联动：改任意一个，另一个按同样增量跟随">⇄</span>
                      )}
                    </span>
                    <span className="cs-hex">{applyAdjust(ms.base[k], k, ms.adj, mode)}</span>
                  </div>
                ))}
                {g.linkable && (
                  <div className="cs-split">
                    卡片面与页面底色的明度差 {surfaceGap.toFixed(1)}
                    {linked ? '（联动时恒定，两层不会重合）' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="cs-foot">
            <button onClick={resetMode}>重置本主题</button>
            <button onClick={resetAll}>全部恢复默认</button>
            <button onClick={copyCss}>{copied ? '已复制' : '复制 CSS'}</button>
          </div>

          <div className="cs-hint">
            滑杆叠加在下面的取色之上；改动实时生效并自动记住。底色层的「联动」开启时，页面底色与卡片面按同样的色相 / 明度增量一起变，两者的明度差恒定保留；拖到纯黑 / 纯白边界时源色会被拉回一点，以保证两层不会重合（卡片面始终为页面底色留出层次）。「亮色提亮 / 暗色压暗」按每个颜色自己的基准明度分边，所以浅色与暗色主题下都是「亮的更亮、暗的更暗」。绿色 / 琥珀 / 红等语义色与白色悬停叠加刻意不随主题色变化。
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
