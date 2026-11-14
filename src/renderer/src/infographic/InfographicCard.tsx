import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ensureSvgNamespace } from '../figure/serializeSvg'
import { FigureFrame } from '../figure/FigureFrame'

/**
 * Infographic 卡片：把 AntV Infographic DSL（缩进式文本语法）渲染成信息图。
 *
 * 与 MermaidCard / SvgCard 的降级策略一致：渲染失败一律交给调用方的
 * renderFallback 渲染成普通代码块；调用方没给 fallback（测试页直连）时
 * 显示一条行内错误提示，因为测试页需要看得见的失败反馈。
 *
 * 为什么用动态 import：@antv/infographic 拖着一串重依赖（d3、@antv/layout、
 * roughjs…），静态引入会把它拉进引用方 chunk。模块级缓存加载 Promise，
 * 多实例共享同一次加载（与 MermaidCard 的 getMermaid 同一路数）。
 *
 * 卡片外壳（标题 / 工具条 / 放大层 / 源码面板）全部由 FigureFrame 提供；
 * 「下载 .svg」的 SVG 从渲染容器里现场提取（库渲染完会在容器里落一个 <svg>），
 * 补 xmlns 保证存下来的文件是独立文档。深浅色：库自带 theme 配置项，
 * 当前用默认主题（测试页以浅色面板为主），深色适配待实测后再接。
 */

type InfographicModule = typeof import('@antv/infographic')

export type InfographicCardProps = {
  code?: string | null
  title?: string | null
  /**
   * 固定渲染高度（px）。不传则容器自动高度（测试页全尺寸预览）。
   * 模板是竖版海报构图（原始画布约 240×425），聊天区不传这个值时图会按
   * 容器宽度等比放大到上千 px 高、占满整屏；会话里传一个封顶值（如 420），
   * SVG 按 viewBox 默认的等比缩进（meet）完整显示在框内。
   */
  height?: number
  renderFallback?: (code: string) => ReactNode
}

let infographicImportPromise: Promise<InfographicModule> | null = null

function getInfographic(): Promise<InfographicModule> {
  if (!infographicImportPromise) {
    infographicImportPromise = import('@antv/infographic').catch((error) => {
      infographicImportPromise = null
      throw error
    })
  }
  return infographicImportPromise
}

/** 创建实例并渲染，失败返回 null（不抛出）。供卡片与放大舞台共用。 */
async function createAndRender(
  container: HTMLElement,
  code: string,
  width: number | string,
  height: number | string
): Promise<InstanceType<InfographicModule['Infographic']> | null> {
  const { Infographic } = await getInfographic()
  const instance = new Infographic({ container, width, height })
  try {
    instance.render(code)
    return instance
  } catch (error) {
    try { instance.destroy() } catch { /* 忽略销毁失败 */ }
    throw error
  }
}

/**
 * 放大层的独立渲染舞台。
 *
 * FigureFrame 打开放大层时会把 zoomFigure 在弹窗里重新挂载一份 —— 命令式实例
 * 绑在卡片内的容器上，放大层必须给一份**独立实例**（自己的 ref、自己的引擎实例），
 * 否则放大层是空容器、且关闭时 ref 置空会弄丢卡片那份的容器引用
 * （与 ChartCard 传独立 zoomFigure 是同一个契约，见 FigureFrame 第 100-104 行注释）。
 * 舞台尺寸由 FigureFrame 按卡片原图测量后给定，这里填满它即可。
 * 引擎已模块级缓存，开销只有一次实例化；卸载即销毁。
 */
function InfographicZoomStage({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    let cancelled = false
    let instance: InstanceType<InfographicModule['Infographic']> | null = null
    void (async () => {
      try {
        if (cancelled || !ref.current) return
        instance = await createAndRender(ref.current, code, '100%', '100%')
        if (cancelled && instance) { instance.destroy(); instance = null }
      } catch { /* 放大层渲染失败就留白：按钮只在卡片渲染成功后可见，此处极难触发 */ }
    })()
    return () => {
      cancelled = true
      try { instance?.destroy() } catch { /* 已销毁则忽略 */ }
    }
  }, [code])
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />
}

export function InfographicCard({ code, title, height, renderFallback }: InfographicCardProps) {
  const source = typeof code === 'string' ? code.trim() : ''
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 失败锁存：DSL 语法错误或库加载失败时置位；源码变化时由调用方用 key 重挂载复位
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    let instance: InstanceType<InfographicModule['Infographic']> | null = null
    setFailed(false)
    void (async () => {
      try {
        if (!containerRef.current) return
        instance = await createAndRender(containerRef.current, source, '100%', height ?? '100%')
        if (cancelled && instance) { instance.destroy(); instance = null }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      try { instance?.destroy() } catch { /* 已销毁则忽略 */ }
    }
  }, [source])

  /** 提取渲染产物里的真 SVG（服务「下载 .svg」）。FigureFrame 按需调用，
      引用必须稳定（useCallback），否则每次渲染都重新建函数。 */
  const getSvgSource = useCallback((): string | null => {
    const el = containerRef.current
    if (!el) return null
    const svg = el.querySelector('svg')
    if (!svg) return null
    return ensureSvgNamespace(svg.outerHTML)
  }, [source])

  /** 源码面板 / 复制按钮展示 DSL 原文，而不是渲染出的 SVG */
  const getSourceText = useCallback((): string | null => (source || null), [source])

  if (!source) return null

  if (failed) {
    if (renderFallback) return <>{renderFallback(source)}</>
    return (
      <div style={{
        padding: 12, fontSize: 12, color: 'var(--danger, #dc2626)',
        border: '1px dashed var(--border, #d1d5db)', borderRadius: 8,
      }}>
        Infographic 渲染失败：请检查 DSL 语法（第一行是模板名，例如
        <code> infographic list-row-simple-horizontal-arrow</code>，缩进表示层级）。
      </div>
    )
  }

  const fileName = typeof title === 'string' && title ? title : 'infographic'

  return (
    <FigureFrame
      title={title ?? null}
      getSvgSource={getSvgSource}
      getSourceText={getSourceText}
      fileName={fileName}
      // 放大层给独立舞台实例（命令式渲染必须传，见 InfographicZoomStage 的注释）
      zoomFigure={source ? <InfographicZoomStage code={source} /> : null}
      // 不开 invertible：库有自己的配色体系（同 ChartCard 的理由，反相只会翻坏配色）
    >
      <div
        ref={containerRef}
        style={height ? { width: '100%', height } : { width: '100%', minHeight: 240 }}
      />
    </FigureFrame>
  )
}

export default InfographicCard
