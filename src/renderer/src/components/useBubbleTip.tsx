import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// ── 共用自定义气泡（useBubbleTip）──
//
// 把原生 title= 换成与导航栏收起气泡同款外观（.nav-tip，见 sidebar.css）：
// 原生 title 有约 1s 延迟、样式不可控（跟系统走，背景图/深色主题下都难看）；
// 自定义气泡即时显示（与导航气泡一致），外观、入场动画、深色主题一次复用。
//
// 用法：
//   const { tipHandlers: tip, tipNode } = useBubbleTip()   // 默认下方
//   <button aria-label="关闭" {...tip('关闭')}><X /></button>
//   …在组件 return 里找个位置放一次 {tipNode}（portal 到 body，不占布局）
//
// 规则：
//  · 必须去掉原生 title=，否则两个一起弹；图标按钮顺手补 aria-label（原来只有
//    title 撑着可读名，去掉就没名字了）。
//  · disabled 的按钮/input 收不到鼠标事件，原生 title 反而能弹——这种外面包一层
//    <span style={{ display: 'inline-flex' }} {...tip('…')}>，事件挂在 span 上。
//  · placement 'right' 是导航栏专用（箭头在左、垂直居中），其它界面用 'below'。
//  · 超过 WRAP_LEN 个字自动折行（.nav-tip-wrap），长说明文字不断成一条横幅。
//  · 视口修正：下方放不下翻到上方，左右贴边内收 90px（原生 title 会被系统钳制，
//    我们自己动手）。滚动/缩放直接收掉——fixed 坐标滚后即错位，原生滚一下也没。

export type BubbleTipPlacement = 'right' | 'below'

const WRAP_LEN = 28
const EDGE = 90
const MIN_H = 44

type TipState = { text: string; left: number; top: number; above: boolean }

export function useBubbleTip(placement: BubbleTipPlacement = 'below') {
  const [tip, setTip] = useState<TipState | null>(null)

  const show = useCallback((text: string, el: HTMLElement | null) => {
    if (!el) { setTip(null); return }
    const r = el.getBoundingClientRect()
    if (placement === 'right') {
      // 导航栏：右缘 + 9px，垂直中心（CSS translateY(-50%) 对齐，见 sidebar.css 注释）
      setTip({ text, left: r.right + 9, top: r.top + r.height / 2, above: false })
      return
    }
    const cx = Math.min(Math.max(r.left + r.width / 2, EDGE), window.innerWidth - EDGE)
    const belowTop = r.bottom + 9
    // 下面剩不下 MIN_H 就翻到上面（top = 上缘 - 9px，CSS translate(-50%,-100%) 顶对齐）
    const above = belowTop + MIN_H > window.innerHeight
    setTip({ text, left: cx, top: above ? r.top - 9 : belowTop, above })
  }, [placement])

  // 滚动/缩放收掉（见文件头说明）
  useEffect(() => {
    if (!tip) return
    const hide = () => setTip(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [tip])

  // 每个要换装的元素 spread 一份：{...tip('文案')}
  const tipHandlers = useCallback((text: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(text, e.currentTarget),
    onMouseLeave: () => setTip(null),
  }), [show])

  // 已有 onMouseEnter 的元素走这对裸方法，在原处理里顺手调用（见 ToolsHub 的 ToolActionItem）
  const hideTip = useCallback(() => setTip(null), [])

  const tipNode = tip ? createPortal(
    <div
      role="tooltip"
      className={
        `nav-tip${placement === 'below' ? (tip.above ? ' nav-tip-above' : ' nav-tip-below') : ''}` +
        (tip.text.length > WRAP_LEN ? ' nav-tip-wrap' : '')
      }
      style={{ left: tip.left, top: tip.top }}
    >
      {tip.text}
    </div>,
    document.body
  ) : null

  return { tipHandlers, tipNode, showTip: show, hideTip }
}
