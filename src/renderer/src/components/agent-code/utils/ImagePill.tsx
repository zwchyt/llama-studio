// 图片胶囊：输入框与消息气泡共用同一副展示——默认图标 + 文件名，不铺开图片本身，
// 尺寸贴着文字；悬停弹出原图预览卡，带磁盘路径的还能点开右侧「预览」工作区看原图。
//
// 预览卡 portal 到 body + fixed 定位：两处宿主都会裁剪（输入框有滚动上限，
// 用户气泡被 max-height 裁过），absolute 挂在胶囊里会被切掉一半。
// 收合延迟一拍：卡片与胶囊之间总有几像素空隙，指针穿过时不该先把卡片收掉。
//
// 预览卡的尺寸按图片实际宽高比算，不是「固定框 + object-fit: contain」——
// 固定框里竖长图/宽图四周会留一大片底色，看着像图没加载全。这里量一次原图宽高比，
// 卡片就贴着图片本身：上限 PREVIEW_MAX_W × PREVIEW_MAX_H，小图不放大（放大只会糊）。
// 位置以胶囊中心为基准水平居中弹出（原来是与胶囊左缘对齐，窄胶囊看着像卡片歪了），
// 上方放不下就翻到下方。
//
// 位置不存坐标而存「胶囊的矩形」：卡片尺寸要等原图量出来才知道，而量图是异步的。
// 存矩形、渲染时用「矩形 + 当前尺寸」现算坐标，图片一量好卡片就自动摆正，
// 不必再补一个 effect 去重算（那种写法容易和 setState 打架转起来）。

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon } from 'lucide-react'
import { XIcon } from '@animateicons/react/lucide'

/** 预览卡里图片的显示上限（原图按宽高比缩进这个框） */
const PREVIEW_MAX_W = 280
const PREVIEW_MAX_H = 220
/** 卡片自身的框：左右各 6px padding + 1px 边框（与 .agent-img-pill-preview 一致） */
const PREVIEW_CHROME = 14
/** 卡片与视口边缘留的缝 */
const PREVIEW_GAP = 8

type Size = { w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function ImagePill({ name, src, onRemove, removeDisabled, onClick, clickHint, titleText }: {
  name: string
  /** 图片 data URL：有值才挂悬停预览 */
  src?: string
  /** 删除按钮（输入框里用） */
  onRemove?: () => void
  /** 生成中禁用删除，与文件附件那颗胶囊的 disabled 表现一致 */
  removeDisabled?: boolean
  /** 点击行为：拿得到磁盘路径时＝在右侧「预览」工作区打开原图 */
  onClick?: () => void
  /** 有 onClick 时的提示后缀 */
  clickHint?: string
  /** 覆盖悬停提示（输入框行内胶囊：没有路径可开时点它是定位光标，提示要另写） */
  titleText?: string
}) {
  const pillRef = useRef<HTMLSpanElement>(null)
  // 卡片开着时＝胶囊的矩形（快照）；关闭后置空。坐标在渲染时现算，见文件头说明。
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  // 原图的显示尺寸（已按宽高比缩进上限框）：一次量好，悬停时直接用
  const [box, setBox] = useState<Size | null>(null)
  const timer = useRef<number | null>(null)

  // 量原图宽高比 → 算卡片该多大。没有这一步就只能在固定框里 contain，
  // 竖长图/宽图四周会空出一大片底色。量不出来就退回上限框，至少还能看。
  useEffect(() => {
    if (!src) { setBox(null); return }
    let alive = true
    const img = new window.Image()
    img.onload = () => {
      if (!alive) return
      const nw = img.naturalWidth || 1
      const nh = img.naturalHeight || 1
      const scale = Math.min(1, PREVIEW_MAX_W / nw, PREVIEW_MAX_H / nh)
      setBox({ w: Math.max(1, Math.round(nw * scale)), h: Math.max(1, Math.round(nh * scale)) })
    }
    img.onerror = () => { if (alive) setBox(null) }
    img.src = src
    return () => { alive = false }
  }, [src])

  const show = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    const r = pillRef.current?.getBoundingClientRect()
    if (r) setAnchor(r)
  }, [])

  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAnchor(null), 140)
  }, [])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  // 卡片几何：尺寸＝图片显示尺寸 + 卡片的框；水平以胶囊中心居中，垂直优先在上方
  const card = (() => {
    if (!anchor) return null
    const w = (box?.w ?? PREVIEW_MAX_W) + PREVIEW_CHROME
    const h = (box?.h ?? PREVIEW_MAX_H) + PREVIEW_CHROME
    const left = clamp(anchor.left + anchor.width / 2 - w / 2, PREVIEW_GAP, window.innerWidth - w - PREVIEW_GAP)
    const above = anchor.top - h - PREVIEW_GAP
    const top = above > PREVIEW_GAP
      ? above
      : clamp(anchor.bottom + PREVIEW_GAP, PREVIEW_GAP, window.innerHeight - h - PREVIEW_GAP)
    return { top, left, width: w, height: h }
  })()

  return (
    <span
      ref={pillRef}
      className={`agent-img-pill${onClick ? ' clickable' : ''}`}
      onMouseEnter={src ? show : undefined}
      onMouseLeave={src ? hide : undefined}
      onClick={onClick}
      title={titleText ?? (onClick ? `${name}（${clickHint ?? '点击打开'}）` : name)}
    >
      <ImageIcon size={11} className="agent-img-pill-icon" />
      <span className="agent-img-pill-name">{name}</span>
      {onRemove && (
        <button type="button" className="agent-img-pill-remove" title="移除" disabled={removeDisabled}
          onClick={e => { e.stopPropagation(); onRemove() }}>
          <XIcon size={10} />
        </button>
      )}
      {src && card && createPortal(
        <div
          className="agent-img-pill-preview"
          style={{ top: card.top, left: card.left, width: card.width, height: card.height }}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <img src={src} alt={name} />
        </div>,
        document.body,
      )}
    </span>
  )
}
