/**
 * ECharts 卡片外壳。
 *
 * 与 ChartCard / SvgCard 同款：FigureFrame 提供标题、复制源码、下载 .svg / .png、
 * 查看源码、放大查看；渲染核心在 EChartsCanvas（懒加载，避免首屏背 echarts）。
 */
import { Suspense, lazy, useCallback, useRef, type ReactNode } from 'react'
import { FigureFrame } from '../figure/FigureFrame'
import type { EChartsCanvasHandle } from './EChartsCanvas'

const EChartsCanvas = lazy(() => import('./EChartsCanvas'))

type Props = {
  code: string
  title?: string | null
  height?: number
  renderFallback?: (code: string) => ReactNode
}

function parseOption(code: string): boolean {
  try {
    const v: unknown = JSON.parse(code)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false
  }
}

export function EChartsCard({ code, title, height = 320, renderFallback }: Props) {
  const mainRef = useRef<EChartsCanvasHandle | null>(null)
  // 回调必须引用稳定（FigureFrame 直接拿它当依赖读源码），不要内联重算。
  const getSvgSource = useCallback(() => mainRef.current?.getSvgString() ?? null, [])
  const getPngSource = useCallback(() => mainRef.current?.getPngDataUrl() ?? null, [])
  const getSourceText = useCallback(() => code, [code])

  // 源码不是合法 option：写错时降级为代码块，而不是摆一张空图。
  if (!parseOption(code)) {
    return renderFallback ? <>{renderFallback(code)}</> : <pre style={{ whiteSpace: 'pre-wrap' }}>{code}</pre>
  }

  const loading = (
    <div style={{
      height, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontSize: 13,
    }}>
      ECharts 加载中…
    </div>
  )

  return (
    <FigureFrame
      title={title ?? ''}
      getSvgSource={getSvgSource}
      getPngSource={getPngSource}
      getSourceText={getSourceText}
      fileName={title || 'echarts'}
      // 放大层用一份独立的 Canvas 实例，避免主实例的 ref 被两棵树争抢（见 FigureFrame 的 zoomFigure 说明）。
      zoomFigure={
        <div style={{ width: '100%', height }}>
          <Suspense fallback={loading}><EChartsCanvas code={code} height={height} /></Suspense>
        </div>
      }
    >
      <div style={{ width: '100%', height }}>
        <Suspense fallback={loading}>
          <EChartsCanvas ref={mainRef} code={code} height={height} />
        </Suspense>
      </div>
    </FigureFrame>
  )
}

export default EChartsCard
