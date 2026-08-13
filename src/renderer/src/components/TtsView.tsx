import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AudioLines, Play, Square, Loader2, Download, Volume2, TriangleAlert, FolderOpen, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import ModelFileSelect from './ModelFileSelect'
import CustomSelect from './CustomSelect'
import '../styles/tts.css'

// ── 语音合成视图：本地模型 TTS（llama-tts）──
// 独立板块：与聊天朗读（纯系统语音）完全解耦。输入文本 → 离线生成 wav →
// 内置播放器试听 / 下载。
// 两种模式：
//  · Qwen3-TTS（新版单模型，llama-tts libmtmd 版）：多语言（含中文）+ 参考音频克隆音色，
//    不需要声码器；需要 2025 年底之后的新版 llama.cpp 后端
//  · OuteTTS + WavTokenizer（经典双模型）：仅支持英文（上游局限），界面已注明
const TTS_LANGS = [
  { value: 'zh', label: '中文（zh）' },
  { value: 'en', label: 'English（en）' },
  { value: 'de', label: 'Deutsch（de）' },
  { value: 'it', label: 'Italiano（it）' },
  { value: 'pt', label: 'Português（pt）' },
  { value: 'es', label: 'Español（es）' },
  { value: 'ja', label: '日本語（ja）' },
  { value: 'ko', label: '한국어（ko）' },
  { value: 'fr', label: 'Français（fr）' },
  { value: 'ru', label: 'Русский（ru）' },
]

