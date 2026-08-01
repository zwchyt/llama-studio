import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, Globe, X, ExternalLink, ZoomIn, ZoomOut, Home, MessageSquarePlus, Trash2, Send } from 'lucide-react'
import '../styles/agent-browser.css'
// 注释工具脚本（?raw 打包为字符串）：webview dom-ready 后 executeJavaScript 注入。
// 不走 webview preload 属性——preload 仅接受 file: 协议，dev 模式（http 页面）无法加载。
import AGENT_ANNOTATE_SCRIPT from '../utils/agentAnnotateScript.js?raw'

// Electron webview 元素的最小类型接口（仅声明组件实际使用的 API）
interface WebviewElement extends HTMLElement {
  setZoomFactor(factor: number): void
  canGoBack(): boolean
  canGoForward(): boolean
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getURL(): string
  focus(): void
  setAudioMuted(muted: boolean): void
  executeJavaScript(code: string): Promise<any>
}

// preload 上报的注释条目（与 agentAnnotateScript.js 的注释结构一致）
export interface UiAnnotation {
  id: string
  kind: 'element' | 'area' | 'multi' | 'text'
  elements: { selector: string; tag: string; name: string; summary: string }[]
  rect?: { x: number; y: number; w: number; h: number }
  text?: string
  styles: Record<string, string>
  component: string
  note: string
  url: string
  ts: number
}

export const ANNOTATION_KIND_LABEL: Record<UiAnnotation['kind'], string> = {
  element: '元素', area: '区域', multi: '多选', text: '文本',
}

// 注释 → 给 Agent 的结构化 Markdown（选择器/组件链/样式/反馈，仿 Agentation Schema）
export function formatAnnotations(list: UiAnnotation[]): string {
  const head = list[0]?.url || ''
  const lines = [
    '# 页面 UI 反馈注释',
    `页面: ${head}`,
    `数量: ${list.length} 条`,
    '',
    ...list.map((a, i) => {
      const style = Object.entries(a.styles || {}).map(([k, v]) => `${k}: ${v}`).join('; ')
      const l = [`## ${i + 1}. ${a.note}`]
      if (a.kind === 'area' && a.rect) {
        l.push('- 类型: 区域')
        l.push(`- 区域: ${Math.round(a.rect.w)}×${Math.round(a.rect.h)} @ (${Math.round(a.rect.x)}, ${Math.round(a.rect.y)})（视口坐标）`)
        if (a.elements.length) l.push(`- 覆盖元素: ${a.elements.map(e => '`' + e.selector + '`').join(' / ')}`)
      } else if (a.kind === 'multi') {
        l.push(`- 类型: 多选（${a.elements.length} 个元素）`)
        a.elements.forEach(e => l.push(`- 选择器: \`${e.selector}\`（<${e.tag}${e.name ? ' ' + e.name : ''}>${e.summary ? ' "' + e.summary + '"' : ''}）`))
        if (style) l.push(`- 计算样式: ${style}`)
      } else if (a.kind === 'text') {
        l.push('- 类型: 文本')
        if (a.text) l.push(`- 引用文本: "${a.text}"`)
        const e = a.elements[0]
        if (e) l.push(`- 元素: \`${e.selector}\`（<${e.tag}>）`)
      } else {
        const e = a.elements[0] || {}
        l.push(`- 选择器: \`${e.selector || ''}\``)
        l.push(`- 元素: <${e.tag || ''}${e.name ? ' ' + e.name : ''}>`)
        if (e.summary) l.push(`- 文本: "${e.summary}"`)
        if (a.component) l.push(`- React 组件链: ${a.component}`)
        if (style) l.push(`- 计算样式: ${style}`)
      }
      return l.filter(Boolean).join('\n')
    }),
  ]
  return lines.join('\n')
}

