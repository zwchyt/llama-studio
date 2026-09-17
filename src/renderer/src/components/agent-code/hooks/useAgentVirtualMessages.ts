import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

// ── 消息级屏外卸载（measured spacer）──
// 只挂载「视口附近 + 必须常驻」的连续消息区间，区间外用等高占位 div 顶住高度，
// 这样滚动条长度与真实内容一致、位置不跳。被顶掉的消息仍在数据层，随时可以重新挂载。
//
// 为什么用「实测高度 + 占位」而不是 content-visibility：
//   agent-code.css 里已记录过，contain-intrinsic-size 的估算高度离真实值太远，
//   消息进视口时真实高度替换估算值 → 滚动位置突跳。所以高度只能实测。
//
// 安全边界（宁可多挂，不可跳）：
//   - 未测到高度的消息一律不允许被顶掉：占位高度算不准就会跳。
//     因此只有「前缀全部已测」和「后缀全部已测」的那两段才允许折叠。
//   - 消息数少于阈值时整体不启用（短会话没必要承担这份复杂度）。
//   - 首帧 end = count（等价于现状：全部挂载），测完一轮后才开始收窄——
//     这样第一次同步就有一份完整的高度表，不会出现「没测过 → 不敢卸 → 永远卸不掉」。

const OVERSCAN_PX = 900
const MIN_MESSAGES_TO_VIRTUALIZE = 60

export type VirtualWindow = { start: number; end: number }

