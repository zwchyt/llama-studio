import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Loader2, X } from 'lucide-react'
import { UbProgress } from './updateBannerShared'
import { useBackendUpdateVisible } from './UpdateBanner'
import { ENGINE_LABELS } from '../utils/engine'

/**
 * 顶部后端下载进度条（llama.cpp / TensorSharp / TurboQuant / BeeLlama 通用）。
 * 只要存在后端包下载（download-progress 事件）即展示，与 llama.cpp 更新横幅是否
 * 正在展示解耦——update 横幅可见时由它接管同一份进度，避免两条重复。
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
  const engine = downloadProgress.engine ?? 'llamacpp'
  return (
    <div className="update-banner">
      <span className="ub-badge">
        <Loader2 size={11} className="spin" />
        {ENGINE_LABELS[engine] ?? engine}
      </span>
      <div className="ub-actions">
        <span>{downloadProgress.phase === 'extracting' ? `解压后端中... ${downloadProgress.percent}%` : `下载后端中... ${downloadProgress.percent}%`}</span>
        <UbProgress percent={downloadProgress.percent || 0} received={downloadProgress.received} total={downloadProgress.total} />
      </div>
      <div className="ub-right">
        <button
          className="dismiss"
          onClick={() => { window.api.cancelBackendDownload(); setDownloadProgress(null) }}
          title="取消下载"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}