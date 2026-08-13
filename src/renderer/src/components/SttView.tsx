import { useState, useRef, useEffect, useMemo } from 'react'
import { Mic, Loader2, FolderOpen, X, Copy, Check, TriangleAlert, AudioLines } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import ModelFileSelect from './ModelFileSelect'
import '../styles/tts.css'

// ── 语音转写视图：本地 ASR（llama-mtmd-cli.exe，libmtmd 多模态音频）──
// 选音频文件 → 本地模型转写 → 显示文本。不需要 whisper.cpp，
// 需要 2025 年底之后的新版 llama.cpp 构建（含 llama-mtmd-cli.exe）。
// 兼容 granite-speech / LFM2.5-Audio / Qwen3-Omni 等 mtmd 音频模型。
const DEFAULT_PROMPT = 'Transcribe the following audio to text.'

export default function SttView() {
  const models = useStore(s => s.models)
  const imageModels = useStore(s => s.imageModels)
  const activeBackend = useStore(s => s.activeBackend)
  const sttModelPath = useStore(s => s.sttModelPath)
  const setSttModelPath = useStore(s => s.setSttModelPath)
  const sttMmprojPath = useStore(s => s.sttMmprojPath)
  const setSttMmprojPath = useStore(s => s.setSttMmprojPath)
  const sttPrompt = useStore(s => s.sttPrompt)
  const setSttPrompt = useStore(s => s.setSttPrompt)
  const sttResult = useStore(s => s.sttResult)
  const setSttResult = useStore(s => s.setSttResult)

  const [audioPath, setAudioPath] = useState('')
  const [transcribing, setTranscribing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const sttIdRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLInputElement | null>(null)

  // 模型下拉与「语音合成」同源设计：模型来自「语音转写模型文件夹」（未配置时回退全部模型），
  // mmproj 来自「图片模型文件夹」（与模板 --mmproj 参数下拉同一来源）
  const asrPool = useMemo(() => {
    const asr = models.filter(m => m.asr)
    return asr.length > 0 ? asr : models
  }, [models])
  const modelItems = asrPool
  const mmprojItems = imageModels.length > 0 ? imageModels : models.filter(m => /mmproj/i.test(m.name))

  const ready = !!(sttModelPath && sttMmprojPath && audioPath && activeBackend?.path)

  // 卸载时停止转写
  useEffect(() => {
    return () => {
      if (sttIdRef.current) window.api.sttStop(sttIdRef.current).catch(() => { })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePickAudio = async () => {
    const res = await window.api.selectFiles()
    if (!res || !res.paths.length) return
    const p = res.paths[0]
    if (!/\.(wav|mp3|flac|ogg|m4a)$/i.test(p)) {
      notify('请选择音频文件（wav / mp3 / flac / ogg / m4a）', 'error')
      return
    }
    setAudioPath(p)
    setSttResult('')
    setError('')
  }

  const handleTranscribe = async () => {
    if (transcribing) {
      // 转写中再点 = 取消
      if (sttIdRef.current) window.api.sttStop(sttIdRef.current).catch(() => { })
      return
    }
    setError('')
    setSttResult('')
    const sttId = crypto.randomUUID()
    sttIdRef.current = sttId
    setTranscribing(true)
    const t0 = performance.now()
    const res = await window.api.sttTranscribe({
      id: sttId,
      backendPath: activeBackend?.path || '',
      modelPath: sttModelPath,
      mmprojPath: sttMmprojPath,
      audioPath,
      prompt: sttPrompt.trim() || DEFAULT_PROMPT,
    }).catch(err => ({ success: false as const, error: String(err) }))
    if (sttIdRef.current !== sttId) return // 已被取消/卸载
    sttIdRef.current = null
    setTranscribing(false)
    setElapsed(Math.round(performance.now() - t0))
    if (!res.success || !res.text) {
      setError(res.error || '未知错误')
      return
    }
    setSttResult(res.text)
  }

  const handleCopy = async () => {
    if (!sttResult) return
    try {
      await navigator.clipboard.writeText(sttResult)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  const handleReset = () => {
    setAudioPath('')
    setSttResult('')
    setError('')
  }

  return (
    <div className="tts-view">
      <div className="page-header">
        <div>
          <h1 className="page-title"><Mic size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />语音转写</h1>
          <p className="page-subtitle">
            基于 llama.cpp 多模态音频（llama-mtmd-cli）的全离线语音转文本，无需 whisper.cpp
          </p>
        </div>
      </div>

      <div className="tts-body">
        {/* 模型配置 */}
        <div className="tts-card">
          <div className="tts-card-title">模型配置</div>
          <div className="tts-model-row">
            <div className="tts-model-field">
              <span className="tts-field-label">语音转写模型</span>
              <ModelFileSelect
                value={sttModelPath}
                onChange={setSttModelPath}
                disabled={transcribing}
                items={modelItems}
                defaultLabel="选择转写模型（如 granite-4.0-1b-speech / LFM2.5-Audio）"
                ariaLabel="语音转写模型"
              />
            </div>
            <div className="tts-model-field">
              <span className="tts-field-label">音频投影（mmproj，必选）</span>
              <ModelFileSelect
                value={sttMmprojPath}
                onChange={setSttMmprojPath}
                disabled={transcribing}
                items={mmprojItems}
                defaultLabel="选择 mmproj（音频编码器 GGUF）"
                ariaLabel="语音转写音频投影"
              />
            </div>
          </div>
          {!activeBackend?.path && (
            <div className="tts-hint warn">
              <TriangleAlert size={13} />
              未检测到激活的后端，请先在后端管理中激活一个 llama.cpp 后端
            </div>
          )}
          {activeBackend?.path && (!sttModelPath || !sttMmprojPath) && (
            <div className="tts-hint warn">
              <TriangleAlert size={13} />
              请选择转写模型与 mmproj：模型在「设置 → 模型文件夹 → 语音转写模型文件夹」中配置，mmproj 在「图片模型文件夹」中配置。模型中心可搜索 Qwen3-ASR（ggml-org，含主模型与 mmproj 两个 GGUF）或 granite-4.0-1b-speech（ibm-granite）。注意：语音转写需要新版 llama.cpp 后端（2025 年底之后构建，含 llama-mtmd-cli.exe）
            </div>
          )}
        </div>

        {/* 音频输入 */}
        <div className="tts-card">
          <div className="tts-card-title">音频</div>
          <div className="tts-speaker-row">
            <input
              className="tts-speaker-input"
              type="text"
              value={audioPath}
              readOnly
              ref={audioRef}
              placeholder="未选择音频文件（wav / mp3 / flac / ogg / m4a）"
            />
            <button className="btn" onClick={handlePickAudio} disabled={transcribing}>
              <FolderOpen size={13} /> 选择音频…
            </button>
            {audioPath && (
              <button className="btn" onClick={handleReset} disabled={transcribing} title="清除音频">
                <X size={13} /> 清除
              </button>
            )}
          </div>

          <div className="tts-model-field" style={{ marginTop: 12 }}>
            <span className="tts-field-label">转写提示词（可自定义）</span>
            <textarea
              className="tts-textarea"
              value={sttPrompt}
              onChange={e => setSttPrompt(e.target.value.slice(0, 500))}
              placeholder={DEFAULT_PROMPT}
              rows={2}
              disabled={transcribing}
            />
          </div>

          <div className="tts-actions">
            <button
              className="btn btn-primary"
              onClick={handleTranscribe}
              disabled={!ready}
            >
              {transcribing ? (<><Loader2 size={14} className="spin" /> 转写中…点击取消</>) : (<><Mic size={14} /> 开始转写</>)}
            </button>
            {sttResult && !transcribing && (
              <button className="btn" onClick={handleCopy}>
                {copied ? (<><Check size={14} /> 已复制</>) : (<><Copy size={14} /> 复制文本</>)}
              </button>
            )}
            {sttResult && !transcribing && (
              <span className="tts-meta">耗时 {(elapsed / 1000).toFixed(1)}s</span>
            )}
          </div>
          {error && (
            <div className="tts-error">
              <TriangleAlert size={13} />
              <span>转写失败：{error}</span>
            </div>
          )}
        </div>

        {/* 转写结果 */}
        {sttResult && (
          <div className="tts-card">
            <div className="tts-card-title">
              <AudioLines size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              转写结果
            </div>
            <textarea
              className="tts-textarea"
              value={sttResult}
              readOnly
              rows={10}
              style={{ minHeight: 160, color: 'var(--text)' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
