import React, { useState, useEffect } from 'react'
import { ExternalLink, Copy, Check, RefreshCw, Loader } from 'lucide-react'

export default function ChatWindow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const [showIframe, setShowIframe] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [waiting, setWaiting] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const isValidUrl = (u: string): boolean => {
    try {
      const parsed = new URL(u)
      return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    } catch { return false }
  }

  useEffect(() => {
    if (!isValidUrl(url)) { setInvalid(true); setWaiting(false); return }
    let cancelled = false
    const urlObj = new URL(url)
    const port = parseInt(urlObj.port, 10)
    ;(async () => {
      const ready = await window.api.waitForServer(port)
      if (!cancelled) {
        setWaiting(false)
        if (ready) setShowIframe(true)
      }
    })()
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!waiting) { setElapsed(0); return }
    const id = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [waiting])

  const handleCopy = () => {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpen = () => {
    if (isValidUrl(url)) window.api.openExternal(url)
  }

  const handleReload = () => {
    if (!isValidUrl(url)) return
    setShowIframe(false)
    setWaiting(true)
    const urlObj = new URL(url)
    const port = parseInt(urlObj.port, 10)
    ;(async () => {
      const ready = await window.api.waitForServer(port)
      setWaiting(false)
      if (ready) {
        setReloadKey(prev => prev + 1)
        setShowIframe(true)
      }
    })()
  }

  return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: 'var(--bg)' }}>
      <div style={{ height: 48, WebkitAppRegion: 'drag', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', background: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>Hexllama - 聊天界面</div>
        <div style={{ WebkitAppRegion: 'no-drag', display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={handleReload}>
            <RefreshCw size={14} />
            重新连接
          </button>
          <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制链接'}
          </button>
          <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 13 }} onClick={handleOpen}>
            <ExternalLink size={14} />
            在浏览器打开
          </button>
        </div>
      </div>
      {invalid ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}>
          <span style={{ fontSize: 14 }}>无效的地址</span>
        </div>
      ) : !showIframe ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: 'var(--text-muted)' }}>
          {waiting ? (
            <>
              <Loader size={28} className="spin" style={{ opacity: 0.5 }} />
              <span style={{ fontSize: 14, opacity: 0.7 }}>等待服务器就绪{elapsed > 0 ? ` (${elapsed}s)` : ''}...</span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 14, opacity: 0.7 }}>无法连接到服务器。点击重新连接重试。</span>
            </>
          )}
        </div>
      ) : (
        <iframe key={reloadKey} src={url} style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }} title="Llama 聊天" />
      )}
    </div>
  )
}
