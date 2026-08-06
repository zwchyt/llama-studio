import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Image, Loader2, RefreshCw, Save, FolderOpen, Upload, Square, Wand2, Trash2, ChevronDown } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { paramSetOf } from '../utils/engine'
import '../styles/imagegen.css'

// ── 图像生成视图：调用运行中的 stable-diffusion.cpp sd-server ────
// sd-server 提供 stable-diffusion-webui 兼容的 /sdapi/v1/txt2img 与 /sdapi/v1/img2img 接口。
// 使用前提：在「我的模板」中创建 stable-diffusion.cpp 引擎的模板并启动（卡片变绿）。
interface HistoryItem {
  id: string
  prompt: string
  dataUrl: string
  savedPath?: string
  createdAt: number
}

const toImageDataUrl = (b64: string): string =>
  b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`

// 单张上传上限（图生图 init image），超出直接拒绝，避免超大 base64 撑爆内存
const MAX_INIT_IMAGE_MB = 25

export default function ImageGenView() {
  const cards = useStore(s => s.cards)
  const backends = useStore(s => s.backends)
  const setView = useStore(s => s.setView)
  const paths = useStore(s => s.paths)

  // 正在运行的 sd-server 卡片（stable-diffusion.cpp 引擎）。
  // 参数集可能显式设在模板上，也可能由后端类型推断；ready 仅作展示，不参与筛选
  const sdCards = useMemo(() => cards.filter(c => {
    if (c.status !== 'running') return false
    const b = backends.find(x => x.name === c.template.backendVersion)
    return paramSetOf(c.template.paramSet ?? b?.kind) === 'sdcpp'
  }), [cards, backends])

  const [selectedId, setSelectedId] = useState('')
  // 当 sd-server 列表变化时自动选中第一个
  useEffect(() => {
    if (sdCards.length === 0) { setSelectedId(''); return }
    if (!sdCards.some(c => c.template.id === selectedId)) setSelectedId(sdCards[0].template.id)
  }, [sdCards, selectedId])

  const selectedCard = sdCards.find(c => c.template.id === selectedId) || null
  const port = selectedCard?.template.serverPort ?? 0

  // ── 参数表单 ──
  const [mode, setMode] = useState<'txt2img' | 'img2img'>('txt2img')
  const [prompt, setPrompt] = useState('a lovely cat, masterpiece, best quality')
  const [negativePrompt, setNegativePrompt] = useState('blurry, low quality, watermark')
  const [steps, setSteps] = useState(20)
  const [cfgScale, setCfgScale] = useState(7)
  const [width, setWidth] = useState(512)
  const [height, setHeight] = useState(512)
  const [seed, setSeed] = useState(-1)
  const [batchSize, setBatchSize] = useState(1)
  const [samplerName, setSamplerName] = useState('')
  const [scheduler, setScheduler] = useState('')
  const [samplers, setSamplers] = useState<string[]>([])
  const [schedulers, setSchedulers] = useState<string[]>([])
  // 图生图
  const [initImage, setInitImage] = useState<string>('') // 纯 base64
  const [initPreview, setInitPreview] = useState<string>('') // dataURL 预览
  const [denoisingStrength, setDenoisingStrength] = useState(0.75)
  const fileRef = useRef<HTMLInputElement>(null)

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<HistoryItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  // 最近一次生成的实际参数（服务端回填，如实际 seed / 耗时），便于复现
  const [lastGenInfo, setLastGenInfo] = useState<{ seed?: number; elapsedSec?: number } | null>(null)

  // 拉取采样器 / 调度器列表（切换服务器时刷新）；返回是否至少成功拉取到一项
  const loadSamplers = useCallback(async (): Promise<boolean> => {
    if (!port) return false
    const [sRes, schRes] = await Promise.all([
      safeCall(() => window.api.sdapiRequest({ port, path: '/sdapi/v1/samplers' }), '获取采样器失败'),
      safeCall(() => window.api.sdapiRequest({ port, path: '/sdapi/v1/schedulers' }), '获取调度器失败')
    ])
    let ok = false
    if (sRes && sRes.ok && Array.isArray(sRes.data)) {
      const names = sRes.data.map((s: any) => String(s.name || s.label || '')).filter(Boolean)
      setSamplers(names)
      setSamplerName(prev => prev && names.includes(prev) ? prev : (names[0] || ''))
      ok = ok || names.length > 0
    }
    if (schRes && schRes.ok && Array.isArray(schRes.data)) {
      const names = schRes.data.map((s: any) => String(s.name || s.label || '')).filter(Boolean)
      setSchedulers(names)
      setScheduler(prev => prev && names.includes(prev) ? prev : (names[0] || ''))
      ok = ok || names.length > 0
    }
    return ok
  }, [port])

  // 首次进入 / 切换服务器：拉取采样器；服务刚启动没就绪时 2.5s 后自动重试一次
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    loadSamplers().then(ok => {
      if (!ok && !cancelled && port) {
        timer = setTimeout(() => { if (!cancelled) loadSamplers() }, 2500)
      }
    })
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [loadSamplers, port])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_INIT_IMAGE_MB * 1024 * 1024) {
      notify(`图片过大（>${MAX_INIT_IMAGE_MB}MB），请压缩后重试`, 'error')
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const comma = dataUrl.indexOf(',')
      setInitImage(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
      setInitPreview(dataUrl)
    }
    reader.readAsDataURL(file)
  }, [])

  const buildBody = useCallback(() => {
    const body: Record<string, unknown> = {
      prompt,
      negative_prompt: negativePrompt,
      steps,
      cfg_scale: cfgScale,
      width,
      height,
      seed,
      batch_size: batchSize,
      sampler_name: samplerName || undefined,
      scheduler: scheduler || undefined
    }
    if (mode === 'img2img') {
      body.init_images = initImage ? [initImage] : []
      body.denoising_strength = denoisingStrength
    }
    return body
  }, [prompt, negativePrompt, steps, cfgScale, width, height, seed, batchSize, samplerName, scheduler, mode, initImage, denoisingStrength])

  const handleGenerate = async () => {
    if (!selectedCard || !port) { notify('请先启动一个 stable-diffusion.cpp 服务', 'error'); return }
    if (generating) return
    if (mode === 'img2img' && !initImage) { notify('图生图需要先上传一张图片', 'error'); return }
    setError('')
    setResults([])
    setLastGenInfo(null)
    setGenerating(true)
    const path = mode === 'txt2img' ? '/sdapi/v1/txt2img' : '/sdapi/v1/img2img'
    const t0 = Date.now()
    try {
      const res = await window.api.sdapiRequest({ port, path, method: 'POST', body: buildBody() })
      if (!res.ok) {
        const msg = res.error
          ? (() => { try { const j = JSON.parse(res.error); return j.error || j.message || res.error } catch { return res.error } })()
          : `请求失败（${res.status ?? 'unknown'}）`
        setError(String(msg))
        notify(`图像生成失败：${String(msg).slice(0, 200)}`, 'error')
        return
      }
      const data = res.data as any
      const images: string[] = Array.isArray(data?.images) ? data.images : []
      if (images.length === 0) { setError('服务未返回图像'); return }
      const now = Date.now()
      const items: HistoryItem[] = images.map((b64, i) => ({
        id: `${now}-${i}`,
        prompt,
        dataUrl: toImageDataUrl(b64),
        createdAt: now
      }))
      setResults(items)
      setHistory(prev => [...items, ...prev].slice(0, 60))
      // 服务端回填的实际参数（seed 等），便于复现同一张图
      const params = data?.parameters ?? {}
      const actualSeed = typeof params.seed === 'number' ? params.seed : undefined
      setLastGenInfo({ seed: actualSeed, elapsedSec: Math.round((Date.now() - t0) / 1000) })
    } catch (e) {
      setError(String(e))
      notify(`图像生成失败：${e}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  // 统一保存：更新历史标记「已保存」，若该图还在当前结果区则同步标记，防止重复保存
  const handleSave = async (item: HistoryItem) => {
    const res = await safeCall(() => window.api.savePng(item.dataUrl), '保存图片失败')
    if (res && typeof res === 'string') {
      const updated = { ...item, savedPath: res }
      setHistory(prev => prev.map(h => h.id === item.id ? updated : h))
      setResults(prev => prev.map(r => r.id === item.id ? updated : r))
      notify(`已保存：${res}`, 'success')
    }
  }

  const openImagesDir = () => {
    if (paths?.chatImages) window.api.openFolder(paths.chatImages)
  }

  // ── 渲染 ──
  if (sdCards.length === 0) {
    return (
      <div className="imagegen-empty">
        <Image size={48} style={{ opacity: 0.35 }} />
        <h3>没有正在运行的 stable-diffusion.cpp 服务</h3>
        <p>
          先在「我的模板」中创建一个 <b>stable-diffusion.cpp</b> 引擎的模板并启动
          （需要先在「设置 → stable-diffusion.cpp 引擎」下载后端，以及一个扩散模型
          <code>.safetensors</code> 权重）。启动成功后回到本页面即可生成图像。
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => setView('cards')}>前往我的模板</button>
          <button className="btn btn-secondary" onClick={() => setView('settings')}>前往设置</button>
        </div>
      </div>
    )
  }

  return (
    <div className="imagegen">
      <div className="imagegen-header">
        <h2 className="imagegen-title">图像生成</h2>
        <div className="imagegen-server-select">
          <span className="text-muted text-sm">服务</span>
          <select
            className="cmd-select"
            style={{ minWidth: 260 }}
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
          >
            {sdCards.map(c => (
              <option key={c.template.id} value={c.template.id}>
                {c.template.name}（:{c.template.serverPort}）
              </option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" onClick={() => loadSamplers()} title="刷新采样器列表">
            <RefreshCw size={13} />
          </button>
        </div>
        {selectedCard?.ready && <span className="badge-ready">● 就绪</span>}
      </div>

      <div className="imagegen-body">
        {/* ── 左侧：参数面板 ── */}
        <div className="imagegen-panel">
          <div className="launch-mode-row" style={{ marginBottom: 12 }}>
            <button type="button" className={`launch-mode-btn ${mode === 'txt2img' ? 'active' : ''}`} onClick={() => setMode('txt2img')}>
              文生图
            </button>
            <button type="button" className={`launch-mode-btn ${mode === 'img2img' ? 'active' : ''}`} onClick={() => setMode('img2img')}>
              图生图
            </button>
          </div>

          {mode === 'img2img' && (
            <div className="imagegen-field">
              <label className="form-label">初始图片</label>
              <div className="imagegen-initimg">
                {initPreview ? (
                  <img src={initPreview} alt="init" className="imagegen-initimg-preview" />
                ) : (
                  <div className="imagegen-initimg-placeholder" onClick={() => fileRef.current?.click()}>
                    <Upload size={20} /> 点击上传图片
                  </div>
                )}
                {initPreview && (
                  <div className="imagegen-initimg-actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>更换</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setInitImage(''); setInitPreview('') }}>清除</button>
                  </div>
                )}
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
              </div>
            </div>
          )}

          <div className="imagegen-field">
            <label className="form-label">提示词 Prompt</label>
            <textarea
              className="form-textarea"
              rows={4}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="描述你想生成的画面..."
            />
          </div>

          <div className="imagegen-field">
            <label className="form-label">负向提示词 Negative Prompt</label>
            <input className="form-input" value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} />
          </div>

          <div className="imagegen-grid">
            <div className="imagegen-field">
              <label className="form-label">步数 Steps</label>
              <input type="number" className="cmd-input num" value={steps} min={1} max={150} onChange={e => setSteps(Number(e.target.value) || 20)} />
            </div>
            <div className="imagegen-field">
              <label className="form-label">CFG</label>
              <input type="number" className="cmd-input num" value={cfgScale} min={1} max={30} step={0.5} onChange={e => setCfgScale(Number(e.target.value) || 7)} />
            </div>
            <div className="imagegen-field">
              <label className="form-label">宽 Width</label>
              <input type="number" className="cmd-input num" value={width} min={64} max={2048} step={64} onChange={e => setWidth(Number(e.target.value) || 512)} />
            </div>
            <div className="imagegen-field">
              <label className="form-label">高 Height</label>
              <input type="number" className="cmd-input num" value={height} min={64} max={2048} step={64} onChange={e => setHeight(Number(e.target.value) || 512)} />
            </div>
            <div className="imagegen-field">
              <label className="form-label">种子 Seed</label>
              <input type="number" className="cmd-input num" value={seed} onChange={e => setSeed(Number(e.target.value) || -1)} title="-1 = 随机" />
            </div>
            <div className="imagegen-field">
              <label className="form-label">数量 Batch</label>
              <input type="number" className="cmd-input num" value={batchSize} min={1} max={8} onChange={e => setBatchSize(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div className="imagegen-field">
              <label className="form-label">采样器</label>
              <select className="cmd-select" value={samplerName} onChange={e => setSamplerName(e.target.value)}>
                {samplers.length === 0 && <option value="">默认</option>}
                {samplers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="imagegen-field">
              <label className="form-label">调度器</label>
              <select className="cmd-select" value={scheduler} onChange={e => setScheduler(e.target.value)}>
                {schedulers.length === 0 && <option value="">默认</option>}
                {schedulers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {mode === 'img2img' && (
              <div className="imagegen-field">
                <label className="form-label">重绘强度</label>
                <input type="number" className="cmd-input num" value={denoisingStrength} min={0} max={1} step={0.05} onChange={e => setDenoisingStrength(Number(e.target.value) || 0.75)} />
              </div>
            )}
          </div>

          <p className="imagegen-hint">
            提示：Z-Image-Turbo 等蒸馏模型建议 <b>8 步、CFG=1.0</b>；分辨率越大耗时与显存占用越高。
          </p>

          <button className="btn btn-primary imagegen-generate" onClick={handleGenerate} disabled={generating}>
            {generating ? <><Loader2 size={16} className="spin" /> 生成中...</> : <><Wand2 size={16} /> {mode === 'txt2img' ? '生成图像' : '开始重绘'}</>}
          </button>
          {error && <div className="text-danger text-sm" style={{ marginTop: 8 }}>{error}</div>}
        </div>

        {/* ── 右侧：结果区 ── */}
        <div className="imagegen-results">
          <div className="imagegen-results-header">
            <span className="text-muted text-sm">生成结果</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowHistory(!showHistory)}>
                <ChevronDown size={13} style={{ transform: showHistory ? 'rotate(180deg)' : 'none' }} /> 历史（{history.length}）
              </button>
              <button className="btn btn-secondary btn-sm" onClick={openImagesDir}>
                <FolderOpen size={13} /> 打开图片目录
              </button>
            </div>
          </div>

          {lastGenInfo && !generating && (
            <div className="imagegen-info">
              {lastGenInfo.seed !== undefined && <>实际种子 <b>{lastGenInfo.seed}</b></>}
              {lastGenInfo.elapsedSec !== undefined && (lastGenInfo.seed !== undefined ? ' · ' : '') + `耗时约 ${lastGenInfo.elapsedSec}s`}
            </div>
          )}

          {generating ? (
            <div className="imagegen-loading">
              <Loader2 size={32} className="spin" />
              <p>正在生成中，请稍候（扩散采样通常需要 10~60 秒）...</p>
              <p className="text-muted" style={{ fontSize: 12 }}>
                生成过程不可中途取消；如需中断可到「我的模板」停止该服务。
              </p>
              <button className="btn btn-secondary btn-sm" onClick={() => setView('cards')}>
                <Square size={13} /> 到「我的模板」停止服务
              </button>
            </div>
          ) : results.length > 0 ? (
            <div className="imagegen-grid-results">
              {results.map(item => (
                <div key={item.id} className="imagegen-result-card">
                  <img src={item.dataUrl} alt={`result ${item.prompt.slice(0, 30)}`} />
                  <div className="imagegen-result-actions">
                    {item.savedPath ? (
                      <span className="text-success" title={item.savedPath}>已保存</span>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => handleSave(item)}>
                        <Save size={13} /> 保存
                      </button>
                    )}
                    <a className="btn btn-secondary btn-sm" href={item.dataUrl} download={`sd-${Date.now()}.png`}>
                      下载
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="imagegen-placeholder">
              <Image size={40} style={{ opacity: 0.3 }} />
              <p>配置好参数后点击「生成图像」，结果会显示在这里。</p>
            </div>
          )}

          {showHistory && history.length > 0 && (
            <div className="imagegen-history">
              <h4>本次会话历史</h4>
              <div className="imagegen-history-grid">
                {history.map(h => (
                  <div key={h.id} className="imagegen-history-item">
                    <img src={h.dataUrl} alt={h.prompt.slice(0, 30)} title={h.prompt} onClick={() => setResults([h])} />
                    <div className="imagegen-history-actions">
                      {h.savedPath ? (
                        <span className="text-success" title={h.savedPath}>已保存</span>
                      ) : (
                        <button className="btn btn-secondary btn-sm" onClick={() => handleSave(h)}>
                          <Save size={12} /> 保存
                        </button>
                      )}
                      <button className="btn btn-secondary btn-sm" onClick={() => setResults([h])}>
                        查看
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setHistory(prev => prev.filter(x => x.id !== h.id))}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
