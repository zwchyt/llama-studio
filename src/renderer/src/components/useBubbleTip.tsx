import React, { useCallback, useEffect, useRef, useState } from 'react'
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
//    我们自己动手）。
//  · 自动收起的时机：指针离开锚点、滚动、缩放、按下鼠标、按键、指针移到别的元素上。
//    只挂 mouseleave 会漏两种：点开浮层时指针没动（浏览器不补发 mouseleave），
//    以及锚点被卸载（列表重排 / 流式刷新 / 切视图），后者一个事件都不会来，
//    气泡就会一直挂在屏幕上。fixed 坐标滚后还会错位，所以滚动也收。

export type BubbleTipPlacement = 'right' | 'below'

const WRAP_LEN = 28
const EDGE = 90
const MIN_H = 44

type TipState = { text: string; left: number; top: number; above: boolean }

export function useBubbleTip(placement: BubbleTipPlacement = 'below', delayMs = 0) {
  const [tip, setTip] = useState<TipState | null>(null)
  // 悬停延迟（delayMs > 0 时生效）：鼠标快速掠过不弹，停住才弹。
  // 默认 0 保持原有「即时」行为，只有显式传了延迟的调用点才变慢。
  const delayTimer = useRef<number | null>(null)
  // 当前气泡挂在哪个元素上：指针移开、锚点被卸载、用户按下时都靠它判断要不要收
  const anchorRef = useRef<HTMLElement | null>(null)
  const clearDelay = useCallback(() => {
    if (delayTimer.current !== null) { window.clearTimeout(delayTimer.current); delayTimer.current = null }
  }, [])
  useEffect(() => clearDelay, [clearDelay])

  const show = useCallback((text: string, el: HTMLElement | null) => {
    if (!el) { anchorRef.current = null; setTip(null); return }
    anchorRef.current = el
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

  // 收气泡的统一出口：清延迟、断锚点、关状态。三件事必须一起做，
  // 漏了断锚点，后面的 pointerover 判断会拿一个已经作废的元素去比。
  const hideTip = useCallback(() => {
    clearDelay()
    anchorRef.current = null
    setTip(p => (p ? null : p))
  }, [clearDelay])

  // 滚动 / 缩放 / 按下 / 按键，都收掉气泡。这些事件本身不频繁，常驻注册一次即可。
  // 只靠 mouseleave 不够：点开浮层时指针没动，浏览器不会补发 mouseleave。
  useEffect(() => {
    window.addEventListener('scroll', hideTip, true)
    window.addEventListener('resize', hideTip)
    window.addEventListener('pointerdown', hideTip, true)
    window.addEventListener('keydown', hideTip, true)
    return () => {
      window.removeEventListener('scroll', hideTip, true)
      window.removeEventListener('resize', hideTip)
      window.removeEventListener('pointerdown', hideTip, true)
      window.removeEventListener('keydown', hideTip, true)
    }
  }, [hideTip])

  // 指针移到别的元素上、或锚点已被卸载，也收掉。
  // 这一条只在有气泡时挂：本 hook 有 83 个调用点，常驻一个 document 级 pointerover 监听
  // 等于每次指针跨元素都跑 83 次空判断，没必要。
  useEffect(() => {
    if (!tip) return
    const onPointerOver = (e: PointerEvent) => {
      const a = anchorRef.current
      if (!a) return
      // 锚点已从文档里移除（列表重排 / 流式刷新 / 切视图）：气泡没有依附对象了，直接收
      if (!a.isConnected) { hideTip(); return }
      const t = e.target as Node | null
      if (t && (t === a || a.contains(t))) return
      hideTip()
    }
    document.addEventListener('pointerover', onPointerOver, true)
    return () => document.removeEventListener('pointerover', onPointerOver, true)
  }, [tip, hideTip])

  // 每个要换装的元素 spread 一份：{...tip('文案')}
  const tipHandlers = useCallback((text: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget
      clearDelay()
      if (delayMs <= 0) { show(text, el); return }
      // 延迟期间元素位置可能变化，坐标在真正显示时再取
      delayTimer.current = window.setTimeout(() => { delayTimer.current = null; show(text, el) }, delayMs)
    },
    onMouseLeave: () => hideTip(),
  }), [show, delayMs, clearDelay, hideTip])

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
