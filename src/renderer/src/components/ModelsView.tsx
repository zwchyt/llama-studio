import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore, ModelFileInfo, ModelDownloadInfo } from '../store/useStore'

import {
  HardDrive, Download, Trash, Pause, Play, X, Link, FolderOpen,
  Pencil, Check, AlertCircle, Loader2, RefreshCw, Search
} from 'lucide-react'
import { formatBytes, formatSpeed } from '../utils/format'
import { notify } from '../store/notificationStore'
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
  const { removeModelDownload } = useStore()
  const isPaused = dl.phase === 'paused'
  const isDone = dl.phase === 'done'
  const isErr = dl.phase === 'error'
  
  const [pending, setPending] = useState<'pausing' | 'resuming' | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout>>()

  async function togglePause() {
    if (isPaused) {
      setPending('resuming')
      await window.api.resumeModelDownload(dl.id)
    } else {
      setPending('pausing')
      await window.api.pauseModelDownload(dl.id)
    }
    
    clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(() => setPending(null), 1500)
  }

  useEffect(() => {
    return () => clearTimeout(pendingTimerRef.current)
  }, [])
  async function cancel() {
    await window.api.cancelModelDownload(dl.id)
    removeModelDownload(dl.id)
  }

  const showSpeed = dl.phase === 'downloading' && !pending && dl.speed && dl.speed > 0
  const statusLabel = pending === 'pausing'
    ? '暂停中…'
    : pending === 'resuming'
    ? '恢复中…'
    : isPaused
    ? '已暂停'
    : isErr
    ? '错误'
    : isDone
    ? '已完成'
    : showSpeed
    ? formatSpeed(dl.speed)
    : `${dl.percent}%`

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
        <span className="models-dl-pct" style={{ minWidth: 80, textAlign: 'right', color: isPaused ? 'var(--text-muted)' : 'inherit' }}>
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
      {isErr && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>下载失败</div>}
      {isDone && <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 2 }}>✓ 已保存至 {dl.destPath}</div>}
    </div>
  )
}

function ModelFileRow({ model, onDeleted }: { model: ModelFileInfo; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState(model.name.replace(/\.[^.]+$/, ''))
  useEffect(() => {
    setNewName(model.name.replace(/\.[^.]+$/, ''))
  }, [model.name])
  async function handleDelete() {
    if (!confirm(`确定删除 "${model.name}"？此操作不可撤销。`)) return
    const res = await window.api.deleteModel(model.path)
    if (res.success) onDeleted()
    else notify('删除失败：' + res.error, 'error')
  }
  async function handleRename() {
    if (!newName.trim() || newName === model.name.replace(/\.[^.]+$/, '')) { setEditing(false); return }
    const res = await window.api.renameModel(model.path, newName.trim())
    if (res.success) { setEditing(false); onDeleted()  }
    else notify('重命名失败：' + res.error, 'error')
  }
  function handleOpenFolder() {
    const idx = Math.max(model.path.lastIndexOf('/'), model.path.lastIndexOf('\\'))
    if (idx > 0) window.api.openFolder(model.path.substring(0, idx))
  }
  return (
    <div className="models-file-row">
      <div className="models-file-icon"><HardDrive size={16} /></div>
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
          {model.external && <span className="models-folder-badge" title="来自外部文件夹的模型——应用不会重命名或删除此类模型">外部</span>}
          <span>{formatBytes(model.size)}</span>
        </div>
      </div>
      <div className="models-file-actions">
        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(true)} title={model.external ? '外部模型不可重命名' : '重命名'} disabled={model.external}><Pencil size={14} /></button>
        <button className="btn btn-ghost btn-icon" onClick={handleOpenFolder} title="打开文件夹"><FolderOpen size={14} /></button>
        <button className="btn btn-ghost btn-icon text-danger" onClick={handleDelete} title={model.external ? '外部模型不可删除' : '删除'} disabled={model.external}><Trash size={14} /></button>
      </div>
    </div>
  )
}
export default function ModelsView() {
  const models = useStore(s => s.models)
  const setModels = useStore(s => s.setModels)
  const modelDownloads = useStore(s => s.modelDownloads)
  const upsertModelDownload = useStore(s => s.upsertModelDownload)
  const paths = useStore(s => s.paths)
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models.filter(m => m.name.toLowerCase().includes(q) || m.folder.toLowerCase().includes(q))
  }, [models, filter])
  const refresh = useCallback(async () => {
    setLoading(true)
    const m = await window.api.listModelsRefresh()
    setModels(m)
    setLoading(false)
  }, [setModels])

  useEffect(() => {
    refresh()

    window.api.listModelDownloads().then((list: any[]) => {
      list.forEach(dl => upsertModelDownload(dl))
    })
  }, [])
  const downloads = Object.values(modelDownloads)
  const activeDownloads = downloads.filter(d => d.phase !== 'cancelled')
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">模型</h1>
          <p className="page-subtitle">
            {filter ? `${filteredModels.length} / ${models.length}` : models.length} 个模型已安装
            {activeDownloads.length > 0 ? ` · ${activeDownloads.length} 正在下载` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-icon" onClick={refresh} title="刷新" disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
          <button className="btn btn-secondary" onClick={() => paths?.models && window.api.openFolder(paths.models)} disabled={!paths?.models}>
            <FolderOpen size={15} /> 打开文件夹
          </button>
          <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
            <Download size={15} /> 通过 URL 下载
          </button>
        </div>
      </div>
      {}
      {activeDownloads.length > 0 && (
        <div className="models-section">
          <div className="models-section-title">
            <Loader2 size={13} className="spin" /> 正在下载
          </div>
          {activeDownloads.map(dl => <DownloadRow key={dl.id} dl={dl} />)}
        </div>
      )}
      {}
      <div className="models-section">
        <div className="models-section-title">
          <HardDrive size={13} /> 已安装的模型
        </div>
        {models.length > 0 && (
          <div className="params-search-box">
            <Search size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="按名称或文件夹筛选模型..."
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
        )}
        {loading && models.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)', fontSize: 13 }}>
            <Loader2 size={16} className="spin" style={{ display: 'block', margin: '0 auto 8px' }} /> 加载中...
          </div>
        )}
        {!loading && models.length === 0 && (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <div className="empty-state-icon"><HardDrive size={28} /></div>
            <h3>暂无模型</h3>
            <p>从模型中心下载模型或使用"通过 URL 下载"按钮。</p>
            <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
              <Download size={15} /> 通过 URL 下载
            </button>
          </div>
        )}
        {models.length > 0 && filteredModels.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
            没有匹配 "{filter}" 的模型
          </div>
        )}
        {filteredModels.map(m => (
          <ModelFileRow key={m.path} model={m} onDeleted={refresh} />
        ))}
      </div>
      {showUrlModal && <UrlDownloadModal onClose={() => { setShowUrlModal(false); refresh() }} />}
    </div>
    )
  }
