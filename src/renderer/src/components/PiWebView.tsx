import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Globe, ExternalLink, Loader, AlertTriangle, Play, Square, RefreshCw, Download } from 'lucide-react'

type PageStatus = 'checking' | 'needs_download' | 'downloading' | 'idle' | 'starting' | 'ready' | 'error'

export default function PiWebView() {
  const { piWebUrl, setPiWebUrl } = useStore(s => ({ piWebUrl: s.piWebUrl, setPiWebUrl: s.setPiWebUrl }), shallow)
  const [localStatus, setLocalStatus] = useState<PageStatus>('checking')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [dlPercent, setDlPercent] = useState(0)
  const [dlPhase, setDlPhase] = useState('')
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (piWebUrl) { setLocalStatus('ready'); return }
    let cancelled = false
    ;(async () => {
      try {
        const { exists } = await window.api.checkPiWeb()
        if (cancelled) return
        if (exists) {
          setLocalStatus('idle')
        } else {
          setLocalStatus('needs_download')
        }
      } catch {
        if (!cancelled) setLocalStatus('needs_download')
      }
    })()
    window.api.getPiWebStatus().then((res: { running: boolean; url: string }) => {
      if (cancelled || !res.running) return
      setLocalStatus('ready')
      setPiWebUrl(res.url)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleDownload = async () => {
    setLocalStatus('downloading')
    setError('')
    setDlPercent(0)
    setDlPhase('downloading')
    window.api.onPiWebDownloadProgress((data) => {
      if (!mountedRef.current) return
      setDlPercent(data.percent)
      setDlPhase(data.phase)
    })
    const res = await window.api.downloadPiWeb()
    window.api.removePiWebDownloadListener()
    if (!mountedRef.current) return
    if (res.success) {
      setLocalStatus('idle')
    } else {
      setLocalStatus('needs_download')
      setError(res.error || '下载失败')
    }
  }

  const handleCancelDownload = () => {
    window.api.cancelPiWebDownload()
    window.api.removePiWebDownloadListener()
    if (mountedRef.current) {
      setLocalStatus('needs_download')
    }
  }

  const handleStart = async () => {
    setLocalStatus('starting')
    setError('')
    try {
      const res = await window.api.startPiWeb()
      if (!mountedRef.current) return
      if (res.success) {
        setLocalStatus('ready')
        setPiWebUrl(res.url)
      } else {
        setLocalStatus('error')
        setError(res.error || '启动失败')
      }
    } catch (e) {
      if (!mountedRef.current) return
      setLocalStatus('error')
      setError(String(e))
    }
  }

  const handleStop = async () => {
    await window.api.stopPiWeb()
    if (!mountedRef.current) return
    setLocalStatus('idle')
    setPiWebUrl(null)
    setError('')
  }

  const handleOpenBrowser = () => {
    if (piWebUrl) window.api.openExternal(piWebUrl)
  }

  const handleReload = () => setReloadKey(k => k + 1)

  if (localStatus === 'ready') {
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
          <webview key={reloadKey} src={piWebUrl!} style={{ flex: 1, width: '100%' }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, color: 'var(--text)', padding: 40 }}>
      {localStatus === 'checking' && (
        <>
          <Loader size={32} className="spin" style={{ opacity: 0.5 }} />
          <span style={{ fontSize: 14, opacity: 0.7 }}>检查 pi-web 安装状态...</span>
        </>
      )}
      {localStatus === 'needs_download' && (
        <>
          <Download size={48} style={{ opacity: 0.4 }} />
          <span style={{ fontSize: 14, opacity: 0.7 }}>需要下载 pi-web 组件</span>
          <span style={{ fontSize: 12, opacity: 0.5 }}>首次使用需下载约 200MB</span>
          <button className="btn btn-primary" onClick={handleDownload}>
            <Download size={14} /> 下载 pi-web
          </button>
        </>
      )}
      {localStatus === 'downloading' && (
        <>
          <Loader size={32} className="spin" style={{ opacity: 0.5 }} />
          <span style={{ fontSize: 14, opacity: 0.7 }}>
            {dlPhase === 'downloading' ? '正在下载 pi-web...' : '正在解压...'}
          </span>
          <div style={{ width: 240, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${dlPercent}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontSize: 12, opacity: 0.5 }}>{dlPercent}%</span>
          <button className="btn btn-ghost btn-sm" onClick={handleCancelDownload}>取消</button>
        </>
      )}
      {localStatus === 'idle' && (
        <>
          <Globe size={48} style={{ opacity: 0.4 }} />
          <span style={{ fontSize: 14, opacity: 0.7 }}>pi-web 已就绪</span>
          <button className="btn btn-primary" onClick={handleStart}>
            <Play size={14} /> 启动 pi-web
          </button>
        </>
      )}
      {localStatus === 'starting' && (
        <>
          <Loader size={32} className="spin" style={{ opacity: 0.5 }} />
          <span style={{ fontSize: 14, opacity: 0.7 }}>正在启动 pi-web...</span>
        </>
      )}
      {localStatus === 'error' && (
        <>
          <AlertTriangle size={32} style={{ color: 'var(--warn, #eab308)' }} />
          <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{error}</span>
          <button className="btn btn-primary" onClick={handleStart}>
            <Play size={14} /> 重试
          </button>
        </>
      )}
    </div>
  )
}