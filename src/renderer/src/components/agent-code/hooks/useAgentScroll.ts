// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentScroll —— 聊天区滚动跟随 + 目录 rail 同步                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的滚动 / rail 两块逻辑，逻辑与注释均未改动。
//
// 自持：15 个 ref + 5 个 state（滚动跟随标志、程序化滚动标记、rail 元素表与预览缓存）。
// 外部输入（由调用方传入）：activeSession（rail 条目取自消息）、loading / streaming
// （贴底策略与「跟随中」判定）、openTabs / activeTabPath（rail 点击跳预览）。
// 对外输出：滚动容器 ref、滚动事件处理器、scrollToBottom / animateScrollTo、
//           rail 条目与状态、rail 点击跳转。

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getMessagePreview } from '../utils/text'
import { useAgentHistoryWindow } from './useAgentHistoryWindow'
import type { AgentSession } from '../../../../../shared/types'

export function useAgentScroll({ activeSession, streaming, setSelectionPopover, taskCardRef, taskModalOpen }: {
  activeSession: AgentSession | null
  streaming: boolean
  setSelectionPopover: (v: { text: string; x: number; y: number } | null) => void
  taskCardRef: React.RefObject<HTMLDivElement | null>
  taskModalOpen: boolean
}) {
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const followingRef = useRef(true)
  // 标记“由代码主动贴底触发的 scroll”，用于在 onChatScroll 中排除，避免与用户上滚抢控制权。
  const programmaticScrollRef = useRef(false)
  // smooth 滚动的抑制截止时间戳：smooth 动画会连发数十次 scroll 事件，布尔标志只能挡第一次，
  // 后续会被误判为“用户滚动”而翻转 atBottom/following（按钮闪烁、贴底失效）。
  // 用时间窗口在整个动画期间持续抑制，而不是只挡一帧。
  const smoothScrollUntilRef = useRef(0)
  const FOLLOW_THRESHOLD = 80
  // 上一次 scroll 事件的位置：用于判断用户滚动方向（只有向下滚回底部才重新跟随）。
  const lastScrollTopRef = useRef(0)
  // 程序化滚动写入的目标位置：scroll 事件只有落在该值上才判定为程序滚动；
  // 若用户滚动与程序写入被合并成同一条 scroll 事件（位置 ≠ 目标），仍按用户输入处理，
  // 否则流式期间拖滚动条/键盘上滚会被 pin 同帧拽回。
  const programmaticScrollTopRef = useRef(0)
  // 重新跟随阈值：必须真正滚到最底（而非停留在 80px 观察带内）才重新接管贴底。
  const REATTACH_THRESHOLD = 4
  const railTargetsRef = useRef(new Map<string, HTMLElement>())
  // 已挂载消息的 [id, 元素] 有序表：只承担「位置」职责，供二分读取 getBoundingClientRect。
  const railEntriesRef = useRef<[string, HTMLElement][]>([])
  // 目录条目的权威顺序，来自数据层 messages，与 DOM 是否挂载无关。
  // 末条判定 / 溢出判定读它：屏外卸载后 DOM 里没有节点，也不能因此丢顺序。
  const railIdsRef = useRef<string[]>([])
  // id → 会话内原始下标：跳转到「当前未挂载」的消息时，要靠它告诉虚拟化该把哪一条纳入窗口。
  const railIndexOfRef = useRef(new Map<string, number>())
  // 虚拟化桥：消息级屏外卸载（useAgentVirtualMessages）与滚动逻辑分处两个组件，
  // 这里留一个注册口，让「跳转到未挂载消息」能先请求挂载、再等 DOM 就位后滚动。
  const virtualApiRef = useRef<{ ensureMounted: (index: number) => void } | null>(null)
  const registerVirtualApi = useCallback((api: { ensureMounted: (index: number) => void } | null) => {
    virtualApiRef.current = api
  }, [])
  const railDirtyRef = useRef(true)
  // 轨道预览缓存（见 syncRailItems 注释）：getMessagePreview 会对「每条消息的完整正文」
  // 跑 4 次 stripThinkContent 正则 + 空白折叠，100 条消息单次约 3ms；而 syncRailItems 被
  // MutationObserver（流式文本改写）/ scroll（贴底 rAF 每帧写 scrollTop）/ ResizeObserver
  // 以 20~60 次/秒驱动，其中绝大多数调用产出的结果完全相同 → 纯重算浪费。
  // 按「消息 id + content 引用 + 下一条 content 引用 + role」缓存：未变的消息 O(1) 命中，
  // 只有正在流式的那一条会重算，预览仍随流式实时更新。
  // 引用比较是安全的：commit() 用 msgs.map 只替换 live 那一条的消息对象，其余消息对象与其
  // content 字符串引用都保持不变；会话切换 / 编辑重发 / 压缩历史时 content 必为新引用 → 自动失效。
  const railPreviewCacheRef = useRef(new Map<string, { content: string; nextContent: string | undefined; role: string; preview: { label: string; description?: string } }>())
  const [railItems, setRailItems] = useState<{ id: string; label: string; description?: string; ariaLabel: string }[]>([])
  const [activeRailId, setActiveRailId] = useState('')
  const [railOverflowing, setRailOverflowing] = useState(false)
  const railFrameRef = useRef<number | undefined>(undefined)
  // 滚动/跳转动画进行中：用于暂时抑制轨道点的「波浪起伏」过渡（transform 弹性 + 波次延迟）。
  // 原因：滚动时 activeRailId 会逐点切换，每切换一次就触发全部点的 transform/background 过渡，
  // 波次延迟最长 300ms + 弹性曲线 → 16 个点反复合成，滚动明显掉帧。动画期间只保留瞬时变色。
  const [railScrolling, setRailScrolling] = useState(false)
  const railScrollIdleTimerRef = useRef<number | undefined>(undefined)
  // 滚动动画互斥锁：任何 animateScrollTo 动画进行期间为 true。
  // 作用：阻止「流式贴底 pin」「messages 变更的 useLayoutEffect 贴底」「scrollToBottom 瞬时分支」
  // 在动画途中抢写 scrollTop —— 多个写入源互相覆盖正是「点击轨道点上下抖动」的根因。
  const railAnimatingRef = useRef(false)
  // 当前动画的中止器：新的动画开始时先中止旧动画，避免两条补间同时写 scrollTop（互抢抖动）。
  const railAnimCancelRef = useRef<(() => void) | null>(null)
  const markRailScrolling = useCallback(() => {
    setRailScrolling(true)
    if (railScrollIdleTimerRef.current) window.clearTimeout(railScrollIdleTimerRef.current)
    // 节流：滚动停止 140ms 后恢复波浪效果
    railScrollIdleTimerRef.current = window.setTimeout(() => setRailScrolling(false), 140)
  }, [])

  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    setSelectionPopover(null)
    // 先记录本次位置：方向始终与「上一条 scroll 事件的位置」比较，
    // 程序化滚动引起的位置变化也要计入基准，否则下一条用户事件的方向会算错。
    const top = el.scrollTop
    const prevTop = lastScrollTopRef.current
    lastScrollTopRef.current = top
    // 程序化滚动（pin / scrollToBottom）不据此翻转跟随态：
    // 否则会被“拉回底部→判为在底部→继续跟随”的反馈环路盖过用户上滚，导致滚动卡死。
    // smooth 动画期间会连发数十次 scroll 事件，故用时间窗口（而非布尔单次标志）持续抑制。
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      // 位置与程序写入目标一致才认作程序滚动。同一渲染帧内用户滚动与程序写入
      // 只会产生一条 scroll 事件，位置偏离目标说明混入了用户输入，必须按用户滚动处理。
      if (Math.abs(top - programmaticScrollTopRef.current) <= 1) return
    } else if (Date.now() < smoothScrollUntilRef.current) {
      return
    }
    const distance = el.scrollHeight - top - el.clientHeight
    // FOLLOW_THRESHOLD 只表达「视口贴近底部」的 UI 态（回到底部按钮），不再驱动跟随翻转。
    const bottom = distance <= FOLLOW_THRESHOLD
    atBottomRef.current = bottom
    setAtBottom(bottom)
    // 重新跟随须同时满足「真正滚到最底」且「方向向下」。只用距离阈值时，近底处的
    // 小幅上滚会在同帧被重新接管、再被 rAF pin 拽回，表现为滚轮被吃掉；方向判断
    // 同时覆盖滚动条拖拽与键盘翻页的向上意图。
    if (distance <= REATTACH_THRESHOLD && top > prevTop) {
      followingRef.current = true
    } else if (top < prevTop) {
      followingRef.current = false
    }
  }, [])

  // 向上滚动立即暂停自动跟随：必须在 rAF pin 执行前同步置位，
  // 否则 pin 每帧把 scrollTop 拽回底部会盖过用户意图（仅用 onChatScroll 翻转因时序竞争仍会卡死）。
  // 向下滚动不暂停：在底部继续下滚本无位移、无 scroll 事件可把跟随翻回来，若在此暂停
  // 会导致「明明在最底下却不跟走」。
  const pauseFollow = useCallback(() => {
    followingRef.current = false
    atBottomRef.current = false
  }, [])
  const { historyStartIndex, loadEarlierMessages } = useAgentHistoryWindow(
    activeSession?.id, activeSession?.messages ?? [], chatScrollRef, pauseFollow,
  )

  // 滚轮带方向：仅上滚（deltaY < 0）暂停跟随。ctrl+wheel 是捏合缩放，delta 正负交替，忽略。
  const onChatWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0 && !e.ctrlKey) pauseFollow()
  }, [pauseFollow])

  // ── 统一的滚动动画（轨道跳转 / 回到底部 共用）──
  // 上滑、下滑、贴底全部走这一条实现，保证「速度与缓动完全一致」，
  // 不再出现「上滑走原生 smooth、下滑走逐帧赋值 → 手感不同」的问题。
  // 特性：
  //   - 时间驱动的补间（非比例衰减），首帧不突跳；
  //   - easeInOutCubic 缓入缓出，两端慢中间快，观感平滑；
  //   - 时长按距离自适应，但设了「每 px 毫秒数」的上限，长距离不会瞬移；
  //   - getTargetTop 每帧重新求值 → 内容增长（懒渲染）时目标自动吸收，不会停在半路。
  const animateScrollTo = useCallback((
    el: HTMLElement,
    getTargetTop: () => number,
    opts?: { maxDuration?: number; onDone?: () => void },
  ) => {
    const maxDuration = opts?.maxDuration ?? 900
    // 若已有动画在跑，先中止它（不触发其 onDone），避免两条补间互抢 scrollTop。
    if (railAnimCancelRef.current) {
      try { railAnimCancelRef.current() } catch { /* ignore */ }
      railAnimCancelRef.current = null
    }
    markRailScrolling()
    railAnimatingRef.current = true
    const startTop = el.scrollTop
    // 真实距离必须由「当前位置 → 目标位置」求得，而不是 scrollHeight 相关量：
    // 早期版本用 |scrollHeight - clientHeight - scrollTop|（即到容器底部的距离）来估时长，
    // 那只对「下滑到底」成立；向上滑时该值≈0 → duration 取下限 320ms，
    // 于是 5000px 的上滑只花 320ms，快得像瞬移（用户反馈的「往上直接一瞬间滑上去」）。
    // 改为先求一次目标，用 |目标 - 当前| 作为距离，上下滑即对称一致。
    const firstTargetTop = getTargetTop()
    const approxDist = Math.abs(firstTargetTop - startTop)
    // 速度控制：约 0.75ms/px（比原生 smooth 略慢更从容），并夹在 [320, maxDuration]。
    // 上下滑共用同一公式 → 相同距离耗时相同，速度一致。
    const duration = Math.min(maxDuration, Math.max(320, approxDist * 0.75))
    let phaseStart = Date.now()
    let phaseFrom = startTop
    let done = false
    let raf = 0
    const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const deadline = Date.now() + maxDuration + 400
    const finish = () => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      if (railAnimCancelRef.current === cancel) railAnimCancelRef.current = null
      railAnimatingRef.current = false
      opts?.onDone?.()
    }
    // 供「被新动画抢占」时调用：只做清理，不回调 onDone（避免旧动画收尾覆盖新动画状态）。
    const cancel = () => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      railAnimatingRef.current = false
    }
    railAnimCancelRef.current = cancel
    const step = () => {
      if (done) return
      const targetTop = getTargetTop()
      const t = Math.min(1, (Date.now() - phaseStart) / duration)
      if (t >= 1) {
        const remain = targetTop - el.scrollTop
        // 内容仍在增长导致目标又变远 → 再补一轮短动画（而非硬跳），保持尾部平滑
        if (remain > 4 && Date.now() < deadline) {
          phaseStart = Date.now()
          phaseFrom = el.scrollTop
          raf = requestAnimationFrame(step)
          return
        }
        el.scrollTop = targetTop
        finish()
        return
      }
      el.scrollTop = phaseFrom + (targetTop - phaseFrom) * easeInOutCubic(t)
      if (Date.now() >= deadline) { el.scrollTop = getTargetTop(); finish(); return }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }, [markRailScrolling])

  const scrollToBottom = useCallback((smooth = false, force = false) => {
    const el = chatScrollRef.current
    if (!el) return
    // 若有滚动动画正在进行（如点击轨道点触发的补间），不要中途抢写 scrollTop：
    // 否则瞬时贴底与动画互相覆盖，表现为「点击点后画面上下抖动/卡顿」。
    // force=true 表示「用户主动要求贴底」（点最后一颗点/点回到底部按钮），
    // 此时应抢占并中止旧动画，而不是被忽略。
    if (railAnimatingRef.current && !force) return
    atBottomRef.current = true
    setAtBottom(true)
    followingRef.current = true
    if (!smooth) {
      const maxTop = el.scrollHeight - el.clientHeight
      // 仅在确有位移时写入并置程序化标志：已在底部时重复调用不产生 scroll 事件，
      // 滞留的标志会把用户的下一条真实滚动误判为程序滚动而漏处理。
      if (maxTop - el.scrollTop > 0.5) {
        programmaticScrollRef.current = true
        programmaticScrollTopRef.current = maxTop
        el.scrollTo({ top: maxTop, behavior: 'auto' })
      }
      return
    }
    // 贴底动画：复用统一的 animateScrollTo（与轨道跳转同一实现，速度/缓动一致）。
    // 目标每帧取「最新 scrollHeight - clientHeight」，故下滚途中懒渲染长高不会被落空。
    const prevAnchor = el.style.overflowAnchor
    el.style.overflowAnchor = 'none'
    // 抑制窗口覆盖整段动画：rAF 每帧写 scrollTop 会产生 scroll 事件，
    // 若窗口过期会被 onChatScroll 误判为用户滚动 → 提前翻转 following 退出。
    smoothScrollUntilRef.current = Date.now() + 1400
    animateScrollTo(el, () => el.scrollHeight - el.clientHeight, {
      maxDuration: 900,
      onDone: () => {
        const cur = chatScrollRef.current
        if (!cur) return
        cur.style.overflowAnchor = prevAnchor
        smoothScrollUntilRef.current = 0
        if (followingRef.current) {
          const maxTop = cur.scrollHeight - cur.clientHeight
          programmaticScrollRef.current = true
          programmaticScrollTopRef.current = maxTop
          cur.scrollTop = maxTop // 精确贴底
          // 贴底后把高亮同步到「最后一颗」：否则 updateActiveRailItem 在本帧取数时
          // 视口中心仍偏向中间消息，高亮会残留在半路那颗点上，与"已到底"观感矛盾。
          // 末条 id 取自数据层顺序（railIdsRef），不依赖 DOM 节点是否存在。
          const lastId = railIdsRef.current.at(-1) ?? ''
          if (lastId) setActiveRailId(current => current === lastId ? current : lastId)
        }
      },
    })
  }, [animateScrollTo])

  // 贴底滚动必须在 paint 前执行（useLayoutEffect）：finalize 切换完成态行件的同一帧，
  // DOM 布局已含新增的 actions/文件汇总（高度突变），若在 paint 后（useEffect）才滚动，
  // 会先绘制一帧旧滚动位置 + 新布局（内容整体位移），再被拉回底部 → 视觉「跳一下」。
  // 用 useLayoutEffect 在绘制前一次性到位，无中间帧。
  useLayoutEffect(() => {
    if (followingRef.current) {
      scrollToBottom()
    }
  }, [activeSession?.messages, scrollToBottom])

  // 流式期间用 requestAnimationFrame 持续贴底，消除气泡底部“一卡一卡”。
  // 原因：正文通过节流的 display 状态“晚一次提交”才增高，而 messages 变更触发的
  // scrollToBottom 在增高之前就已执行，两者相位错开 → 滞后一拍的追赶式跳动。
  // 改为每帧把滚动条钉到底（仅当用户处于底部），滚动便与真实内容高度同步增长；
  // 用户上滚查看时（atBottomRef=false）不打断。
  useEffect(() => {
    if (!streaming) return
    let raf = 0
    const pin = () => {
      const el = chatScrollRef.current
      // 滚动动画进行中不抢滚动控制权：直接赋值 scrollTop 会打断补间动画，
      // 表现为「点击轨道点后上下抖动 / 停在半路」。动画由 animateScrollTo 收尾后恢复贴底。
      if (el && followingRef.current && !railAnimatingRef.current && Date.now() >= smoothScrollUntilRef.current) {
        const maxTop = el.scrollHeight - el.clientHeight
        // 仅在确有位移时写入并置程序化标志：位置未变时不产生 scroll 事件，
        // 滞留的标志会把用户的下一条真实滚动误判为程序滚动而漏处理（滚轮时灵时不灵）。
        if (maxTop - el.scrollTop > 0.5) {
          programmaticScrollRef.current = true
          programmaticScrollTopRef.current = maxTop
          el.scrollTop = maxTop
        }
      }
      raf = requestAnimationFrame(pin)
    }
    raf = requestAnimationFrame(pin)
    return () => cancelAnimationFrame(raf)
  }, [streaming])

  // truncateMessageText / getMessagePreview / stripThinkContent 及 PREVIEW_* 常量
  // 已抽至 agent-code/utils/text.ts（纯函数，无组件作用域依赖）

  const updateActiveRailItem = useCallback(() => {
    const viewport = chatScrollRef.current
    const targets = railEntriesRef.current
    if (!viewport || targets.length === 0) return

    const viewportRect = viewport.getBoundingClientRect()
    if (viewport.scrollTop <= FOLLOW_THRESHOLD) {
      const firstId = targets[0]?.[0] ?? ''
      setActiveRailId(current => current === firstId ? current : firstId)
      return
    }

    const distanceFromEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distanceFromEnd <= FOLLOW_THRESHOLD) {
      const lastId = targets.at(-1)?.[0] ?? ''
      setActiveRailId(current => current === lastId ? current : lastId)
      return
    }

    // 消息节点按文档顺序排列，位置单调：二分查找将每帧布局读取从 O(N) 降为 O(log N)。
    const refLine = viewportRect.top + Math.min(120, viewportRect.height * 0.25)
    let low = 0
    let high = targets.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (targets[mid]![1].getBoundingClientRect().top <= refLine) low = mid + 1
      else high = mid
    }
    const chosen = targets[Math.max(0, low - 1)]![0]
    setActiveRailId(current => current === chosen ? current : chosen)
  }, [FOLLOW_THRESHOLD])

  // 目录条目改由数据层生成（activeSession.messages 的已加载区间），不再从 DOM 反查。
  // 原因：屏外卸载后消息节点可能不存在，若仍以 DOM 为条目来源，目录会缺项、条目顺序也会
  // 随挂载范围抖动（rail id 落在哪条消息上取决于当时谁在 DOM 里）。
  // DOM 只保留「位置」职责：按 data-message-index 建一次索引，供二分与跳转取节点；
  // 取不到节点的条目仍进目录（顺序正确），只是暂时不参与位置二分。
  const syncRailItems = useCallback(() => {
    const viewport = chatScrollRef.current
    if (!viewport) return

    const all = activeSession?.messages ?? []
    const messages = all.slice(historyStartIndex)
    const nodeByIndex = new Map<number, HTMLElement>()
    for (const node of viewport.querySelectorAll<HTMLElement>('[data-slot="message"]')) {
      const idx = Number(node.dataset.messageIndex)
      if (Number.isFinite(idx)) nodeByIndex.set(idx, node)
    }

    const targets = new Map<string, HTMLElement>()
    const ids: string[] = []
    const indexById = new Map<string, number>()
    const nextItems: { id: string; label: string; description?: string; ariaLabel: string }[] = []
    // 预览缓存：命中条件见 railPreviewCacheRef 声明处。只有「content 引用变了」的消息
    // （即正在流式的那一条）才真正重跑 getMessagePreview。
    const previewCache = railPreviewCacheRef.current
    const aliveIds = new Set<string>()

    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i]!
      const originalIndex = historyStartIndex + i
      // rail id 直接复用消息的稳定 id：与数据一一对应，编辑重发 / 压缩历史 / 屏外卸载都不会错位。
      const id = msg.id
      aliveIds.add(id)
      ids.push(id)
      indexById.set(id, originalIndex)
      const node = nodeByIndex.get(originalIndex)
      if (node) targets.set(id, node)
      // 预览同时依赖「本条 content」与「下一条 content」（下一条是助手消息时取它作 description），
      // 两者任一换新引用即失效重算，因此缓存键必须带上 nextContent。
      const nextContent = all[originalIndex + 1]?.content
      const hit = previewCache.get(id)
      let preview: { label: string; description?: string }
      if (hit && hit.content === msg.content && hit.nextContent === nextContent && hit.role === msg.role) {
        preview = hit.preview
      } else {
        preview = getMessagePreview(msg, all, originalIndex)
        previewCache.set(id, { content: msg.content, nextContent, role: msg.role, preview })
      }
      nextItems.push({
        id,
        label: preview.label,
        description: preview.description,
        ariaLabel: `Go to ${msg.role} message`,
      })
    }
    // 清理已不在列表里的消息（编辑重发 / 压缩历史 / 切换会话），避免缓存无限增长
    if (previewCache.size > aliveIds.size) {
      for (const key of previewCache.keys()) if (!aliveIds.has(key)) previewCache.delete(key)
    }

    railTargetsRef.current = targets
    railEntriesRef.current = [...targets.entries()]
    railIdsRef.current = ids
    railIndexOfRef.current = indexById
    railDirtyRef.current = false
    // 只在「条目内容真正变化」时才 setState：滚动动画期间 syncRailItems 会被每帧调用，
    // 若无条件 setRailItems(新数组引用) 会触发整条 rail 每帧重渲染（16 个点 + 预览文本
    // 每帧重算），造成可见的掉帧/顿挫。用内容比对跳过无意义的渲染。
    setRailItems(prev => {
      if (prev.length === nextItems.length) {
        let same = true
        for (let i = 0; i < nextItems.length; i += 1) {
          const a = prev[i]
          const b = nextItems[i]
          if (a.id !== b.id || a.label !== b.label || a.description !== b.description || a.ariaLabel !== b.ariaLabel) {
            same = false
            break
          }
        }
        if (same) return prev // 引用不变 → React 跳过渲染
      }
      return nextItems
    })
    setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && nextItems.length > 1)
  }, [activeSession?.messages, historyStartIndex])

  const scheduleRailSync = useCallback(() => {
    if (railFrameRef.current) return
    railFrameRef.current = requestAnimationFrame(() => {
      railFrameRef.current = undefined
      if (railDirtyRef.current) syncRailItems()
      const viewport = chatScrollRef.current
      if (viewport) setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && railIdsRef.current.length > 1)
      updateActiveRailItem()
    })
  }, [syncRailItems, updateActiveRailItem])

  // 把某条「已挂载」的消息滚到视口顶部附近：轨道点跳转与「屏外卸载后补挂载」共用的出口。
  // 跳向某条用户提问时显式进入离底态（露出“回到底部”按钮）；与「跳到底部」共用同一个
  // animateScrollTo → 上下滑动动画速度/缓动完全一致。
  const animateToRailTarget = useCallback((id: string) => {
    const viewport = chatScrollRef.current
    if (!viewport) return
    followingRef.current = false
    atBottomRef.current = false
    setAtBottom(false)
    const prevAnchor = viewport.style.overflowAnchor
    viewport.style.overflowAnchor = 'none'
    smoothScrollUntilRef.current = Date.now() + 1400
    // 目标位置每帧重算：消息高度可能因懒渲染变化，重算可保证最终精确落在目标处。
    // 用「不变式」求目标的绝对内容偏移：contentTop = scrollTop + (tgtRect.top - viewRect.top)。
    // 该值不随滚动变化（下滚 δ 时两 rect.top 同步减 δ、scrollTop 加 δ，互相抵消），
    // 因此不会出现「目标跟着视口跑」的自我引用问题；只在内容高度变化时更新。
    // 对齐策略：把用户提问滚到「视口顶部稍下方」——提问在上、模型回答在下方依次展开，
    // 符合「按提问索引跳转」的阅读习惯（居中对齐会让提问悬在中间、下方留白）。
    const RAIL_TOP_GAP = 12
    const computeTop = () => {
      const cur = chatScrollRef.current
      const tgt = railTargetsRef.current.get(id)
      if (!cur || !tgt) return cur?.scrollTop ?? viewport.scrollTop
      const vRect = cur.getBoundingClientRect()
      const tRect = tgt.getBoundingClientRect()
      const contentTop = cur.scrollTop + (tRect.top - vRect.top) // 目标的绝对内容偏移（滚动不变）
      const raw = contentTop - RAIL_TOP_GAP
      const maxTop = cur.scrollHeight - cur.clientHeight
      return Math.max(0, Math.min(maxTop, raw))
    }
    animateScrollTo(viewport, computeTop, {
      maxDuration: 900,
      onDone: () => {
        const cur = chatScrollRef.current
        if (cur) cur.style.overflowAnchor = prevAnchor
        smoothScrollUntilRef.current = 0
        scheduleRailSync()
      },
    })
    setActiveRailId(id)
    scheduleRailSync()
  }, [animateScrollTo, scheduleRailSync])

  const scrollToRailItem = useCallback((item: { id: string }) => {
    const viewport = chatScrollRef.current
    if (!viewport) return

    // 每条消息一个点。点击一律把该消息滚到「视口顶部附近」（提问在上、回答在下方展开，
    // 比居中更符合阅读习惯）。唯一例外：末颗点即最后一条消息 → 等同贴底。
    // 末条判定读数据层顺序（railIdsRef）：不再扫 DOM 找「最后一个消息节点」，
    // 那个查询在长会话里是 O(全部节点)，而且屏外卸载后最后一条未必在 DOM 里。
    const ids = railIdsRef.current
    const isLast = ids.length > 0 && ids[ids.length - 1] === item.id
    if (isLast) {
      // 末颗且它就是最后一条消息 → 等同贴底，复用统一出口（含 following/锚定处理）
      scrollToBottom(true, true)
      setActiveRailId(item.id)
      scheduleRailSync()
      return
    }
    if (railTargetsRef.current.has(item.id)) {
      animateToRailTarget(item.id)
      return
    }
    // 目标当前未挂载（被屏外卸载顶掉了）：先请虚拟化把窗口扩到包含它，
    // 等 DOM 就位（两帧：一帧提交挂载、一帧完成布局）再走同一套滚动动画。
    const api = virtualApiRef.current
    const index = railIndexOfRef.current.get(item.id)
    if (!api || index === undefined) return
    api.ensureMounted(index)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const node = chatScrollRef.current?.querySelector<HTMLElement>(`[data-slot="message"][data-message-index="${index}"]`)
      if (!node) return
      railTargetsRef.current.set(item.id, node)
      animateToRailTarget(item.id)
    }))
  }, [animateToRailTarget, scheduleRailSync, scrollToBottom])

  useEffect(() => {
    const viewport = chatScrollRef.current
    if (!viewport) return
    const onScroll = () => {
      markRailScrolling()
      scheduleRailSync()
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [scheduleRailSync, markRailScrolling])

  useEffect(() => {
    const viewport = chatScrollRef.current
    if (!viewport) return

    // 数据变化 / 挂载消息范围变化才重建目录。正文 token、代码高亮及思考计时
    // 只改变位置，不应重新扫描整棵 DOM 和重建所有目录项。
    railDirtyRef.current = true
    scheduleRailSync()
    const mutationObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(records => {
      if (records.some(record => record.type === 'childList' && record.target === viewport)) railDirtyRef.current = true
      scheduleRailSync()
    }) : null
    mutationObserver?.observe(viewport, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleRailSync) : null
    resizeObserver?.observe(viewport)

    return () => {
      if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current)
      railFrameRef.current = undefined
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
    }
  }, [scheduleRailSync])

  // 卸载时清理轨道滚动节流定时器，避免卸载后 setState
  useEffect(() => () => {
    if (railScrollIdleTimerRef.current) window.clearTimeout(railScrollIdleTimerRef.current)
  }, [])

  useEffect(() => {
    const root = chatScrollRef.current?.closest('.agent-code-chat') as HTMLElement | null
    if (!root) return
    const apply = () => {
      const h = taskCardRef.current && taskModalOpen ? taskCardRef.current.offsetHeight : 0
      root.style.setProperty('--task-card-h', `${h}px`)
      const el = chatScrollRef.current
      // 实时计算贴底（不依赖缓存的 atBottomRef，避免 padding 变化引发的 scroll 误判）；
      // 只在本来就跟随时才续贴：用户已上滚暂停跟随时，任务卡/计划项刷新不得把人拽回底部。
      if (el && followingRef.current && el.scrollHeight - el.scrollTop - el.clientHeight < 80) scrollToBottom()
    }
    apply()
    const ro = new ResizeObserver(apply)
    if (taskCardRef.current) ro.observe(taskCardRef.current)
    return () => ro.disconnect()
  }, [taskModalOpen, scrollToBottom])

  // 会话切换时把跟随态复位（原内联在 activeSessionId 变更 effect 中）
  const resetFollow = useCallback(() => {
    atBottomRef.current = true
    setAtBottom(true)
  }, [])

  return {
    historyStartIndex, loadEarlierMessages,
    chatScrollRef, atBottom, railItems, activeRailId, railOverflowing, railScrolling,
    onChatScroll, onChatWheel, pauseFollow, markRailScrolling,
    animateScrollTo, scrollToBottom, updateActiveRailItem, syncRailItems,
    scheduleRailSync, scrollToRailItem, resetFollow, registerVirtualApi,
  }
}