import { useEffect, useRef } from 'react'

/**
 * 全屏弹层的焦点管理：打开时把焦点移进来，Tab / Shift+Tab 在层内循环，关闭时归还触发元素。
 *
 * 只做键盘可达所需的最小集合，不改弹层的 DOM 结构。挂到「对话框容器」上（不是遮罩），
 * 遮罩自身的点击关闭逻辑不受影响。
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>() {
  const rootRef = useRef<T>(null)
  useEffect(() => {
    const root = rootRef.current
    const prev = document.activeElement as HTMLElement | null
    // 可见且可聚焦：用 getClientRects 判断可见性——对 fixed 定位元素 offsetParent 恒为 null，
    // 用 offsetParent 会把整个 fixed 弹层里的按钮全过滤掉。
    const focusables = (): HTMLElement[] => {
      if (!root) return []
      return Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
    }
    // 打开即聚焦首个可聚焦元素（通常是关闭按钮）：Esc / Tab 立刻可用，读屏也会先读标题
    focusables()[0]?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const idx = list.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? (idx <= 0 ? list.length - 1 : idx - 1)
        : (idx === -1 || idx === list.length - 1 ? 0 : idx + 1)
      e.preventDefault()
      list[next]!.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // 关闭后归还焦点：键盘用户不会掉回文档开头（触发元素已被卸载时 isConnected 为 false，跳过）
      if (prev && prev.isConnected) prev.focus()
    }
  }, [])
  return rootRef
}
