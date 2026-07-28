import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Loader2, X } from 'lucide-react'
import { UbProgress } from './updateBannerShared'
export default function BackendDownloadBanner() {
  const { downloadProgress, setDownloadProgress, releaseInfo } = useStore(
    s => ({ downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, releaseInfo: s.releaseInfo }),
    shallow
  )
  if (!downloadProgress) return null
  // UpdateBanner handles download display when visible
  if (releaseInfo && releaseInfo.isNewer !== false) return null
  return (
    <div className="update-banner">
      <span className="ub-badge">
        <Loader2 size={11} className="spin" />
        llama.cpp
      </span>
      <div className="ub-actions">
        <span>{downloadProgress.phase === 'extracting' ? '解压后端中...' : '下载后端中...'}</span>
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
