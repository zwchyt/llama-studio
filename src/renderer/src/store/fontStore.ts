import { create } from 'zustand'

// ── 应用字体系统：与主题系统同构——通过在根节点挂 data-font 属性切换字体预设，
// 全部字体规则集中在 fonts.css，不修改任何旧样式文件。
// 预设仅使用 Windows 自带/常见字体栈，无需下载字体文件，离线可用。
export type FontThemeId = 'default' | 'system' | 'serif' | 'geek' | 'humanist'

export interface FontTheme {
  id: FontThemeId
  /** 设置面板中显示的名称 */
  label: string
  /** 一句话描述 */
  desc: string
  /** 预览用 UI 字体栈（与 fonts.css 中的定义保持一致，仅用于选择器卡片预览） */
  previewStack: string
}

export const FONT_THEMES: FontTheme[] = [
  { id: 'default', label: '默认', desc: 'Inter 现代无衬线（应用原生）', previewStack: "'Inter', system-ui, sans-serif" },
  { id: 'system', label: '系统原生', desc: 'Segoe UI + 微软雅黑，跟随 Windows', previewStack: "'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif" },
  { id: 'serif', label: '衬线阅读', desc: 'Georgia 衬线，适合长文阅读', previewStack: "Georgia, 'Times New Roman', 'Noto Serif SC', serif" },
  { id: 'geek', label: '极客等宽', desc: '全界面等宽字体，代码质感', previewStack: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace" },
  { id: 'humanist', label: '人文简约', desc: 'Verdana 人文无衬线，字形开阔', previewStack: "Verdana, 'Segoe UI', Tahoma, sans-serif" },
]

const STORAGE_KEY = 'llama_studio_font_theme'

function isFontThemeId(v: string | null): v is FontThemeId {
  return !!v && FONT_THEMES.some(t => t.id === v)
}

// default 预设不挂属性：旧样式的 --font 原样生效，保证默认视觉零变化
function applyFont(id: FontThemeId): void {
  const el = document.documentElement
  if (id === 'default') el.removeAttribute('data-font')
  else el.setAttribute('data-font', id)
}

const initialFont: FontThemeId = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return isFontThemeId(saved) ? saved : 'default'
  } catch { return 'default' }
})()
applyFont(initialFont)

interface FontState {
  font: FontThemeId
  setFont: (id: FontThemeId) => void
}

export const useFontStore = create<FontState>((set) => ({
  font: initialFont,
  setFont: (id) => {
    set({ font: id })
    applyFont(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch { /* ignore */ }
  },
}))
