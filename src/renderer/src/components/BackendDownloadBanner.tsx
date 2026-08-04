import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Loader2, X, Play, Pause } from 'lucide-react'
import { UbProgress, formatSize, ChunkGrid } from './updateBannerShared'
import { useBackendUpdateVisible } from './UpdateBanner'
import { notify } from '../store/notificationStore'
import { ENGINE_LABELS } from '../utils/engine'

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}分${s}秒`
  return `${Math.floor(m / 60)}小时${m % 60}分`
}

/**
 * 顶部后端下载进度条（llama.cpp / TensorSharp / TurboQuant / BeeLlama 通用）。
 * 只要存在后端包下载（download-progress 事件）即展示，与 llama.cpp 更新横幅是否
 * 正在展示解耦——update 横幅可见时由它接管同一份进度，避免两条重复。
 * 支持：暂停 / 继续（主进程断点续传）、取消、分片可视化、速度与剩余时间。
 */
export default function BackendDownloadBanner() {
  const { downloadProgress, setDownloadProgress } = useStore(
    s => ({ downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress }),
    shallow
  )
  const backendBannerVisible = useBackendUpdateVisible()
  if (!downloadProgress) return null
  // llama.cpp 更新横幅处于展示态时，由它负责下载进度显示，这里跳过避免重复
  if (backendBannerVisible) return null
  const p = downloadProgress
  const engine = p.engine ?? 'llamacpp'
  const paused = p.phase === 'paused'
  // 速度与剩余时间（主进程每 200ms 上报一次瞬时速度）
  let speedText = ''
  if (!paused && p.speed && p.speed > 0) {
    const etaSec = p.total && p.received !== undefined && p.total > p.received ? Math.round((p.total - p.received) / p.speed) : 0
    speedText = ` · ${formatSize(p.speed)}/s${etaSec > 0 ? ` · 剩余 ${formatEta(etaSec)}` : ''}`
  }
  const phaseText = paused
    ? `已暂停（已下载 ${Math.round((p.received || 0) / 1024 / 1024)} / ${Math.round((p.total || 0) / 1024 / 1024)} MB）`
    : p.phase === 'extracting'
      ? '解压后端中...'
      : p.phase === 'verifying'
        ? '校验下载文件（sha256）...'
        : `下载后端中...${speedText}`
  const handleResume = async () => {
    const res = await window.api.resumeBackendDownload().catch(() => null)
    if (res && !res.success) {
      setDownloadProgress(null)
      notify(`继续下载失败：${res.error}`, 'error')
    }
  }
  return (
    <div className="update-banner">
      <span className="ub-badge">
        <Loader2 size={11} className={paused ? '' : 'spin'} />
        {ENGINE_LABELS[engine] ?? engine}
      </span>
      <div className="ub-actions">
        <span>{phaseText}</span>
        {paused ? (
          <span className="ub-progress-text">{p.percent}%</span>
        ) : p.phase === 'verifying' ? (
          <span className="ub-progress-text">{p.percent}%</span>
        ) : (
          <UbProgress percent={p.percent || 0} received={p.received} total={p.total} />
        )}
        {p.chunks && p.chunks.length > 0 && !paused && <ChunkGrid chunks={p.chunks} />}
      </div>
      {p.note && (
        <div className="ub-right">
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.note}</span>
        </div>
      )}
      <div className="ub-right">
        {paused ? (
          <button className="btn btn-secondary btn-xs" onClick={handleResume} title="从断点继续下载">
            <Play size={11} /> 继续
          </button>
        ) : p.phase === 'downloading' ? (
          <button className="btn btn-secondary btn-xs" onClick={() => window.api.pauseBackendDownload()} title="暂停下载（保留已下载部分）">
            <Pause size={11} /> 暂停
          </button>
        ) : null}
        <button
          className="dismiss"
          onClick={() => { window.api.cancelBackendDownload(); setDownloadProgress(null) }}
          title={paused ? '取消并删除已下载文件' : '取消下载'}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
