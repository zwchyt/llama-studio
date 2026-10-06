// ══════════════════════════════════════════════════════════════════════════════
// 发送飞行（sendFlight）：用户气泡从输入框盒真伸缩飞进会话
// 移植自 E:\llama-studio\chat-anim-demo.html（STAGE 7r2），行为逐项对齐：
//   起点＝整个输入框盒（文字再少，起跑也是输入框宽度）→ 落点＝文字实际宽高
//   零渐变｜单 rAF 时钟｜落点精确＋错一帧交换｜滚动跟随补偿
// 与 demo 不同之处（刻意）：
//   - 假模型占位不搬：项目里助手占位与用户消息同 commit 挂载、随后真实流式，
//     用户气泡落点天然已是最终位置；流式增长只向下撑，不顶用户气泡。
//   - 文本/字体/圆角/边框/颜色全部实测，不猜主题变量。
// 失败策略：任何一步对不上就静默放弃，消息照常直接显示，绝不吞消息。
// ══════════════════════════════════════════════════════════════════════════════

const DUR = 900
const EASE_CSS = 'cubic-bezier(0.33, 1, 0.68, 1)'

function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const cx = 3 * p1x
  const bx = 3 * (p2x - p1x) - cx
  const ax = 1 - cx - bx
  const cy = 3 * p1y
  const by = 3 * (p2y - p1y) - cy
  const ay = 1 - cy - by
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  return (x: number): number => {
    let t = x
    for (let i = 0; i < 5; i++) {
      const err = sx(t) - x
      if (Math.abs(err) < 1e-4) break
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    return sy(t)
  }
}
const easeFlight = cubicBezier(0.33, 1, 0.68, 1)

type Rect = { left: number; top: number; width: number; height: number }

type FlightAnchor = {
  /** 新用户消息的 data-message-index（末条渲染行下标 + 1，续写行不渲染但占下标，防呆靠 role 校验） */
  expectedIndex: number
  /** 记录时的渲染行数：提交后行数没涨说明本次没上屏，留给下次 */
  rowsCount: number
  startR: Rect
  textStart: { left: number; top: number }
  oldTops: Map<Element, number>
  wasAtBottom: boolean
}

let anchor: FlightAnchor | null = null

const num = (v: string | null | undefined): number => parseFloat(v ?? '') || 0

function listEl(): HTMLElement | null {
  const scope = document.querySelector('.agent-code-view')
  const el = scope ? scope.querySelector('.chat-messages') : null
  return el instanceof HTMLElement ? el : null
}

/** 取 computed border-radius 单角（"8px" 或 "8px 8px"）拆成横/纵两项 */
function splitRadius(v: string): [string, string] {
  const p = v.trim().split(/\s+/)
  const h = p[0] || '0px'
  return [h, p[1] || h]
}

/**
 * handleSend 顶部同步调用：记录起跑快照。纯 DOM 读取，内部吞错，绝不影响发送。
 * 必须在输入框清空前执行（调用处保证为函数内第一批语句）。
 */
export function noteSendIntent(): void {
  try {
    const list = listEl()
    if (!list) return
    const scope = document.querySelector('.agent-code-view')
    const field = scope ? scope.querySelector('.chat-input-field') : null
    const ta = field ? field.querySelector('.chat-input') : null
    if (!(field instanceof HTMLElement) || !(ta instanceof HTMLTextAreaElement)) return
    const rows = Array.from(list.querySelectorAll('[data-slot="message"]'))
    const last = rows.length > 0 ? rows[rows.length - 1] : undefined
    const rawIdx = last ? last.getAttribute('data-message-index') : null
    const lastIdx = rawIdx == null ? -1 : Number(rawIdx)
    if (!Number.isFinite(lastIdx)) return
    const fr = field.getBoundingClientRect()
    if (fr.width < 2 || fr.height < 2) return
    const tr = ta.getBoundingClientRect()
    const ts = getComputedStyle(ta)
    const maxTop = list.scrollHeight - list.clientHeight
    anchor = {
      expectedIndex: lastIdx + 1,
      rowsCount: rows.length,
      startR: { left: fr.left, top: fr.top, width: fr.width, height: fr.height },
      textStart: { left: tr.left + num(ts.paddingLeft), top: tr.top + num(ts.paddingTop) },
      oldTops: new Map(rows.map((r) => [r, r.getBoundingClientRect().top] as [Element, number])),
      wasAtBottom: maxTop - list.scrollTop < 2,
    }
  } catch {
    anchor = null
  }
}

/** 旧行 FLIP：只动视口内的行，消息多时不爆合成层（已是 transform，零重排） */
function flipOldRows(list: HTMLElement, a: FlightAnchor): void {
  const view = list.getBoundingClientRect()
  a.oldTops.forEach((top0, el) => {
    if (!el.isConnected) return
    const nr = el.getBoundingClientRect()
    const d = top0 - nr.top
    if (!d) return
    if (nr.bottom < view.top || nr.top > view.bottom) return
    el.animate?.(
      [{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }],
      { duration: DUR, easing: EASE_CSS },
    )
  })
}

