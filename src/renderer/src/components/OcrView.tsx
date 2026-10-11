import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Upload, X, Copy, Check, Loader2, FileText, Trash2, AlertCircle, ImageIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { parseOcrResult, boxesToText, type OcrBox } from '../utils/ocrBoxes'
import { renderMathInHtml } from './agent-code/utils/mathHtml'
import 'katex/dist/katex.min.css'
import '../styles/ocr.css'

/** 渲染公式前必须先转义：renderMathInHtml 只认分隔符，不负责转义 HTML */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// OCR 提示词保持极简，用官方原样的一个词 "OCR"。
// 实测（GLM-OCR / Baidu-OCR）：提示词越长输出越差——加坐标要求会让 Baidu-OCR 出现重复块、把整句拆开，
// 让 GLM-OCR 连文字都写坏；「图在前、文在后」还会让 Baidu-OCR 丢掉坐标。
// 用 "OCR" 时：Baidu-OCR 按它原生的 `text [x1,y1,x2,y2]内容` 行格式返回（自带坐标与标签），
// GLM-OCR 只返回纯文字。两种情况解析层都能处理。
const OCR_BOX_PROMPT = 'OCR'

// 本页只做「文字识别」一件事。「图片描述」模式已移除：
// 两者共用同一条请求管线、只差一句提示词，放在同一页里既容易让人误以为是两种识别能力，
// 也容易被当成 OCR 失败的备选路径。Agent Code 的聊天/编码模式另有自己的图片理解能力，与本页无关。

// 叠加层标签配色：常见标签用固定色，其余按标签名哈希取色（同一标签恒定同色）
const LABEL_COLORS: Record<string, string> = {
  title: '#dc2626',
  sub_title: '#9333ea',
  text: '#2563eb',
  table: '#16a34a',
  figure: '#db2777',
  image: '#9333ea'
}
const LABEL_PALETTE = ['#dc2626', '#2563eb', '#16a34a', '#db2777', '#9333ea', '#ea580c', '#0891b2', '#4f46e5']
const DEFAULT_BOX_COLOR = '#2563eb'

function labelColor(label?: string): string {
  if (!label) return DEFAULT_BOX_COLOR
  const key = label.toLowerCase()
  if (LABEL_COLORS[key]) return LABEL_COLORS[key]
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash)
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length]
}

