import React, { useState, useEffect, useRef } from 'react'
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
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (releaseInfo?.assets?.length && !selectedAssetUrl) {
      setSelectedAssetUrl(releaseInfo.assets[0].downloadUrl)
    }
  }, [releaseInfo, selectedAssetUrl])
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  const [notifPref] = useState(() => {
    try { return localStorage.getItem('hexllama_update_notify') || 'banner' } catch { return 'banner' }
  })
  if (!releaseInfo || releaseInfo.error || releaseInfo.noRelease || releaseInfo.noPackage || updateDismissed || releaseInfo.isNewer === false || notifPref === 'manual') return null
  const selectedAsset = releaseInfo.assets?.find(a => a.downloadUrl === selectedAssetUrl)
  const handleDownload = async () => {
    if (!releaseInfo.assets?.length) return
    const asset = selectedAsset || releaseInfo.assets[0]
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
      if (backendsData.length > 0) useStore.getState().setActiveBackend(backendsData[0])
    } else {
      notify(`下载失败：${res.error}`, 'error')
    }
  }
  return (
    <div className="update-banner" style={downloadProgress || downloading ? { whiteSpace: 'nowrap', justifyContent: 'flex-start' } : {}}>
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
              <>
                <span>下载中...</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle', margin: '0 4px' }}>
                  <div style={{ width: 80, height: 6, background: 'rgba(255,255,255,0.25)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                    <div style={{ width: `${downloadProgress?.percent || 0}%`, height: '100%', background: 'rgba(255,255,255,0.8)', borderRadius: 3, transition: 'width .3s' }} />
                  </div>
                  <span>{downloadProgress?.percent || 0}%</span>
                </span>
              </>
            ) : (
              <>
                <span style={{ position: 'relative', display: 'inline-block', marginRight: 8 }} ref={dropdownRef}>
                  <button
                    style={{
                      font: 'inherit', fontSize: 12, color: 'inherit',
                      background: 'rgba(255,255,255,0.15)', border: '1.5px solid rgba(255,255,255,0.3)',
                      borderRadius: 'var(--radius-sm)', outline: 'none', cursor: 'pointer',
                      padding: '3px 8px', textAlign: 'center',
                      whiteSpace: 'nowrap', maxWidth: 400
                    }}
                    onClick={() => setShowDropdown(!showDropdown)}
                    title={selectedAsset?.name}
                  >
                    {selectedAsset?.name || '选择版本'}
                  </button>
                  {showDropdown && (
                    <div style={{
                      position: 'absolute' as const, left: 0, right: 0, minWidth: 300, maxWidth: 400,
                      background: 'var(--surface)', border: '1.5px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)',
                      maxHeight: 240, overflowY: 'auto' as const, zIndex: 300, color: 'var(--text)',
                      top: 'calc(100% + 2px)'
                    }}>
                      {releaseInfo.assets.map(a => (
                        <div
                          key={a.downloadUrl}
                          style={{
                            padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                            background: a.downloadUrl === selectedAssetUrl ? 'var(--bg)' : 'transparent',
                            color: 'var(--text)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                          }}
                          onClick={() => { setSelectedAssetUrl(a.downloadUrl); setShowDropdown(false) }}
                          onMouseEnter={(e) => { if (a.downloadUrl !== selectedAssetUrl) e.currentTarget.style.background = 'var(--surface-hover)' }}
                          onMouseLeave={(e) => { if (a.downloadUrl !== selectedAssetUrl) e.currentTarget.style.background = 'transparent' }}
                        >
                          {a.name}
                        </div>
                      ))}
                    </div>
                  )}
                </span>
                <button onClick={handleDownload}>下载</button>
              </>
            )}
          </>
        )}
      </span>
      {downloadProgress || downloading ? (
        <button
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', textDecoration: 'underline', padding: 0, flexShrink: 0 }}
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