/**
 * Layout 的 useLayoutEffect 里调用（依赖消息数）：新行已挂载、绘制前执行飞行。
 * 行数没涨（本次发送没上屏，如排队/校验拦截）就把锚点留给下次；对不上就静默放弃。
 */
export function maybeRunSendFlight(): void {
  if (!anchor) return
  try {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      anchor = null
      return
    }
    const list = listEl()
    if (!list) return
    if (list.querySelectorAll('[data-slot="message"]').length <= anchor.rowsCount) return
    const a = anchor
    anchor = null
    const row = list.querySelector(`[data-slot="message"][data-message-index="${a.expectedIndex}"]`)
    if (!(row instanceof HTMLElement) || row.getAttribute('data-from') !== 'user') return
    const bubble = row.querySelector('.chat-msg-bubble')
    if (!(bubble instanceof HTMLElement)) return
    // 绘制前藏住真气泡（占位不占眼），后面只翻可见性
    bubble.style.visibility = 'hidden'
    // 贴底一次（与项目自身的贴底逻辑同值，幂等），后面量落点才准
    try {
      list.scrollTop = list.scrollHeight
    } catch {
      /* noop */
    }
    // 旧行顶位：只在本来就贴底时 FLIP（坐标系可比）；之前在上面看历史就让它正常贴底
    if (a.wasAtBottom) flipOldRows(list, a)
    requestAnimationFrame(() => {
      try {
        runFlight(a, list, bubble)
      } catch {
        bubble.style.visibility = ''
      }
    })
  } catch {
    /* 降级：最多就是没藏住，消息直接显示 */
  }
}

