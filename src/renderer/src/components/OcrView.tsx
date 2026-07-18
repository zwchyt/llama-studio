import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Upload, X, Copy, Check, Loader2, FileText, Trash2, AlertCircle, ImageIcon } from 'lucide-react'
import { notify } from '../store/notificationStore'
import '../styles/ocr.css'

export default function OcrView() {
  const cards = useStore(s => s.cards, shallow)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [ocrResult, setOcrResult] = useState('')
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [mode, setMode] = useState<'ocr' | 'describe'>('ocr')
  const [customPrompt, setCustomPrompt] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamIdRef = useRef<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const runningModel = cards.find(c => c.status === 'running')
  const port = runningModel?.template.serverPort

  useEffect(() => {
    window.api.onOcrChunk((data) => {
      if (data.delta) {
        setOcrResult(prev => prev + data.delta)
      }
      if (data.error) {
        setStatus('error')
        setErrorMsg(data.error)
        streamIdRef.current = null
      }
      if (data.done && !data.error) {
        setStatus('done')
        streamIdRef.current = null
      }
    })
    return () => {
      window.api.removeOcrListeners()
      if (streamIdRef.current) {
        window.api.abortOcrStream(streamIdRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (resultRef.current) {
      resultRef.current.scrollTop = resultRef.current.scrollHeight
    }
  }, [ocrResult])

  function loadImage(file: File) {
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件', 'error')
      return
    }
    setFileName(file.name)
    setOcrResult('')
    setStatus('idle')
    setErrorMsg('')
    const reader = new FileReader()
    reader.onload = () => {
      setImageDataUrl(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    loadImage(files[0])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false) }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) loadImage(files[0])
  }, [])

  function clearAll() {
    setImageDataUrl(null)
    setFileName('')
    setOcrResult('')
    setStatus('idle')
    setErrorMsg('')
    if (streamIdRef.current) {
      window.api.abortOcrStream(streamIdRef.current)
      streamIdRef.current = null
    }
  }

  function handleModeChange(newMode: 'ocr' | 'describe') {
    if (newMode === mode) return
    setMode(newMode)
    if (newMode === 'describe' && !customPrompt) {
      setCustomPrompt('详细描述这张图片的内容')
    }
    if (status !== 'idle') {
      setOcrResult('')
      setStatus('idle')
      setErrorMsg('')
    }
  }

  async function handleOcr() {
    if (!imageDataUrl || !port) return
    setOcrResult('')
    setStatus('processing')
    setErrorMsg('')
    const streamId = crypto.randomUUID()
    streamIdRef.current = streamId
    try {
      const prompt = mode === 'ocr' ? '请识别这张图片中的文字' : (customPrompt || '详细描述这张图片的内容')
      const res = await window.api.ocrStream({ streamId, port, image: imageDataUrl, prompt, templateArgs: runningModel?.template.args })
      if (!res.success) {
        setStatus('error')
        setErrorMsg(res.error || 'OCR 请求失败')
        streamIdRef.current = null
      }
    } catch (e: any) {
      setStatus('error')
      setErrorMsg(e.message || 'OCR 请求异常')
      streamIdRef.current = null
    }
  }

  function handleAbort() {
    if (streamIdRef.current) {
      window.api.abortOcrStream(streamIdRef.current)
      streamIdRef.current = null
    }
    setStatus('idle')
  }

  function handleCopy() {
    if (!ocrResult) return
    navigator.clipboard.writeText(ocrResult)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const hasResult = status !== 'idle' && (ocrResult || status === 'processing')

  return (
    <div className="ocr-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">{mode === 'ocr' ? 'OCR 文字识别' : '图片描述'}</h1>
          <p className="page-subtitle">{mode === 'ocr' ? '上传图片，识别其中的文字内容' : '上传图片，AI 将描述其中的内容'}</p>
        </div>
        {status === 'done' && ocrResult && (
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={handleCopy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? '已复制' : '复制结果'}
            </button>
            <button className="btn btn-ghost" onClick={clearAll}>
              <Trash2 size={15} /> 清除
            </button>
          </div>
        )}
      </div>

      {!port && (
        <div className="ocr-notice">
          <AlertCircle size={16} />
          没有运行中的模型。请先在「我的模板」中启动一个支持多模态的模型。
        </div>
      )}

      {port && (
        <div className="ocr-mode-toggle">
          <button className={`ocr-mode-btn${mode === 'ocr' ? ' active' : ''}`} onClick={() => handleModeChange('ocr')}>文字识别</button>
          <button className={`ocr-mode-btn${mode === 'describe' ? ' active' : ''}`} onClick={() => handleModeChange('describe')}>图片描述</button>
        </div>
      )}
      {port && mode === 'describe' && (
        <input
          className="ocr-prompt-input"
          value={customPrompt}
          onChange={e => setCustomPrompt(e.target.value)}
          placeholder="输入自定义描述指令..."
        />
      )}

      <div className="ocr-split">
        {/* ── 左侧：图片 ── */}
        <div className="ocr-left-panel">
          {!imageDataUrl ? (
            <div
              className={`ocr-dropzone ${dragOver ? 'dragover' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
              <Upload size={36} className="ocr-dropzone-icon" />
              <span className="ocr-dropzone-text">拖拽或点击选择图片</span>
              <span className="ocr-dropzone-hint">PNG / JPG / WebP</span>
            </div>
          ) : (
            <div className="ocr-image-card">
              <div className="ocr-image-card-header">
                <FileText size={14} />
                <span className="ocr-image-name">{fileName}</span>
                <button className="btn btn-ghost btn-icon" onClick={clearAll} title="清除">
                  <X size={14} />
                </button>
              </div>
              <div className={`ocr-image-preview${status === 'processing' ? ' scanning' : ''}`}>
                <img src={imageDataUrl} alt="预览" />
                {status === 'processing' && (
                  <div className="ocr-scan-overlay">
                    {Array.from({ length: 7 * 12 }, (_, i) => (
                      <div key={i} className="ocr-scan-dot" style={{ animationDelay: `${Math.floor(i / 12) * 0.12}s` }} />
                    ))}
                  </div>
                )}
              </div>
              <div className="ocr-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleOcr}
                  disabled={status === 'processing' || !port}
                >
                  {status === 'processing' ? <Loader2 size={14} className="spin" /> : <FileText size={14} />}
                  {status === 'processing' ? `${mode === 'ocr' ? '识别' : '描述'}中...` : `开始${mode === 'ocr' ? '识别' : '描述'}`}
                </button>
                {status === 'processing' && (
                  <button className="btn btn-ghost" onClick={handleAbort}>
                    <X size={14} /> 停止
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── 右侧：结果 ── */}
        <div className="ocr-right-panel">
          {!hasResult ? (
            <div className="ocr-placeholder">
              <ImageIcon size={40} className="ocr-placeholder-icon" />
              <span className="ocr-placeholder-text">选择图片后开始{mode === 'ocr' ? '识别' : '描述'}</span>
              <span className="ocr-placeholder-hint">{mode === 'ocr' ? '识别' : '描述'}结果将显示在此处</span>
            </div>
          ) : (
            <div className="ocr-result-card">
              <div className="ocr-result-header">
                <span className="ocr-result-title">{mode === 'ocr' ? '识别结果' : '描述结果'}</span>
                {status === 'processing' && (
                  <span className="ocr-badge ocr-badge-processing">处理中...</span>
                )}
                {status === 'done' && (
                  <span className="ocr-badge ocr-badge-done">完成</span>
                )}
                {status === 'error' && (
                  <span className="ocr-badge ocr-badge-error">失败</span>
                )}
                {status === 'processing' && <Loader2 size={14} className="spin" />}
              </div>
              <div className="ocr-result-body" ref={resultRef}>
                {status === 'error' && errorMsg && (
                  <div className="ocr-error-inline">
                    <AlertCircle size={14} />
                    {errorMsg}
                  </div>
                )}
                {status === 'processing' && !ocrResult && (
                  <span className="ocr-result-placeholder">等待识别结果...</span>
                )}
                {ocrResult && (
                  <pre className="ocr-result-text">{ocrResult}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
