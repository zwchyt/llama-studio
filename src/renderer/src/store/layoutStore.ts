import { create } from 'zustand'

// ── 界面布局模式：侧边栏布局（旧）/ 顶部导航布局（新），两套并存可自由切换 ──
export type LayoutMode = 'sidebar' | 'topnav'

interface LayoutState {
  mode: LayoutMode
  setMode: (m: LayoutMode) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  mode: (() => {
    try { return localStorage.getItem('layoutMode') === 'topnav' ? 'topnav' : 'sidebar' } catch { return 'sidebar' }
  })(),
  setMode: (m) => {
    set({ mode: m })
    try { localStorage.setItem('layoutMode', m) } catch { /* ignore */ }
    window.api?.setUiSetting('layoutMode', m)
  },
}))
