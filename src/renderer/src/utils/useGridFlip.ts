// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：网格重排的 FLIP 过渡（列数变化时卡片滑到新位置）                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// CSS Grid 的 `repeat(auto-fill, minmax(300px, 1fr))` 在容器宽度跨过「能放几列」的
// 阈值时会整体重排，而 grid 布局本身没有可过渡的属性——表现就是卡片瞬移。
// 这里用 FLIP：在重排发生的同一帧内把卡片按「旧位置 - 新位置」反向位移，再动画回 0。
//
// 三个关键约束：
//   ① 只在**列数变化**时做。窗口连续拖动时卡片只是被拉伸（left/top 每帧都在微动），
//      逐帧启动动画会互相打断，看起来比瞬移更糟。
//   ② 在 ResizeObserver 回调里**同步**做（不 setTimeout）。RO 回调在布局之后、绘制之前，
//      此刻补上反向位移，用户根本看不到瞬移那一帧；延后再做就会变成「先瞬移再飞回去」。
//   ③ 每张卡片只保留一个动画：连续跨列时先取消上一个，避免两个动画抢同一个 transform。

import { useEffect, useRef } from 'react'

// 重排过渡时长：260ms 实测偏急（卡片像是「被弹过去」），360ms 更接近「挪过去」的手感。
// 上限别超过 450ms——再长会盖住用户拖动窗口的连续动作，显得拖沓。
const DEFAULT_DURATION_MS = 360
const EASE = 'cubic-bezier(.2, .8, .2, 1)'

export function useGridFlip(
  ref: React.RefObject<HTMLElement | null>,
  opts: {
    /** 网格当前是否真的挂载着（条件渲染时用来重新挂监听） */
    active: boolean
    /** 子项集合的版本号（如卡片数量）：变化时重新量一遍基线，避免用过期的旧位置做 FLIP */
    revision?: unknown
    durationMs?: number
  },
): void {
  const { active, revision, durationMs = DEFAULT_DURATION_MS } = opts
  // 每张卡当前在跑的动画：连续重排时先取消，避免两段 transform 互相覆盖出现回跳
  const runningRef = useRef(new WeakMap<Element, Animation>())

  useEffect(() => {
    const grid = ref.current
    if (!active || !grid) return
    // 系统开了「减少动态效果」就完全不做，交回瞬移
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let prevRects = new Map<Element, DOMRect>()
    // 列数用「卡片 left 的去重个数」量，不依赖 gridTemplateColumns 的字符串格式
    const readCols = (): number =>
      new Set(Array.from(grid.children, el => Math.round(el.getBoundingClientRect().left))).size
    let prevCols = 0
    const snapshot = (): void => {
      prevRects = new Map(Array.from(grid.children, el => [el, el.getBoundingClientRect()] as const))
      prevCols = readCols()
    }
    snapshot()

    const ro = new ResizeObserver(() => {
      const cols = readCols()
      if (cols !== prevCols) {
        for (const el of Array.from(grid.children)) {
          if (!el.isConnected) continue
          const next = el.getBoundingClientRect()
          const prev = prevRects.get(el)
          if (!prev) continue // 新出现的卡片（搜索过滤后重排）不参与，它有自己的入场动画
          const dx = prev.left - next.left
          const dy = prev.top - next.top
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
          runningRef.current.get(el)?.cancel()
          const anim = el.animate?.(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: durationMs, easing: EASE },
          )
          if (anim) runningRef.current.set(el, anim)
        }
      }
      snapshot()
    })
    ro.observe(grid)
    return () => ro.disconnect()
  }, [ref, active, revision, durationMs])
}
