import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import './mermaid.css'

type MermaidModule = typeof import('mermaid')
type MermaidInstance = MermaidModule['default']

type MermaidCardProps = {
  props?: {
    code?: string | null
    title?: string | null
  }
  state?: {
    code?: string | null
    title?: string | null
  }
  // 兼容扁平传入
  code?: string | null
  title?: string | null
  children?: any
  emit?: (event: string, data?: any) => void
  renderFallback?: (code: string) => ReactNode
  fallbackLang?: string
}

type RenderState = 'pending' | 'chart' | 'code'

let renderSequence = 0
let mermaidImportPromise: Promise<MermaidInstance> | null = null
let renderQueue: Promise<void> = Promise.resolve()

function normalizeCode(raw: string | undefined | null): string {
  if (typeof raw !== 'string') {
    return ''
  }
  // 全角标点转半角（LLM 常输出全角冒号/逗号导致 mermaid 解析失败）
  const normalized = raw
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/；/g, ';')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
  // 兜底处理 JSON 解析后残留的字面 \n
  const processed = normalized.replace(/\\n/g, '\n')
  const trimmed = processed.trim()
  if (!trimmed) {
    return ''
  }
  // 修复正则：匹配三反引号 ```mermaid ... ```
  const fencedCodeBlock = /^```(?:mermaid)?[^\S\r\n]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(
    trimmed,
  )
  const code = (fencedCodeBlock?.[1] ?? trimmed).trim()
  return normalizeMermaidKeyword(code)
}

// 关键词规范化：模型常输出错误的 mermaid 关键字，在此统一修正
const KEYWORD_FIXES: Array<[RegExp, string]> = [
  // sankey-beta / xychart-beta（缺 -beta 后缀）
  [/^\s*sankey\b(?!\s*-)/i, 'sankey-beta'],
  [/^\s*xychart\b(?!\s*-)/i, 'xychart-beta'],
  // architecture-beta / block-beta / packet-beta（缺 -beta 后缀）
  [/^\s*architecture\b(?!\s*-)/i, 'architecture-beta'],
  [/^\s*block\b(?!\s*-)/i, 'block-beta'],
  [/^\s*packet\b(?!\s*-)/i, 'packet-beta'],
  // stateDiagram-v2（缺 -v2）
  [/^\s*stateDiagram\b(?!\s*-v2)/i, 'stateDiagram-v2'],
  // classDiagram-v2（缺 -v2）
  [/^\s*classDiagram\b(?!\s*-v2)/i, 'classDiagram-v2'],
  // 常见拼写变体
  [/^\s*flow[\s\-_]*chart\b/i, 'flowchart'],
  [/^\s*sequence[\s\-_]*diagram\b/i, 'sequenceDiagram'],
  [/^\s*class[\s\-_]*diagram\b(?!\s*-v2)/i, 'classDiagram-v2'],
  [/^\s*state[\s\-_]*diagram\b(?!\s*-v2)/i, 'stateDiagram-v2'],
  [/^\s*er[\s\-_]*diagram\b/i, 'erDiagram'],
  [/^\s*git[\s\-_]*graph\b/i, 'gitGraph'],
  [/^\s*requirement[\s\-_]*diagram\b/i, 'requirementDiagram'],
  [/^\s*quadrant[\s\-_]*chart\b/i, 'quadrantChart'],
]

function normalizeMermaidKeyword(code: string): string {
  for (const [re, fix] of KEYWORD_FIXES) {
    if (re.test(code)) {
      // 只替换第一行的关键词部分，保留后续内容
      return code.replace(re, fix)
    }
  }
  return code
}

function getCssVariable(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback
  }

  try {
    return (
      getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim() || fallback
    )
  } catch {
    return fallback
  }
}

function getThemeVariables(): Record<string, string> {
  const surface = getCssVariable('--surface', '#ffffff')
  const background = getCssVariable('--bg', '#f5f5f5')
  const border = getCssVariable('--border', '#d1d5db')
  const strongBorder = getCssVariable('--border-strong', '#9ca3af')
  const text = getCssVariable('--text', '#111827')
  const mutedText = getCssVariable('--text-muted', '#6b7280')

  return {
    primaryColor: surface,
    primaryBorderColor: strongBorder,
    primaryTextColor: text,
    mainBkg: surface,
    nodeBorder: strongBorder,
    lineColor: mutedText,
    secondaryColor: background,
    secondaryBorderColor: border,
    tertiaryColor: background,
    tertiaryBorderColor: border,
    edgeLabelBackground: surface,
    clusterBkg: background,
    clusterBorder: border,
    textColor: text,
    titleColor: text,
    actorBkg: surface,
    actorBorder: strongBorder,
    actorTextColor: text,
    actorLineColor: mutedText,
    signalColor: mutedText,
    signalTextColor: text,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: border,
    labelTextColor: text,
    noteBkgColor: background,
    noteBorderColor: border,
    noteTextColor: text,
    activationBkgColor: background,
    activationBorderColor: strongBorder,
    sectionBkgColor: background,
    altSectionBkgColor: surface,
    gridColor: border,
    taskBkgColor: surface,
    taskBorderColor: strongBorder,
    taskTextColor: text,
    taskTextLightColor: text,
    taskTextOutsideColor: text,
    taskTextClickableColor: text,
    activeTaskBkgColor: background,
    activeTaskBorderColor: strongBorder,
    doneTaskBkgColor: background,
    doneTaskBorderColor: border,
    critBkgColor: surface,
    critBorderColor: strongBorder,
  }
}

function isErrorSvg(svg: string): boolean {
  if (!svg) return true
  const trimmed = svg.trim()
  // 不是 svg 或过短（空白图/碎片）视为渲染失败。
  if (!/^\s*<svg\b/i.test(trimmed) || trimmed.length < 80) return true
  // mermaid 会在每张正常图的 SVG <style> 中预定义 .error-icon/.error-text 等样式规则，
  // 直接匹配整个 SVG 会把所有正常图误判为错误图。先剔除 <style> 块再检测实际内容。
  const contentOnly = trimmed.replace(/<style[\s\S]*?<\/style>/gi, '')
  return (
    /error-icon/i.test(contentOnly) ||
    /syntax error/i.test(contentOnly) ||
    /rendering error/i.test(contentOnly) ||
    /mermaid-error/i.test(contentOnly) ||
    /class=["']error-text["']/i.test(contentOnly) ||
    /class=["']error["']/i.test(contentOnly)
  )
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=/gi, 'data-blocked=')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/<svg\b/, '<svg style="max-width:100%;height:auto"')
}

async function getMermaid(): Promise<MermaidInstance> {
  if (!mermaidImportPromise) {
    mermaidImportPromise = import('mermaid')
      .then((module) => module.default)
      .catch((error) => {
        mermaidImportPromise = null
        throw error
      })
  }

  return mermaidImportPromise
}

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task)

  renderQueue = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

export function MermaidCard(renderProps: MermaidCardProps) {
  // ===== 智能提取 code 和 title（支持 props/state/扁平/children）=====
  const title =
    renderProps.props?.title ??
    renderProps.title ??
    renderProps.state?.title ??
    null

  let rawCode =
    renderProps.props?.code ??
    renderProps.code ??
    renderProps.state?.code ??
    ''

  if (!rawCode && typeof renderProps.children === 'string') {
    rawCode = renderProps.children
  }

  if (typeof rawCode !== 'string') {
    if (rawCode && typeof rawCode === 'object') {
      const obj = rawCode as any
      // 只提取合法的 code/value/text
      const extracted = obj.code ?? obj.value ?? obj.text
      if (extracted && typeof extracted === 'string') {
        rawCode = extracted
      } else {
        // 不满足条件则置空，避免错误序列化
        rawCode = ''
      }
    } else {
      rawCode = String(rawCode ?? '')
    }
  }

  const renderCode = useMemo(() => normalizeCode(rawCode), [rawCode])
  const fallbackCode = useMemo(() => {
    const text = typeof rawCode === 'string' ? rawCode : ''
    return text.trimEnd()
  }, [rawCode])
  const displayFallbackCode = fallbackCode || renderCode

  const [renderState, setRenderState] = useState<RenderState>('pending')
  const [svg, setSvg] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showDownloadMenu, setShowDownloadMenu] = useState(false)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })

  const requestIdRef = useRef(0)

  // 静默：能渲染返回安全 svg 字符串；不能正确渲染一律返回 null（绝不抛出任何错误信息）。
  const renderMermaid = useCallback(async (sourceCode: string, isDark: boolean): Promise<string | null> => {
    if (!sourceCode) return null

    return enqueueMermaidRender(async () => {
      try {
        const mermaid = await getMermaid()
        const fontFamily = getCssVariable(
          '--font',
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        )

        // parse 预检：失败即判定“不能正确渲染”，静默降级，不抛错。
        try {
          await mermaid.parse(sourceCode)
        } catch {
          return null
        }

        // 仅用 strict 安全等级重试两档主题（不使用 loose，避免不安全渲染）。
        const configs: Array<Record<string, unknown>> = [
          {
            securityLevel: 'strict',
            theme: isDark ? 'dark' : 'default',
            themeVariables: getThemeVariables(),
            fontFamily,
            suppressErrorRendering: true,
          },
          {
            securityLevel: 'strict',
            theme: 'default',
            suppressErrorRendering: true,
          },
        ]

        for (let i = 0; i < configs.length; i++) {
          mermaid.initialize({ startOnLoad: false, ...configs[i] })
          try {
            const result = await mermaid.render(
              `jui-mermaid-${Date.now()}-${++renderSequence}-${i}`,
              sourceCode,
            )
            if (result?.svg && !isErrorSvg(result.svg)) {
              return sanitizeSvg(result.svg)
            }
          } catch {
            // 渲染抛异常 = 不是合法图表 → 试下一个配置
            continue
          }
        }
        return null
      } catch {
        // 加载/解析基础流程失败，同样静默降级当代码块。
        return null
      }
    })
  }, [])

  const downloadMenuRef = useRef<HTMLDivElement>(null)

  const triggerDownload = useCallback((filename: string, data: string | Blob, mime?: string) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleDownloadSvg = useCallback(() => {
    if (!svg) return
    triggerDownload(`${title || 'mermaid-chart'}.svg`, svg, 'image/svg+xml')
    setShowDownloadMenu(false)
  }, [svg, title, triggerDownload])

  const handleDownloadCode = useCallback(() => {
    if (!displayFallbackCode) return
    triggerDownload(`${title || 'mermaid-chart'}.mmd`, displayFallbackCode, 'text/plain')
    setShowDownloadMenu(false)
  }, [displayFallbackCode, title, triggerDownload])

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  useEffect(() => {
    if (!isFullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isFullscreen])

  const ZOOM_MIN = 0.3, ZOOM_MAX = 3, ZOOM_STEP = 0.1
  const zoomIn = useCallback(() => setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2))), [])
  const zoomOut = useCallback(() => setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2))), [])
  const zoomReset = useCallback(() => { setScale(1); setTranslate({ x: 0, y: 0 }) }, [])

  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null)
  const svgContainerRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (scale <= 1) return
    e.preventDefault()
      ; (e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, tx: translate.x, ty: translate.y }
  }, [scale, translate])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setTranslate({ x: dragRef.current.tx + dx, y: dragRef.current.ty + dy })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  useEffect(() => {
    if (!isFullscreen) return
    const el = fullscreenRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(s + delta).toFixed(2)))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isFullscreen])

  useEffect(() => {
    if (!showDownloadMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target as Node)) {
        setShowDownloadMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDownloadMenu])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const requestId = ++requestIdRef.current
    let disposed = false

    const isCurrentRequest = () =>
      !disposed && requestId === requestIdRef.current

    const setSafeState = (updater: () => void) => {
      if (isCurrentRequest()) {
        updater()
      }
    }

    const render = async (isDark: boolean) => {
      if (!renderCode) {
        setSafeState(() => {
          setSvg(null)
          setIsLoading(false)
          setRenderState('code')
        })
        return
      }

      setSafeState(() => {
        setIsLoading(true)
        setSvg(null)
        setShowCode(false)
        setRenderState('pending')
      })

      let nextSvg: string | null = null
      try {
        nextSvg = await renderMermaid(renderCode, isDark)
      } catch {
        nextSvg = null
      }

      setSafeState(() => {
        setIsLoading(false)
        if (nextSvg) {
          setSvg(nextSvg)
          setRenderState('chart')
        } else {
          setSvg(null)
          setRenderState('code')
        }
      })
    }

    const root = document.documentElement
    let isDark = root.classList.contains('theme-dark')

    void render(isDark)

    const observer = new MutationObserver(() => {
      const nextIsDark = root.classList.contains('theme-dark')
      if (nextIsDark === isDark) {
        return
      }
      isDark = nextIsDark
      void render(isDark)
    })

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [renderCode, renderMermaid])

  useEffect(() => {
    setRenderState('pending')
    setShowCode(false)
    setSvg(null)
  }, [renderCode])

  const cardStyle: CSSProperties = {
    overflow: 'hidden',
    border: '1px solid var(--border, #d1d5db)',
    borderRadius: 6,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text, #111827)',
  }

  const titleStyle: CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--border, #d1d5db)',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
  }

  const contentStyle: CSSProperties = {
    position: 'relative',
    // 加载态预留接近真实图表的高度：mermaid.render 是异步的，完成前只显示一行提示文字，
    // 若占位过矮（原 80px），渲染完成的瞬间容器会从 80px 猛增到数百 px →
    // 聊天区 scrollHeight 突变 → 滚动条跳变/抖动（尤其同时有多张图时）。
    // 预留 260px 可把突变幅度压到很小，视觉上几乎无感。
    minHeight: isFullscreen ? 0 : 260,
    padding: '4px 4px',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }

  const codeStyle: CSSProperties = {
    margin: '8px 0 0',
    maxHeight: 260,
    overflow: 'auto',
    padding: 10,
    borderRadius: 4,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text, #111827)',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }

  const btnBase: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '2px 6px', borderRadius: 4, border: 'none',
    background: 'transparent', cursor: 'pointer', fontSize: 11, lineHeight: '16px',
    color: 'var(--text-muted, #6b7280)',
  }

  const svgIcon = (d: string, w = 13, h = 13) => (
    <svg width={w} height={h} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )

  if (renderState === 'code') {
    if (!displayFallbackCode) {
      return null
    }

    if (renderProps.renderFallback) {
      return renderProps.renderFallback(displayFallbackCode)
    }

    return (
      <pre style={{ ...codeStyle, margin: 0, maxHeight: 'none' }}>
        <code>{displayFallbackCode}</code>
      </pre>
    )
  }

  if (renderState === 'pending') {
    return (
      <div
        style={{
          minHeight: isFullscreen ? 0 : 260,
        }}
        aria-hidden="true"
      />
    )
  }

  const chartContent = (
    <div style={contentStyle}>
      {showCode ? (
        <pre style={{ ...codeStyle, margin: 0, maxHeight: isFullscreen ? 'none' : 400, flex: 1, overflow: 'auto' }}>
          <code>{displayFallbackCode}</code>
        </pre>
      ) : svg ? (
        <div
          ref={isFullscreen ? undefined : svgContainerRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            width: '100%',
            flex: 1,
            overflow: 'hidden',
            lineHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: scale > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragRef.current ? 'none' : 'transform 0.15s ease',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : null}
    </div>
  )

  const toolbar = (
    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
      <button type="button" onClick={() => setShowCode(false)} title="图表"
        style={{
          ...btnBase,
          background: !showCode ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
          color: !showCode ? 'var(--accent)' : 'var(--text-muted, #6b7280)',
        }}>
        {svgIcon('M3 3h18v18H3zM3 15l4-4a2 2 0 012.8 0L15 16M14 14l1-1a2 2 0 012.8 0L21 16')}
      </button>
      <button type="button" onClick={() => setShowCode(true)} title="代码"
        style={{
          ...btnBase,
          background: showCode ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
          color: showCode ? 'var(--accent)' : 'var(--text-muted, #6b7280)',
        }}>
        &lt;/&gt;
      </button>
      <div style={{ width: 1, margin: '0 2px', borderLeft: '1px solid var(--border, #d1d5db)' }} />
      <div ref={downloadMenuRef} style={{ position: 'relative' }}>
        <button type="button" onClick={() => setShowDownloadMenu((v) => !v)} title="下载"
          style={{ ...btnBase, opacity: svg || displayFallbackCode ? 1 : 0.4 }}>
          {svgIcon('M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3')}
        </button>
        {showDownloadMenu && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            minWidth: 140, padding: '4px 0', borderRadius: 6,
            border: '1px solid var(--border, #d1d5db)',
            background: 'var(--surface, #ffffff)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            zIndex: 100,
          }}>
            <button type="button" onClick={handleDownloadSvg} disabled={!svg}
              style={{
                display: 'block', width: '100%', padding: '5px 10px', border: 0,
                background: 'transparent', textAlign: 'left', cursor: svg ? 'pointer' : 'default',
                fontSize: 12, opacity: svg ? 1 : 0.4, color: 'var(--text, #111827)'
              }}>
              SVG 图片
            </button>
            <button type="button" onClick={handleDownloadCode} disabled={!displayFallbackCode}
              style={{
                display: 'block', width: '100%', padding: '5px 10px', border: 0,
                background: 'transparent', textAlign: 'left', cursor: displayFallbackCode ? 'pointer' : 'default',
                fontSize: 12, opacity: displayFallbackCode ? 1 : 0.4, color: 'var(--text, #111827)'
              }}>
              源代码 (.mmd)
            </button>
          </div>
        )}
      </div>
      <div style={{ width: 1, margin: '0 2px', borderLeft: '1px solid var(--border, #d1d5db)' }} />
      <button type="button" onClick={zoomOut} title="缩小" disabled={scale <= ZOOM_MIN}
        style={{ ...btnBase, opacity: scale > ZOOM_MIN ? 1 : 0.3 }}>
        {svgIcon('M5 12h14', 12, 12)}
      </button>
      <button type="button" onClick={zoomReset} title={`${Math.round(scale * 100)}%`}
        style={{ ...btnBase, fontSize: 10, padding: '2px 4px', minWidth: 36 }}>
        {Math.round(scale * 100)}%
      </button>
      <button type="button" onClick={zoomIn} title="放大" disabled={scale >= ZOOM_MAX}
        style={{ ...btnBase, opacity: scale < ZOOM_MAX ? 1 : 0.3 }}>
        {svgIcon('M12 5v14M5 12h14', 12, 12)}
      </button>
      <button type="button" onClick={toggleFullscreen} title={isFullscreen ? '退出全屏' : '全屏'}
        style={btnBase}>
        {isFullscreen
          ? svgIcon('M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3')
          : svgIcon('M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3')}
      </button>
    </div>
  )

  const card = (
    <section
      style={cardStyle}
      aria-busy={isLoading}
      aria-label={title ? `Mermaid 图表：${title}` : 'Mermaid 图表'}
    >
      <header style={{ ...titleStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || 'Mermaid 图表'}
        </span>
        {toolbar}
      </header>
      {chartContent}
    </section>
  )

  if (!isFullscreen) return card

  return createPortal(
    <div
      ref={fullscreenRef}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) setIsFullscreen(false) }}
    >
      <div style={{
        width: '90vw', height: '90vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', borderRadius: 8,
        border: '1px solid var(--border, #d1d5db)',
        background: 'var(--surface, #ffffff)',
        color: 'var(--text, #111827)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}>
        <header style={{ ...titleStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title || 'Mermaid 图表'}
          </span>
          {toolbar}
        </header>
        {chartContent}
      </div>
    </div>,
    document.body
  )
}
