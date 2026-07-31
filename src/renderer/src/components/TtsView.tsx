import { useState, useRef, useEffect, useCallback } from 'react'
import { AudioLines, Play, Square, Loader2, Download, Volume2, TriangleAlert } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import ModelFileSelect from './ModelFileSelect'
import '../styles/tts.css'

// ── 语音合成视图：本地模型 TTS（llama-tts + OuteTTS + WavTokenizer）────
// 独立板块：与聊天朗读（纯系统语音）完全解耦。输入文本 → 离线生成 wav →
// 内置播放器试听 / 下载。llama-tts 仅支持英文文本（上游局限），界面已注明。
export default function TtsView() {
  const models = useStore(s => s.models)
  const activeBackend = useStore(s => s.activeBackend)
  const ttsModelPath = useStore(s => s.ttsModelPath)
  const setTtsModelPath = useStore(s => s.setTtsModelPath)
  const ttsVocoderPath = useStore(s => s.ttsVocoderPath)
  const setTtsVocoderPath = useStore(s => s.setTtsVocoderPath)

  const [text, setText] = useState('')
  const [generating, setGenerating] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [wavUrl, setWavUrl] = useState<string | null>(null)
  const [wavSize, setWavSize] = useState(0)
  const [genMs, setGenMs] = useState(0)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsIdRef = useRef<string | null>(null)

  const ready = !!(ttsModelPath && ttsVocoderPath && activeBackend?.path)
  // llama-tts 文本预处理仅保留英文字母，含 CJK 必失败（实测验证），提前拦截
  const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
  const hasLetters = /[a-zA-Z]/.test(text)

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause() } catch { /* ignore */ }
      audioRef.current = null
    }
    setPlaying(false)
  }, [])

  // 卸载时停止生成与播放，释放 blob URL
  useEffect(() => {
    return () => {
      if (ttsIdRef.current) window.api.ttsStop(ttsIdRef.current).catch(() => { })
      cleanupAudio()
      if (wavUrl) URL.revokeObjectURL(wavUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleGenerate = async () => {
    if (generating) {
      // 生成中再点 = 取消
      if (ttsIdRef.current) window.api.ttsStop(ttsIdRef.current).catch(() => { })
      return
    }
    setError('')
    cleanupAudio()
    const ttsId = crypto.randomUUID()
    ttsIdRef.current = ttsId
    setGenerating(true)
    const t0 = performance.now()
    const res = await window.api.ttsGenerate({
      id: ttsId,
      backendPath: activeBackend?.path || '',
      modelPath: ttsModelPath,
      vocoderPath: ttsVocoderPath,
      text: text.trim(),
    }).catch(err => ({ success: false as const, error: String(err) }))
    if (ttsIdRef.current !== ttsId) return // 已被取消/卸载
    ttsIdRef.current = null
    setGenerating(false)
    if (!res.success || !('wavBase64' in res) || !res.wavBase64) {
      setError(res.error || '未知错误')
      return
    }
    const bytes = Uint8Array.from(atob(res.wavBase64), c => c.charCodeAt(0))
    if (wavUrl) URL.revokeObjectURL(wavUrl)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    setWavUrl(url)
    setWavSize(bytes.length)
    setGenMs(Math.round(performance.now() - t0))
    // 生成完自动试听
    playUrl(url)
  }

  const playUrl = (url: string) => {
    cleanupAudio()
    const audio = new Audio(url)
    audioRef.current = audio
    audio.onended = () => setPlaying(false)
    audio.onerror = () => { setPlaying(false); notify('音频播放失败', 'error') }
    setPlaying(true)
    audio.play().catch(() => setPlaying(false))
  }

  const handleDownload = () => {
    if (!wavUrl) return
    const a = document.createElement('a')
    a.href = wavUrl
    a.download = `tts-${Date.now()}.wav`
    a.click()
  }

  return (
    <div className="tts-view">
      <div className="page-header">
        <div>
          <h1 className="page-title"><AudioLines size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />语音合成</h1>
          <p className="page-subtitle">基于 llama-tts 的全离线文本转语音：OuteTTS 生成音频 token，WavTokenizer 声码器还原波形</p>
        </div>
      </div>

      <div className="tts-body">
        {/* 模型配置 */}
        <div className="tts-card">
          <div className="tts-card-title">模型配置</div>
          <div className="tts-model-row">
            <div className="tts-model-field">
              <span className="tts-field-label">OuteTTS 模型</span>
              <ModelFileSelect
                value={ttsModelPath}
                onChange={setTtsModelPath}
                disabled={generating}
                items={models}
                defaultLabel="选择 OuteTTS 模型（如 OuteTTS-0.2-500M）"
                ariaLabel="OuteTTS 模型"
              />
            </div>
            <div className="tts-model-field">
              <span className="tts-field-label">WavTokenizer 声码器</span>
              <ModelFileSelect
                value={ttsVocoderPath}
                onChange={setTtsVocoderPath}
                disabled={generating}
                items={models}
                defaultLabel="选择声码器（如 WavTokenizer-Large-75）"
                ariaLabel="WavTokenizer 声码器"
              />
            </div>
          </div>
          {!ready && (
            <div className="tts-hint warn">
              <TriangleAlert size={13} />
              {activeBackend?.path
                ? '请先选择 OuteTTS 模型与 WavTokenizer 声码器（模型中心搜索 OuteTTS-0.2-500M-GGUF 与 WavTokenizer，选 ggml-org 的 GGUF 版）'
                : '未检测到激活的后端，请先在后端管理中激活一个 llama.cpp 后端'}
            </div>
          )}
        </div>

        {/* 文本输入 */}
        <div className="tts-card">
          <div className="tts-card-title">文本</div>
          <textarea
            className="tts-textarea"
            value={text}
            onChange={e => setText(e.target.value.slice(0, 500))}
            placeholder="输入要合成的英文文本（最多 500 字符）…&#10;e.g. Hello, this is a fully offline text to speech demo."
            rows={5}
            disabled={generating}
          />
          <div className="tts-input-footer">
            <span className="tts-char-count">{text.length} / 500</span>
            {hasCjk && (
              <span className="tts-hint warn inline">
                <TriangleAlert size={13} />
                llama-tts 仅支持英文文本（上游局限），中文等非英文字符会被剥离导致生成失败
              </span>
            )}
          </div>
          <div className="tts-actions">
            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={!ready || (!generating && (!text.trim() || !hasLetters || hasCjk))}
            >
              {generating ? (<><Loader2 size={14} className="spin" /> 生成中…点击取消</>) : (<><Volume2 size={14} /> 生成语音</>)}
            </button>
            {wavUrl && !generating && (
              <>
                <button className="btn" onClick={() => playing ? cleanupAudio() : playUrl(wavUrl)}>
                  {playing ? (<><Square size={14} /> 停止</>) : (<><Play size={14} /> 重新播放</>)}
                </button>
                <button className="btn" onClick={handleDownload}>
                  <Download size={14} /> 下载 wav
                </button>
                <span className="tts-meta">{(wavSize / 1024).toFixed(0)} KB · 生成耗时 {(genMs / 1000).toFixed(1)}s</span>
              </>
            )}
          </div>
          {error && (
            <div className="tts-error">
              <TriangleAlert size={13} />
              <span>生成失败：{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
