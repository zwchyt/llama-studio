import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Download,
  Copy,
  Check,
  Maximize2,
  X,
  // 注意：这个版本的 lucide-react（0.400.0）里没有 `Code2`，导出名是 `CodeXml`。
  // 写 Code2 会在运行时拿到 undefined，React 直接抛「Element type is invalid」。
  CodeXml,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react'
import { copyToClipboard, downloadSvg, toSvgDataUri } from './serializeSvg'
import './figure.css'

/**
 * 图形卡片外壳：标题 + 工具条 + 画布 + 源码面板 + 放大层。
 *
 * SvgCard（```svg 围栏）和 ChartCard（Recharts）共用这一层，两者的差异被收敛成
 * 两个回调 —— 它们要的东西**不是同一份**，混在一起会出错：
 *   - getSvgSource：**真 SVG**，只服务「下载 .svg」与放大层（放大层是 <img>，
 *     没有命名空间/真实尺寸就不是一张图，不能拿 JSON 去顶）。
 *     SvgCard 直接返回模型给的源码；ChartCard 必须序列化 DOM 里活的 <svg>。
 *   - getSourceText（可选）：**可读源码**，服务源码面板与「复制」。
 *     围栏路径下就是模型原文（```chart 是那段 JSON、```svg 是 SVG 本身），
 *     jsonui 路径没有原文时才回落到 getSvgSource。
 *
 * 所以新增图形类型时仍然不必再改本文件：把两个回调接上即可。
 *
 * 画布底色**没有**卡片级的开关：早先这里有一个「背景切换」按钮（跟随主题 /
 * 白底 / 深底），后来去掉了 —— 应用本身已经有主题开关，卡片再挂一个等于两个
 * 入口抢同一件事，用户还会看到「应用浅色 + 卡片深底」这种自相矛盾的组合。
 * 现在底色一律跟随主题（见 themeCanvas），深色下的可见性由 CSS 反相负责。
 */

