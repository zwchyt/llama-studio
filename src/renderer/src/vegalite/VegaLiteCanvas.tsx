/**
 * Vega-Lite 渲染核心。
 *
 * 唯一静态引入 vega 系列的地方（vega-embed / vega / vega-lite 合计约 10 MB），
 * 由 VegaLiteCard 用 React.lazy 引入，聊天首屏/应用启动都不加载。
 * 用 vega-embed 的 embed() 渲染，关闭它自带的 actions 工具条（外壳用 FigureFrame）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { expressionInterpreter } from 'vega-interpreter'
import { useThemeStore } from '../store/themeStore'

type VegaView = Awaited<ReturnType<typeof import('vega-embed')['default']>>['view']

export type VegaLiteCanvasHandle = {
  getSvgString: () => string | null
  getPngDataUrl: () => string | null
}

type Props = {
  code: string
  width: number
  height: number
}

function parseSpec(code: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(code)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const VegaLiteCanvas = forwardRef<VegaLiteCanvasHandle, Props>(function VegaLiteCanvas({ code, width, height }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<VegaView | null>(null)
  const svgRef = useRef<string | null>(null)
  const pngRef = useRef<string | null>(null)
  const isDark = useThemeStore((s) => s.theme === 'dark')
  const [error, setError] = useState<string | null>(null)

  const refreshExports = useCallback(async (v: VegaView) => {
    try {
      svgRef.current = await v.toSVG()
    } catch {
      svgRef.current = null
    }
    try {
      const canvas = await v.toCanvas(2)
      pngRef.current = canvas.toDataURL('image/png')
    } catch {
      pngRef.current = null
    }
  }, [])

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    let disposed = false
    let currentView: VegaView | null = null

    void (async () => {
      try {
        const { default: embed } = await import('vega-embed')
        const spec = parseSpec(code)
        if (!spec) {
          if (!disposed) setError('Vega-Lite spec 必须是顶层 JSON 对象')
          return
        }
        // 用 container 宽度让 canvas 跟随 FigureFrame 画布（框框）的大小，
        // 面板/窗口缩放时图表跟着变。spec 显式指定 width 时尊重它。
        const finalSpec: Record<string, unknown> = {
          width: spec.width ?? 'container',
          height: spec.height ?? height,
          ...spec,
        }
        const result = await embed(el, finalSpec as never, {
          actions: false,
          renderer: 'canvas',
          theme: isDark ? 'dark' : undefined,
          // 用 AST 解释器代替默认的 new Function，避免触发 CSP 的 unsafe-eval 拦截。
          ast: true,
          expr: expressionInterpreter,
        })
        if (disposed) {
          result.view.finalize()
          return
        }
        currentView = result.view
        viewRef.current = result.view
        await refreshExports(result.view)
        if (!disposed) setError(null)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      viewRef.current = null
      svgRef.current = null
      pngRef.current = null
      currentView?.finalize()
    }
  }, [code, width, height, isDark, refreshExports])

  useImperativeHandle(ref, () => ({
    getSvgString: () => svgRef.current,
    getPngDataUrl: () => pngRef.current,
  }), [])

  // 根 div 填满 FigureFrame 画布并跟随其宽度；min-width:0 防止 vega 的绝对宽度
  // canvas 把 flex item 撑破（否则 width:100% 失效、图表跑出框框）。
  return (
    <div className="vl-canvas" style={{ width: '100%', position: 'relative', minWidth: 0 }}>
      <style>{`.vl-canvas .vega-embed { max-width: 100% !important; } .vl-canvas canvas, .vl-canvas svg { max-width: 100% !important; }`}</style>
      <div ref={elRef} style={{ width: '100%', minWidth: 0, minHeight: height }} />
      {error ? (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 12, color: 'var(--danger, #dc2626)', fontSize: 12, whiteSpace: 'pre-wrap', textAlign: 'center',
          background: 'var(--surface)',
        }}>
          {error}
        </div>
      ) : null}
    </div>
  )
})

export default VegaLiteCanvas
