import React, { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { ExternalLink, Copy, Check, RefreshCw, Loader, X, Globe, Square } from 'lucide-react'
import '../styles/llama.css'

export default function LlamaChatView() {
  const { activeChatUrl, activeChatPort, clearActiveChat, setView } = useStore(
    s => ({ activeChatUrl: s.activeChatUrl, activeChatPort: s.activeChatPort, clearActiveChat: s.clearActiveChat, setView: s.setView }),
    shallow
  )
  const [copied, setCopied] = useState(false)
  const [reloadKey] = useState(0)
  const iframeKey = `${activeChatPort}-${reloadKey}`
  const [waiting, setWaiting] = useState(true)
  const [showIframe, setShowIframe] = useState(false)

  const checkServer = useCallback(async (port: number | null) => {
    if (!port) return
    setWaiting(true)
    setShowIframe(false)
    const ready = await safeCall(() => window.api.waitForServer(port), '连接服务器失败')
    setWaiting(false)
    if (ready) setShowIframe(true)
  }, [])

  useEffect(() => {
    if (!activeChatPort) {
      setShowIframe(false)
      setWaiting(false)
      return
    }
    setWaiting(true)
    setShowIframe(false)
    checkServer(activeChatPort)
  }, [activeChatPort, checkServer])

  const handleCopy = () => {
    if (!activeChatUrl) return
    navigator.clipboard.writeText(activeChatUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpenBrowser = () => {
    if (activeChatUrl) window.api.openExternal(activeChatUrl)
  }

  const handleReload = () => {
    if (activeChatPort) checkServer(activeChatPort)
  }

  const handleStop = async () => {
    const s = useStore.getState()
    const card = s.cards.find(c => c.template.serverPort === activeChatPort && c.status === 'running')
    if (!card) return
    // optimistic update: update UI immediately for zero-latency
    s.setCardStatus(card.template.id, 'idle')
    clearActiveChat()
    setView('cards')
    try {
      const res = await window.api.stopModel(card.template.id)
      if (!res.success) notify(`停止失败：${res.error}`, 'error')
    } catch (e) { console.error('停止模型失败', e) }
  }

  const handleClose = () => {
    clearActiveChat()
    setView('cards')
  }

  if (!activeChatUrl) {
    return (
      <div className="llama-empty">
        <button className="llama-empty-close" onClick={handleClose}>
          <X size={16} />
        </button>
        <Globe size={48} style={{ opacity: 0.4 }} />
        <span style={{ fontSize: 14, opacity: 0.7 }}>暂无活跃的聊天会话</span>
        <button className="btn btn-primary" onClick={() => setView('cards')}>
          前往启动模型
        </button>
      </div>
    )
  }

  return (
    <div className="llama-chat-container">
      <div className="llama-chat-header">
        <div className="llama-chat-header-left">
          <Globe size={16} />
          <span className="llama-chat-title">Llama-UI</span>
          <span className="llama-chat-url">{activeChatUrl}</span>
        </div>
        <div className="llama-chat-header-actions">
          <button className="btn btn-danger btn-sm" onClick={handleStop}>
            <Square size={13} /> 停止
          </button>
          <span className="llama-chat-sep" />
          <button className="btn btn-ghost btn-sm" onClick={handleReload}>
            <RefreshCw size={13} />
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleCopy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleOpenBrowser}>
            <ExternalLink size={13} />
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="llama-chat-body">
        {!showIframe ? (
          <div className="llama-chat-status">
            {waiting ? (
              <div className="llama-waiting">
                <Loader size={28} className="spin" style={{ opacity: 0.5 }} />
                <span>正在连接服务器…</span>
              </div>
            ) : (
              <>
                <span>无法连接到服务器</span>
                <button className="btn btn-secondary btn-sm" onClick={handleReload}>
                  <RefreshCw size={13} /> 重新连接
                </button>
              </>
            )}
          </div>
        ) : (
          <iframe key={iframeKey} src={activeChatUrl} className="llama-chat-iframe" title="Llama Chat" />
        )}
      </div>
    </div>
  )
}
