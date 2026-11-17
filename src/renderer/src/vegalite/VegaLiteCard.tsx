/**
 * Vega-Lite 卡片外壳。
 *
 * 与 EChartsCard 同款：FigureFrame 提供标题、复制源码、下载 .svg / .png、
 * 查看源码、放大查看；渲染核心在 VegaLiteCanvas（懒加载，避免首屏背 vega 系列）。
 */
import { Suspense, lazy, useCallback, useRef, type ReactNode } from 'react'
import { FigureFrame } from '../figure/FigureFrame'
import type { VegaLiteCanvasHandle } from './VegaLiteCanvas'

const VegaLiteCanvas = lazy(() => import('./VegaLiteCanvas'))

type Props = {
  code: string
  title?: string | null
  width?: number
  height?: number
  renderFallback?: (code: string) => ReactNode
}

function parseSpec(code: string): boolean {
  try {
    const v: unknown = JSON.parse(code)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false
  }
}

export function VegaLiteCard({ code, title, width = 560, height = 360, renderFallback }: Props) {
  const mainRef = useRef<VegaLiteCanvasHandle | null>(null)
  // 回调引用必须稳定（FigureFrame 直接拿它当依赖读源码）。
  const getSvgSource = useCallback(() => mainRef.current?.getSvgString() ?? null, [])
  const getPngSource = useCallback(() => mainRef.current?.getPngDataUrl() ?? null, [])
  const getSourceText = useCallback(() => code, [code])

  if (!parseSpec(code)) {
    return renderFallback ? <>{renderFallback(code)}</> : <pre style={{ whiteSpace: 'pre-wrap' }}>{code}</pre>
  }

  const loading = (
    <div style={{
      width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontSize: 13,
    }}>
      Vega-Lite 加载中…
    </div>
  )

  return (
    <FigureFrame
      title={title ?? ''}
      getSvgSource={getSvgSource}
      getPngSource={getPngSource}
      getSourceText={getSourceText}
      fileName={title || 'vegalite'}
      zoomFigure={
        // 填满 FigureFrame 放大层的 stage（stage 尺寸 = 卡片里图表的原始尺寸），
        // 让放大层里的 vega 图表自适应到相同尺寸，缩放时与卡片里逐像素一致。
        <div style={{ width: '100%', height: '100%' }}>
          <Suspense fallback={loading}><VegaLiteCanvas code={code} width={width} height={height} /></Suspense>
        </div>
      }
    >
      <Suspense fallback={loading}>
        <VegaLiteCanvas ref={mainRef} code={code} width={width} height={height} />
      </Suspense>
    </FigureFrame>
  )
}

export default VegaLiteCard
