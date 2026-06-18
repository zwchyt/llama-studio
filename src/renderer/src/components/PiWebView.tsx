import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Globe, ExternalLink, Loader, AlertTriangle, Play, Square, RefreshCw } from 'lucide-react'
import { safeCall } from '../utils/safeCall'

export default function PiWebView() {
  const { piWebUrl, setPiWebUrl } = useStore(s => ({ piWebUrl: s.piWebUrl, setPiWebUrl: s.setPiWebUrl }), shallow)
  const [localStatus, setLocalStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>(piWebUrl ? 'ready' : 'idle')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let cancelled = false
    if (piWebUrl) {
      setLocalStatus('ready')
    } else {
      window.api.getPiWebStatus().then((res: { running: boolean; url: string }) => {
        if (cancelled) return
        if (res.running) {
          setLocalStatus('ready')
          setPiWebUrl(res.url)
        }
      }).catch((e) => console.error('[getPiWebStatus]', e))
    }
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'REQUEST_DIRECTORY_SELECTION') return
      if (e.source !== iframeRef.current?.contentWindow) return
      if (!piWebUrl || e.origin !== new URL(piWebUrl).origin) return
      const result = await safeCall(() => window.api.selectDirectory(), '选择目录失败')
      e.source?.postMessage({ type: 'DIRECTORY_SELECTION_RESULT', path: result?.path ?? null }, { targetOrigin: piWebUrl })
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [piWebUrl])

  const handleStart = async () => {
    setLocalStatus('starting')
    setError('')
    const res = await safeCall(() => window.api.startPiWeb(), '启动 pi-web 失败')
    if (res && res.success) {
      setLocalStatus('ready')
      setPiWebUrl(res.url)
    } else if (res) {
      setLocalStatus('error')
      setError(res.error || 'Failed to start pi-web')
    } else {
      setLocalStatus('error')
      setError('启动 pi-web 失败')
    }
  }

  const handleStop = async () => {
    const ok = await safeCall(() => window.api.stopPiWeb(), '停止 pi-web 失败')
    if (ok === null) return
    setLocalStatus('idle')
    setPiWebUrl(null)
    setError('')
  }

  const handleOpenBrowser = () => {
    if (piWebUrl) window.api.openExternal(piWebUrl)
  }

  const handleReload = () => setReloadKey(k => k + 1)

  if (localStatus !== 'ready') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, color: 'var(--text)', padding: 40 }}>
        {localStatus === 'idle' && (
          <>
            <Globe size={48} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: 14, opacity: 0.7 }}>pi-web server is not running</span>
            <button className="btn btn-primary" onClick={handleStart}>
              <Play size={14} /> Start pi-web
            </button>
          </>
        )}
        {localStatus === 'starting' && (
          <>
            <Loader size={32} className="spin" style={{ opacity: 0.5 }} />
            <span style={{ fontSize: 14, opacity: 0.7 }}>Starting pi-web server...</span>
          </>
        )}
        {localStatus === 'error' && (
          <>
            <AlertTriangle size={32} style={{ color: 'var(--warn, #eab308)' }} />
            <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{error}</span>
            <button className="btn btn-primary" onClick={handleStart}>
              <Play size={14} /> Retry
            </button>
          </>
        )}
      </div>
    )
  }

  return (
      <div className="llama-chat-container">
        <div className="llama-chat-header">
          <div className="llama-chat-header-left">
            <Globe size={16} />
            <span className="llama-chat-title">pi-web</span>
            <span className="llama-chat-url">{piWebUrl}</span>
          </div>
          <div className="llama-chat-header-actions">
            <button className="btn btn-danger btn-sm" onClick={handleStop} title="停止 pi-web">
              <Square size={13} /> 停止
            </button>
            <span className="llama-chat-sep" />
            <button className="btn btn-ghost btn-sm" onClick={handleReload} title="刷新">
              <RefreshCw size={13} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleOpenBrowser} title="在浏览器打开">
              <ExternalLink size={13} />
            </button>
          </div>
        </div>
        <div className="llama-chat-body">
          <iframe key={reloadKey} ref={iframeRef} src={piWebUrl!} className="llama-chat-iframe" title="pi-web" />
        </div>
      </div>
  )
}