export default function OcrView() {
  const cards = useStore(s => s.cards, shallow)
  const backends = useStore(s => s.backends, shallow)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [ocrResult, setOcrResult] = useState('')
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  // 拖拽悬停：整页都是投放区，这个状态同时驱动整页高亮与拖放区高亮
  const [dragOver, setDragOver] = useState(false)
  // 左右面板折叠：分隔条常驻，按钮寄生其中；两块不允许同时收起
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamIdRef = useRef<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  // 累积完整识别文本（onOcrChunk 回调里 state 是旧值，解析需用 ref）
  const ocrTextRef = useRef('')
  // 解析出的文字块（带位置）；null = 模型输出不是结构化 JSON（回退显示原文）
  const [ocrBoxes, setOcrBoxes] = useState<OcrBox[] | null>(null)
  // 图片真实尺寸：像素坐标归一化与分栏检测要用；用 ref 才能在只注册一次的流回调里读到最新值
  const imageSizeRef = useRef<{ w: number; h: number } | null>(null)
  // 解析过程中的提示（坐标混用、丢块、降级等）
  const [ocrWarnings, setOcrWarnings] = useState<string[]>([])
  // 结果列表悬停到哪一行，图上就只画那一行的框（null = 不画）
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const runningModel = cards.find(c => c.status === 'running')
  const port = runningModel?.template.serverPort
  // OCR 走 llama.cpp 原生 /completion 多模态端点，TensorSharp 不提供 → 提示而非请求
  const runningIsTensorSharp = runningModel
    ? backends.find(b => b.name === runningModel.template.backendVersion)?.kind === 'tensorsharp'
    : false

  // 解析入口。注意：它会被下面只注册一次的流回调捕获（闭包定格在首帧），
  // 所以这里只允许读 ref 与稳定的 setter，不要引用 state / props，否则会读到旧值。
  function runParse(text: string): OcrBox[] | null {
    const size = imageSizeRef.current
    const res = parseOcrResult(text, { imageWidth: size?.w, imageHeight: size?.h })
    setOcrWarnings(res.warnings)
    return res.boxes.length > 0 ? res.boxes : null
  }

  useEffect(() => {
    window.api.onOcrChunk((data) => {
      // 仅处理当前活动流的事件：停止后旧流残留的 delta/done 会误改新一轮状态
      if (data.streamId !== streamIdRef.current) return
      if (data.delta) {
        ocrTextRef.current += data.delta
        setOcrResult(ocrTextRef.current)
      }
      if (data.error) {
        setStatus('error')
        setErrorMsg(data.error)
        streamIdRef.current = null
      }
      if (data.done && !data.error) {
        setOcrBoxes(runParse(ocrTextRef.current))
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

  // 文字块叠加层要对齐到「图片本身」而不是容器：img 用 contain 会留黑边，
  // 所以这里量出图片的实际渲染矩形，叠加层再按它定位。
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [imgRect, setImgRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  const measure = useCallback(() => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img || !img.naturalWidth || !img.naturalHeight) {
      setImgRect(null)
      return
    }
    const cw = stage.clientWidth
    const ch = stage.clientHeight
    if (cw <= 0 || ch <= 0) return
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    setImgRect({ left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h })
  }, [])

  // 图片加载完成、容器尺寸变化（含面板折叠/窗口缩放）都要重量一次
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(stage)
    measure()
    return () => ro.disconnect()
  }, [measure, imageDataUrl])

  function loadImage(file: File) {
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件', 'error')
      return
    }
    setFileName(file.name)
    ocrTextRef.current = ''
    setOcrResult('')
    setOcrBoxes(null)
    setStatus('idle')
    setErrorMsg('')
    setOcrWarnings([])
    imageSizeRef.current = null
    setHoverIdx(null)
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      // 先量出真实尺寸：像素坐标要按图片实际宽高归一化，分栏检测也依赖它
      const img = new Image()
      img.onload = () => { imageSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight } }
      img.src = url
      setImageDataUrl(url)
    }
    reader.readAsDataURL(file)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    loadImage(files[0])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // 整页拖放：只在拖的是文件时才高亮；离开时用 contains 判断，避免在子元素间移动时反复闪烁
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setDragOver(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) loadImage(files[0])
  }, [])

  function clearAll() {
    setImageDataUrl(null)
    setFileName('')
    ocrTextRef.current = ''
    setOcrResult('')
    setOcrBoxes(null)
    setStatus('idle')
    setErrorMsg('')
    setOcrWarnings([])
    imageSizeRef.current = null
    setHoverIdx(null)
    if (streamIdRef.current) {
      window.api.abortOcrStream(streamIdRef.current)
      streamIdRef.current = null
    }
  }

  async function handleOcr() {
    if (!imageDataUrl || !port) return
    if (runningIsTensorSharp) {
      setStatus('error')
      setErrorMsg('OCR 需要 llama.cpp 引擎（/completion 端点）。TensorSharp 引擎不支持，请启动一张 llama.cpp 模型卡。')
      return
    }
    setOcrResult('')
    ocrTextRef.current = ''
    setOcrBoxes(null)
    setOcrWarnings([])
    // 上一轮的悬停项不能带到新结果上（否则新列表会无故显示某行悬停态）
    setHoverIdx(null)
    setStatus('processing')
    setErrorMsg('')
    const streamId = crypto.randomUUID()
    streamIdRef.current = streamId
    try {
      const res = await window.api.ocrStream({ streamId, port, image: imageDataUrl, prompt: OCR_BOX_PROMPT })
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
    // 已流出部分结果时置 done 保留展示（可复制）：置 idle 会让右侧面板
    // 退回占位图，「识别到需要的部分就停」拿不到已出的文字。
    if (ocrTextRef.current) {
      setOcrBoxes(runParse(ocrTextRef.current))
      setStatus('done')
    } else {
      setStatus('idle')
    }
  }

  function handleCopy() {
    if (!ocrResult) return
    const copyText = ocrBoxes && ocrBoxes.length > 0 ? boxesToText(ocrBoxes) : ocrResult
    navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const hasResult = status !== 'idle' && (ocrResult || status === 'processing')
  // 当前悬停项对应的框：只有它会被画到图上
  const hoverBox = hoverIdx !== null ? (ocrBoxes?.[hoverIdx] ?? null) : null
  // 识别结果里的数学公式用 KaTeX 渲染（模型常输出 \(...\) \[...\] $...$ 这类 LaTeX 分隔符）。
  // 先转义再渲染：转义不影响反斜杠与 $，但能挡住 OCR 文本里的尖括号被当成 HTML 注入。
  const boxHtml = useMemo(
    () => (ocrBoxes ?? []).map((b) => renderMathInHtml(escapeHtml(b.text))),
    [ocrBoxes]
  )
  // 状态胶囊：区分「未运行 / 引擎不支持 / 可用」三态
  const statusState = !port ? 'off' : runningIsTensorSharp ? 'warn' : 'on'
  const statusText = runningModel ? runningModel.template.name : '未运行模型'

  return (
    <div
      className={`ocr-view${dragOver ? ' page-drop' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="page-header">
        <div>
          <h1 className="page-title">OCR 文字识别</h1>
          <p className="page-subtitle">上传图片，识别其中的文字内容</p>
        </div>
        <div className="ocr-header-right">
          <div
            className="ocr-status-pill"
            title={runningIsTensorSharp ? '当前引擎不支持 OCR，请启动一张 llama.cpp 模型卡' : statusText}
          >
            <span className={`ocr-status-dot ${statusState}`} />
            <span className="ocr-status-text">{statusText}</span>
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
      </div>

      {!port && (
        <div className="ocr-notice">
          <AlertCircle size={16} />
          没有运行中的模型。请先在「模型管理 」中启动一个支持多模态的模型。
        </div>
      )}

      {port && runningIsTensorSharp && (
        <div className="ocr-notice">
          <AlertCircle size={16} />
          当前运行的是 TensorSharp 引擎，OCR 功能仅支持 llama.cpp 引擎（/completion 端点）。
        </div>
      )}

      <div className="ocr-split">
        {/* ── 左：图片 ── */}
        <div className={`ocr-left-panel${leftCollapsed ? ' is-collapsed' : ''}`}>
          {!imageDataUrl ? (
            <div
              className={`ocr-dropzone${dragOver ? ' dragover' : ''}`}
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
                <button className="btn btn-ghost btn-icon" onClick={clearAll}>
                  <X size={14} />
                </button>
              </div>
              <div className={`ocr-image-preview${status === 'processing' ? ' scanning' : ''}`}>
                <div className="ocr-image-stage" ref={stageRef}>
                  <img ref={imgRef} src={imageDataUrl} alt="预览" onLoad={measure} />
                  {/* 只画当前悬停的那一块：识别结果里滑到哪一行，图上才出现哪一行的框。
                      位置用 0-1000 归一化坐标换算成百分比，叠加层已对齐到图片实际渲染区域。 */}
                  {imgRect && hoverBox && hoverBox.hasBox && (
                    <div
                      className="ocr-bbox-layer"
                      style={{ left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height }}
                    >
                      <span
                        className="ocr-bbox"
                        style={{
                          left: `${hoverBox.n.x1 / 10}%`,
                          top: `${hoverBox.n.y1 / 10}%`,
                          width: `${(hoverBox.n.x2 - hoverBox.n.x1) / 10}%`,
                          height: `${(hoverBox.n.y2 - hoverBox.n.y1) / 10}%`,
                          '--bbox': labelColor(hoverBox.label)
                        } as React.CSSProperties}
                      >
                        {/* 标签牌：贴近图片顶边（放不下约 16px）时改放框内，避免被裁掉 */}
                        {hoverBox.label && (
                          <span
                            className={`ocr-bbox-label${(imgRect.height * hoverBox.n.y1) / 1000 < 16 ? ' inside' : ''}`}
                            style={{ background: labelColor(hoverBox.label) }}
                          >
                            {hoverBox.label}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
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
                  {status === 'processing' ? '识别中...' : '开始识别'}
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

        {/* ── 面板分隔条：折叠按钮寄生在这里，不额外占工具栏 ── */}
        <div className="ocr-divider">
          <button
            type="button"
            className="ocr-divider-btn"
            disabled={rightCollapsed}
            title={leftCollapsed ? '展开图片面板' : '收起图片面板'}
            onClick={() => setLeftCollapsed(v => !v)}
          >
            {leftCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
          <button
            type="button"
            className="ocr-divider-btn"
            disabled={leftCollapsed}
            title={rightCollapsed ? '展开结果面板' : '收起结果面板'}
            onClick={() => setRightCollapsed(v => !v)}
          >
            {rightCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>

        {/* ── 右：结果 ── */}
        <div className={`ocr-right-panel${rightCollapsed ? ' is-collapsed' : ''}`}>
          {!hasResult ? (
            <div className="ocr-placeholder">
              <div className="ocr-placeholder-icon-wrap">
                <ImageIcon size={26} />
              </div>
              <span className="ocr-placeholder-title">还没有识别结果</span>
              <span className="ocr-placeholder-hint">
                把图片拖到页面任意位置，或点击左侧区域选择文件
              </span>
              <div className="ocr-placeholder-tags">
                <span className="ocr-tag">PNG</span>
                <span className="ocr-tag">JPG</span>
                <span className="ocr-tag">WebP</span>
              </div>
            </div>
          ) : (
            <div className="ocr-result-card">
              <div className="ocr-result-header">
                <span className="ocr-result-title">识别结果</span>
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
                {status === 'done' && ocrWarnings.length > 0 && (
                  <div className="ocr-warn-inline">{ocrWarnings.join('；')}</div>
                )}
                {status === 'error' && errorMsg && (
                  <div className="ocr-error-inline">
                    <AlertCircle size={14} />
                    {errorMsg}
                  </div>
                )}
                {status === 'processing' && !ocrTextRef.current && (
                  <span className="ocr-result-placeholder">等待识别结果...</span>
                )}
                {status === 'processing' && ocrTextRef.current && (
                  <span className="ocr-result-placeholder">正在识别文字及位置...</span>
                )}
                {status === 'done' && ocrBoxes && ocrBoxes.length > 0 && (
                  <div className="ocr-box-list">
                    {ocrBoxes.map((b, i) => (
                      <div
                        key={i}
                        className={`ocr-box-item${hoverIdx === i ? ' is-hover' : ''}`}
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(h => (h === i ? null : h))}
                      >
                        <span className="ocr-box-item-text" dangerouslySetInnerHTML={{ __html: boxHtml[i] ?? escapeHtml(b.text) }} />
                      </div>
                    ))}
                  </div>
                )}
                {ocrResult && !(ocrBoxes && ocrBoxes.length > 0) && (
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
