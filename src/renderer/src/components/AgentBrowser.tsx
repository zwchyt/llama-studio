import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, Globe, X, ExternalLink, ZoomIn, ZoomOut, Home } from 'lucide-react'
import '../styles/agent-browser.css'

export default function AgentBrowser() {
  const [initialUrl, setInitialUrl] = useState('')
  const [inputUrl, setInputUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const webviewRef = useRef<any>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // webview dom-ready 后绑定事件
  useEffect(() => {
    if (!initialUrl) return
    const wv = webviewRef.current
    if (!wv) return

    const onDomReady = () => {
      // 设置缩放
      try { wv.setZoomFactor(zoom) } catch {}
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

    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-loading', onStartLoad)
    wv.addEventListener('did-stop-loading', onStopLoad)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitleUpdate)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('new-window', onNewWindow)

    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-start-loading', onStartLoad)
      wv.removeEventListener('did-stop-loading', onStopLoad)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitleUpdate)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('new-window', onNewWindow)
    }
  }, [initialUrl, zoom])

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
        <button className="agent-browser-nav-btn" onClick={() => { setInitialUrl(''); setInputUrl(''); setTitle(''); setError(null); setCanGoBack(false); setCanGoForward(false) }} title="重置">
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
          <webview
            ref={webviewRef as any}
            className="agent-browser-webview"
            src={initialUrl}
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
