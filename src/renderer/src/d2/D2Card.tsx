import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ensureSvgNamespace, toSvgDataUri } from '../figure/serializeSvg'
import { FigureFrame } from '../figure/FigureFrame'

/**
 * D2 卡片：把 D2 图表语言（d2lang.com）的源码渲染成 SVG 图。
 *
 * 与 MermaidCard 的形态同类（异步源码 → SVG 字符串），但产物是**自包含 SVG**
 * （实测无 <script>、无外部资源引用），所以展示走 `<img src="data:...">`
 * 的沙箱路线（与 SvgCard 相同）——纯声明式，FigureFrame 的放大层直接复用
 * children 即可，不需要 InfographicCard 那种独立 zoomFigure 舞台。
 *
 * 为什么渲染在主进程执行（window.api.renderD2）：D2 的 WASM 运行时（wasm_exec）
 * 会把字符串当 JS 执行，渲染进程的 CSP 刻意不放行 'unsafe-eval'（Electron 安全
 * 检查明令反对），Worker 链路必被拦——实测症状就是永远卡在「编译中」或报
 * CSP 违例。主进程是 Node 环境、无 CSP 约束，且 D2 类内部自带 Worker 线程，
 * 不会阻塞主进程事件循环。渲染进程也因此不引入 8.2MB 的引擎构建。
 *
 * 降级策略与 MermaidCard / InfographicCard 一致：编译或渲染失败交给调用方的
 * renderFallback 渲染成普通代码块；调用方没给 fallback（测试页直连）时显示
 * 行内错误提示（含底层错误详情）。
 */

export type D2CardProps = {
  code?: string | null
  title?: string | null
  /**
   * 固定渲染高度（px）。不传则容器自动高度（测试页全尺寸预览）。
   * D2 图的宽高随内容走、可能很高，会话里传封顶值让 SVG 等比缩进框内。
   */
  height?: number
  renderFallback?: (code: string) => ReactNode
}

export function D2Card({ code, title, height, renderFallback }: D2CardProps) {
  const source = typeof code === 'string' ? code.trim() : ''
  // 渲染结果与失败锁存：源码变化时由调用方用 key 重挂载复位
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  // 竞态守卫：源码快速变化时旧渲染的结果不得覆盖新状态（参照 MermaidCard）
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!source) return
    const id = ++requestIdRef.current
    setFailed(false)
    setErrMsg('')
    setSvg(null)
    void (async () => {
      try {
        const res = await window.api.renderD2(source)
        if (requestIdRef.current !== id) return // 已有更新的渲染在跑，丢弃旧结果
        if (res.error) throw new Error(res.error)
        const out = res.svg
        if (typeof out !== 'string' || !out.includes('<svg')) throw new Error('D2 输出为空')
        setSvg(out)
      } catch (error) {
        // 失败原因必须可见可查：引擎链路（加载/Worker/WASM/编译）任何一环出错都在这里现形
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[D2Card] D2 渲染失败:', msg)
        if (requestIdRef.current === id) { setErrMsg(msg); setFailed(true) }
      }
    })()
  }, [source])

  /** 下载用的真 SVG。FigureFrame 按需调用，引用必须稳定。 */
  const getSvgSource = useCallback((): string | null => (svg ? ensureSvgNamespace(svg) : null), [svg])

  /** 源码面板 / 复制按钮展示 D2 源码原文 */
  const getSourceText = useCallback((): string | null => (source || null), [source])

  if (!source) return null

  if (failed) {
    if (renderFallback) return <>{renderFallback(source)}</>
    return (
      <div style={{
        padding: 12, fontSize: 12, color: 'var(--danger, #dc2626)',
        border: '1px dashed var(--border, #d1d5db)', borderRadius: 8,
      }}>
        <div>D2 渲染失败：请检查 D2 源码语法（例如 <code>x -&gt; y: 标签</code> 的箭头与连接写法）。</div>
        {errMsg ? <div style={{ marginTop: 6, fontFamily: 'monospace', wordBreak: 'break-all' }}>错误详情：{errMsg}</div> : null}
      </div>
    )
  }

  const fileName = typeof title === 'string' && title ? title : 'd2'

  return (
    <FigureFrame
      title={title ?? null}
      getSvgSource={getSvgSource}
      getSourceText={getSourceText}
      fileName={fileName}
      // 不开 invertible：D2 输出自带配色主题（同 ChartCard 的理由）
    >
      <div style={height
        ? { width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
        : { width: '100%', minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {svg ? (
          <img
            src={toSvgDataUri(svg)}
            alt={typeof title === 'string' && title ? title.slice(0, 80) : 'D2 图'}
            draggable={false}
            // 放大层（FigureFrame）靠 pointermove 平移，img 原生拖拽会打断它（同 SvgCard）
            style={{
              maxWidth: '100%',
              maxHeight: height ? '100%' : undefined,
              objectFit: 'contain',
            }}
          />
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>D2 引擎编译中…</div>
        )}
      </div>
    </FigureFrame>
  )
}

export default D2Card
