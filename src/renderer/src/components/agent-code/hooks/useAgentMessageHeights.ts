import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// ── 消息高度测量与缓存 ──
// 用途：消息级屏外卸载（useAgentVirtualMessages）需要「每条消息占多高」才能把屏外消息换成
// 等高占位、并算出当前可见区间。高度只能实测（content-visibility 那条路已在 agent-code.css
// 记录过为什么走不通：估算高度偏离真实值，进视口会跳）。
//
// 设计要点：
//   - 只测「已挂载」的消息节点，测过即缓存；键用 msg.id（与消息一一对应，编辑重发也不会错位）。
//   - 缓存带内容指纹：消息内容变了（流式追加 / 编辑重发）→ 指纹不同 → 失效重测。
//   - 流式中那条消息高度每帧都在变，缓存它没有意义：标记为 volatile 并直接移出缓存，
//     由调用方按「保守挂载」处理（宁多挂不跳）。
//   - 测量只读 offsetHeight，不写样式，不会与 ResizeObserver 形成回写循环；只有缓存内容
//     真的变了才 version+1，避免无谓重渲染。

export type MessageHeightEntry = { height: number; fingerprint: string }

// 高度稳定多久之后才通知调用方重算（ms）。
// 展开/收起思考链时消息高度在整段过渡里每帧都在变，取 150ms 让动画期间完全不触发重渲染，
// 动画结束后再补一次。取值明显小于动画时长即可，取太大（如 500ms）会让窗口收窄滞后可感知。
const HEIGHT_COMMIT_DEBOUNCE_MS = 150

type MeasurableMessage = { id: string; content?: string; toolCalls?: readonly unknown[] }

// 内容指纹：只取 O(1) 可得的量，不做字符串拼接/哈希。
function fingerprintOf(msg: MeasurableMessage): string {
  return `${msg.content?.length ?? 0}|${msg.toolCalls?.length ?? 0}`
}

