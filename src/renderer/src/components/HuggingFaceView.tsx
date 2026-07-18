import React, { useState, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import {
  Search, Download, Heart, ChevronDown, ChevronLeft,
  FolderOpen, CheckCircle, Loader2, X, AlertCircle, Box, Pause, Play
} from 'lucide-react'
import { formatBytes } from '../utils/format'
import { formatDownloadStatus, formatDownloadStripText } from '../utils/downloadFormat'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import '../styles/hub.css'
interface HfModel {
  id: string
  author: string
  name: string
  downloads: number
  likes: number
  tags: string[]
  lastModified: string
}
interface HfFile {
  name: string
  size: number
  downloadUrl: string
}
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
function quantLabel(filename: string): { label: string; color: string } {
  const upper = filename.toUpperCase()
  if (upper.includes('Q2')) return { label: 'Q2', color: '#ef4444' }
  if (upper.includes('Q3')) return { label: 'Q3', color: '#f97316' }
  if (upper.includes('Q4')) return { label: 'Q4', color: '#eab308' }
  if (upper.includes('Q5')) return { label: 'Q5', color: '#22c55e' }
  if (upper.includes('Q6')) return { label: 'Q6', color: '#3b82f6' }
  if (upper.includes('Q8')) return { label: 'Q8', color: '#8b5cf6' }
  if (upper.includes('F16')) return { label: 'F16', color: '#6366f1' }
  if (upper.includes('F32')) return { label: 'F32', color: '#6366f1' }
  if (upper.includes('BF16')) return { label: 'BF16', color: '#6366f1' }
  return { label: 'GGUF', color: '#6b7280' }
}
const popularQueries = ['llama', 'mistral', 'phi', 'qwen', 'gemma', 'deepseek', 'falcon']

export default function HuggingFaceView() {
  const {
    hfDownloads, setHfDownload, removeHfDownload,
    hubQuery, hubResults, hubSelectedModelId, hubSource,
    setHubQuery, setHubResults, setHubSelectedModelId, setHubSource
  } = useStore(
    s => ({ hfDownloads: s.hfDownloads, setHfDownload: s.setHfDownload, removeHfDownload: s.removeHfDownload, hubQuery: s.hubQuery, hubResults: s.hubResults, hubSelectedModelId: s.hubSelectedModelId, hubSource: s.hubSource, setHubQuery: s.setHubQuery, setHubResults: s.setHubResults, setHubSelectedModelId: s.setHubSelectedModelId, setHubSource: s.setHubSource }),
    shallow
  )

  const isHF = hubSource === 'huggingface'
  const sourceLabel = isHF ? 'HuggingFace' : 'ModelScope'
  const selectedModel = (hubResults as HfModel[]).find(m => m.id === hubSelectedModelId) ?? null

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<HfFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const [inputValue, setInputValue] = useState(hubQuery)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) return
    setHubQuery(q)
    setLoading(true)
    setError('')
    setHubResults([])
    setHubSelectedModelId(null)
    try {
      const res = isHF
        ? await window.api.hfSearch(q.trim())
        : await window.api.msSearch(q.trim())
      if ('error' in res) throw new Error(res.error)
      setHubResults(res)
    } catch (e: any) {
      setError(e.message || '搜索失败')
    } finally {
      setLoading(false)
    }
  }, [setHubQuery, setHubResults, setHubSelectedModelId, setLoading, setError, isHF])

  async function fetchFiles(model: HfModel) {
    setFiles([])
    setFilesLoading(true)
    try {
      const res = isHF
        ? await window.api.hfGetFiles(model.id)
        : await window.api.msGetFiles(model.id)
      if ('error' in res) throw new Error(res.error)
      setFiles(res)
    } catch (e: any) {
      setError(e.message || '获取文件失败')
    } finally {
      setFilesLoading(false)
    }
  }

  async function handleSelectModel(model: HfModel) {
    setHubSelectedModelId(model.id)
    fetchFiles(model)
  }

  async function handleDownload(file: HfFile) {
    if (!selectedModel) return
    setHfDownload({ repoId: selectedModel.id, filename: file.name, percent: 0, phase: 'starting' })
    const api = isHF ? window.api.hfDownloadModel : window.api.msDownloadModel
    const res = await safeCall(() => api({
      repoId: selectedModel.id,
      filename: file.name,
      downloadUrl: file.downloadUrl
    }), '启动下载失败')
    if (res === null) {
      removeHfDownload(file.name)
      return
    }
    if (!res.success) {
      removeHfDownload(file.name)
      notify(`下载失败：${res.error}`, 'error')
    }
  }

  const isDownloading = useCallback((filename: string) => hfDownloads.some(d => d.filename === filename), [hfDownloads])
  const getProgress = useCallback((filename: string) => hfDownloads.find(d => d.filename === filename), [hfDownloads])
  return (
    <div className="hub-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">模型中心</h1>
          <p className="page-subtitle">在 {isHF ? 'HuggingFace' : 'ModelScope (魔搭)'} 上搜索并下载 GGUF 模型</p>
        </div>
        <div className="hub-tabs">
          <button
            className={`hub-tab ${isHF ? 'active' : ''}`}
            onClick={() => {
              if (hubSource !== 'huggingface') {
                setHubSource('huggingface')
                setHubQuery('')
                setHubResults([])
                setHubSelectedModelId(null)
                setInputValue('')
                setFiles([])
                setError('')
              }
            }}
          >
            <img src="./models-web-logo/HuggingFace.png" alt="" style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 2 }} /> HuggingFace
          </button>
          <button
            className={`hub-tab ${!isHF ? 'active' : ''}`}
            onClick={() => {
              if (hubSource !== 'modelscope') {
                setHubSource('modelscope')
                setHubQuery('')
                setHubResults([])
                setHubSelectedModelId(null)
                setInputValue('')
                setFiles([])
                setError('')
              }
            }}
          >
            <img src="./models-web-logo/ModelScope.png" alt="" style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 2 }} /> 魔搭社区
          </button>
        </div>
        <button className="btn btn-ghost" onClick={() => window.api[isHF ? 'hfOpenModelsDir' : 'msOpenModelsDir']()} title="打开模型文件夹">
          <FolderOpen size={15} /> 打开 /models
        </button>
      </div>
      <div className="hub-search-bar">
        <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          className="hub-search-input"
          type="text"
          placeholder={`在 ${sourceLabel} 上搜索 GGUF 模型...`}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch(inputValue)}
        />
        {inputValue && (
          <button className="hub-search-clear" onClick={() => { setInputValue(''); setHubQuery(''); setHubResults([]); setHubSelectedModelId(null) }} aria-label="清除搜索">
            <X size={14} />
          </button>
        )}
        <button className="btn btn-primary" onClick={() => doSearch(inputValue)} disabled={loading || !inputValue.trim()}>
          {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          搜索
        </button>
      </div>
      {!hubResults.length && !loading && (
        <div className="hub-tags">
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>热门搜索：</span>
          {popularQueries.map(q => (
            <button key={q} className="hub-tag-btn" onClick={() => { setInputValue(q); doSearch(q) }}>
              {q}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="hub-error">
          <AlertCircle size={14} />
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }} aria-label="关闭错误">
            <X size={12} />
          </button>
        </div>
      )}
      {loading && (
        <div className="hub-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="hub-card skeleton" />
          ))}
        </div>
      )}
      {!loading && hubResults.length > 0 && (
        <div className={`hub-results-layout ${selectedModel ? 'has-detail' : ''}`}>
          <div className="hub-grid">
            {(hubResults as HfModel[]).map(model => (
              <button
                key={model.id}
                className={`hub-card ${selectedModel?.id === model.id ? 'selected' : ''}`}
                onClick={() => handleSelectModel(model)}
              >
                <div className="hub-card-icon">
                  <Box size={18} />
                </div>
                <div className="hub-card-body">
                  <div className="hub-card-name" title={model.name}>{model.name}</div>
                  <div className="hub-card-author">{model.author}</div>
                  <div className="hub-card-stats">
                    <span><Download size={11} /> {formatNumber(model.downloads)}</span>
                    <span><Heart size={11} /> {formatNumber(model.likes)}</span>
                  </div>
                </div>
                <ChevronDown size={14} style={{ transform: 'rotate(-90deg)', flexShrink: 0, color: 'var(--text-muted)' }} />
              </button>
            ))}
          </div>
          {selectedModel && (
            <div className="hub-detail-panel">
              <div className="hub-detail-header">
                <button className="btn btn-ghost btn-icon" onClick={() => setHubSelectedModelId(null)} title="返回">
                  <ChevronLeft size={16} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="hub-detail-name" title={selectedModel.name}>{selectedModel.name}</div>
                  <div className="hub-detail-author">{selectedModel.author}</div>
                </div>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => window.api.openExternal(isHF ? `https://huggingface.co/${selectedModel.id}` : `https://modelscope.cn/models/${selectedModel.id}`)}
                  title={`在 ${sourceLabel} 上打开`}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
              </div>
              <div className="hub-detail-stats">
                <span><Download size={12} /> {formatNumber(selectedModel.downloads)} 次下载</span>
                <span><Heart size={12} /> {formatNumber(selectedModel.likes)} 次点赞</span>
              </div>
              <div className="hub-detail-section-label">GGUF 文件</div>
              {filesLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                  <Loader2 size={14} className="spin" /> 加载中...
                </div>
              )}
              {!filesLoading && files.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>未找到 GGUF 文件。</div>
              )}
              {!filesLoading && files.map(file => {
                const dl = getProgress(file.name)
                const downloading = isDownloading(file.name)
                const done = dl?.phase === 'done'
                const { label, color } = quantLabel(file.name)
                return (
                  <div key={file.name} className="hub-file-row">
                    <div className="hub-file-info">
                      <span className="hub-quant-badge" style={{ background: color + '22', color }}>
                        {label}
                      </span>
                      <div className="hub-file-name" title={file.name}>{file.name}</div>
                      <div className="hub-file-size">{formatBytes(file.size)}</div>
                    </div>
                    {downloading && !done ? (
                      <div className="hub-file-progress">
                        <div className="hub-progress-bar">
                          <div className="hub-progress-fill" style={{ width: `${dl?.percent || 0}%`, opacity: dl?.phase === 'paused' ? 0.45 : 1, transition: 'width 0.3s ease' }} />
                        </div>
                        <span className="hub-progress-label">
                          {formatDownloadStatus({ phase: dl!.phase, percent: dl!.percent || 0, speed: dl!.speed })}
                        </span>
                        {dl?.phase === 'paused' ? (
                          <button
                            className="btn btn-ghost btn-icon"
                            style={{ marginLeft: 4 }}
                            onClick={() => safeCall(() => window.api.resumeModelDownload(file.name), '继续下载失败')}
                            title="继续"
                          >
                            <Play size={12} />
                          </button>
                        ) : dl?.phase === 'downloading' ? (
                          <button
                            className="btn btn-ghost btn-icon"
                            style={{ marginLeft: 4 }}
                            onClick={() => safeCall(() => window.api.pauseModelDownload(file.name), '暂停下载失败')}
                            title="暂停"
                          >
                            <Pause size={12} />
                          </button>
                        ) : null}
                      </div>
                    ) : done ? (
                      <div className="hub-file-done">
                        <CheckCircle size={16} style={{ color: 'var(--success)' }} />
                      </div>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm hub-dl-btn"
                        onClick={() => handleDownload(file)}
                      >
                        <Download size={13} />
                        下载
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {hfDownloads.filter(d => d.phase !== 'done').length > 0 && (
        <div className="hub-downloads-strip">
          {hfDownloads.filter(d => d.phase !== 'done').map(dl => {
            const isPaused = dl.phase === 'paused'
            const statusText = formatDownloadStripText({ phase: dl.phase, percent: dl.percent, speed: dl.speed })
            return (
              <div key={dl.filename} className="hub-dl-strip-item">
                {isPaused
                  ? <Pause size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  : <Loader2 size={12} className="spin" style={{ flexShrink: 0 }} />}
                <span className="hub-dl-strip-name">{dl.filename}</span>
                <div className="hub-dl-strip-bar">
                  <div className="hub-dl-strip-fill" style={{ width: `${dl.percent}%`, opacity: isPaused ? 0.45 : 1, transition: 'width 0.3s ease' }} />
                </div>
                <span className="hub-dl-strip-pct">{statusText}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