function runFlight(a: FlightAnchor, list: HTMLElement, bubble: HTMLElement): void {
  let done = false
  let safety = 0
  const flyers: HTMLElement[] = []
  const abort = (): void => {
    if (done) return
    done = true
    if (safety) window.clearTimeout(safety)
    for (const el of flyers) el.remove()
    if (bubble.isConnected) bubble.style.visibility = ''
  }
  safety = window.setTimeout(abort, DUR + 800)
  try {
    const to = bubble.getBoundingClientRect()
    if (to.width < 2 || to.height < 2) {
      abort()
      return
    }
    const cs = getComputedStyle(bubble)
    const padL = num(cs.borderLeftWidth) + num(cs.paddingLeft)
    const padT = num(cs.borderTopWidth) + num(cs.paddingTop)
    const padR = num(cs.borderRightWidth) + num(cs.paddingRight)
    const textSrc = bubble.querySelector('.user-plain-text')
    const text = textSrc?.textContent ?? bubble.textContent ?? ''
    const fs = textSrc ? getComputedStyle(textSrc) : cs
    const s = a.startR
    if (s.width < 2 || s.height < 2) {
      abort()
      return
    }
    const Wh = to.width
    const Hh = to.height
    const dx = to.left + Wh / 2 - (s.left + s.width / 2)
    const dy0 = to.top + Hh / 2 - (s.top + s.height / 2)
    const sx1 = Wh / s.width
    const sy1 = Hh / s.height
    // 外层缩放原点：结束时外层盒 == 家矩形（退化回退，避免除零）
    const Ox = Math.abs(1 - sx1) < 1e-4 ? 0 : (to.left - (s.left + dx)) / (1 - sx1)
    const Oy = Math.abs(1 - sy1) < 1e-4 ? 0 : (to.top - (s.top + dy0)) / (1 - sy1)

    const flyPos = document.createElement('div')
    flyPos.className = 'sendfly-pos'
    flyPos.style.left = `${s.left}px`
    flyPos.style.top = `${s.top}px`
    flyPos.style.width = `${s.width}px`
    flyPos.style.height = `${s.height}px`
    flyPos.style.transformOrigin = `${Ox}px ${Oy}px`
    const flyBox = document.createElement('div')
    flyBox.className = 'sendfly-box'
    // 颜色快照：飞行中切主题也不突变
    flyBox.style.background = cs.backgroundColor
    flyBox.style.borderColor = cs.borderColor
    // 边框基值实测＋圆角实测（补偿除数走变量，反算落点精确）
    flyBox.style.borderTopWidth = `calc(${cs.borderTopWidth || '0px'} / var(--sndfy, 1))`
    flyBox.style.borderBottomWidth = `calc(${cs.borderBottomWidth || '0px'} / var(--sndfy, 1))`
    flyBox.style.borderLeftWidth = `calc(${cs.borderLeftWidth || '0px'} / var(--sndfx, 1))`
    flyBox.style.borderRightWidth = `calc(${cs.borderRightWidth || '0px'} / var(--sndfx, 1))`
    const [tlh, tlv] = splitRadius(cs.borderTopLeftRadius)
    const [trh, trv] = splitRadius(cs.borderTopRightRadius)
    const [brh, brv] = splitRadius(cs.borderBottomRightRadius)
    const [blh, blv] = splitRadius(cs.borderBottomLeftRadius)
    flyBox.style.borderTopLeftRadius = `calc(${tlh} / var(--sndfx, 1)) calc(${tlv} / var(--sndfy, 1))`
    flyBox.style.borderTopRightRadius = `calc(${trh} / var(--sndfx, 1)) calc(${trv} / var(--sndfy, 1))`
    flyBox.style.borderBottomRightRadius = `calc(${brh} / var(--sndfx, 1)) calc(${brv} / var(--sndfy, 1))`
    flyBox.style.borderBottomLeftRadius = `calc(${blh} / var(--sndfx, 1)) calc(${blv} / var(--sndfy, 1))`
    // 文字层：宽度一生下来就是落位宽度，途中只跟飞，自己不换行不重排不虚化
    const homeContentW = Math.max(Wh - padL - padR, 0)
    const flyText = document.createElement('div')
    flyText.className = 'sendfly-text'
    flyText.style.width = `${homeContentW}px`
    flyText.style.fontSize = fs.fontSize
    flyText.style.lineHeight = fs.lineHeight
    flyText.style.fontFamily = fs.fontFamily
    flyText.style.fontWeight = fs.fontWeight
    flyText.style.letterSpacing = fs.letterSpacing
    flyText.style.color = fs.color
    flyText.textContent = text
    // 文字静态位：右偏与家一致；P0y 取近似居中即可，反缩放数学对任意 P0 精确自洽
    const P0x = s.width - homeContentW - padR
    const P0y = s.height / 2 - 10
    flyText.style.left = `${P0x}px`
    flyText.style.top = `${P0y}px`
    flyPos.appendChild(flyBox)
    flyPos.appendChild(flyText)
    document.body.appendChild(flyPos)
    flyers.push(flyPos)
    // 阴影层：从第一帧就是家尺寸家阴影（快照），只做位移——合成器驱动零滞后，
    // 起点与外层同中心，落点精确，不变形
    const flyShadow = document.createElement('div')
    flyShadow.className = 'sendfly-shadow'
    flyShadow.style.left = `${to.left - dx}px`
    flyShadow.style.top = `${to.top - dy0}px`
    flyShadow.style.width = `${Wh}px`
    flyShadow.style.height = `${Hh}px`
    flyShadow.style.boxShadow = cs.boxShadow
    flyShadow.style.borderRadius = cs.borderRadius
    document.body.appendChild(flyShadow)
    flyers.push(flyShadow)

    const baseScroll = list.scrollTop
    const t0 = performance.now()
    // 变量节流：scale 变化 < 0.008 不写样式（边框差 < 0.1px，不可见），落点帧强制精确
    let lastSx = -1
    let lastSy = -1
    const frame = (now: number): void => {
      if (done) return
      const t = Math.min((now - t0) / DUR, 1)
      const k = easeFlight(t)
      // 流式/手动滚动跟随：落点随内容走，旧行 FLIP 是相对位移不受影响
      const sh = list.scrollTop - baseScroll
      const dyk = dy0 - sh
      const toy = to.top - sh
      const sx = 1 + (sx1 - 1) * k
      const sy = 1 + (sy1 - 1) * k
      flyPos.style.transform = `translate(${(dx * k).toFixed(2)}px, ${(dyk * k).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      if (t >= 1 || Math.abs(sx - lastSx) >= 0.008 || Math.abs(sy - lastSy) >= 0.008) {
        flyBox.style.setProperty('--sndfx', sx.toFixed(4))
        flyBox.style.setProperty('--sndfy', sy.toFixed(4))
        lastSx = sx
        lastSy = sy
      }
      // 阴影与外层同位移（中心重合，位移量天然一致），无缩放无变形，合成器同拍
      flyShadow.style.transform = `translate(${(dx * k).toFixed(2)}px, ${(dyk * k).toFixed(2)}px)`
      // 文字到期位置 L(k)，自身反缩放抵消外层缩放（净零缩放，数学精确）
      const Lx = a.textStart.left + (to.left + padL - a.textStart.left) * k
      const Ly = a.textStart.top + (toy + padT - a.textStart.top) * k
      const qx = s.left + Ox + (P0x - Ox) * sx + dx * k
      const qy = s.top + Oy + (P0y - Oy) * sy + dyk * k
      const ux = (Lx - qx) / sx
      const uy = (Ly - qy) / sy
      flyText.style.transform = `translate(${ux.toFixed(2)}px, ${uy.toFixed(2)}px) scale(${(1 / sx).toFixed(4)}, ${(1 / sy).toFixed(4)})`
      if (t < 1) {
        requestAnimationFrame(frame)
      } else {
        // 落点：先显真气泡，下一帧再撤飞行层，消除一帧闪白
        bubble.style.visibility = ''
        requestAnimationFrame(() => {
          for (const el of flyers) el.remove()
          done = true
          window.clearTimeout(safety)
        })
      }
    }
    requestAnimationFrame(frame)
  } catch {
    abort()
  }
}
