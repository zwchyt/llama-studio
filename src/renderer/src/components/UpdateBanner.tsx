import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { X, Download, Loader2, ExternalLink, ChevronDown, ArrowUpCircle } from 'lucide-react'
import { type BannerSlotProps, useBannerClose, isVersionSkipped, skipVersion, UbProgress } from './updateBannerShared'

const SKIP_KEY = 'llama_studio_skip_backend_version'

/** llama.cpp 后端更新横幅是否应展示（供合并调度与组件自身共用同一判断） */
export function useBackendUpdateVisible(): boolean {
  const { releaseInfo, updateDismissed } = useStore(
    s => ({ releaseInfo: s.releaseInfo, updateDismissed: s.updateDismissed }),
    shallow
  )
  if (!releaseInfo || releaseInfo.error || releaseInfo.noRelease || releaseInfo.noPackage || updateDismissed || releaseInfo.isNewer === false) return false
  try { if (localStorage.getItem('llama_studio_update_notify') === 'manual') return false } catch { /* ignore */ }
  if (isVersionSkipped(SKIP_KEY, releaseInfo.tagName)) return false
  return true
}

export default function UpdateBanner({ hidden, switcher }: BannerSlotProps = {}) {
  const { releaseInfo, setUpdateDismissed, downloadProgress, setDownloadProgress, setBackends } = useStore(
    s => ({ releaseInfo: s.releaseInfo, setUpdateDismissed: s.setUpdateDismissed, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, setBackends: s.setBackends }),
    shallow
  )
  const visible = useBackendUpdateVisible()
  const [downloading, setDownloading] = useState(false)
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const { closing, closeWithAnim } = useBannerClose(() => setUpdateDismissed(true))
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
  if (!visible || !releaseInfo) return null
  const selectedAsset = releaseInfo.assets?.find(a => a.downloadUrl === selectedAssetUrl)
  const isBusy = downloading || !!downloadProgress
  const busyEngine = downloadProgress?.engine === 'tensorsharp' ? 'TensorSharp' : 'llama.cpp'
  const handleSkipVersion = () => {
    skipVersion(SKIP_KEY, releaseInfo.tagName)
    closeWithAnim()
  }
  const handleDownload = async () => {
    if (!releaseInfo.assets?.length) return
    const asset = selectedAsset || releaseInfo.assets[0]
    setDownloading(true)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      version: `${releaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name
    }), '下载后端失败')
    setDownloading(false)
    setDownloadProgress(null)
    if (res && res.success) {
      notify(`成功下载并解压 ${asset.name}`, 'success')
      setUpdateDismissed(true)
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
      if (backendsData.length > 0) useStore.getState().setActiveBackend(backendsData[0])
    } else if (res) {
      notify(`下载失败：${res.error}`, 'error')
    }
  }
  return (
    <div className={`update-banner${closing ? ' closing' : ''}`} style={hidden ? { display: 'none' } : undefined}>
      <span className="ub-badge">
        {isBusy ? <Loader2 size={11} className="spin" /> : <ArrowUpCircle size={11} />}
        {busyEngine}
      </span>
      {isBusy ? (
        <div className="ub-actions">
          <span>正在下载 <strong>{downloadProgress?.name || selectedAsset?.name || releaseInfo.tagName}</strong></span>
          <UbProgress percent={downloadProgress?.percent || 0} received={downloadProgress?.received} total={downloadProgress?.total} />
        </div>
      ) : (
        <div className="ub-actions">
          <span className="ub-version">
            新版本 <span className="ub-new">{releaseInfo.name || releaseInfo.tagName}</span> 可用
          </span>
          {releaseInfo.assets?.length > 0 ? (
            <>
              <span style={{ position: 'relative', display: 'inline-flex' }} ref={dropdownRef}>
                <button className="ub-select" onClick={() => setShowDropdown(!showDropdown)} title={selectedAsset?.name}>
                  {selectedAsset?.name || '选择版本'} <ChevronDown size={11} style={{ verticalAlign: -1 }} />
                </button>
                {showDropdown && (
                  <div className="ub-menu">
                    {releaseInfo.assets.map(a => (
                      <div
                        key={a.downloadUrl}
                        className={`ub-menu-item${a.downloadUrl === selectedAssetUrl ? ' selected' : ''}`}
                        onClick={() => { setSelectedAssetUrl(a.downloadUrl); setShowDropdown(false) }}
                      >
                        {a.name}
                      </div>
                    ))}
                  </div>
                )}
              </span>
              <button className="btn btn-primary btn-xs" onClick={handleDownload}>
                <Download size={12} /> 下载
              </button>
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>安装包尚未就绪，可稍后再检查更新</span>
          )}
          <button className="btn btn-ghost btn-xs" onClick={() => window.api.openExternal(releaseInfo.url)}>
            <ExternalLink size={12} /> 查看发布
          </button>
        </div>
      )}
      <div className="ub-right">
        {switcher}
        {isBusy ? (
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => { window.api.cancelBackendDownload(); setDownloading(false); setDownloadProgress(null) }}
          >
            取消
          </button>
        ) : (
          <>
            <button className="btn btn-ghost btn-xs" onClick={handleSkipVersion} title="不再提醒此版本，有新版本时仍会通知">
              跳过此版本
            </button>
            <button className="dismiss" onClick={() => closeWithAnim()} title="关闭">
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
