import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore, ModelFileInfo, ModelDownloadInfo } from '../store/useStore'

import {
  HardDrive, Download, Trash, Pause, Play, X, Link, FolderOpen,
  Pencil, Check, AlertCircle, Loader2, Search, Image as ImageIcon, FileSearch, FileText, AudioLines, ScanText
} from 'lucide-react'
import { formatBytes } from '../utils/format'
import { formatDownloadStatus } from '../utils/downloadFormat'
import { notify } from '../store/notificationStore'
import '../styles/models.css'
import { safeCall } from '../utils/safeCall'
function UrlDownloadModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [hfFiles, setHfFiles] = useState<{ name: string; size: number; downloadUrl: string }[]>([])
  const [error, setError] = useState('')
  function parseHfRepoId(url: string): string | null {
    const m = url.match(/huggingface\.co\/([^/]+\/[^/]+?)(?:\/|$)/)
    return m ? m[1] : null
  }
  function isDirectGguf(url: string) {
    return url.toLowerCase().includes('.gguf') || url.toLowerCase().includes('.ggml') || url.toLowerCase().includes('.bin')
  }
  async function handleAnalyze() {
    setError(''); setHfFiles([]); setLoading(true)
    try {
      if (isDirectGguf(url)) {
        const filename = url.split('/').pop()?.split('?')[0] || 'model.gguf'
        const folder = url.includes('huggingface.co') ? (parseHfRepoId(url)?.split('/').pop() || 'downloads') : 'downloads'
        await window.api.startModelDownload({ url, filename, modelFolder: folder })
        onClose()
      } else {
        const repoId = parseHfRepoId(url)
        if (!repoId) throw new Error('无法识别的 URL。请粘贴直接的 .gguf 链接或 HuggingFace 模型页面 URL。')
        const res = await window.api.hfGetFiles(repoId)
        if ('error' in res) throw new Error(res.error)
        setHfFiles(res)
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }
  async function handleDownloadFile(file: { name: string; downloadUrl: string }) {
    const repoId = parseHfRepoId(url) || 'downloads'
    await window.api.startModelDownload({ url: file.downloadUrl, filename: file.name, repoId, modelFolder: repoId.split('/').pop() })
    onClose()
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">通过 URL 下载</h2>
        </div>
        <div className="modal-body">
          <p className="form-hint" style={{ marginBottom: 12 }}>
            粘贴直接的 <strong>.gguf</strong> URL，或 HuggingFace 模型页面链接。<br />
            示例：<code>https://huggingface.co/TheBloke/Llama-2-7B-GGUF</code>
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" style={{ flex: 1 }} type="url" placeholder="https://..." value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAnalyze()} autoFocus />
            <button className="btn btn-primary" onClick={handleAnalyze} disabled={!url.trim() || loading}>
              {loading ? <Loader2 size={14} className="spin" /> : <Link size={14} />} 分析
            </button>
          </div>
          {error && <div className="hub-error" style={{ marginTop: 10 }}><AlertCircle size={14} />{error}</div>}
          {hfFiles.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="hub-detail-section-label">选择要下载的 GGUF 文件</div>
              {hfFiles.map(f => (
                <div key={f.name} className="hub-file-row" style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="hub-file-name" style={{ fontSize: 12 }}>{f.name}</div>
                    <div className="hub-file-size">{formatBytes(f.size)}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => handleDownloadFile(f)}>
                    <Download size={13} /> 下载
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}
function DownloadRow({ dl }: { dl: ModelDownloadInfo }) {
  const removeModelDownload = useStore(s => s.removeModelDownload)
  const isPaused = dl.phase === 'paused'
  const isDone = dl.phase === 'done'
  const isErr = dl.phase === 'error'
  
  const [pending, setPending] = useState<'pausing' | 'resuming' | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  async function togglePause() {
    if (isPaused) {
      setPending('resuming')
      const ok = await safeCall(() => window.api.resumeModelDownload(dl.id), '继续下载失败')
      if (ok === null) { setPending(null); return }
    } else {
      setPending('pausing')
      const ok = await safeCall(() => window.api.pauseModelDownload(dl.id), '暂停下载失败')
      if (ok === null) { setPending(null); return }
    }
    
    clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(() => setPending(null), 1500)
  }

  useEffect(() => {
    return () => clearTimeout(pendingTimerRef.current)
  }, [])
  async function cancel() {
    const ok = await safeCall(() => window.api.cancelModelDownload(dl.id), '取消下载失败')
    if (ok === null) return
    removeModelDownload(dl.id)
  }

  const showSpeed = dl.phase === 'downloading' && !pending && dl.speed && dl.speed > 0
  const statusLabel = pending === 'pausing'
    ? '暂停中…'
    : pending === 'resuming'
    ? '恢复中…'
    : formatDownloadStatus({ phase: dl.phase, percent: dl.percent, speed: showSpeed ? dl.speed : undefined })

  return (
    <div className={`models-dl-row ${isDone ? 'done' : ''} ${isErr ? 'error' : ''}`}>
      <div className="models-dl-meta">
        <span className="models-dl-name">{dl.filename}</span>
        <span className="models-dl-size">
          {formatBytes(dl.receivedBytes)} / {formatBytes(dl.totalBytes)}
        </span>
      </div>
      <div className="models-dl-bar-row">
        <div className="models-dl-bar">
          <div className="models-dl-fill" style={{ width: `${dl.percent}%`, background: isErr ? 'var(--danger)' : isDone ? 'var(--success)' : 'var(--accent)', opacity: isPaused || pending ? 0.5 : 1, transition: 'width 0.3s ease' }} />
        </div>
        <span className="models-dl-pct" style={{ color: isPaused ? 'var(--text-muted)' : 'inherit' }}>
          {statusLabel}
        </span>
        {!isDone && !isErr && (
          <>
            <button
              className="btn btn-ghost btn-icon"
              onClick={togglePause}
              disabled={!!pending}
              title={isPaused ? '继续' : '暂停'}
            >
              {pending
                ? <Loader2 size={13} className="spin" />
                : isPaused
                ? <Play size={13} />
                : <Pause size={13} />}
            </button>
            <button className="btn btn-ghost btn-icon text-danger" onClick={cancel} title="取消">
              <X size={13} />
            </button>
          </>
        )}
        {(isDone || isErr) && (
          <button className="btn btn-ghost btn-icon" onClick={() => removeModelDownload(dl.id)} title="关闭">
            <X size={13} />
          </button>
        )}
      </div>
      {isErr && <div className="models-dl-status-text">下载失败</div>}
      {isDone && <div className="models-dl-status-text">✓ 已保存至 {dl.destPath}</div>}
    </div>
  )
}

function ModelFileRow({ model, isImage, isTts, isOcr, onDeleted }: { model: ModelFileInfo; isImage?: boolean; isTts?: boolean; isOcr?: boolean; onDeleted: () => void }) {
  const setView = useStore(s => s.setView)
  const setModelToolsTarget = useStore(s => s.setModelToolsTarget)
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState(model.name.replace(/\.[^.]+$/, ''))
  useEffect(() => {
    setNewName(model.name.replace(/\.[^.]+$/, ''))
  }, [model.name])
  async function handleDelete() {
    if (!confirm(`确定删除 "${model.name}"？此操作不可撤销。`)) return
    const res = await safeCall(() => window.api.deleteModel(model.path), '删除模型失败')
    if (res === null) return
    if (res.success) onDeleted()
    else notify('删除失败：' + res.error, 'error')
  }
  async function handleRename() {
    if (!newName.trim() || newName === model.name.replace(/\.[^.]+$/, '')) { setEditing(false); return }
    const res = await safeCall(() => window.api.renameModel(model.path, newName.trim()), '重命名模型失败')
    if (res === null) return
    if (res.success) { setEditing(false); onDeleted()  }
    else notify('重命名失败：' + res.error, 'error')
  }
  function handleOpenFolder() {
    const idx = Math.max(model.path.lastIndexOf('/'), model.path.lastIndexOf('\\'))
    if (idx > 0) window.api.openFolder(model.path.substring(0, idx))
  }
  // 跳转到「模型工具 → GGUF 检查器」并预选当前模型
  function handleInspect() {
    setModelToolsTarget({ tab: 'inspector', modelPath: model.path })
    setView('model-tools')
  }
  return (
    <div className="models-file-row">
      <div className="models-file-icon">
        {isImage ? <ImageIcon size={16} /> : isTts ? <AudioLines size={16} /> : isOcr ? <ScanText size={16} /> : <FileText size={16} />}
      </div>
      <div className="models-file-meta">
        {editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, flex: 1 }} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }} autoFocus aria-label="重命名" />
            <button className="btn btn-primary btn-sm btn-icon" onClick={handleRename} aria-label="确认重命名"><Check size={13} /></button>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(false)} aria-label="取消重命名"><X size={13} /></button>
          </div>
        ) : (
          <span className="models-file-name">{model.name}</span>
        )}
        <div className="models-file-sub">
          <span className="models-folder-badge">{model.folder}</span>
          {model.external && (
            <span className="models-folder-badge" title="来自外部路径添加的模型文件夹——删除操作不可用">外部</span>
          )}
          {model.external && !isImage && !model.tts && !model.ocr && (
            <span className="models-folder-badge" style={{ background: 'var(--amber, #f59e0b)', color: '#fff' }} title="文字模型（大语言模型）">文本</span>
          )}
          {isTts && <span className="models-folder-badge" style={{ background: 'var(--violet, #a855f7)', color: '#fff' }} title="语音合成模型文件夹中的文件（OuteTTS / WavTokenizer）——删除操作不可用">语音合成</span>}
          {isOcr && <span className="models-folder-badge" style={{ background: 'var(--cyan, #06b6d4)', color: '#fff' }} title="OCR 模型文件夹中的文件（多模态 / 图片理解模型）——删除操作不可用">OCR</span>}
          {isImage && <span className="models-folder-badge" style={{ background: 'var(--green, #10b981)', color: '#fff' }} title="多模态投影仪文件（--mmproj）——删除操作不可用">图片</span>}
          <span>{formatBytes(model.size)}</span>
        </div>
      </div>
      <div className="models-file-actions">
        <button className="btn btn-ghost btn-icon" onClick={handleInspect} title="在模型工具中检查 GGUF 元数据"><FileSearch size={14} /></button>
        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(true)}><Pencil size={14} /></button>
        <button className="btn btn-ghost btn-icon" onClick={handleOpenFolder}><FolderOpen size={14} /></button>
        <button className="btn btn-ghost btn-icon text-danger" onClick={handleDelete} disabled={model.external}><Trash size={14} /></button>
      </div>
    </div>
  )
}
export default function ModelsView() {
  const models = useStore(s => s.models)
  const imageModels = useStore(s => s.imageModels)
  const setModels = useStore(s => s.setModels)
  const setImageModels = useStore(s => s.setImageModels)
  const modelDownloads = useStore(s => s.modelDownloads)
  const upsertModelDownload = useStore(s => s.upsertModelDownload)
  const paths = useStore(s => s.paths)
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'text' | 'image' | 'tts' | 'ocr'>('all')
  const allModels = useMemo(() => {
    const seen = new Set(models.map(m => m.path))
    const unique = imageModels.filter(m => !seen.has(m.path))
    return [...models, ...unique]
  }, [models, imageModels])
  const imagePathSet = useMemo(() => new Set(imageModels.map(m => m.path)), [imageModels])
  const typeCounts = useMemo(() => {
    let text = 0, image = 0, tts = 0, ocr = 0
    for (const m of allModels) {
      if (m.tts) tts++
      else if (m.ocr) ocr++
      else if (imagePathSet.has(m.path)) image++
      else text++
    }
    return { text, image, tts, ocr }
  }, [allModels, imagePathSet])
  const filteredModels = useMemo(() => {
    let list = allModels
    if (typeFilter === 'text') list = allModels.filter(m => !m.tts && !m.ocr && !imagePathSet.has(m.path))
    else if (typeFilter === 'image') list = allModels.filter(m => imagePathSet.has(m.path))
    else if (typeFilter === 'tts') list = allModels.filter(m => m.tts)
    else if (typeFilter === 'ocr') list = allModels.filter(m => m.ocr)
    const q = filter.trim().toLowerCase()
    if (!q) return list
    return list.filter(m => m.name.toLowerCase().startsWith(q) || m.folder.toLowerCase().startsWith(q))
  }, [allModels, filter, typeFilter, imagePathSet])
  const refresh = useCallback(async () => {
    setLoading(true)
    const [m, im] = await Promise.all([
      safeCall(() => window.api.listModelsRefresh(), '刷新模型列表失败'),
      safeCall(() => window.api.listImageModelsRefresh(), '刷新图片模型列表失败')
    ])
    if (m) setModels(m)
    if (im) setImageModels(im)
    setLoading(false)
  }, [setModels, setImageModels])

  useEffect(() => {
    refresh()

    window.api.listModelDownloads().then((list: any[]) => {
      list.forEach(dl => upsertModelDownload(dl))
    }).catch((e) => console.error('[listModelDownloads]', e))
  }, [])
  const downloads = Object.values(modelDownloads)
  const activeDownloads = downloads.filter(d => d.phase !== 'cancelled')
  return (
    <div className="models-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            模型
            <span
              className="header-count-badge"
              title={`${filter || typeFilter !== 'all' ? `${filteredModels.length} / ${allModels.length}` : allModels.length} 个模型已安装`}
            >
              {filter || typeFilter !== 'all' ? filteredModels.length : allModels.length}
            </span>
          </h1>
          {activeDownloads.length > 0 && (
            <p className="page-subtitle">{activeDownloads.length} 正在下载</p>
          )}
        </div>
        <div className="page-actions">
          <div className="params-search-box models-filter-inline">
            <Search size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="按名称或文件夹前缀筛选模型..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filter && (
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setFilter('')}
                title="清除筛选"
                style={{ padding: 4 }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button className="btn btn-secondary" onClick={() => paths?.models && window.api.openFolder(paths.models)} disabled={!paths?.models}>
            <FolderOpen size={15} /> 打开文件夹
          </button>
          <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
            <Download size={15} /> 通过 URL 下载
          </button>
        </div>
      </div>
      <div className="models-type-tabs">
        {([
          ['all', '全部', 0],
          ['text', '文本', typeCounts.text],
          ['image', '图片', typeCounts.image],
          ['tts', '语音合成', typeCounts.tts],
          ['ocr', 'OCR', typeCounts.ocr],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            className={`models-type-tab${typeFilter === key ? ' active' : ''}`}
            onClick={() => setTypeFilter(key)}
          >
            {label}
            {key !== 'all' && <span className="models-type-count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="models-scroll">
      {activeDownloads.length > 0 && (
        <div className="models-section">
          <div className="models-section-title">
            <Loader2 size={13} className="spin" /> 正在下载
          </div>
          {activeDownloads.map(dl => <DownloadRow key={dl.id} dl={dl} />)}
        </div>
      )}
      <div className="models-section">
        {loading && models.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)', fontSize: 13 }}>
            <Loader2 size={16} className="spin" style={{ display: 'block', margin: '0 auto 8px' }} /> 加载中...
          </div>
        )}
        {!loading && models.length === 0 && (
          <div className="empty-state empty-state--md">
            <div className="empty-state-icon"><HardDrive size={28} /></div>
            <h3>暂无模型</h3>
            <p>从模型中心下载模型或使用"通过 URL 下载"按钮。</p>
            <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
              <Download size={15} /> 通过 URL 下载
            </button>
          </div>
        )}
        {models.length > 0 && filteredModels.length === 0 && (
          <div className="empty-state empty-state--sm">
            {filter ? `没有匹配 "${filter}" 的模型` : `该分类下暂无模型，可在设置中添加对应类型的模型文件夹`}
          </div>
        )}
          {filteredModels.map(m => (
            <ModelFileRow key={m.path} model={m} isImage={imageModels.some(im => im.path === m.path)} isTts={m.tts} isOcr={m.ocr} onDeleted={refresh} />
          ))}
      </div>
      </div>
      {showUrlModal && <UrlDownloadModal onClose={() => { setShowUrlModal(false); refresh() }} />}
    </div>
    )
  }
