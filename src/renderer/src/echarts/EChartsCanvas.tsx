/**
 * ECharts 渲染核心。
 *
 * 这是整个项目里唯一静态 `import 'echarts'` 的地方：ECharts 全量包体积大，
 * 由 EChartsCard 用 React.lazy 引入，聊天首屏/应用启动都不加载它。
 *
 * 主实例用 canvas renderer（默认）——PNG 导出可直接 `getDataURL({type:'png'})`。
 * SVG 导出需要另一个 svg renderer 的离屏实例（canvas 实例没有 renderToSVGString），
 * 渲染同一份 option 取字符串，用完 dispose。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { useThemeStore } from '../store/themeStore'

export type EChartsCanvasHandle = {
  /** 导出 SVG 源码（离屏 svg 实例渲染）；拿不到返回 null */
  getSvgString: () => string | null
  /** 导出 PNG data URL（主 canvas 实例）；拿不到返回 null */
  getPngDataUrl: () => string | null
}

type Props = {
  code: string
  height: number
}

type OptionArg = Parameters<echarts.EChartsType['setOption']>[0]

function parseOption(code: string): OptionArg | null {
  try {
    const v: unknown = JSON.parse(code)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as OptionArg
  } catch {
    /* 不是合法 JSON，交给调用方的 renderFallback */
  }
  return null
}

const EChartsCanvas = forwardRef<EChartsCanvasHandle, Props>(function EChartsCanvas({ code, height }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)
  const optionRef = useRef<OptionArg | null>(null)
  const isDark = useThemeStore((s) => s.theme === 'dark')
  const isDarkRef = useRef(isDark)
  isDarkRef.current = isDark
  const [error, setError] = useState<string | null>(null)

  // 主题变化时 setTheme 只能在 init 时指定，所以重建实例。
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    let chart: echarts.EChartsType
    try {
      // 不传 width/height：让 zrender 从容器读实际尺寸。传固定值会把尺寸钉进
      // zrender 的 opts，之后 chart.resize() 即使不传参也读到旧值，图表就不会
      // 跟随容器/窗口缩放。首次挂载容器可能 0 尺寸，ResizeObserver 随后会 resize 修正。
      chart = echarts.init(el, isDark ? 'dark' : undefined, {
        renderer: 'canvas',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    chartRef.current = chart
    // 同一帧内的多次尺寸变化只 resize 一次，避免拖拽窗口时反复重绘。
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => chart.resize())
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      chart.dispose()
      chartRef.current = null
    }
  }, [isDark, height])

  // option 变化：解析并 setOption；写错只提示，保留上一张图（不 clear）。
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const option = parseOption(code)
    if (!option) {
      setError('ECharts option 必须是顶层 JSON 对象')
      return
    }
    optionRef.current = option
    try {
      chart.setOption({ backgroundColor: 'transparent', ...option } as OptionArg, true)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [code, isDark])

  useImperativeHandle(ref, () => ({
    getSvgString() {
      const option = optionRef.current
      if (!option) return null
      const w = chartRef.current?.getWidth() || 640
      const h = chartRef.current?.getHeight() || height
      const el = document.createElement('div')
      let off: echarts.EChartsType | null = null
      try {
        off = echarts.init(el, isDarkRef.current ? 'dark' : undefined, {
          renderer: 'svg',
          width: w,
          height: h,
        })
        off.setOption({ backgroundColor: 'transparent', ...option } as OptionArg, true)
        return off.renderToSVGString()
      } catch {
        return null
      } finally {
        off?.dispose()
      }
    },
    getPngDataUrl() {
      try {
        return chartRef.current?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: 'transparent' }) ?? null
      } catch {
        return null
      }
    },
  }), [height])

  return (
    <div ref={elRef} style={{ width: '100%', height, position: 'relative' }}>
      {error ? (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 12, color: 'var(--danger, #dc2626)', fontSize: 12, whiteSpace: 'pre-wrap', textAlign: 'center',
        }}>
          {error}
        </div>
      ) : null}
    </div>
  )
})

export default EChartsCanvas
