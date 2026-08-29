import { useEffect } from 'react'

// 浮层外部点击 / Esc 关闭的通用逻辑。抽象自 AgentCodeView 中多处手写的
// document.addEventListener('pointerdown'/'mousedown', ...) 关闭浮层 effect。
//
// 三种「点击内部不关闭」的判定方式（可组合）：
//   - btnRef：触发按钮（点击它不关闭，让按钮自身负责 toggle 打开/关闭）
//   - popRef：浮层元素 ref，用 contains 判定——portal 到 body 也准确，比 class 选择器更稳
//   - popSelector：按 class 选择浮层（旧用法 / 未持有 ref 时）。注意逗号选择器必须用
//     querySelectorAll 逐一检查——querySelector 只返回文档序第一个匹配，portal 到 body
//     的浮层面板排在卡片之后会被漏判，导致点选项被当成「点击外部」而误关弹层
export function usePopoverDismiss(
  open: boolean,
  setOpen: (v: boolean) => void,
  btnRef?: React.RefObject<HTMLElement | null>,
  popSelector?: string,
  popRef?: React.RefObject<HTMLElement | null>,
  capture = false,
) {
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e.type === 'keydown') {
        if ((e as KeyboardEvent).key === 'Escape') setOpen(false)
        return
      }
      const target = e.target as Node
      // 点在触发按钮内不关闭（让按钮自身负责 toggle）
      if (btnRef?.current?.contains(target)) return
      // 点在浮层内不关闭：基于 ref 的 contains 判定，portal 到 body 也准确
      if (popRef?.current?.contains(target)) return
      // 兼容「按 class 选择浮层」的旧用法（多浮层 / 未持有 ref 时）
      if (popSelector) {
        const pops = document.querySelectorAll(popSelector)
        for (const pop of pops) { if (pop.contains(target)) return }
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', close, capture)
    document.addEventListener('keydown', close, capture)
    return () => {
      document.removeEventListener('pointerdown', close, capture)
      document.removeEventListener('keydown', close, capture)
    }
  }, [open, setOpen, btnRef, popSelector, popRef, capture])
}
