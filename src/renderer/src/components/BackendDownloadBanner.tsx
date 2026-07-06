import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Loader2, X } from 'lucide-react'
export default function BackendDownloadBanner() {
  const { downloadProgress, setDownloadProgress, releaseInfo } = useStore(
    s => ({ downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, releaseInfo: s.releaseInfo }),
    shallow
  )
  if (!downloadProgress) return null
  // UpdateBanner handles download display when visible
  if (releaseInfo && releaseInfo.isNewer !== false) return null
  return (
    <div className="update-banner" style={{ whiteSpace: 'nowrap' }}>
      <Loader2 size={14} className="spin" />
      <span>{downloadProgress.phase === 'extracting' ? '解压后端中...' : '下载后端中...'}</span>
      <div style={{ width: 100, height: 6, background: 'rgba(255,255,255,0.25)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${downloadProgress.percent || 0}%`, height: '100%', background: 'rgba(255,255,255,0.8)', borderRadius: 3, transition: 'width .3s' }} />
      </div>
      <span>{downloadProgress.percent || 0}%</span>
      <button
        className="dismiss"
        onClick={() => { window.api.cancelBackendDownload(); setDownloadProgress(null) }}
        title="取消下载"
      >
        <X size={14} />
      </button>
    </div>
  )
}
