import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { paramSetOf } from '../utils/engine'
import { safeCall } from '../utils/safeCall'
import CustomSelect from './CustomSelect'
import { AudioLines, ExternalLink, RotateCw, Power, CircleStop, LayoutGrid, TriangleAlert } from 'lucide-react'
import '../styles/audiocpp.css'

export default function AudioCppView() {
  const cards = useStore(s => s.cards)
  const backends = useStore(s => s.backends)
  const setView = useStore(s => s.setView)
  const setCardStatus = useStore(s => s.setCardStatus)

  // 所有 audio.cpp 卡片（参数集显式在模板上，或由后端类型推断）
  const audioCards = useMemo(() => cards.filter(c => {
    const b = backends.find(x => x.name === c.template.backendVersion)
    return paramSetOf(c.template.paramSet ?? b?.kind) === 'audiocpp'
  }), [cards, backends])

  const runningAudioCards = useMemo(() => audioCards.filter(c => c.status === 'running'), [audioCards])

  const [selectedId, setSelectedId] = useState('')
  // 列表变化时自动选中第一个运行中的卡片；没有正在运行的卡片则保持空（显示占位，不默认选中某个未启动的服务）
  useEffect(() => {
    if (audioCards.length === 0) { setSelectedId(''); return }
    if (!audioCards.some(c => c.template.id === selectedId)) {
      setSelectedId(runningAudioCards[0]?.template.id ?? '')
    }
  }, [audioCards, runningAudioCards, selectedId])

  const selectedCard = audioCards.find(c => c.template.id === selectedId) || null
  const isRunning = selectedCard?.status === 'running'
  const port = selectedCard?.template.serverPort || 8088
  const url = `http://127.0.0.1:${port}`

  // iframe 刷新：改 key 强制重挂载
  const [frameKey, setFrameKey] = useState(0)
  const reloadFrame = useCallback(() => setFrameKey(k => k + 1), [])

  const [stopping, setStopping] = useState(false)
  const handleStop = useCallback(async (cardId: string) => {
    if (stopping) return
    setStopping(true)
    try {
      await safeCall(() => window.api.stopModel(cardId), '停止 audio.cpp 失败')
      await new Promise(r => setTimeout(r, 300))
      setCardStatus(cardId, 'idle')
      reloadFrame()
    } finally {
      setStopping(false)
    }
  }, [stopping, setCardStatus, reloadFrame])

  if (audioCards.length === 0) {
    return (
      <div className="audiocpp">
        <div className="audiocpp-header">
          <div className="audiocpp-header-left">
            <h2 className="audiocpp-title"><AudioLines size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />音频工作室</h2>
          </div>
        </div>
        <div className="audiocpp-empty">
          <LayoutGrid size={42} className="audiocpp-empty-icon" />
          <h3>还没有 audio.cpp 引擎</h3>
          <p>在「后端与引擎」中下载 audio.cpp（0xShug0/audio.cpp），或在「我的模板」中创建一个 audio.cpp 模板并启动它。</p>
          <button className="btn btn-primary" onClick={() => setView('engines')}>前往后端与引擎</button>
        </div>
      </div>
    )
  }

  return (
    <div className="audiocpp">
      <div className="audiocpp-header">
        <div className="audiocpp-header-left">
          <h2 className="audiocpp-title"><AudioLines size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />音频工作室</h2>
          <span className="audiocpp-subtitle">audio.cpp — TTS · ASR · 音乐 · 声音克隆 (内嵌官方 WebUI)</span>
        </div>
        <div className="audiocpp-header-right">
          <label className="audiocpp-server-label">audio.cpp 服务</label>
          <CustomSelect
            className="audiocpp-server-select-wrap"
            buttonClass="audiocpp-server-select"
            value={selectedId}
            onChange={setSelectedId}
            placeholder="没有运行中的服务"
            aria-label="audio.cpp 服务"
            options={runningAudioCards.map(c => ({
              value: c.template.id,
              label: `${c.template.name}（:${c.template.serverPort || 8088} · 运行中）`
            }))}
          />
          <span className={`status-dot ${isRunning ? 'ready' : 'idle'}`} />
          <button className={`btn btn-sm ${isRunning ? '' : 'btn-primary'}`} onClick={() => isRunning ? handleStop(selectedCard!.template.id) : setView('cards')} disabled={stopping}>
            {stopping ? <CircleStop size={13} /> : isRunning ? <Power size={13} /> : <Power size={13} />}
            {isRunning ? '停止' : '去启动'}
          </button>
          <button className="btn btn-sm" onClick={reloadFrame} title="刷新界面">
            <RotateCw size={13} />
          </button>
          <button className="btn btn-sm" onClick={() => window.api.openExternal(url)} title="在系统浏览器打开">
            <ExternalLink size={13} />外部浏览器
          </button>
        </div>
      </div>

      {isRunning ? (
        <div className="audiocpp-frame-wrap">
          <iframe
            key={`${selectedId}-${frameKey}`}
            className="audiocpp-frame"
            src={url}
            title="audio.cpp WebUI"
            allow="microphone; autoplay"
          />
        </div>
      ) : (
        <div className="audiocpp-empty">
          <TriangleAlert size={36} className="audiocpp-empty-warn" />
          <h3>服务未运行</h3>
          <p>当前没有正在运行的 audio.cpp 服务。在「我的模板」中启动一个 audio.cpp 模板，即可在下方使用完整的音频工作台（模型加载、TTS、语音转写、音乐生成等）。</p>
          <button className="btn btn-primary" onClick={() => setView('cards')}>前往「我的模板」启动</button>
        </div>
      )}
    </div>
  )
}