export default function AgentBrowser({ visible = true, onSendToAgent }: { visible?: boolean; onSendToAgent?: (text: string) => void }) {
  const [initialUrl, setInitialUrl] = useState('')
  const [inputUrl, setInputUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [crashed, setCrashed] = useState(false)
  const [unresponsive, setUnresponsive] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [annotateActive, setAnnotateActive] = useState(false)
  const [annotations, setAnnotations] = useState<UiAnnotation[]>([])
  const zoomRef = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const webviewRef = useRef<WebviewElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 注释模式开关：通知 webview 内的注释工具（preload 会回传状态）
  const toggleAnnotate = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    wv.executeJavaScript('window.__agentAnnotate && window.__agentAnnotate.toggle()').catch(() => {})
  }, [])

  // 清空全部注释
  const clearAnnotations = useCallback(() => {
    setAnnotations([])
    webviewRef.current?.executeJavaScript('window.__agentAnnotate && window.__agentAnnotate.clear()').catch(() => {})
  }, [])

  // 删除单条注释
  const removeAnnotation = useCallback((id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id))
    webviewRef.current?.executeJavaScript(`window.__agentAnnotate && window.__agentAnnotate.removeById(${JSON.stringify(id)})`).catch(() => {})
  }, [])

  // 发送给 Agent：结构化 Markdown → 回调 AgentCodeView（模型未启动时填入输入框）
  // 发送成功后清空注释：宿主面板卡片消失 + 页面内角标清除（内容已在会话消息中可复查）
  const sendToAgent = useCallback(() => {
    if (!annotations.length) return
    onSendToAgent?.(formatAnnotations(annotations))
    setAnnotations([])
    webviewRef.current?.executeJavaScript('window.__agentAnnotate && window.__agentAnnotate.clear()').catch(() => {})
  }, [annotations, onSendToAgent])

  // 轮询取回注释工具状态（active + 注释列表）：注入脚本在页面上下文无法推送，
  // 由宿主周期性 snapshot；浏览器面板不可见时暂停以省开销。
  // snapshot 每次返回新数组引用，内容比较后才 setState，避免轮询触发整组件重渲染。
  useEffect(() => {
    if (!initialUrl || !visible) return
    const wv = webviewRef.current
    if (!wv) return
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const snap = await wv.executeJavaScript('window.__agentAnnotate && window.__agentAnnotate.snapshot()')
        if (snap && !stopped) {
          setAnnotateActive(prev => prev === !!snap.active ? prev : !!snap.active)
          setAnnotations(prev => {
            const next = snap.annotations || []
            if (prev.length === next.length && prev.every((a, i) => a.id === next[i].id && a.note === next[i].note && a.kind === next[i].kind)) return prev
            return next
          })
        }
      } catch {}
    }
    const t = setInterval(tick, 800)
    tick()
    return () => { stopped = true; clearInterval(t) }
  }, [initialUrl, visible])

  // webview dom-ready 后绑定事件
  useEffect(() => {
    if (!initialUrl) return
    const wv = webviewRef.current
    if (!wv) return

    const onDomReady = () => {
      // 设置缩放（从 ref 读取最新值，避免将 zoom 加入 effect 依赖导致所有监听重绑）
      try { wv.setZoomFactor(zoomRef.current) } catch {}
      // 注入注释工具脚本（页面每次加载后重新注入；脚本自带防重复保护）
      wv.executeJavaScript(AGENT_ANNOTATE_SCRIPT).catch(() => {})
    }
    const onStartLoad = () => { setLoading(true); setError(null); setAnnotateActive(false); setAnnotations([]) }
    const onStopLoad = () => {
      setLoading(false)
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {}
    }
    const onNavigate = (e: any) => {
      setInputUrl(e.url)
      // SPA 页内跳转（did-navigate-in-page）不触发加载事件，仅靠 did-stop-loading
      // 更新会让后退/前进按钮状态滞后（有历史可退但按钮灰着），这里同步刷新。
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {}
    }
    const onTitleUpdate = (e: any) => {
      setTitle(e.title || '')
    }
    const onFailLoad = (e: any) => {
      // 忽略 aborted（用户取消）和子框架错误
      if (e.errorCode === -3 || e.isMainFrame === false) return
      setError(`加载失败: ${e.errorDescription || e.errorCode}`)
      setLoading(false)
    }
    // 拦截新窗口：在当前 webview 中打开
    const onNewWindow = (e: any) => {
      e.preventDefault()
      const targetUrl = e.url
      if (targetUrl) wv.loadURL(targetUrl).catch(() => {})
    }
    // 渲染进程崩溃恢复
    const onCrashed = () => {
      setCrashed(true)
      setLoading(false)
    }
    // 页面无响应提示
    const onUnresponsive = () => setUnresponsive(true)
    const onResponsive = () => setUnresponsive(false)
    // 渲染进程异常退出
    const onProcessGone = () => {
      setCrashed(true)
      setLoading(false)
    }

    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-loading', onStartLoad)
    wv.addEventListener('did-stop-loading', onStopLoad)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitleUpdate)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('new-window', onNewWindow)
    wv.addEventListener('crashed', onCrashed)
    wv.addEventListener('unresponsive', onUnresponsive)
    wv.addEventListener('responsive', onResponsive)
    wv.addEventListener('render-process-gone', onProcessGone)

    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-start-loading', onStartLoad)
      wv.removeEventListener('did-stop-loading', onStopLoad)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitleUpdate)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('new-window', onNewWindow)
      wv.removeEventListener('crashed', onCrashed)
      wv.removeEventListener('unresponsive', onUnresponsive)
      wv.removeEventListener('responsive', onResponsive)
      wv.removeEventListener('render-process-gone', onProcessGone)
    }
  }, [initialUrl])

  // 隐藏时暂停 webview 后台活动，可见时恢复
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !initialUrl) return
    try {
      if (!visible) {
        wv.setAudioMuted(true)
      } else {
        wv.setAudioMuted(false)
      }
    } catch {}
  }, [visible, initialUrl])

  // 崩溃后重新加载
  const handleRecover = useCallback(() => {
    setCrashed(false)
    setUnresponsive(false)
    setError(null)
    const wv = webviewRef.current
    if (wv) {
      try { wv.reload() } catch {
        // 如果 reload 失败，重新加载 URL
        try { wv.loadURL(inputUrl || initialUrl) } catch {}
      }
    }
  }, [inputUrl, initialUrl])

  const navigate = useCallback((targetUrl?: string) => {
    let final = (targetUrl ?? inputUrl).trim()
    if (!final) return
    if (!/^https?:\/\//i.test(final)) {
      if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,}/i.test(final)) {
        final = 'https://' + final
      } else {
        final = `https://www.google.com/search?q=${encodeURIComponent(final)}`
      }
    }
    setInputUrl(final)
    setError(null)
    const wv = webviewRef.current
    if (wv) {
      wv.loadURL(final).catch(() => { /* 忽略重定向引起的 ERR_ABORTED */ })
    } else {
      setInitialUrl(final)
    }
  }, [inputUrl])

  const goBack = useCallback(() => { webviewRef.current?.goBack() }, [])
  const goForward = useCallback(() => { webviewRef.current?.goForward() }, [])
  const reload = useCallback(() => { webviewRef.current?.reload() }, [])
  const stop = useCallback(() => { webviewRef.current?.stop() }, [])
  const openExternal = useCallback(() => {
    const wv = webviewRef.current
    const currentUrl = wv ? wv.getURL() : inputUrl
    if (currentUrl) window.open(currentUrl, '_blank')
  }, [inputUrl])

  const handleZoom = useCallback((dir: 1 | -1) => {
    setZoom(prev => {
      const next = Math.max(0.5, Math.min(2, prev + dir * 0.1))
      try { webviewRef.current?.setZoomFactor(next) } catch {}
      return next
    })
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigate()
      // 导航后将焦点转移到 webview
      setTimeout(() => webviewRef.current?.focus(), 50)
    }
  }, [navigate])

  // Ctrl+L 聚焦地址栏（仅浏览器面板可见时：组件常驻隐藏挂载，
  // 不门控会在全应用任意界面劫持 Ctrl+L，把焦点抢到不可见的地址栏）
  useEffect(() => {
    if (!visible) return
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  }, [visible])

  return (
    <div className="agent-browser">
      <div className="agent-browser-toolbar">
        <button className="agent-browser-nav-btn" onClick={goBack} disabled={!canGoBack} title="后退">
          <ArrowLeft size={14} />
        </button>
        <button className="agent-browser-nav-btn" onClick={goForward} disabled={!canGoForward} title="前进">
          <ArrowRight size={14} />
        </button>
        <button className="agent-browser-nav-btn" onClick={loading ? stop : reload} title={loading ? '停止' : '刷新'}>
          {loading ? <X size={14} /> : <RotateCcw size={14} />}
        </button>
        <button className="agent-browser-nav-btn" onClick={() => { try { webviewRef.current?.stop() } catch {} setInitialUrl(''); setInputUrl(''); setTitle(''); setError(null); setCanGoBack(false); setCanGoForward(false) }} title="重置">
          <Home size={14} />
        </button>
        <div className="agent-browser-urlbar">
          <Globe size={12} className="agent-browser-urlbar-icon" />
          <input
            ref={inputRef}
            className="agent-browser-urlbar-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="输入网址或搜索..."
            spellCheck={false}
          />
          {loading && <span className="agent-browser-loading-dot" />}
        </div>
        <button className={`agent-browser-nav-btn${annotateActive ? ' agent-browser-nav-btn--active' : ''}`} onClick={toggleAnnotate} title="UI 注释模式：点击页面元素添加注释（发送给 Agent 自动定位修改）">
          <MessageSquarePlus size={14} />
          {annotations.length > 0 && <span className="agent-browser-annotate-count">{annotations.length}</span>}
        </button>
        <button className="agent-browser-nav-btn" onClick={() => handleZoom(-1)} title="缩小" disabled={zoom <= 0.5}>
          <ZoomOut size={13} />
        </button>
        <button className="agent-browser-nav-btn" onClick={() => handleZoom(1)} title="放大" disabled={zoom >= 2}>
          <ZoomIn size={13} />
        </button>
        <button className="agent-browser-nav-btn" onClick={openExternal} title="在外部浏览器打开">
          <ExternalLink size={13} />
        </button>
      </div>
      {title && <div className="agent-browser-title" title={title}>{title}</div>}
      {initialUrl ? (
        <>
          {error && <div className="agent-browser-error">{error}</div>}
          {crashed && (
            <div className="agent-browser-error" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>页面进程已崩溃</span>
              <button className="agent-browser-nav-btn" onClick={handleRecover} title="重新加载" style={{ width: 'auto', padding: '2px 8px', fontSize: 11 }}>
                <RotateCcw size={11} /> 恢复
              </button>
            </div>
          )}
          {unresponsive && !crashed && (
            <div className="agent-browser-error" style={{ background: 'color-mix(in srgb, #f90 10%, transparent)', color: '#d97706' }}>
              页面无响应，等待恢复中…
            </div>
          )}
          <webview
            ref={webviewRef as any}
            className="agent-browser-webview"
            src={initialUrl}
            partition="persist:agent-browser"
            /* @ts-ignore */
            allowpopups="true"
          />
          {/* UI 注释面板：注释列表 + 发送给 Agent */}
          {annotations.length > 0 && (
            <div className="agent-browser-annotations">
              <div className="agent-browser-annotations-head">
                <span>UI 注释（{annotations.length}）</span>
                <button className="agent-browser-annotations-clear" onClick={clearAnnotations} title="清空全部注释"><Trash2 size={11} /> 清空</button>
              </div>
              <div className="agent-browser-annotations-list">
                {annotations.map(a => (
                  <div className="agent-browser-annotations-item" key={a.id}>
                    <div className="agent-browser-annotations-note">
                      <span className={`agent-ann-kind kind-${a.kind}`}>{ANNOTATION_KIND_LABEL[a.kind]}</span>{a.note}
                    </div>
                    {a.kind === 'area' && a.rect
                      ? <div className="agent-browser-annotations-sel" title={`${Math.round(a.rect.w)}×${Math.round(a.rect.h)} @ (${Math.round(a.rect.x)}, ${Math.round(a.rect.y)})`}>区域 {Math.round(a.rect.w)}×{Math.round(a.rect.h)} @ ({Math.round(a.rect.x)},{Math.round(a.rect.y)}) · 覆盖 {a.elements.length} 元素</div>
                      : a.kind === 'text'
                        ? <div className="agent-browser-annotations-sel" title={a.text}>"{a.text}"</div>
                        : <div className="agent-browser-annotations-sel" title={a.elements.map(e => e.selector).join('\n')}>{a.elements.length > 1 ? `多选 ${a.elements.length} 个元素` : (a.elements[0]?.selector || '')}</div>}
                    {a.component && <div className="agent-browser-annotations-comp" title={a.component}>{a.component}</div>}
                    <button className="agent-browser-annotations-del" onClick={() => removeAnnotation(a.id)} title="删除该注释"><X size={11} /></button>
                  </div>
                ))}
              </div>
              <button className="agent-browser-annotations-send" onClick={sendToAgent} disabled={!onSendToAgent}>
                <Send size={12} /> 发送给 Agent
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="agent-browser-empty">输入网址或搜索关键词后按 Enter</div>
      )}
    </div>
  )
}
