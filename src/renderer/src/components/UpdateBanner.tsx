import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { X, Download, Loader2 } from 'lucide-react'
export default function UpdateBanner() {
  const { releaseInfo, updateDismissed, setUpdateDismissed, downloadProgress, setDownloadProgress, setBackends } = useStore(
    s => ({ releaseInfo: s.releaseInfo, updateDismissed: s.updateDismissed, setUpdateDismissed: s.setUpdateDismissed, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, setBackends: s.setBackends }),
    shallow
  )
  const [downloading, setDownloading] = useState(false)
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('')
  useEffect(() => {
    if (releaseInfo?.assets?.length && !selectedAssetUrl) {
      setSelectedAssetUrl(releaseInfo.assets[0].downloadUrl)
    }
  }, [releaseInfo, selectedAssetUrl])
  const [notifPref] = useState(() => {
    try { return localStorage.getItem('hexllama_update_notify') || 'banner' } catch { return 'banner' }
  })
  if (!releaseInfo || releaseInfo.error || updateDismissed || releaseInfo.isNewer === false || notifPref === 'manual') return null
  const handleDownload = async () => {
    if (!releaseInfo.assets?.length) return
    const asset = releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl) || releaseInfo.assets[0]
    setDownloading(true)
    const res = await window.api.downloadRelease({
      url: asset.downloadUrl,
      version: `${releaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name
    })
    setDownloading(false)
    setDownloadProgress(null)
    if (res.success) {
      notify(`成功下载并解压 ${asset.name}`, 'success')
      setUpdateDismissed(true)
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
    } else {
      notify(`下载失败：${res.error}`, 'error')
    }
  }
  return (
    <div className="update-banner">
      {downloadProgress || downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
      <span>
        <strong>{releaseInfo.name || releaseInfo.tagName}</strong> 可用 —{' '}
        <button onClick={() => window.api.openExternal(releaseInfo.url)}>
          查看发布
        </button>
        {releaseInfo.assets?.length > 0 && (
          <>
            {' '}·{' '}
            {downloading || downloadProgress ? (
              <span style={{ opacity: 0.8 }}>
                {downloadProgress?.phase === 'extracting' ? '解压中...' : `下载中... ${downloadProgress?.percent || 0}%`}
              </span>
            ) : (
              <>
                <select 
                  style={{ background: 'transparent', color: 'inherit', border: 'none', outline: 'none', borderBottom: '1px solid rgba(255,255,255,0.2)', marginRight: '8px', maxWidth: '280px' }}
                  value={selectedAssetUrl}
                  onChange={(e) => setSelectedAssetUrl(e.target.value)}
                  title={releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl)?.name}
                >
                  {releaseInfo.assets.map(a => (
                    <option style={{ color: 'black' }} key={a.downloadUrl} value={a.downloadUrl} title={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
                  <button onClick={handleDownload}>
                    下载
                  </button>
              </>
            )}
          </>
        )}
      </span>
      {downloadProgress || downloading ? (
        <button 
          className="dismiss text-danger" 
          onClick={() => { window.api.cancelBackendDownload(); setDownloading(false); setDownloadProgress(null); }} 
          title="取消下载"
        >
          取消
        </button>
      ) : (
        <button className="dismiss" onClick={() => setUpdateDismissed(true)} title="关闭">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
