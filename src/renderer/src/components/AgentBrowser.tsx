import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, Globe, X, ExternalLink, ZoomIn, ZoomOut, Home } from 'lucide-react'
import '../styles/agent-browser.css'

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
}

export default function AgentBrowser({ visible = true }: { visible?: boolean }) {
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
  const zoomRef = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const webviewRef = useRef<WebviewElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // webview dom-ready 后绑定事件
  useEffect(() => {
    if (!initialUrl) return
    const wv = webviewRef.current
    if (!wv) return

    const onDomReady = () => {
      // 设置缩放（从 ref 读取最新值，避免将 zoom 加入 effect 依赖导致所有监听重绑）
      try { wv.setZoomFactor(zoomRef.current) } catch {}
    }
    const onStartLoad = () => { setLoading(true); setError(null) }
    const onStopLoad = () => {
      setLoading(false)
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {}
    }
    const onNavigate = (e: any) => {
      setInputUrl(e.url)
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

  // Ctrl+L 聚焦地址栏
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  }, [])

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
        </>
      ) : (
        <div className="agent-browser-empty">输入网址或搜索关键词后按 Enter</div>
      )}
    </div>
  )
}
