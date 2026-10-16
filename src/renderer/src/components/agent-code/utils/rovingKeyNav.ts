import type React from 'react'

/** 项内第一个可聚焦控件（标签项里就是那个按钮） */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** 列表行 / 标签条的键盘导航（会话栏与右侧面板标签共用同一套）：
 *  · 方向键在相邻项之间移焦 —— 纵向列表用 ↑/↓，横向标签条传 horizontal: true 用 ←/→；
 *  · Enter / Space 仅在**项本身**被聚焦时等价于点击；焦点在项内控件上时不接管这两个键，
 *    留给控件自己的默认行为；
 *  · 默认方向键也只在项本身聚焦时生效（不抢行内按钮/输入框的键）；项本身不可聚焦、
 *    焦点只能落在内层控件上的结构（如标签条）传 arrowsFromDescendants: true 放开；
 *  · 焦点在文本输入框里时一律不接管 —— 否则改会话名时按方向键会跳行；
 *  · 移焦目标：项本身可聚焦就聚焦项，否则聚焦项内第一个可聚焦控件。
 *  兄弟项由 itemSelector 定位（默认 '[data-row]'），调用方要给项元素挂上同样的标记。 */
export function rovingKeyNav(
  e: React.KeyboardEvent<HTMLElement>,
  opts: { horizontal?: boolean; itemSelector?: string; arrowsFromDescendants?: boolean } = {},
): void {
  const { horizontal = false, itemSelector = '[data-row]', arrowsFromDescendants = false } = opts
  const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp'
  const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown'
  const self = e.currentTarget
  const target = e.target as HTMLElement
  const onSelf = target === self
  const isArrow = e.key === prevKey || e.key === nextKey
  if (!isArrow && !(onSelf && (e.key === 'Enter' || e.key === ' '))) return
  if (isArrow && !onSelf && !arrowsFromDescendants) return
  if (!onSelf && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  e.preventDefault()
  if (onSelf && (e.key === 'Enter' || e.key === ' ')) { self.click(); return }
  const items = Array.from(self.parentElement?.querySelectorAll<HTMLElement>(`:scope > ${itemSelector}`) ?? [])
  const next = items[items.indexOf(self) + (e.key === nextKey ? 1 : -1)]
  if (!next) return
  ;(next.matches(FOCUSABLE) ? next : next.querySelector<HTMLElement>(FOCUSABLE))?.focus()
}