const MIN_SCALE = 0.2
const MAX_SCALE = 8

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type FigureFrameProps = {
  title?: string | null
  /**
   * 取**真 SVG**（下载 .svg 与放大层用）。
   * **必须用 useCallback 保持引用稳定**，否则每次渲染都会重新序列化。
   */
  getSvgSource?: () => string | null
  /**
   * 取**可读源码**（源码面板与「复制」用）。省略时回落到 getSvgSource。
   * 围栏路径（```chart / ```json）要传模型原文，否则面板里会显示序列化出来的 SVG，
   * 用户会以为「我的 JSON 被改写成 SVG 了」。
   */
  getSourceText?: () => string | null
  /** 下载文件名（不含扩展名） */
  fileName?: string
  /**
   * 深色主题下要不要把图形反相（invert(1) hue-rotate(180deg)）。
   *
   * 只有 SvgCard 该开：模型写的 SVG 用字面颜色画图（黑线、透明/白底），
   * 我们拿不到它的语义，深色主题下只能靠反相近似地把它翻成「浅色线条」。
   * ChartCard 必须**不**开 —— 它的颜色本来就是主题变量（var(--rc-cN)），
   * 已经跟着主题走了，再翻一次只会把适配好的配色翻坏。
   */
  invertible?: boolean
  /**
   * 画布的底色。两张卡片的诉求正好相反：
   *   - SvgCard  → 模型写的 SVG 用字面颜色画图、默认假定「白底黑字」，
   *                我们拿不到它的语义，只能在下面垫一层底。它传的是
   *                `var(--svg-canvas, var(--surface))`，而 --svg-canvas 在
   *                两个主题里都取 --surface：底色与卡片同色 → 不出现
   *                「灰卡片套白框」的内框；深色下「看不看得见」交给反相
   *                （见 invertible），而不是靠垫一层白底。
   *   - ChartCard → 图表配色本身就是主题色（var(--rc-cN)），既不需要垫白
   *                也不需要反相，用默认值 `var(--surface)` 即可。
   * 放大层里这张图是浮在深色遮罩上的，所以这里不能给透明值，
   * 否则浅色主题下深色图形会消失在遮罩里 —— 默认值给 --surface 正是为此。
   */
  themeCanvas?: string
  /**
   * 是否提供「放大查看」按钮。默认 true（SvgCard 与直连的 ```chart 围栏照常）。
   * jsonui 路径传 false：工具条只保留 复制 / 下载 / 查看源码。
   * 放大层只能从这个按钮打开，隐藏按钮后其余缩放逻辑自然不可达。
   */
  zoomable?: boolean
  children: ReactNode
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`fig-btn${active ? ' fig-btn--on' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function FigureFrame({
  title,
  getSvgSource,
  getSourceText,
  fileName,
  invertible,
  themeCanvas = 'var(--surface)',
  zoomable = true,
  children,
}: FigureFrameProps) {
  const [showSource, setShowSource] = useState(false)
  /**
   * 两份「源码」分开存，它们回答的是不同问题：
   *   · svgSource  → 怎么把这张图**存成文件 / 放大看**（必须是真 SVG）
   *   · sourceText → 用户点「查看源码」时他想看的**原文**（图表就是那段 JSON）
   * 合用一个 state 时，```chart / ```json 卡片的面板里会显示序列化出来的 SVG。
   */
  const [svgSource, setSvgSource] = useState<string | null>(null)
  const [sourceText, setSourceText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [notice, setNotice] = useState<string | null>(null)

  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const copiedTimer = useRef<number | null>(null)

  const flash = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200)
  }, [])

  /**
   * 读一次两份源码并缓存进 state。取不到（例如图表懒 chunk 还没到位）返回 null。
   * text 拿不到时回落到 svg —— 面板宁可显示 SVG 也不能空着。
   */
  const readSources = useCallback((): { svg: string | null; text: string | null } => {
    let svg: string | null = null
    try {
      svg = getSvgSource?.() ?? null
    } catch {
      svg = null
    }
    let text: string | null = svg
    if (getSourceText) {
      try {
        text = getSourceText() ?? svg
      } catch {
        text = svg
      }
    }
    setSvgSource(svg)
    setSourceText(text)
    return { svg, text }
  }, [getSvgSource, getSourceText])

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    }
  }, [])

  const onDownload = () => {
    // 下载要的是真 SVG：拿模型原文（JSON）存成 .svg 会得到一个打不开的文件。
    const { svg } = readSources()
    if (!svg) return flash('图形尚未就绪，稍后再试')
    downloadSvg(fileName || title || 'figure', svg)
  }

  const onCopy = async () => {
    // 复制跟面板同源：用户想带走的是「这段图表的代码」，图表就是那段 JSON。
    const { text } = readSources()
    if (!text) return flash('图形尚未就绪，稍后再试')
    const ok = await copyToClipboard(text)
    if (!ok) return flash('复制失败，可展开源码手动选中')
    setCopied(true)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  const onToggleSource = () => {
    const next = !showSource
    setShowSource(next)
    if (next) readSources()
  }

  const onOpenZoom = () => {
    const { svg } = readSources()
    if (!svg) return flash('图形尚未就绪，稍后再试')
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setZoom(true)
  }

  // 放大层：滚轮缩放。React 的 onWheel 在根容器上是 passive 的，
  // preventDefault 会被忽略（滚轮会连带滚动背景），所以必须手挂非 passive 监听。
  useEffect(() => {
    if (!zoom) return
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => clamp(s * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_SCALE, MAX_SCALE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])

  // 放大层：Esc 关闭
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  // 拖拽的监听挂在放大层的 stage（底色 + 位移都在它身上），不是挂在 img 上 ——
  // 反相滤镜作用于 img，位移与底色若也放在 img，底色会被一起翻掉。
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // 底色只能内联给：它要按卡片类型取值（见 themeCanvas 的注释），
  // CSS 类无法反过来去问调用方。值是 var()，由浏览器在运行时按当前主题解析，
  // 所以切主题不需要任何 JS 参与 —— 这个内联样式不必随主题重算。
  const canvasStyle: CSSProperties = { background: themeCanvas }

  // fig-invertible 是反相规则的唯一锚点（见 figure.css）：卡片画布与放大层的
  // stage 共用它，两处观感因此永远一致。ChartCard 不传 invertible，
  // 于是它既不会被反相，也不会命中那条规则。
  const invertClass = invertible ? ' fig-invertible' : ''

  // data URI 只在 svgSource 变化时算一次。放大层每次拖拽（pointermove）都会重渲染，
  // 而序列化出来的图表 SVG 动辄几万字符 —— 每帧都重新 encodeURIComponent 一遍
  // 会让拖拽明显发卡，所以在这里缓存住。
  const zoomUri = useMemo(() => (svgSource ? toSvgDataUri(svgSource) : ''), [svgSource])

  return (
    <div className="fig-card">
      <div className="fig-head">
        <div className="fig-title">{title ?? ''}</div>
        <div className={`fig-tools${showSource || copied ? ' fig-tools--pinned' : ''}`}>
          <ToolButton label={copied ? '已复制' : '复制源码'} onClick={onCopy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </ToolButton>
          <ToolButton label="下载 .svg" onClick={onDownload}>
            <Download size={13} />
          </ToolButton>
          <ToolButton label={showSource ? '收起源码' : '查看源码'} active={showSource} onClick={onToggleSource}>
            <CodeXml size={13} />
          </ToolButton>
          {zoomable ? (
            <ToolButton label="放大查看" onClick={onOpenZoom}>
              <Maximize2 size={13} />
            </ToolButton>
          ) : null}
        </div>
      </div>

      <div className={`fig-canvas${invertClass}`} style={canvasStyle}>
        {children}
      </div>

      {notice ? <div className="fig-notice">{notice}</div> : null}

      {showSource ? (
        <pre className="fig-source" aria-label="源码">
          <code>{sourceText ?? '（源码暂不可用）'}</code>
        </pre>
      ) : null}

      {zoom && svgSource
        ? createPortal(
            <div
              ref={overlayRef}
              className="fig-zoom"
              onClick={() => setZoom(false)}
              role="dialog"
              aria-modal="true"
              aria-label="放大查看"
            >
              <div className="fig-zoom-bar" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="fig-btn" title="缩小" aria-label="缩小" onClick={() => setScale((s) => clamp(s / 1.25, MIN_SCALE, MAX_SCALE))}>
                  <ZoomOut size={14} />
                </button>
                <span className="fig-zoom-pct">{Math.round(scale * 100)}%</span>
                <button type="button" className="fig-btn" title="放大" aria-label="放大" onClick={() => setScale((s) => clamp(s * 1.25, MIN_SCALE, MAX_SCALE))}>
                  <ZoomIn size={14} />
                </button>
                <button
                  type="button"
                  className="fig-btn"
                  title="重置"
                  aria-label="重置"
                  onClick={() => {
                    setScale(1)
                    setOffset({ x: 0, y: 0 })
                  }}
                >
                  <RotateCcw size={14} />
                </button>
                <button type="button" className="fig-btn" title="关闭 (Esc)" aria-label="关闭" onClick={() => setZoom(false)}>
                  <X size={14} />
                </button>
              </div>
              {/* 底色 + 位移 + 拖拽都在 stage 上，img 只负责「被反相」。
                  两者合在一个元素上时，反相会把底色一起翻掉（深底变浅底），
                  浅色图形就落在浅色底上消失了。 */}
              <div
                className={`fig-zoom-stage${invertClass}`}
                style={{
                  ...canvasStyle,
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <img
                  className="fig-zoom-img"
                  src={zoomUri}
                  alt={title || '图形'}
                  draggable={false}
                />
              </div>
              <div className="fig-zoom-hint">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export default FigureFrame