export function useAgentVirtualMessages({ viewportRef, messages, startIndex, heightsRef, heightsVersion, pinnedIndices, enabled = true }: {
  viewportRef: RefObject<HTMLDivElement | null>
  /** 当前已加载并参与渲染的消息区间（通常是 activeSession.messages.slice(historyStartIndex)） */
  messages: readonly { id: string }[]
  /** 该区间第一条消息在会话内的原始下标（= historyStartIndex），用于和 data-message-index 对齐 */
  startIndex: number
  /** useAgentMessageHeights 的高度缓存 */
  heightsRef: RefObject<Map<string, { height: number; fingerprint: string }>>
  /** useAgentMessageHeights 的 version：缓存变化时重算占位高度 */
  heightsVersion: number
  /** 必须常驻挂载的原始下标（流式中那条、编辑中那条） */
  pinnedIndices?: readonly number[]
  enabled?: boolean
}) {
  const count = messages.length
  // 首帧挂载全部（等价于现状），测完一轮后由 sync 收窄
  const [win, setWin] = useState<VirtualWindow>({ start: 0, end: Number.MAX_SAFE_INTEGER })
  const [spacers, setSpacers] = useState({ top: 0, bottom: 0 })

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const startIndexRef = useRef(startIndex)
  startIndexRef.current = startIndex
  const pinnedRef = useRef(pinnedIndices ?? [])
  pinnedRef.current = pinnedIndices ?? []
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  // 主动要求挂载的原始下标（跳转 / 搜索命中）。会被扩进窗口，进入自然窗口后自动移除。
  const forcedRef = useRef(new Set<number>())

  // 前缀和 + 逐条高度：占位高度必须是「已测消息高度之和」，故未测的记 -1 以便识别。
  const metrics = useMemo(() => {
    const heights = new Array<number>(count)
    const prefix = new Array<number>(count + 1)
    prefix[0] = 0
    const cache = heightsRef.current
    for (let i = 0; i < count; i += 1) {
      const h = cache?.get(messages[i]!.id)?.height
      heights[i] = h ?? -1
      prefix[i + 1] = prefix[i]! + (h ?? 0)
    }
    return { heights, prefix }
  }, [messages, count, heightsVersion, heightsRef])
  const metricsRef = useRef(metrics)
  metricsRef.current = metrics

  const frameRef = useRef<number | undefined>(undefined)
  const sync = useCallback(() => {
    const viewport = viewportRef.current
    const list = messagesRef.current
    const n = list.length
    const { heights, prefix } = metricsRef.current
    if (!viewport || prefix.length !== n + 1) return

    const reset = () => {
      setWin(w => (w.start === 0 && w.end === n ? w : { start: 0, end: n }))
      setSpacers(s => (s.top === 0 && s.bottom === 0 ? s : { top: 0, bottom: 0 }))
    }
    if (!enabledRef.current || n <= MIN_MESSAGES_TO_VIRTUALIZE) { reset(); return }

    // 只有「前缀全测过」「后缀全测过」的两段才允许被占位顶掉，否则高度算不准。
    let prefixEnd = 0
    while (prefixEnd < n && heights[prefixEnd]! >= 0) prefixEnd += 1
    let suffixStart = n
    while (suffixStart > 0 && heights[suffixStart - 1]! >= 0) suffixStart -= 1

    // 锚点：拿第一个已挂载消息节点的实际位置，把「数据层前缀和」换算成「容器内容坐标」。
    // 这样不必关心列表前面还有没有 banner / 摘要 / 「加载更早消息」按钮。
    const nodes = viewport.querySelectorAll<HTMLElement>('[data-slot="message"]')
    const first = nodes[0]
    if (!first) return
    const localAnchor = Number(first.dataset.messageIndex) - startIndexRef.current
    if (!Number.isFinite(localAnchor) || localAnchor < 0 || localAnchor >= n) return
    const vRect = viewport.getBoundingClientRect()
    const anchorOffset = viewport.scrollTop + (first.getBoundingClientRect().top - vRect.top)
    const base = prefix[localAnchor]!
    const offsetOf = (i: number) => anchorOffset + (prefix[i]! - base)

    const top = viewport.scrollTop - OVERSCAN_PX
    const bottom = viewport.scrollTop + viewport.clientHeight + OVERSCAN_PX
    // 二分：第一个「底边越过上沿」的消息
    let lo = 0
    let hi = prefixEnd
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (offsetOf(mid) + Math.max(0, heights[mid]!) <= top) lo = mid + 1
      else hi = mid
    }
    let start = Math.min(lo, prefixEnd)
    // 二分：第一个「顶边越过下沿」的消息
    lo = suffixStart
    hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (offsetOf(mid) <= bottom) lo = mid + 1
      else hi = mid
    }
    let end = Math.max(lo, suffixStart)

    // 常驻 + 主动要求挂载的下标：扩进窗口；已落在自然窗口内的从 forced 里摘掉，避免无限累积。
    const pin = (local: number) => {
      if (local < 0 || local >= n) return
      if (local >= start && local < end) return
      if (local < start) start = local
      else end = local + 1
    }
    const local = (original: number) => original - startIndexRef.current
    for (const p of pinnedRef.current) pin(local(p))
    for (const original of forcedRef.current) {
      const l = local(original)
      if (l >= start && l < end) forcedRef.current.delete(original)
      else pin(l)
    }

    const nextTop = prefix[start]!
    const nextBottom = prefix[n]! - prefix[end]!
    setWin(w => (w.start === start && w.end === end ? w : { start, end }))
    setSpacers(s => (s.top === nextTop && s.bottom === nextBottom ? s : { top: nextTop, bottom: nextBottom }))
  }, [viewportRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      sync()
    })
  }, [sync])

  // 高度表 / 消息列表变化后立刻重算（用 layout effect：占位高度要在 paint 前就位，否则会闪一帧空档）。
  // 依赖刻意不写 metrics / messages 对象：流式期间它们每帧都换引用，会让 sync 每帧做一次
  // querySelectorAll + getBoundingClientRect（强制布局）。metrics 通过 ref 读取，等价且不抖动。
  const pinnedKey = (pinnedIndices ?? []).join(',')
  useLayoutEffect(() => { sync() }, [sync, heightsVersion, count, startIndex, enabled, pinnedKey])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', schedule, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(viewport)
    return () => {
      viewport.removeEventListener('scroll', schedule)
      ro?.disconnect()
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = undefined
      }
    }
  }, [viewportRef, schedule])

  // 请求把某条消息（原始下标）纳入挂载范围，供跳转 / 搜索命中使用。
  // 注意：会临时把窗口扩成「覆盖该下标的连续区间」，跳到远处时这一帧挂载量偏大，
  // 滚动到位后窗口会自动收窄——这是为「不跳位」付出的代价。
  const ensureMounted = useCallback((originalIndex: number) => {
    forcedRef.current.add(originalIndex)
    sync()
  }, [sync])

  // 原始下标 → 容器内容坐标；高度未测到时返回 null（调用方应先 ensureMounted）。
  const getOffsetForIndex = useCallback((originalIndex: number): number | null => {
    const viewport = viewportRef.current
    const n = messagesRef.current.length
    const { prefix } = metricsRef.current
    const l = originalIndex - startIndexRef.current
    if (!viewport || l < 0 || l >= n || prefix.length !== n + 1) return null
    const first = viewport.querySelector<HTMLElement>('[data-slot="message"]')
    if (!first) return null
    const anchor = Number(first.dataset.messageIndex) - startIndexRef.current
    if (!Number.isFinite(anchor) || anchor < 0 || anchor >= n) return null
    const vRect = viewport.getBoundingClientRect()
    const anchorOffset = viewport.scrollTop + (first.getBoundingClientRect().top - vRect.top)
    return anchorOffset + (prefix[l]! - prefix[anchor]!)
  }, [viewportRef])

  return {
    windowStart: win.start,
    windowEnd: Math.min(win.end, count),
    spacerTop: spacers.top,
    spacerBottom: spacers.bottom,
    ensureMounted,
    getOffsetForIndex,
    sync,
  }
}
