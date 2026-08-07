import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Image, Loader2, Save, FolderOpen, Upload, Square, Wand2, Trash2, ChevronDown, Play, AlertTriangle, X, Sparkles } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useImageStore, type ImageGenItem } from '../store/imageStore'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { paramSetOf } from '../utils/engine'
import CustomSelect from './CustomSelect'
import '../styles/imagegen.css'

// ── 图像生成视图：调用运行中的 stable-diffusion.cpp sd-server ────
// sd-server 提供 stable-diffusion-webui 兼容的 /sdapi/v1/txt2img 与 /sdapi/v1/img2img 接口。
// 使用前提：在「我的模板」中创建 stable-diffusion.cpp 引擎的模板并启动（卡片变绿）。
type HistoryItem = ImageGenItem

const toImageDataUrl = (b64: string): string =>
  b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`

// 单张上传上限（图生图 init image），超出直接拒绝，避免超大 base64 撑爆内存
const MAX_INIT_IMAGE_MB = 25

export default function ImageGenView() {
  const cards = useStore(s => s.cards)
  const backends = useStore(s => s.backends)
  const setView = useStore(s => s.setView)
  const paths = useStore(s => s.paths)

  // 所有 stable-diffusion.cpp 卡片（不区分是否运行）：
  // 参数面板始终可用，未启动时顶部显示启动提示；运行中的用于生成。
  // 参数集可能显式设在模板上，也可能由后端类型推断
  const sdCards = useMemo(() => cards.filter(c => {
    const b = backends.find(x => x.name === c.template.backendVersion)
    return paramSetOf(c.template.paramSet ?? b?.kind) === 'sdcpp'
  }), [cards, backends])

  // 正在运行的 sd-server 卡片（ready 仅作展示，不参与筛选）
  const runningSdCards = useMemo(() => sdCards.filter(c => c.status === 'running'), [sdCards])

  const [selectedId, setSelectedId] = useState('')
  // 列表变化时自动选中第一个运行中的卡片，否则选中第一个卡片
  useEffect(() => {
    if (sdCards.length === 0) { setSelectedId(''); return }
    if (!sdCards.some(c => c.template.id === selectedId)) {
      setSelectedId((runningSdCards[0] ?? sdCards[0]).template.id)
    }
  }, [sdCards, runningSdCards, selectedId])

  const selectedCard = sdCards.find(c => c.template.id === selectedId) || null
  const isRunning = selectedCard?.status === 'running'
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

  // ── 生成过程 / 结果：全局 store（切换导航卸载组件也不丢，返回可继续展示）──
  const generating = useImageStore(s => s.generating)
  const results = useImageStore(s => s.results)
  const lastGenInfo = useImageStore(s => s.lastGen)
  const error = useImageStore(s => s.error)
  const elapsed = useImageStore(s => s.elapsed)
  const progress = useImageStore(s => s.progress)
  const progressPreview = useImageStore(s => s.progressPreview)
  const setResults = useImageStore(s => s.setResults)
  const history = useImageStore(s => s.history)
  const setHistory = useImageStore(s => s.setHistory)
  const startInProgress = useImageStore(s => s.startInProgress)
  const stopInProgress = useImageStore(s => s.stopInProgress)
  const setImgError = useImageStore(s => s.setError)

  const [showHistory, setShowHistory] = useState(false)
  const [showReco, setShowReco] = useState(false)

  // 大图预览（点击结果图放大）
  const [lightbox, setLightbox] = useState<string | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

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

  // 让生成面板与「服务端当前配置 / 模板启动参数」保持一致。
  // 稳定观察到：每次生成请求都会显式带上面板参数并覆盖服务端默认值，因此面板与启动参数本是两套独立数据；
  // 这里在切换到某服务、且服务就绪时，把服务端 /sdapi/v1/options 的有效值回填到面板，保证二者一致。
  const templatesArgs = selectedCard?.template.args
  useEffect(() => {
    let cancelled = false
    const argsLoaded = {} as Record<string, boolean>
    const pick = (k: string) => argsLoaded[k]

    const apply = (patch: Record<string, string | number>) => {
      if (cancelled) return
      Object.entries(patch).forEach(([k]) => { argsLoaded[k] = true })
      if (patch.steps !== undefined) setSteps(Number(patch.steps))
      if (patch.cfg !== undefined) setCfgScale(Number(patch.cfg))
      if (patch.width !== undefined) setWidth(Number(patch.width))
      if (patch.height !== undefined) setHeight(Number(patch.height))
      if (patch.seed !== undefined) setSeed(Number(patch.seed))
      if (patch.batch !== undefined) setBatchSize(Math.max(1, Number(patch.batch)))
      if (patch.sampler !== undefined) setSamplerName(String(patch.sampler))
      if (patch.scheduler !== undefined) setScheduler(String(patch.scheduler))
      if (patch.denoise !== undefined) setDenoisingStrength(Number(patch.denoise))
    }

    // 1) 模板启动参数 → 面板（即使服务未运行也生效）
    const args = (templatesArgs || {}) as Record<string, string | number | boolean | null>
    const num = (v: string | number | boolean | null) => (v === undefined || v === null || v === '' ? undefined : Number(v))
    const patchFromArgs: Record<string, string | number> = {}
    const A = args
    if (num(A['--steps']) !== undefined) patchFromArgs.steps = num(A['--steps'])!
    if (num(A['--cfg-scale']) !== undefined) patchFromArgs.cfg = num(A['--cfg-scale'])!
    if (num(A['--width']) !== undefined) patchFromArgs.width = num(A['--width'])!
    if (num(A['--height']) !== undefined) patchFromArgs.height = num(A['--height'])!
    if (num(A['--seed']) !== undefined) patchFromArgs.seed = num(A['--seed'])!
    if (num(A['--batch-size']) !== undefined) patchFromArgs.batch = num(A['--batch-size'])!
    if (A['--sampler'] !== null && A['--sampler'] !== undefined && A['--sampler'] !== '') patchFromArgs.sampler = String(A['--sampler'])
    if (A['--scheduler'] !== null && A['--scheduler'] !== undefined && A['--scheduler'] !== '') patchFromArgs.scheduler = String(A['--scheduler'])
    if (num(A['--denoise-strength']) !== undefined) patchFromArgs.denoise = num(A['--denoise-strength'])!
    apply(patchFromArgs)

    // 2) 服务就绪时：读取 sd-server 的有效配置并回填（这些仍是显式覆盖，故仅在未手动改过的字段上生效）
    if (selectedCard?.ready && port) {
      safeCall(() => window.api.sdapiRequest({ port, path: '/sdapi/v1/options' }), '获取生成配置失败').then(res => {
        if (cancelled || !res?.ok || !res.data || typeof res.data !== 'object') return
        const d = res.data as Record<string, unknown>
        const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
        const patch: Record<string, string | number> = {}
        if (!pick('steps') && n(d.steps) !== undefined) patch.steps = n(d.steps)!
        if (!pick('cfg') && n(d.cfg_scale) !== undefined) patch.cfg = n(d.cfg_scale)!
        if (!pick('width') && n(d.width) !== undefined) patch.width = n(d.width)!
        if (!pick('height') && n(d.height) !== undefined) patch.height = n(d.height)!
        if (!pick('seed') && n(d.seed) !== undefined) patch.seed = n(d.seed)!
        if (!pick('batch') && n(d.batch_size) !== undefined) patch.batch = n(d.batch_size)!
        if (!pick('sampler') && typeof d.sampler_name === 'string') patch.sampler = String(d.sampler_name)
        if (!pick('scheduler') && typeof d.scheduler === 'string') patch.scheduler = String(d.scheduler)
        if (!pick('denoise') && n(d.denoising_strength) !== undefined) patch.denoise = n(d.denoising_strength)!
        apply(patch)
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedCard?.ready, port, templatesArgs])

  // 历史清单落盘：仅在磁盘有文件的记录写入（不内嵌 base64）
  useEffect(() => {
    const persistable = history
      .filter(h => h.file)
      .map(h => ({ file: h.file, prompt: h.prompt, createdAt: h.createdAt, meta: h.meta }))
    if (persistable.length === 0 && history.length === 0) return
    window.api.saveImagegenHistory(persistable).catch(() => {})
  }, [history])

  // 首次进入：从磁盘回读历史，按文件名回读图片后重建条目
  useEffect(() => {
    let cancelled = false
    window.api.loadImagegenHistory().then(async (raw) => {
      if (cancelled || !Array.isArray(raw)) return
      const loaded = await Promise.all(raw.slice(0, 60).map(async (entry: any) => {
        const file = typeof entry?.file === 'string' ? entry.file : ''
        if (!file) return null
        const dataUrl = await window.api.readImagegenImage(file).catch(() => null)
        if (!dataUrl) return null
        return {
          id: `hist-${file}`,
          prompt: typeof entry?.prompt === 'string' ? entry.prompt : '',
          dataUrl,
          file,
          meta: entry?.meta && typeof entry.meta === 'object' ? (entry.meta as ImageGenItem['meta']) : undefined,
          createdAt: typeof entry?.createdAt === 'number' ? entry.createdAt : Date.now()
        } as HistoryItem
      }))
      setHistory(prev => {
        const fresh = loaded.filter(Boolean) as HistoryItem[]
        // 与内存已有条目按 file 去重，内存优先
        const seen = new Set(prev.map(h => h.file))
        return [...prev, ...fresh.filter(h => h.file && !seen.has(h.file))].slice(0, 60)
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

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
    if (!selectedCard) { notify('请先在「我的模板」创建一个 stable-diffusion.cpp 模板', 'error'); return }
    if (!isRunning) { notify('该服务尚未运行，请先启动后再生成', 'error'); return }
    if (generating) return
    if (mode === 'img2img' && !initImage) { notify('图生图需要先上传一张图片', 'error'); return }
    setImgError('')
    setResults([])
    startInProgress()
    // 尝试轮询 /progress（sd-server 不一定实现，失败则静默只保留计时）
    const progressTimer = setInterval(async () => {
      try {
        const r = await window.api.sdapiRequest({ port, path: '/sdapi/v1/progress' })
        if (!r.ok || !r.data || typeof r.data !== 'object') return
        const d = r.data as any
        if (typeof d.progress === 'number' && d.progress >= 0) useImageStore.getState().setProgress(Math.min(1, Math.max(0, d.progress)))
        if (typeof d.current_image === 'string' && d.current_image) useImageStore.getState().setProgressPreview(toImageDataUrl(d.current_image))
      } catch { /* 服务端无该接口时忽略 */ }
    }, 1200)
    const path = mode === 'txt2img' ? '/sdapi/v1/txt2img' : '/sdapi/v1/img2img'
    const t0 = Date.now()
    try {
      const res = await window.api.sdapiRequest({ port, path, method: 'POST', body: buildBody() })
      if (!res.ok) {
        const msg = res.error
          ? (() => { try { const j = JSON.parse(res.error); return j.error || j.message || res.error } catch { return res.error } })()
          : `请求失败（${res.status ?? 'unknown'}）`
        setImgError(String(msg))
        notify(`图像生成失败：${String(msg).slice(0, 200)}`, 'error')
        return
      }
      const data = res.data as any
      const images: string[] = Array.isArray(data?.images) ? data.images : []
      if (images.length === 0) { setImgError('服务未返回图像'); return }
      const now = Date.now()
      // 服务端回填的实际参数（actual seed 等），便于文件名描述与复现
      const params = data?.parameters ?? {}
      const actualSeed = typeof params.seed === 'number' ? params.seed : undefined

      // 1) 自动保存到目录（文件名带参数，便于归档）
      let files: string[] | undefined
      const saveRes = await safeCall(() => window.api.saveImages({
        images,
        mode,
        seed: actualSeed ?? seed,
        steps,
        cfg: cfgScale,
        width,
        height,
        prompt,
        negativePrompt,
        sampler: samplerName || undefined,
        scheduler: scheduler || undefined,
        model: selectedCard?.template?.name
      }), '自动保存失败')
      if (saveRes && typeof saveRes === 'object') {
        const sr = saveRes as { ok: boolean; files?: string[] }
        files = sr.ok ? sr.files : undefined
      }

      const items: HistoryItem[] = images.map((b64, i) => ({
        id: `${now}-${i}`,
        prompt,
        dataUrl: toImageDataUrl(b64),
        file: files?.[i],
        meta: {
          mode,
          seed: actualSeed ?? seed,
          steps,
          cfg: cfgScale,
          width,
          height,
          sampler: samplerName || undefined,
          scheduler: scheduler || undefined
        },
        createdAt: now
      }))
      setResults(items)
      setHistory(prev => [...items, ...prev].slice(0, 60))
      // 服务端回填的实际参数（seed 等），便于复现同一张图
      useImageStore.getState().setLastGen({ seed: actualSeed, elapsedSec: Math.round((Date.now() - t0) / 1000) })
    } catch (e) {
      setImgError(String(e))
      notify(`图像生成失败：${e}`, 'error')
    } finally {
      clearInterval(progressTimer)
      stopInProgress()
    }
  }

  // 兜底保存：生成时已自动保存，这里作为图片文件缺失时的补救
  const handleSave = async (item: HistoryItem) => {
    const res = await safeCall(() =>
      window.api.saveImages({ images: [item.dataUrl], prompt: item.prompt }),
      '保存图片失败'
    )
    const file = res && typeof res === 'object' ? (res as { files?: string[] }).files?.[0] : undefined
    if (file) {
      const updated: HistoryItem = { ...item, file }
      setHistory(prev => prev.map(h => h.id === item.id ? updated : h))
      setResults(useImageStore.getState().results.map(r => r.id === item.id ? updated : r))
      notify(`已保存：${file}`, 'success')
    }
  }

  // 删除历史条目：从列表移除 + 删除磁盘文件 + 落盘
  const handleDeleteHistory = (item: HistoryItem) => {
    setHistory(prev => prev.filter(h => h.id !== item.id))
    setResults(useImageStore.getState().results.filter(r => r.id !== item.id))
    if (item.file) window.api.deleteImagegenImages([item.file]).catch(() => {})
  }

  const openImagesDir = () => {
    if (paths?.chatImages) window.api.openFolder(paths.chatImages)
  }

  // ── 渲染 ──
  if (sdCards.length === 0) {
    return (
      <div className="imagegen-empty">
        <Image size={48} style={{ opacity: 0.35 }} />
        <h3>还没有 stable-diffusion.cpp 模板</h3>
        <p>
          先在「我的模板」中创建一个 <b>stable-diffusion.cpp</b> 引擎的模板
          （需要先在「设置 → stable-diffusion.cpp 引擎」下载后端，以及一个扩散模型
          <code>.safetensors</code> 权重）。创建后回到本页面即可在此查看参数面板并启动生成。
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => setView('cards')}>前往我的模板</button>
          <button className="btn btn-secondary" onClick={() => setView('settings')}>前往设置</button>
        </div>
      </div>
    )
  }

  // 有模板但无一运行：参数面板照常展示，顶部显示醒目的启动提示
  const noRunning = runningSdCards.length === 0

  return (
    <div className="imagegen">
      {noRunning && (
        <div className="imagegen-notice">
          <AlertTriangle size={18} />
          <div className="imagegen-notice-text">
            <strong>当前没有正在运行的 stable-diffusion.cpp 服务</strong>
            <span>你可以先在这里设置好生成参数；选择下方「服务」后点击「启动」再生成，或前往「我的模板」启动。</span>
          </div>
          <button className="btn btn-primary" onClick={() => setView('cards')}>
            <Play size={14} /> 前往我的模板启动
          </button>
        </div>
      )}
      <div className="imagegen-header">
        <div className="imagegen-header-left">
          <h2 className="imagegen-title">图像生成</h2>
          <button className={`btn btn-sm imagegen-reco-btn ${showReco ? 'active' : ''}`} onClick={() => setShowReco(v => !v)}>
            <Sparkles size={14} /> 用户建议
          </button>
        </div>
        <div className="imagegen-server-select">
          <span className="text-muted text-sm">服务</span>
          <CustomSelect
            className="imagegen-server-select-wrap"
            buttonClass="imagegen-server-select-btn"
            panelClass="imagegen-dropdown-panel"
            itemClass="imagegen-dropdown-item"
            value={selectedId}
            onChange={setSelectedId}
            options={sdCards.map(c => ({
              value: c.template.id,
              label: `${c.template.name}（:${c.template.serverPort}${c.status !== 'running' ? ' · 未运行' : ''}）`
            }))}
            placeholder="选择服务"
          />
        </div>
        {selectedCard?.ready ? (
          <span className="badge-ready">● 就绪</span>
        ) : selectedCard && selectedCard.status !== 'running' ? (
          <span className="badge-warn">○ 未运行</span>
        ) : null}
      </div>

      {showReco && (
        <div className="imagegen-reco">
          <div className="imagegen-reco-head">
            <Sparkles size={15} />
            <strong>推荐模型 · Z-Image-Turbo</strong>
            <span className="imagegen-reco-tag">用户建议</span>
          </div>
          <div className="imagegen-reco-files">
            <code>z-image-turbo-Q4_K_M.gguf</code>
            <span>扩散主模型（Q4_K_M 量化）</span>
            <code>z-image-turbo ae.safetensors</code>
            <span>VAE 解码器</span>
            <code>Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf</code>
            <span>文本编码器</span>
          </div>
          <p className="imagegen-reco-note">将以上权重放入对应的模型文件夹，并在「我的模板」中指定后即可使用。</p>
        </div>
      )}
      <div className="imagegen-body">
        {/* ── 左侧：参数面板 ── */}
        <div className="imagegen-panel">
          <div className="imagegen-panel-scroll">
          <div className="imagegen-panel-head">
            <div className="launch-mode-row">
              <button type="button" className={`launch-mode-btn ${mode === 'txt2img' ? 'active' : ''}`} onClick={() => setMode('txt2img')}>
                文生图
              </button>
              <button type="button" className={`launch-mode-btn ${mode === 'img2img' ? 'active' : ''}`} onClick={() => setMode('img2img')}>
                图生图
              </button>
            </div>
            <span className="imagegen-panel-mode">{mode === 'txt2img' ? 'Text → Image' : 'Image → Image'}</span>
          </div>

          {mode === 'img2img' && (
            <div className="imagegen-section">
              <h3 className="imagegen-section-title">初始图片</h3>
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

          <div className="imagegen-section">
            <h3 className="imagegen-section-title">提示词</h3>
            <div className="imagegen-field">
              <textarea
                className="form-textarea imagegen-prompt"
                rows={4}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="描述你想生成的画面..."
              />
            </div>
            <div className="imagegen-field">
              <label className="form-label">负向提示词</label>
              <input className="form-input" value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} placeholder="blurry, low quality, watermark" />
            </div>
          </div>

          <div className="imagegen-section">
            <h3 className="imagegen-section-title">生成参数</h3>
            <div className="imagegen-grid">
              <div className="imagegen-field">
                <label className="form-label">步数</label>
                <input type="number" className="cmd-input num" value={steps} min={1} max={150} onChange={e => setSteps(Number(e.target.value) || 20)} />
              </div>
              <div className="imagegen-field">
                <label className="form-label">CFG</label>
                <input type="number" className="cmd-input num" value={cfgScale} min={1} max={30} step={0.5} onChange={e => setCfgScale(Number(e.target.value) || 7)} />
              </div>
              <div className="imagegen-field">
                <label className="form-label">宽</label>
                <input type="number" className="cmd-input num" value={width} min={64} max={2048} step={64} onChange={e => setWidth(Number(e.target.value) || 512)} />
              </div>
              <div className="imagegen-field">
                <label className="form-label">高</label>
                <input type="number" className="cmd-input num" value={height} min={64} max={2048} step={64} onChange={e => setHeight(Number(e.target.value) || 512)} />
              </div>
              <div className="imagegen-field">
                <label className="form-label">种子</label>
                <input type="number" className="cmd-input num" value={seed} onChange={e => setSeed(Number(e.target.value) || -1)}/>
              </div>
              <div className="imagegen-field">
                <label className="form-label">数量</label>
                <input type="number" className="cmd-input num" value={batchSize} min={1} max={8} onChange={e => setBatchSize(Math.max(1, Number(e.target.value) || 1))} />
              </div>
              <div className="imagegen-field">
                <label className="form-label">采样器</label>
                <CustomSelect
                  className="imagegen-select-wrap"
                  buttonClass="imagegen-select"
                  panelClass="imagegen-dropdown-panel"
                  itemClass="imagegen-dropdown-item"
                  value={samplerName}
                  onChange={setSamplerName}
                  options={samplers.length === 0 ? [{ value: '', label: '默认' }] : samplers.map(s => ({ value: s, label: s }))}
                  placeholder="默认"
                />
              </div>
              <div className="imagegen-field">
                <label className="form-label">调度器</label>
                <CustomSelect
                  className="imagegen-select-wrap"
                  buttonClass="imagegen-select"
                  panelClass="imagegen-dropdown-panel"
                  itemClass="imagegen-dropdown-item"
                  value={scheduler}
                  onChange={setScheduler}
                  options={schedulers.length === 0 ? [{ value: '', label: '默认' }] : schedulers.map(s => ({ value: s, label: s }))}
                  placeholder="默认"
                />
              </div>
              {mode === 'img2img' && (
                <div className="imagegen-field">
                  <label className="form-label">重绘强度</label>
                  <input type="number" className="cmd-input num" value={denoisingStrength} min={0} max={1} step={0.05} onChange={e => setDenoisingStrength(Number(e.target.value) || 0.75)} />
                </div>
              )}
            </div>
          </div>

          </div>

          <div className="imagegen-footer">
            <p className="imagegen-hint">
              提示：Z-Image-Turbo 等蒸馏模型建议 <b>8 步、CFG=1.0</b>；分辨率越大耗时与显存占用越高。
            </p>
            <button className="btn btn-primary imagegen-generate" onClick={handleGenerate} disabled={generating || !isRunning}>
              {!isRunning
                ? <><Play size={16} /> 请先启动服务</>
                : generating ? <><Loader2 size={16} className="spin" /> 生成中...</> : <><Wand2 size={16} /> {mode === 'txt2img' ? '生成图像' : '开始重绘'}</>}
            </button>
            {!isRunning && (
              <p className="text-muted text-sm" style={{ marginTop: 8 }}>
                当前选中的「{selectedCard?.template.name}」未运行，启动后才能生成图像。
              </p>
            )}
            {error && <div className="text-danger text-sm" style={{ marginTop: 8 }}>{error}</div>}
          </div>
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
              <div className="imagegen-loading-box">
                <div className="imagegen-loading-head">
                  <Loader2 size={22} className="spin" />
                  <span>正在生成中…</span>
                  <span className="imagegen-elapsed">已用时 {elapsed}s</span>
                </div>

                {progress !== null && (
                  <div className="imagegen-progress">
                    <div className="imagegen-progress-bar">
                      <div className="imagegen-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                    <span className="imagegen-progress-text">{Math.round(progress * 100)}%</span>
                  </div>
                )}

                {progressPreview ? (
                  <div className="imagegen-loading-preview">
                    <img src={progressPreview} alt="中途预览" />
                    <span className="imagegen-loading-caption">采样进行中预览（图生图/部分模型支持）</span>
                  </div>
) : (
<div className="imagegen-skeleton-grid">
  {Array.from({ length: Math.max(1, batchSize) }).map((_, i) => (
    <div key={i} className="imagegen-skeleton" />
  ))}
</div>
)}

                <p className="imagegen-loading-note">
                  扩散采样通常需要 10~60 秒；过程不可中途取消，如需中断可到「我的模板」停止该服务。
                </p>
                <button className="btn btn-secondary btn-sm" onClick={() => setView('cards')}>
                  <Square size={13} /> 到「我的模板」停止服务
                </button>
              </div>
            </div>
          ) : results.length > 0 ? (
            <div className="imagegen-grid-results">
              {results.map(item => {
                const m = item.meta
                const chips = [
                  m?.mode === 'img2img' ? 'img2img' : 'txt2img',
                  m?.steps !== undefined ? `${m.steps} 步` : '',
                  m?.cfg !== undefined ? `CFG ${m.cfg}` : '',
                  m?.width && m?.height ? `${m.width}×${m.height}` : '',
                  m?.seed !== undefined ? `seed ${m.seed}` : '',
                  m?.sampler || '',
                  m?.scheduler || ''
                ].filter(Boolean)
                return (
                  <div key={item.id} className="imagegen-result-card">
                    <div className="imagegen-result-img">
                      <img src={item.dataUrl} alt={item.prompt} onClick={() => setLightbox(item.dataUrl)} />
                    </div>
                    <div className="imagegen-result-body">
                      <p className="imagegen-result-prompt" title={item.prompt}>{item.prompt}</p>
                      {chips.length > 0 && (
                        <div className="imagegen-result-chips">
                          {chips.map(c => <span key={c} className="imagegen-chip">{c}</span>)}
                        </div>
                      )}
                      {item.file && (
                        <p className="imagegen-result-file" title={item.file}>{item.file}</p>
                      )}
<div className="imagegen-result-actions">
  {(item.file || item.savedPath) ? (
    <span className="text-success" title={item.file || item.savedPath}>已保存</span>
  ) : (
    <button className="btn btn-primary btn-sm" onClick={() => handleSave(item)}>
      <Save size={13} /> 保存
    </button>
  )}
</div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="imagegen-placeholder">
              <Image size={40} style={{ opacity: 0.3 }} />
              <p>配置好参数后点击「生成图像」，结果会显示在这里。</p>
            </div>
          )}

          {showHistory && history.length > 0 && (
            <div className="imagegen-history">
              <h4>生成历史</h4>
              <div className="imagegen-history-grid">
                {history.map(h => (
                  <div key={h.id} className="imagegen-history-item">
                    <div className="imagegen-history-img">
                      <img src={h.dataUrl} alt={h.prompt.slice(0, 30)} title={h.prompt} onClick={() => setResults([h])} />
                      <button
                        className="imagegen-history-delete"
                        onClick={() => handleDeleteHistory(h)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <div className="imagegen-lightbox" onClick={() => setLightbox(null)}>
          <button className="imagegen-lightbox-close" onClick={() => setLightbox(null)} aria-label="关闭">
            <X size={22} />
          </button>
          <img src={lightbox} alt="放大预览" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