export default function TtsView() {
  const models = useStore(s => s.models)
  const imageModels = useStore(s => s.imageModels)
  const activeBackend = useStore(s => s.activeBackend)
  const ttsModelPath = useStore(s => s.ttsModelPath)
  const setTtsModelPath = useStore(s => s.setTtsModelPath)
  const ttsVocoderPath = useStore(s => s.ttsVocoderPath)
  const setTtsVocoderPath = useStore(s => s.setTtsVocoderPath)
  const ttsMode = useStore(s => s.ttsMode)
  const setTtsMode = useStore(s => s.setTtsMode)
  const ttsLang = useStore(s => s.ttsLang)
  const setTtsLang = useStore(s => s.setTtsLang)
  const ttsMmprojPath = useStore(s => s.ttsMmprojPath)
  const setTtsMmprojPath = useStore(s => s.setTtsMmprojPath)
  const ttsSpeakerFile = useStore(s => s.ttsSpeakerFile)
  const setTtsSpeakerFile = useStore(s => s.setTtsSpeakerFile)
  const ttsWavDataUrl = useStore(s => s.ttsWavDataUrl)
  const setTtsWavDataUrl = useStore(s => s.setTtsWavDataUrl)
  const ttsWavSize = useStore(s => s.ttsWavSize)
  const setTtsWavSize = useStore(s => s.setTtsWavSize)
  const ttsGenMs = useStore(s => s.ttsGenMs)
  const setTtsGenMs = useStore(s => s.setTtsGenMs)

  const [text, setText] = useState('')
  const [generating, setGenerating] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [wavUrl, setWavUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsIdRef = useRef<string | null>(null)
  const autoPlayRef = useRef(false)

  const isQwen3 = ttsMode === 'qwen3'
  const ready = isQwen3
    ? !!(ttsModelPath && ttsMmprojPath && activeBackend?.path)
    : !!(ttsModelPath && ttsVocoderPath && activeBackend?.path)
  // 配置了语音合成模型文件夹时，下拉只列出其中的模型（OuteTTS / WavTokenizer / Qwen3-TTS 专用目录）；
  // 未配置时回退为全部模型，兼容把 TTS 模型放在 /models 或其他目录的用法
  const ttsPool = useMemo(() => {
    const tts = models.filter(m => m.tts)
    return tts.length > 0 ? tts : models
  }, [models])
  // 各下拉直接对应设置界面的文件夹扫描结果：
  // 模型/声码器来自「语音合成模型文件夹」（ttsPool，未配置时回退全部模型）；
  // mmproj 来自「图片模型文件夹」（imageModels）——与模板 --mmproj 参数下拉同一来源。
  // 不配置对应文件夹时下拉会缺项，请在 设置 → 模型文件夹 中配置
  const qwen3Items = ttsPool
  const mmprojItems = imageModels.length > 0 ? imageModels : models.filter(m => /mmproj/i.test(m.name))
  const outettsItems = ttsPool
  const vocoderItems = ttsPool
  // llama-tts（OuteTTS 经典模式）文本预处理仅保留英文字母，含 CJK 必失败（实测验证）；
  // Qwen3-TTS 模式原生多语言，无此限制
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

  // 从 store 中的 data URL 重建可播放/可下载的 blob URL；
  // 切换界面后 TtsView 卸载再挂载，音频结果仍然保留
  useEffect(() => {
    if (!ttsWavDataUrl) {
      setWavUrl(null)
      return
    }
    const base64 = ttsWavDataUrl.split(',')[1] ?? ''
    if (!base64) {
      setWavUrl(null)
      return
    }
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    setWavUrl(url)
    if (autoPlayRef.current) {
      autoPlayRef.current = false
      playUrl(url)
    }
    return () => URL.revokeObjectURL(url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsWavDataUrl])

  const handlePickSpeakerFile = async () => {
    const res = await window.api.selectFiles()
    if (!res || !res.paths.length) return
    const p = res.paths[0]
    if (!/\.(wav|mp3)$/i.test(p)) {
      notify('参考音频仅支持 wav / mp3', 'error')
      return
    }
    setTtsSpeakerFile(p)
  }

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
      vocoderPath: isQwen3 ? undefined : ttsVocoderPath,
      text: text.trim(),
      qwen3: isQwen3,
      lang: isQwen3 && ttsLang ? ttsLang : undefined,
      mmprojPath: isQwen3 && ttsMmprojPath ? ttsMmprojPath : undefined,
      speakerFile: isQwen3 && ttsSpeakerFile ? ttsSpeakerFile : undefined,
    }).catch(err => ({ success: false as const, error: String(err) }))
    if (ttsIdRef.current !== ttsId) return // 已被取消/卸载
    ttsIdRef.current = null
    setGenerating(false)
    if (!res.success || !('wavBase64' in res) || !res.wavBase64) {
      setError(res.error || '未知错误')
      return
    }
    const bytes = Uint8Array.from(atob(res.wavBase64), c => c.charCodeAt(0))
    setTtsWavSize(bytes.length)
    setTtsGenMs(Math.round(performance.now() - t0))
    setTtsWavDataUrl(`data:audio/wav;base64,${res.wavBase64}`)
    // 新生成 → 自动试听（由 data URL → blob URL 的 effect 统一构建后播放）
    autoPlayRef.current = true
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
          <p className="page-subtitle">
            {isQwen3
              ? '基于新版 llama-tts（libmtmd）的全离线文本转语音：Qwen3-TTS 单模型，多语言（含中文）+ 参考音频克隆音色'
              : '基于 llama-tts 的全离线文本转语音：OuteTTS 生成音频 token，WavTokenizer 声码器还原波形'}
          </p>
        </div>
      </div>

      <div className="tts-body">
        {/* 模型配置 */}
        <div className="tts-card">
          <div className="tts-card-title">模型配置</div>
          <div className="tts-mode-row" role="radiogroup" aria-label="TTS 模式">
            <button
              className={`tts-mode-option${isQwen3 ? ' active' : ''}`}
              onClick={() => setTtsMode('qwen3')}
              disabled={generating}
            >
              Qwen3-TTS <span className="tts-mode-tag">新版·单模型·多语言</span>
            </button>
            <button
              className={`tts-mode-option${!isQwen3 ? ' active' : ''}`}
              onClick={() => setTtsMode('outetts')}
              disabled={generating}
            >
              OuteTTS + WavTokenizer <span className="tts-mode-tag">经典·双模型</span>
            </button>
          </div>

          {isQwen3 ? (
            <>
              <div className="tts-model-row">
                <div className="tts-model-field">
                  <span className="tts-field-label">Qwen3-TTS 模型</span>
                  <ModelFileSelect
                    value={ttsModelPath}
                    onChange={setTtsModelPath}
                    disabled={generating}
                    items={qwen3Items}
                    defaultLabel="选择 Qwen3-TTS 模型（如 Qwen3-TTS-12Hz-1.7B-Base）"
                    ariaLabel="Qwen3-TTS 模型"
                  />
                </div>
                <div className="tts-model-field">
                  <span className="tts-field-label">语言</span>
                  <CustomSelect
                    value={ttsLang}
                    onChange={setTtsLang}
                    options={TTS_LANGS}
                    disabled={generating}
                    aria-label="TTS 语言"
                  />
                </div>
              </div>
              <div className="tts-model-field" style={{ marginTop: 12 }}>
                <span className="tts-field-label">音频投影（mmproj，必选）</span>
                <ModelFileSelect
                  value={ttsMmprojPath}
                  onChange={setTtsMmprojPath}
                  disabled={generating}
                  items={mmprojItems}
                  defaultLabel="选择 mmproj（如 mmproj-Qwen3-TTS-12Hz-1.7B-Base-f16）"
                  ariaLabel="Qwen3-TTS 音频投影"
                />
              </div>
              <div className="tts-model-field" style={{ marginTop: 12 }}>
                <span className="tts-field-label">参考音频（可选，用于克隆音色）</span>
                <div className="tts-speaker-row">
                  <input
                    className="tts-speaker-input"
                    type="text"
                    value={ttsSpeakerFile}
                    readOnly
                    placeholder="未选择参考音频（使用默认音色）"
                  />
                  <button className="btn" onClick={handlePickSpeakerFile} disabled={generating}>
                    <FolderOpen size={13} /> 选择音频…
                  </button>
                  {ttsSpeakerFile && (
                    <button className="btn" onClick={() => setTtsSpeakerFile('')} disabled={generating} title="清除参考音频">
                      <X size={13} /> 清除
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="tts-model-row">
              <div className="tts-model-field">
                <span className="tts-field-label">OuteTTS 模型</span>
                <ModelFileSelect
                  value={ttsModelPath}
                  onChange={setTtsModelPath}
                  disabled={generating}
                  items={outettsItems}
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
                  items={vocoderItems}
                  defaultLabel="选择声码器（如 WavTokenizer-Large-75）"
                  ariaLabel="WavTokenizer 声码器"
                />
              </div>
            </div>
          )}
          {!ready && (
            <div className="tts-hint warn">
              <TriangleAlert size={13} />
              {activeBackend?.path
                ? isQwen3
                  ? '请选择 Qwen3-TTS 主模型与 mmproj：模型在「设置 → 模型文件夹 → 语音合成模型文件夹」中配置，mmproj 在「图片模型文件夹」中配置（模型中心搜索 Qwen3-TTS-12Hz，如 ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF，含主模型与 mmproj 两个 GGUF）。注意：Qwen3-TTS 需要新版 llama.cpp 后端（含多模态音频的 llama-tts，2025 年底之后构建）'
                  : '请先选择 OuteTTS 模型与 WavTokenizer 声码器（在「设置 → 模型文件夹 → 语音合成模型文件夹」中配置；模型中心搜索 OuteTTS-0.2-500M-GGUF 与 WavTokenizer，选 ggml-org 的 GGUF 版）'
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
            placeholder={isQwen3
              ? '输入要合成的文本（最多 500 字符）…\n中文与多语言均支持。\ne.g. 你好，这是完全离线的本地语音合成。'
              : '输入要合成的英文文本（最多 500 字符）…\ne.g. Hello, this is a fully offline text to speech demo.'}
            rows={5}
            disabled={generating}
          />
          <div className="tts-input-footer">
            <span className="tts-char-count">{text.length} / 500</span>
            {!isQwen3 && hasCjk && (
              <span className="tts-hint warn inline">
                <TriangleAlert size={13} />
                llama-tts 仅支持英文文本（上游局限），中文等非英文字符会被剥离导致生成失败；多语言请切换到 Qwen3-TTS 模式
              </span>
            )}
            {isQwen3 && ttsLang && (
              <span className="tts-hint inline">
                <Volume2 size={13} />
                当前语言：{TTS_LANGS.find(l => l.value === ttsLang)?.label ?? ttsLang}
              </span>
            )}
          </div>
          <div className="tts-actions">
            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={!ready || (!generating && (!text.trim() || (!isQwen3 && (!hasLetters || hasCjk))))}
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
                <span className="tts-meta">{(ttsWavSize / 1024).toFixed(0)} KB · 生成耗时 {(ttsGenMs / 1000).toFixed(1)}s</span>
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
