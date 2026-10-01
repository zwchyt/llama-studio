import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 拖拽面板宽度期间要「钉住」的元素。
 *
 * 目前只有 Mermaid 的 SVG 容器：它的内容是**内联 SVG**，宽度一变就要按新尺寸重新栅格化，
 * 大图（节点多）拖起来会一顿一顿。钉住宽度 → 拖拽中它一次都不重排，松手后一次性对齐。
 *
 * 为什么**不**钉图形卡片的画布（.fig-canvas）：
 *   · Recharts —— 容器跟着缩才是我们想要的，见 chart.css 的 is-panel-resizing 规则：
 *     拖拽期间强制 SVG 按容器等比缩放（纯合成层操作，不触发 recharts 的 JS），
 *     所以它「跟着缩」且几乎零成本；钉住反而会让它不跟随。
 *   · SVG 卡片 —— <img> 跟着容器缩是浏览器自己的栅格缩放，很便宜，钉住同样只会让它不跟随。
 * 钉住是一种「用不跟随换零重排」的手段，只留给真正吃不消的那一类。
 *
 * 做法：拖拽开始时给元素挂一个 `--pin-w`（= 当前宽度），松手时撤掉。
 * 为什么走 CSS 变量而不是直接写 el.style.width：Mermaid 容器的 width:100% 是 React
 * 写在 style 上的，startResize 里紧接着的 setResizing(true) 会触发重渲染、把它重新写回去，
 * 内联 width 当场被覆盖。CSS 变量不在 React 的 style 对象里，它的 diff 不会碰；
 * 规则那头再用 !important 压过 React 写的内联 width，两边都稳。
 */
const FIGURE_SELECTORS = ['.mmd-viewport']

/**
 * 松手后延迟这么久才撤掉钉住 / 缩放规则。
 *
 * 松手瞬间容器已经是最终宽度，但 Recharts 那边是防抖重排（ChartView 的 120ms）——
 * 立刻撤规则会先露出一帧「旧尺寸的图」压在已经变窄的容器上（溢出），等它重排才收回来。
 * 等过防抖窗口再撤，两边就衔接上了：期间规则还在、图形仍按容器等比缩放（看起来是对的），
 * 撤掉时 recharts 已经用最终尺寸重排完，svg 属性与容器一致，不跳变。
 */
const RELEASE_DELAY_MS = 200

function pinFigures(): () => void {
  const pinned: HTMLElement[] = []
  for (const sel of FIGURE_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const w = el.getBoundingClientRect().width
      if (w > 0) {
        el.style.setProperty('--pin-w', `${w}px`)
        pinned.push(el)
      }
    })
  }
  document.documentElement.classList.add('is-panel-resizing')
  return () => {
    for (const el of pinned) el.style.removeProperty('--pin-w')
    document.documentElement.classList.remove('is-panel-resizing')
  }
}

/** 展开/收起动画的标记计时器（模块级：同时只可能有一场动画） */
let animTimer: number | null = null

/**
 * 标记「面板正在做展开/收起动画」，时长 ms 后自动摘掉。
 *
 * 面板展开/收起是 CSS 过渡（宽度逐帧变化），和手动拖拽是同一类问题：
 * 动画期间聊天区宽度每帧在变，里面的图表跟着每帧重排。
 * 所以这里复用**同一个** `<html>` 标记 —— CSS 那边（chart.css 的等比缩放、
 * ChartView 的 recharts 挂起、表格的 table-layout:fixed）一行都不用改，
 * 两条路径自动共享同一套处理。
 *
 * 时长给固定值而不是去读 --agent-right-collapse-dur：那个变量是 JS 按位移等比算的
 * （最长约 0.57s），读它要额外做 DOM 查询与解析，而多挂 100ms 的代价只是
 * 「图形多缩着一会儿」，可以忽略。取 700ms 覆盖最长的一场。
 */
export function markPanelAnimating(ms = 700): void {
  const root = document.documentElement
  root.classList.add('is-panel-resizing')
  if (animTimer !== null) window.clearTimeout(animTimer)
  animTimer = window.setTimeout(() => {
    animTimer = null
    root.classList.remove('is-panel-resizing')
  }, ms)
}

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
  // 图形钉住的解绑函数，卸载时也要撤（否则组件没了、图形还停在固定宽度上）
  const unpinRef = useRef<(() => void) | null>(null)
  // 松手后的延迟撤除定时器（见 RELEASE_DELAY_MS）；下一次拖拽开始时要清掉它
  const releaseTimerRef = useRef<number | null>(null)

  // 宽度吸附到设备像素栅格：拖拽中 dx 取自 clientX，是个小数值，落在半根设备像素上的
  // 面板边缘会让整块内容每帧重新排字 —— 看上去就是发虚（Windows 125%/150% 缩放最明显）。
  const snap = (w: number) => { const d = window.devicePixelRatio || 1; return Math.round(w * d) / d }

  const clamp = useCallback((w: number) => snap(Math.max(min, Math.min(max, w))), [min, max])

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

    // 钉住图形：拖拽全程不让它们跟着宽度重排（见 pinFigures 的说明）
    if (releaseTimerRef.current !== null) {
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    const unpin = pinFigures()
    unpinRef.current = unpin
    let unpinned = false
    const releasePins = () => {
      if (unpinned) return
      unpinned = true
      unpinRef.current = null
      unpin()
    }
    /** 松手用：延迟到 recharts 重排之后再撤（见 RELEASE_DELAY_MS） */
    const releasePinsLater = () => {
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null
        releasePins()
      }, RELEASE_DELAY_MS)
    }

    const finish = (commit: boolean) => {
      const d = dragRef.current
      if (commit && d) {
        const finalW = snap(Math.max(minW, Math.min(max, d.startW + direction * (lastClientXRef.current - d.startX))))
        setWidth(finalW)
        onCommit?.(finalW)
      }
      dragRef.current = null
      // 正常松手：延迟撤（等 recharts 重排完）；异常结束（指针丢了）立刻撤
      if (commit) releasePinsLater()
      else releasePins()
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
      const clamped = snap(Math.max(minW, Math.min(max, next)))
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
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = null
      }
      unpinRef.current?.()
      unpinRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [])

  return { width, resizing, startResize }
}
