import { useCallback, useEffect, useRef, useState } from 'react'

export type ResizablePanelOptions = {
  initialWidth: number
  min: number
  max: number
  cssVarName: string
  rootSelector: string
  // 拖拽方向：1 = 向右拖拽增大宽度（侧边栏）；-1 = 向左拖拽增大宽度（预览区 / 右侧面板）
  direction?: 1 | -1
  // 从持久化存储读取初始宽度（如右侧面板的 localStorage）
  getInitial?: () => number
  // 拖拽开始时计算动态最小宽度（如终端模式：滑到顶栏文件路径工具栏左缘即停）
  getMin?: () => number
  // 拖拽结束提交最终宽度（如右侧面板的 localStorage 持久化）
  onCommit?: (width: number) => void
}

// 抽出面板宽度拖拽逻辑（预览区 / 侧边栏 / 右侧面板三处原本几乎完全一致，
// 仅变量名、CSS 变量名、拖拽方向、是否持久化不同）。核心约定：
//   - 拖拽过程中只写 CSS 变量（rAF 节流），不触发 React 重渲染；
//   - 拖拽结束才把最终宽度提交到 React state，并调用 onCommit；
//   - 指针捕获 + buttons&1 兜底，避免 pointerup 丢失导致拖拽状态残留；
//   - 组件卸载时清理 window 监听器与 body 样式。
export function useResizablePanel(opts: ResizablePanelOptions) {
  const { initialWidth, min, max, cssVarName, rootSelector, direction = -1, getInitial, onCommit } = opts

  const [width, setWidth] = useState(() => {
    const base = getInitial ? getInitial() : initialWidth
    return Math.max(min, Math.min(max, base))
  })
  const [resizing, setResizing] = useState(false)

  // 最新 options 引用：startResize 时读取 getMin 计算本次拖拽的动态最小宽度
  const optsRef = useRef(opts)
  optsRef.current = opts

  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const lastClientXRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  // 当前拖拽的监听器引用，供卸载安全网移除
  const activeRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null)

  const clamp = useCallback((w: number) => Math.max(min, Math.min(max, w)), [min, max])

  const applyWidth = useCallback((w: number) => {
    const clamped = clamp(w)
    const root = document.querySelector(rootSelector) as HTMLElement | null
    if (root) root.style.setProperty(cssVarName, `${clamped}px`)
  }, [clamp, cssVarName, rootSelector])

  // 宽度状态变化 → 写入 CSS 变量
  useEffect(() => { applyWidth(width) }, [width, applyWidth])

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    // 指针捕获：即使鼠标移入 iframe/预览区也强制派发 pointerup，杜绝状态残留
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}

    // 本次拖拽的最小宽度：getMin 返回动态下限（不提供则用静态 min）
    const minW = optsRef.current.getMin?.() ?? min

    lastClientXRef.current = e.clientX
    dragRef.current = { startX: e.clientX, startW: width }

    const finish = (commit: boolean) => {
      const d = dragRef.current
      if (commit && d) {
        const finalW = Math.max(minW, Math.min(max, d.startW + direction * (lastClientXRef.current - d.startX)))
        setWidth(finalW)
        onCommit?.(finalW)
      }
      dragRef.current = null
      setResizing(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      activeRef.current = null
    }

    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      // 兜底：松开左键（pointerup 丢失防护）→ 结束拖拽并解绑
      if (!(e.buttons & 1)) { finish(false); return }
      lastClientXRef.current = e.clientX
      const dx = e.clientX - d.startX
      const next = direction === 1 ? d.startW + dx : d.startW - dx
      // 动态下限在拖拽过程中同样生效（applyWidth 内的静态 clamp 不感知 minW）
      const clamped = Math.max(minW, Math.min(max, next))
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => applyWidth(clamped))
    }

    const up = () => finish(true)

    activeRef.current = { move, up }
    setResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [width, applyWidth, clamp, direction, onCommit])

  // 卸载安全网：清理残留的 window 监听器与 body 样式
  useEffect(() => {
    return () => {
      const a = activeRef.current
      if (a) {
        window.removeEventListener('pointermove', a.move)
        window.removeEventListener('pointerup', a.up)
        window.removeEventListener('pointercancel', a.up)
      }
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [])

  return { width, resizing, startResize }
}