export function useAgentMessageHeights({ sessionId, viewportRef, messages, volatileId }: {
  sessionId: string | undefined
  viewportRef: RefObject<HTMLDivElement | null>
  messages: readonly MeasurableMessage[]
  /** 高度持续变化、不参与缓存的消息（通常是正在流式输出的那一条） */
  volatileId?: string | null
}) {
  const heightsRef = useRef(new Map<string, MessageHeightEntry>())
  const [version, setVersion] = useState(0)
  const commitTimerRef = useRef<number | undefined>(undefined)

  // 切换会话：整表作废（不同会话的消息 id 不同，留着只会白占内存）
  const sessionRef = useRef(sessionId)
  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId
    heightsRef.current.clear()
  }

  // messages / volatileId 用 ref 持有：它们每次 render 都可能换引用，放进回调依赖会让
  // ResizeObserver 反复重建。
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const volatileRef = useRef(volatileId)
  volatileRef.current = volatileId

  // 测量给定节点（不传则测容器内全部消息节点）。返回是否真的更新了缓存。
  // knownHeights：调用方已经拿到的实测高度（ResizeObserver 的 borderBoxSize），
  // 传了就省掉一次 offsetHeight 读取（那是强制布局）。
  const measureNodes = useCallback((nodes?: readonly HTMLElement[], knownHeights?: ReadonlyMap<HTMLElement, number>) => {
    const viewport = viewportRef.current
    if (!viewport) return false
    const cache = heightsRef.current
    const list = messagesRef.current
    const volatile = volatileRef.current
    const targets = nodes ?? Array.from(viewport.querySelectorAll<HTMLElement>('[data-slot="message"]'))
    let changed = false
    for (const node of targets) {
      const index = Number(node.dataset.messageIndex)
      if (!Number.isFinite(index)) continue
      const msg = list[index]
      if (!msg) continue
      if (volatile && msg.id === volatile) {
        if (cache.delete(msg.id)) changed = true
        continue
      }
      // 优先用 ResizeObserver 给的 borderBoxSize，避免再读一次 offsetHeight。
      // 读 offsetHeight 会触发强制布局，而展开/收起动画期间这里每帧都会被调到。
      const height = knownHeights?.get(node) ?? node.offsetHeight
      if (height <= 0) continue
      const fingerprint = fingerprintOf(msg)
      const hit = cache.get(msg.id)
      if (hit && hit.height === height && hit.fingerprint === fingerprint) continue
      cache.set(msg.id, { height, fingerprint })
      changed = true
    }
    return changed
  }, [viewportRef])

  // 高度变化的「通知」延后到稳定之后再发。
  // 关键：展开/收起思考链时，消息高度在整段 max-height 过渡里每帧都在变，ResizeObserver
  // 也就每帧都触发。若当场 setVersion，整个布局组件（AgentCodeViewLayout）会每帧重渲染，
  // 叠加过渡本身每帧的布局 → 正文区肉眼可见的卡顿/闪烁。
  // 缓存仍然每帧即时更新（O(1) 写 map），只是把「重算窗口」推迟到高度稳定后一次。
  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current !== undefined) window.clearTimeout(commitTimerRef.current)
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = undefined
      setVersion(v => v + 1)
    }, HEIGHT_COMMIT_DEBOUNCE_MS)
  }, [])

  const measure = useCallback(() => {
    if (measureNodes()) scheduleCommit()
  }, [measureNodes, scheduleCommit])

  const clear = useCallback(() => {
    if (heightsRef.current.size === 0) return
    heightsRef.current.clear()
    setVersion(v => v + 1)
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // 无 ResizeObserver（测试环境）时退化为「挂载后测一次」，不参与后续增量更新。
    if (typeof ResizeObserver === 'undefined') { measure(); return }

    // 逐个节点观察，回调里只测被报告变化的节点：全量测在长会话里是 O(挂载数) 次强制布局。
    const observed = new WeakSet<Element>()
    // 补观察新出现的消息节点，并把「本次新增的」返回给调用方——只测这些，
    // 不再顺手全量测一遍。全量测里每个节点都要读 offsetHeight（强制布局），
    // 而流式期间 / 思考链展开期间 DOM 每帧都在变，全量测就是每帧 O(挂载数) 次强制布局。
    const observeAll = (): HTMLElement[] => {
      const added: HTMLElement[] = []
      for (const node of viewport.querySelectorAll<HTMLElement>('[data-slot="message"]')) {
        if (observed.has(node)) continue
        observed.add(node)
        ro.observe(node)
        added.push(node)
      }
      return added
    }
    const ro = new ResizeObserver(entries => {
      const resized: HTMLElement[] = []
      const knownHeights = new Map<HTMLElement, number>()
      let viewportResized = false
      for (const e of entries) {
        const t = e.target as HTMLElement
        if (t === viewport) { viewportResized = true; continue }
        if (t.dataset?.slot !== 'message') continue
        resized.push(t)
        const box = e.borderBoxSize?.[0]
        if (box) knownHeights.set(t, box.blockSize)
      }
      // 容器变宽/变高（侧栏拖拽、面板开合）会让消息重排，但已挂载的每条消息自己的框也变了，
      // RO 已把新高度随 entry 带回来 → 优先用这些。只有没有任何节点上报时才退回全量测：
      // measure() 里每条都要读一次 offsetHeight（强制布局），拖拽中逐帧跑就是发虚/卡顿。
      if (resized.length > 0) {
        if (measureNodes(resized, knownHeights)) scheduleCommit()
      } else if (viewportResized) measure()
    })
    ro.observe(viewport)
    observeAll()
    measure()

    // 新增消息节点（新消息、加载更早消息、屏外卸载后重新挂载）时补观察并只测新增的那些
    const mo = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
        const added = observeAll()
        if (added.length > 0 && measureNodes(added)) scheduleCommit()
      })
      : null
    mo?.observe(viewport, { childList: true, subtree: true })

    return () => {
      ro.disconnect()
      mo?.disconnect()
      if (commitTimerRef.current !== undefined) {
        window.clearTimeout(commitTimerRef.current)
        commitTimerRef.current = undefined
      }
    }
  }, [viewportRef, sessionId, measure, measureNodes, scheduleCommit])

  return { heightsRef, version, measure, clear }
}
