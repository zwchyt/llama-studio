import { create } from 'zustand'

interface SidebarState {
  collapsed: boolean
  collapsing: boolean
  hoverExpanded: boolean
  hoverExpandEnabled: boolean
  setCollapsed: (v: boolean) => void
  setCollapsing: (v: boolean) => void
  setHoverExpanded: (v: boolean) => void
  setHoverExpandEnabled: (v: boolean) => void
  toggleCollapse: () => void
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: false,
  collapsing: false,
  hoverExpanded: false,
  hoverExpandEnabled: (() => {
    try { return localStorage.getItem('sidebarHoverExpand') !== 'false' } catch { return true }
  })(),
  setCollapsed: (v) => set({ collapsed: v }),
  setCollapsing: (v) => set({ collapsing: v }),
  setHoverExpanded: (v) => set({ hoverExpanded: v }),
  setHoverExpandEnabled: (v) => {
    set({ hoverExpandEnabled: v })
    try { localStorage.setItem('sidebarHoverExpand', String(v)) } catch {}
  },
  toggleCollapse: () => {
    const { collapsed } = get()
    if (collapsed) {
      set({ hoverExpanded: true, collapsed: false, collapsing: false })
      setTimeout(() => set({ hoverExpanded: false }), 250)
    } else {
      set({ collapsed: true, collapsing: true, hoverExpanded: false })
      setTimeout(() => set({ collapsing: false }), 250)
    }
  },
}))
