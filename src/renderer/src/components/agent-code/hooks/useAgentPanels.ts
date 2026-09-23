// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentPanels —— 三块可拖拽面板的宽度状态与起手回调                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的三处 useResizablePanel 调用（逻辑与注释未变）：
//   · 预览面板宽度（--agent-preview-width，向左拖增大）
//   · 会话侧边栏宽度（--agent-sidebar-width，向右拖增大）
//   · 右侧面板宽度（--agent-right-width，向左拖增大，按模式动态下限 + localStorage 持久化）
//
// 同时持有三块拖拽手柄的图标句柄 ref（sidebarHandleIconRef / previewHandleIconRef /
// previewPanelHandleIconRef）——它们与各自面板一一对应，属于同一职责域。
//
// rightPanelMode 由调用方注入：useResizablePanel 内部以 optsRef.current = opts
// 每次渲染刷新选项，因此 getMin 闭包读到的始终是当次渲染的 rightPanelMode。
// 由于该参数需在调用点已求值，本 hook 应在 useAgentUiState 之后调用。

import { useRef } from 'react'
import { useResizablePanel } from '../../../utils/useResizablePanel'
import type { AniIconHandle } from '../types'
import type { useAgentUiState } from './useAgentUiState'

export function useAgentPanels({ rightPanelMode }: {
  rightPanelMode: ReturnType<typeof useAgentUiState>['rightPanelMode']
}) {
  // ── 区域：可拖拽面板宽度管理（预览区 / 侧边栏 / 右侧面板共用 useResizablePanel）──
  // 预览面板宽度：拖拽预览左边框时调整，文件树宽度固定不动
  const PREVIEW_MIN = 240, PREVIEW_MAX = 760
  const previewResize = useResizablePanel({
    initialWidth: PREVIEW_MIN,
    min: PREVIEW_MIN,
    max: PREVIEW_MAX,
    cssVarName: '--agent-preview-width',
    rootSelector: '.agent-code-right-body',
    direction: -1,
  })

  // 会话侧边栏宽度：拖拽侧边栏右边框时调整（向右拖拽增大）
  const SIDEBAR_MIN = 160, SIDEBAR_MAX = 420
  const sidebarResize = useResizablePanel({
    initialWidth: 200,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    cssVarName: '--agent-sidebar-width',
    rootSelector: '.agent-code-body',
    direction: 1,
  })

  // 浏览器 / 终端模式：右侧面板宽度可拖拽调整（聊天区 ↔ 右侧面板，手柄在右侧面板左边缘）
  const RIGHT_MIN = 260, RIGHT_MAX = 900
  const rightResize = useResizablePanel({
    initialWidth: 480,
    min: RIGHT_MIN,
    max: RIGHT_MAX,
    cssVarName: '--agent-right-width',
    rootSelector: '.agent-code-body',
    direction: -1,
    // 终端模式：顶栏「工作目录/文件路径」工具栏绝对定位在右上角、宽度不随面板收缩，
    // 面板过窄时会被截断。拖拽开始时实测该工具栏宽度作为本次拖拽的下限——
    // 手柄滑到文件路径左缘即停，不再缩小。浏览器模式无此工具栏，退回静态 min。
    // 变更模式：顶栏「N 个文件 +32 −43」统计在 header overflow:hidden 下会先被裁掉，
    // 同样实测 header 内容自然宽度（含被省略号压缩的部分）作为下限。
    getMin: () => {
      if (rightPanelMode === 'terminal') {
        // 终端标题栏布局：标签区（可缩可滚，flex:0 1 auto）+ cwd 输入框（弹性，
        // 随手柄伸缩）+ 右侧按钮组（绝对定位，不在流内，只由 tabbar 的
        // padding-right 预留）。手柄下限 = 输入框 CSS min-width + 其左外边距 +
        // tabbar 的 padding-right（预留区已覆盖按钮组宽度）。不取输入框实时宽度：
        // 它会被 flex 拉伸到≈当前面板宽度，取实时值会让下限跟着当前宽度走、
        // 拖拽一开始就被钳死（同下方 diff 分支教训）。
        const wrap = document.querySelector('.agent-terminal-tabbar > .agent-terminal-auto-input') as HTMLElement | null
        const tabbar = document.querySelector('.agent-terminal-tabbar') as HTMLElement | null
        if (!wrap || !tabbar) return RIGHT_MIN
        const wcs = getComputedStyle(wrap)
        const bcs = getComputedStyle(tabbar)
        const w = Math.ceil(
          (parseFloat(wcs.minWidth) || 0) +
          (parseFloat(wcs.marginLeft) || 0) +
          (parseFloat(bcs.paddingRight) || 0),
        )
        return w > 0 ? w + 6 : RIGHT_MIN
      }
      if (rightPanelMode === 'diff') {
        const header = document.querySelector('.agent-git-header') as HTMLElement | null
        if (!header) return RIGHT_MIN
        const cs = getComputedStyle(header)
        const gap = parseFloat(cs.columnGap || cs.gap) || 0
        let natural = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        const kids = [...header.children] as HTMLElement[]
        kids.forEach((k, i) => {
          // flex-grow 的占位元素（如把刷新按钮推到右端的 .agent-git-spacer）没有自己的内容，
          // 自然宽度为 0；若按拉伸后的 rect/scrollWidth 计入，最小宽度会≈当前面板宽度，
          // 拖拽一开始就被钳死（表现为手柄滑不动）——这里必须按 0 宽度处理。
          const grow = parseFloat(getComputedStyle(k).flexGrow) || 0
          const w = grow > 0 ? 0 : Math.max(k.getBoundingClientRect().width, k.scrollWidth)
          natural += w
          if (i < kids.length - 1) natural += gap
        })
        const w = Math.ceil(natural)
        return w > 0 ? w + 4 : RIGHT_MIN
      }
      if (rightPanelMode === 'browser') {
        // 浏览器模式：中间行（导航按钮 + URL 栏）宽度不足时会溢出 padding 区，
        // 压到右侧绝对定位的图标组。URL 输入框可缩为 0（正常），但左侧导航按钮
        // flex-shrink:0 缩不掉——实测中间行最小宽度，让手柄停在压到第一个图标之前。
        const toolbar = document.querySelector('.agent-browser-toolbar') as HTMLElement | null
        if (!toolbar) return RIGHT_MIN
        const tcs = getComputedStyle(toolbar)
        const tGap = parseFloat(tcs.columnGap || tcs.gap) || 0
        const kids = [...toolbar.children].filter(el => !el.classList.contains('agent-browser-toolbar-right')) as HTMLElement[]
        let mid = 0
        kids.forEach((k, i) => {
          if (i > 0) mid += tGap
          if (k.classList.contains('agent-browser-urlbar')) {
            // URL 栏最小宽度 = 自身内边距/边框 + 除输入框外的子元素（输入框 min-width:0 可缩没）
            const ucs = getComputedStyle(k)
            const uGap = parseFloat(ucs.columnGap || ucs.gap) || 0
            let u = parseFloat(ucs.paddingLeft) + parseFloat(ucs.paddingRight) + parseFloat(ucs.borderLeftWidth) + parseFloat(ucs.borderRightWidth)
            const nonInput = [...k.children].filter(c => !(c as HTMLElement).classList.contains('agent-browser-urlbar-input'))
            nonInput.forEach((c, j) => {
              if (j > 0) u += uGap
              u += c.getBoundingClientRect().width
            })
            mid += u
          } else {
            mid += k.getBoundingClientRect().width
          }
        })
        const w = Math.ceil(parseFloat(tcs.paddingLeft) + mid + parseFloat(tcs.paddingRight))
        return w > 0 ? w + 4 : RIGHT_MIN
      }
      return RIGHT_MIN
    },
    getInitial: () => {
      try {
        const v = Number(window.localStorage.getItem('agent-right-width') || '')
        return v && Number.isFinite(v) ? v : 480
      } catch { return 480 }
    },
    onCommit: (w) => { try { window.localStorage.setItem('agent-right-width', String(w)) } catch { } },
  })

  const sidebarHandleIconRef = useRef<AniIconHandle>(null)
  const previewHandleIconRef = useRef<AniIconHandle>(null)
  const previewPanelHandleIconRef = useRef<AniIconHandle>(null)

  return {
    sidebarResize, previewResize, rightResize,
    sidebarHandleIconRef, previewHandleIconRef, previewPanelHandleIconRef,
  }
}
