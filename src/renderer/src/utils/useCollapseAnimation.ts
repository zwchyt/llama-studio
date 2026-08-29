import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type CollapseAnimationOptions = {
  // 初始展开态（挂载时即展开，如「默认展开」卡片 / 流式思考块）
  initialExpanded?: boolean
  // 挂载时若已展开，跳过展开动画直接自适应高度（defaultOpen 场景）；
  // 否则回到「首次展开」的 0→scrollHeight 动画路径
  skipFirstAnim?: boolean
  // 每次点击折叠/展开前的回调（如 ThinkBlock 记录 userToggledRef，阻止自动态覆盖手动操作）
  beforeToggle?: () => void
}

// 折叠/展开动画引擎：裁剪层（外层 max-height）像素级过渡 + overflow:hidden。
// 与 AgentCodeView 中 ThinkBlock / ToolCallCard 原内联实现保持一致的关键约定：
//   - 首次展开：先 setVisible(true) 挂载内容，下一帧布局完成后从 0 过渡到 scrollHeight；
//   - 已挂载展开：直接过渡到 scrollHeight（无重挂载 → 不重解析 Markdown/高亮，顺滑）；
//   - 收起：固定当前像素高度→强制回流→过渡到 0；内容保持挂载不卸载（避免再次展开卡顿）；
//   - 过渡结束（max-height）：展开完成后置 'none' 以自适应后续高度增长，收起保持 0。
// 流式内容持续增长时，由调用方自行把 maxHeight 设为 'none'（见 ThinkBlock 的流式 effect）。
// 注意：自动展开（如流式期间）不走本 hook 的 expand()，而是直接 setState + 由调用方的
// 流式 effect 把 maxHeight 置 'none'，因此本 hook 只负责「手动点击」的像素过渡动画。
export function useCollapseAnimation<T extends HTMLElement = HTMLDivElement>(
  bodyRef: React.RefObject<T | null>,
  options: CollapseAnimationOptions = {},
) {
  const { initialExpanded = false, skipFirstAnim = false, beforeToggle } = options

  const [expanded, setExpanded] = useState(initialExpanded)
  // visible：内容是否已挂载。初始展开（skipFirstAnim）时立即挂载；
  // 否则首次展开由 expand() 置 true。收起不卸载（保持挂载），故仅首次/最终收起时变化。
  const [visible, setVisible] = useState(initialExpanded)

  const expandedRef = useRef(expanded)
  useEffect(() => { expandedRef.current = expanded }, [expanded])

  // 初始即展开（skipFirstAnim）：挂载后直接自适应高度，跳过展开动画
  useLayoutEffect(() => {
    if (skipFirstAnim && expandedRef.current && bodyRef.current) {
      bodyRef.current.style.maxHeight = 'none'
    }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const collapse = useCallback(() => {
    setExpanded(false)
    const el = bodyRef.current
    if (el) {
      // 固定当前像素高度 → 强制回流 → 过渡到 0；保持挂载不卸载
      el.style.maxHeight = el.scrollHeight + 'px'
      void el.offsetHeight
      el.style.maxHeight = '0px'
    }
  }, [bodyRef])

  const expand = useCallback(() => {
    const el = bodyRef.current
    if (el) {
      // 已挂载：直接过渡到内容高度（无重挂载 → 顺滑）
      setExpanded(true)
      el.style.maxHeight = el.scrollHeight + 'px'
    } else {
      // 首次展开：先挂载，待下一帧布局完成再从 0 过渡到内容高度
      setVisible(true)
      requestAnimationFrame(() => {
        setExpanded(true)
        const el2 = bodyRef.current
        if (el2) el2.style.maxHeight = el2.scrollHeight + 'px'
      })
    }
  }, [bodyRef])

  const toggle = useCallback(() => {
    beforeToggle?.()
    if (expandedRef.current) collapse()
    else expand()
  }, [beforeToggle, collapse, expand])

  const onBodyTransitionEnd = useCallback((e: React.TransitionEvent<T>) => {
    if (e.propertyName !== 'max-height') return
    const el = bodyRef.current
    if (el && expandedRef.current) el.style.maxHeight = 'none'
  }, [bodyRef])

  return {
    expanded,
    visible,
    expandedRef,
    setExpanded,
    setVisible,
    expand,
    collapse,
    toggle,
    onBodyTransitionEnd,
  }
}
