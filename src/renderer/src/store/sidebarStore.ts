import { create } from 'zustand'

// 窄窗口自动收起的阈值（px，窗口宽度）。窗口缩到 1190 及以下时侧栏自动收起，把宽度让给对话区。
// 只按窗口宽度判断，不看右侧面板拖宽——拖窗口时左侧栏突然消失太突兀。
export const SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH = 1190

interface SidebarState {
  /** 有效收起态（宽度窄）。所有消费方（侧栏 / 标题栏按钮）都读它 */
  collapsed: boolean
  collapsing: boolean
  hoverExpanded: boolean
  hoverExpandEnabled: boolean
  /** 窗口是否落在「窄到需要自动收起」的区间（由 Sidebar 的 matchMedia 驱动） */
  autoNarrow: boolean
  /** 宽窗口下的用户偏好：变宽时恢复到它，所以「手动收起后拉大窗口」不会被自动展开 */
  userCollapsed: boolean
  /** 窄窗口下用户的手动指定；窗口跨过阈值即清空，交回自动 */
  narrowOverride: boolean | null
  setCollapsed: (v: boolean) => void
  setCollapsing: (v: boolean) => void
  setHoverExpanded: (v: boolean) => void
  setHoverExpandEnabled: (v: boolean) => void
  toggleCollapse: () => void
  /** 窗口跨过阈值时调用：窄 → 自动收起；宽 → 恢复 userCollapsed */
  syncAutoNarrow: (narrow: boolean) => void
}

export const useSidebarStore = create<SidebarState>((set, get) => {
  // 收起动画的 250ms 窗口（与 .sidebar-wrapper 的 width transition 对齐）：
  // 会话槽要等它走完才 display:none。连点/连续跨阈值时只保留最后一个定时器。
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const settle = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { settleTimer = null; set({ collapsing: false }) }, 250)
  }

  return {
    collapsed: false,
    collapsing: false,
    hoverExpanded: false,
    hoverExpandEnabled: (() => {
      try { return localStorage.getItem('sidebarHoverExpand') !== 'false' } catch { return true }
    })(),
    autoNarrow: false,
    userCollapsed: false,
    narrowOverride: null,
    setCollapsed: (v) => set({ collapsed: v }),
    setCollapsing: (v) => set({ collapsing: v }),
    setHoverExpanded: (v) => set({ hoverExpanded: v }),
    setHoverExpandEnabled: (v) => {
      set({ hoverExpandEnabled: v })
      try { localStorage.setItem('sidebarHoverExpand', String(v)) } catch {}
    },
    // 用户点击（标题栏折叠键）。**最后一次手动动作同时记成长期偏好**（userCollapsed），
    // 窄屏下再额外写一份 narrowOverride 用来临时压过自动收起——两条一起写的好处是：
    // 窄屏里点开/收起之后拉大窗口，不会被一条更早的偏好反着弹回去。
    toggleCollapse: () => {
      const { collapsed, autoNarrow } = get()
      if (collapsed) {
        set({
          hoverExpanded: true, collapsed: false, collapsing: false, userCollapsed: false,
          ...(autoNarrow ? { narrowOverride: false } : {}),
        })
        setTimeout(() => set({ hoverExpanded: false }), 250)
      } else {
        set({
          collapsed: true, collapsing: true, hoverExpanded: false, userCollapsed: true,
          ...(autoNarrow ? { narrowOverride: true } : {}),
        })
        settle()
      }
    },
    syncAutoNarrow: (narrow) => {
      const s = get()
      if (s.autoNarrow === narrow) return
      if (narrow) {
        // 变窄：自动收起，但不动 userCollapsed（宽屏偏好原样保留），清掉上轮的窄屏覆盖
        set({ autoNarrow: true, narrowOverride: null, collapsed: true, hoverExpanded: false, collapsing: true })
        settle()
        return
      }
      // 变宽：回到宽屏偏好。之前手动收起过的仍然是收起——不擅自替用户展开
      const next = s.userCollapsed
      set({ autoNarrow: false, narrowOverride: null, collapsed: next, hoverExpanded: false, collapsing: next })
      if (next) settle()
    },
  }
})
