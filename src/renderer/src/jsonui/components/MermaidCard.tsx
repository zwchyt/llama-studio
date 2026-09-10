import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

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
}

type ValidationResult =
  | { valid: true; chartType: MermaidChartType }
  | { valid: false; error: string }

type MermaidChartType =
  | 'flowchart'
  | 'sequence'
  | 'class'
  | 'state'
  | 'gantt'
  | 'er'
  | 'journey'
  | 'git'
  | 'mindmap'
  | 'timeline'
  | 'pie'
  | 'sankey'
  | 'xychart'
  | 'quadrant'
  | 'requirement'
  | 'architecture'
  | 'block'
  | 'packet'
  | 'kanban'
  | 'unknown'

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

function detectChartType(code: string): MermaidChartType {
  const firstMeaningfulLine = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'))

  if (!firstMeaningfulLine) {
    return 'unknown'
  }

  if (/^(?:flowchart|graph)\b/i.test(firstMeaningfulLine)) {
    return 'flowchart'
  }

  if (/^sequenceDiagram\b/i.test(firstMeaningfulLine)) {
    return 'sequence'
  }

  if (/^classDiagram(?:-v2)?\b/i.test(firstMeaningfulLine)) {
    return 'class'
  }

  if (/^stateDiagram(?:-v2)?\b/i.test(firstMeaningfulLine)) {
    return 'state'
  }

  if (/^gantt\b/i.test(firstMeaningfulLine)) {
    return 'gantt'
  }

  if (/^erDiagram\b/i.test(firstMeaningfulLine)) {
    return 'er'
  }

  if (/^journey\b/i.test(firstMeaningfulLine)) {
    return 'journey'
  }

  if (/^gitGraph\b/i.test(firstMeaningfulLine)) {
    return 'git'
  }

  if (/^mindmap\b/i.test(firstMeaningfulLine)) {
    return 'mindmap'
  }

  if (/^timeline\b/i.test(firstMeaningfulLine)) {
    return 'timeline'
  }

  if (/^pie\b/i.test(firstMeaningfulLine)) {
    return 'pie'
  }

  if (/^sankey-beta\b/i.test(firstMeaningfulLine)) {
    return 'sankey'
  }

  if (/^xychart(?:-beta)?\b/i.test(firstMeaningfulLine)) {
    return 'xychart'
  }

  if (/^quadrantChart\b/i.test(firstMeaningfulLine)) {
    return 'quadrant'
  }

  if (/^requirementDiagram\b/i.test(firstMeaningfulLine)) {
    return 'requirement'
  }

  if (/^architecture-beta\b/i.test(firstMeaningfulLine)) {
    return 'architecture'
  }

  if (/^block-beta\b/i.test(firstMeaningfulLine)) {
    return 'block'
  }

  if (/^packet-beta\b/i.test(firstMeaningfulLine)) {
    return 'packet'
  }

  if (/^kanban\b/i.test(firstMeaningfulLine)) {
    return 'kanban'
  }

  return 'unknown'
}

function validateStructure(code: string, chartType: MermaidChartType): string | null {
  switch (chartType) {
    case 'gantt':
      if (!code.includes('dateFormat')) {
        return '甘特图缺少日期格式定义，请添加：dateFormat YYYY-MM-DD'
      }
      return null

    case 'sequence':
      if (!code.includes('participant') && !code.includes('actor') && !code.includes('->')) {
        return '时序图缺少参与者或消息传递定义'
      }
      return null

    case 'sankey':
      return null

    case 'pie': {
      const dataLines = code
        .split('\n')
        .filter((l) => l.trim() && !l.includes('pie') && !l.includes('title'))
      if (dataLines.length === 0) {
        return '饼图缺少数据项，格式："标签" : 数值'
      }
      return null
    }

    default:
      return null
  }
}

function validateChartCode(code: string): ValidationResult {
  const normalized = normalizeCode(code)

  if (!normalized) {
    return {
      valid: false,
      error: 'Mermaid 代码为空。',
    }
  }

  const chartType = detectChartType(normalized)

  if (chartType === 'unknown') {
    return {
      valid: false,
      error:
        '无法识别 Mermaid 图表类型。代码应以 flowchart、sequenceDiagram、classDiagram、stateDiagram、gantt、erDiagram、pie、mindmap、timeline、gitGraph、sankey-beta 等关键字开头。',
    }
  }

  const structuralError = validateStructure(normalized, chartType)
  if (structuralError) {
    return { valid: false, error: structuralError }
  }

  return {
    valid: true,
    chartType,
  }
}

function formatRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (!message || message === '[object Object]') {
    return 'Mermaid 图表渲染失败，请检查图表语法。'
  }

  return message
    .replace(/^Error:\s*/i, '')
    .replace(/\s+at\s+.+$/m, '')
    .trim()
}

function isErrorSvg(svg: string): boolean {
  // mermaid 会在每张正常图的 SVG <style> 中预定义 .error-icon/.error-text 等样式规则，
  // 直接匹配整个 SVG 会把所有正常图误判为错误图。先剔除 <style> 块再检测实际内容。
  const contentOnly = svg.replace(/<style[\s\S]*?<\/style>/gi, '')
  return (
    /error-icon/i.test(contentOnly) ||
    /syntax error/i.test(contentOnly) ||
    /class=["']error-text["']/i.test(contentOnly) ||
    /class=["']error["']/i.test(contentOnly)
  )
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=/gi, 'data-blocked=')
    .replace(/javascript:/gi, 'blocked:')
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

  const code = useMemo(() => normalizeCode(rawCode), [rawCode])

  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorExpanded, setErrorExpanded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [showCode, setShowCode] = useState(false)

  const requestIdRef = useRef(0)

  const renderMermaid = useCallback(async (sourceCode: string, isDark: boolean) => {
    const validation = validateChartCode(sourceCode)

    if (!validation.valid) {
      throw new Error(validation.error)
    }

    return enqueueMermaidRender(async () => {
      const mermaid = await getMermaid()
      const fontFamily = getCssVariable(
        '--font',
        'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      )
      const id = `jui-mermaid-${Date.now()}-${++renderSequence}`

      // parse 预检：render 语法失败时不抛错而是返回内置错误图，真正的报错被吞掉；
      // parse 失败会抛出带具体行列信息的语法错误，可直出给用户。
      try {
        await mermaid.parse(sourceCode)
      } catch (parseError) {
        const detail =
          parseError instanceof Error
            ? parseError.message
            : String((parseError as any)?.str ?? parseError ?? '')
        throw new Error(
          `Mermaid 语法解析失败：${detail || '未知语法错误'}。请检查第一行图表关键字与各行语法。`,
        )
      }

      // 两档配置：完整主题（美观）→ 最简配置（兜底）。完整配置渲染失败时自动降级，
      // 避免 themeVariables/securityLevel 在个别图表类型上的渲染期异常让图完全画不出来。
      const attempts: Array<{ label: string; config: Record<string, unknown> }> = [
        {
          label: 'full',
          config: {
            securityLevel: 'strict',
            theme: isDark ? 'dark' : 'default',
            themeVariables: getThemeVariables(),
            fontFamily,
          },
        },
        {
          label: 'minimal',
          config: {
            securityLevel: 'loose',
            theme: 'default',
            suppressErrorRendering: false,
          },
        },
      ]

      let lastErrorSvg = ''
      for (const attempt of attempts) {
        mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, ...attempt.config })
        try {
          const result = await mermaid.render(id + '-' + attempt.label, sourceCode)
          if (!isErrorSvg(result.svg)) {
            return sanitizeSvg(result.svg)
          }
          lastErrorSvg = result.svg
          console.warn(
            `[MermaidCard] ${attempt.label} 配置返回错误图形，标记命中:`,
            {
              errorIcon: /error-icon/i.test(lastErrorSvg),
              syntaxError: /syntax error/i.test(lastErrorSvg),
              errorText: /error-text/i.test(lastErrorSvg),
              errorClass: /class=(?:"|')error(?:"|')/i.test(lastErrorSvg),
              svgHead: lastErrorSvg.slice(0, 300),
            },
          )
        } catch (renderError) {
          console.warn(`[MermaidCard] ${attempt.label} 配置渲染抛异常:`, renderError)
          if (attempt.label === 'minimal') throw renderError
        }
      }

      throw new Error(
        'Mermaid 两种配置（完整主题/最简兜底）均返回错误图形，请查看控制台 [MermaidCard] 日志定位具体原因。',
      )
    })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const requestId = ++requestIdRef.current
    let disposed = false

    const isCurrentRequest = () =>
      !disposed && requestId === requestIdRef.current

    const setSafeState = (
      updater: () => void,
    ) => {
      if (isCurrentRequest()) {
        updater()
      }
    }

    const render = async (isDark: boolean) => {
      if (!code) {
        setSafeState(() => {
          setSvg(null)
          setError('Mermaid 代码为空。')
          setIsLoading(false)
        })
        return
      }

      setSafeState(() => {
        setIsLoading(true)
        setError(null)
        setSvg(null)
      })

      try {
        const output = await renderMermaid(code, isDark)

        setSafeState(() => {
          setSvg(output)
          setError(null)
        })
      } catch (renderError) {
        setSafeState(() => {
          setSvg(null)
          setError(formatRenderError(renderError))
        })
      } finally {
        setSafeState(() => {
          setIsLoading(false)
        })
      }
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
  }, [code, renderMermaid])

  const cardStyle: CSSProperties = {
    overflow: 'hidden',
    border: '1px solid var(--border, #d1d5db)',
    borderRadius: 8,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text, #111827)',
  }

  const titleStyle: CSSProperties = {
    padding: '10px 14px',
    borderBottom: '1px solid var(--border, #d1d5db)',
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
  }

  const contentStyle: CSSProperties = {
    position: 'relative',
    minHeight: 96,
    padding: 12,
  }

  const centerStyle: CSSProperties = {
    display: 'flex',
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted, #6b7280)',
    fontSize: 13,
  }

  const errorStyle: CSSProperties = {
    border: '1px solid var(--border, #d1d5db)',
    borderRadius: 6,
    background: 'var(--bg, #f5f5f5)',
    padding: 12,
    color: 'var(--text, #111827)',
  }

  const errorHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  }

  const errorMessageStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflowWrap: 'anywhere',
    fontSize: 13,
    lineHeight: 1.5,
  }

  const toggleStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    marginTop: 10,
    padding: 0,
    border: 0,
    background: 'transparent',
    color: 'var(--text-muted, #6b7280)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 12,
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

  return (
    <section
      style={cardStyle}
      aria-busy={isLoading}
      aria-label={title ? `Mermaid 图表：${title}` : 'Mermaid 图表'}
    >
      <header style={{ ...titleStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{title || 'Mermaid 图表'}</span>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setShowCode(false)}
            style={{
              padding: '2px 8px', borderRadius: 4, border: '1px solid',
              borderColor: !showCode ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
              background: !showCode ? 'var(--accent, #3b82f6)' : 'transparent',
              color: !showCode ? '#fff' : 'var(--text-muted, #6b7280)',
              cursor: 'pointer', fontSize: 11, lineHeight: '16px',
            }}
            title="显示图表"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 15l4-4a2 2 0 012.8 0L15 16"/>
              <path d="M14 14l1-1a2 2 0 012.8 0L21 16"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setShowCode(true)}
            style={{
              padding: '2px 8px', borderRadius: 4, border: '1px solid',
              borderColor: showCode ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
              background: showCode ? 'var(--accent, #3b82f6)' : 'transparent',
              color: showCode ? '#fff' : 'var(--text-muted, #6b7280)',
              cursor: 'pointer', fontSize: 11, lineHeight: '16px',
            }}
            title="显示源代码"
          >
            &lt;/&gt;
          </button>
        </div>
      </header>

      <div style={contentStyle}>
        {error ? (
          <div role="alert" style={errorStyle}>
            <div style={errorHeaderStyle}>
              <div style={errorMessageStyle}>
                ⚠️ 图形渲染失败：{error}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setErrorExpanded((expanded) => !expanded)}
              style={toggleStyle}
              aria-expanded={errorExpanded}
            >
              {errorExpanded ? '▲ 隐藏原始代码' : '▼ 查看原始代码'}
            </button>

            {errorExpanded ? (
              <pre style={codeStyle}>
                <code>{code || '（空）'}</code>
              </pre>
            ) : null}
          </div>
        ) : showCode ? (
          <pre style={{ ...codeStyle, margin: 0, maxHeight: 400 }}>
            <code>{code || '（空）'}</code>
          </pre>
        ) : svg ? (
          <div
            style={{
              width: '100%',
              overflowX: 'auto',
              lineHeight: 0,
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div style={centerStyle}>
            {isLoading ? '⏳ 图形渲染中…' : '⏳ 准备渲染…'}
          </div>
        )}
      </div>
    </section>
  )
}