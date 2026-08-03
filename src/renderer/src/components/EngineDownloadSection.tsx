import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { RefreshCw, Loader2, Cpu, X } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import type { ReleaseInfo } from '../../../shared/types'

interface Props {
  /** GitHub 仓库（owner/repo），与 llama.cpp / TensorSharp 共用同一条 check-updates / download-release 通道 */
  repo: string
  /** 引擎显示名（徽标 / 按钮文案），如 TurboQuant / BeeLlama */
  engineLabel: string
  /** 区块描述文案 */
  description: React.ReactNode
}

/**
 * 后端引擎发布下载区块（llama.cpp 分支引擎专用）：
 * 检查 GitHub 发布 → 选择平台资产 → 下载并安装到 backend/ 目录。
 * 行为与 TensorSharp 引擎区块一致；版本目录名 = tag + 资产名去掉扩展名，
 * 安装后按目录名（含 turboquant / beellama）自动识别引擎类型。
 */
export default function EngineDownloadSection({ repo, engineLabel, description }: Props) {
  const { setBackends, downloadProgress, setDownloadProgress } = useStore(
    s => ({ setBackends: s.setBackends, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress }),
    shallow
  )
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownUp, setDropdownUp] = useState(false)
  const [hoveredAsset, setHoveredAsset] = useState('')
  const assetDropdownRef = useRef<HTMLDivElement>(null)

  // 外部点击关闭资产下拉
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (assetDropdownRef.current && !assetDropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // 检查到发布后默认选中第一个资产
  useEffect(() => {
    if (releaseInfo?.assets?.length && !selectedAssetUrl) {
      setSelectedAssetUrl(releaseInfo.assets[0].downloadUrl)
    }
  }, [releaseInfo, selectedAssetUrl])

  async function handleCheck() {
    setChecking(true)
    try {
      const info = await window.api.checkUpdates(repo)
      setReleaseInfo(info)
    } finally {
      setChecking(false)
    }
  }

  async function handleDownload() {
    if (!releaseInfo || !releaseInfo.assets?.length) return
    // 防止与其他引擎下载并发（主进程同一时刻只支持一个后端包下载）
    if (downloadProgress) return
    const asset = releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl) || releaseInfo.assets[0]
    setDownloading(true)
    setDownloadProgress(null)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      // 版本目录名与 llama.cpp / TensorSharp 统一：tag + 资源名去掉扩展名（如 tqp-v0.3.0-turboquant-plus-…-windows-x64-cuda12.4）
      version: `${releaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name
    }), `下载 ${engineLabel} 失败`)
    setDownloading(false)
    setDownloadProgress(null)
    if (res && res.success) {
      notify(`${engineLabel} 安装完成`, 'success')
      const backendsData = await safeCall(() => window.api.listBackends(), '刷新后端列表失败')
      if (backendsData) setBackends(backendsData)
      // 安装后立即复查版本状态，让“已是最新”徽标及时生效
      try {
        const info = await window.api.checkUpdates(repo)
        setReleaseInfo(info)
      } catch { /* 忽略复查失败 */ }
    } else if (res && !res.success && !res.cancelled) {
      notify(`下载失败：${res.error}`, 'error')
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Cpu /> {engineLabel} 引擎</div>
      <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {description}
        </p>
        {checking ? (
          <div className="flex items-center gap-2 text-sm py-2" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw size={14} className="spin" /> 正在检查 GitHub 发布...
          </div>
        ) : releaseInfo ? (
          releaseInfo.error ? (
            <div className="text-danger text-sm py-2">错误：{releaseInfo.error}</div>
          ) : releaseInfo.noPackage ? (
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>未检测到适用于当前平台的 {engineLabel} 发布包。</div>
          ) : (
            <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '6px 0' }}>
              <div>
                <div className="settings-row-label">{releaseInfo.name || releaseInfo.tagName}</div>
                <div className="settings-row-sub">
                  发布日期：{new Date(releaseInfo.publishedAt).toLocaleDateString()}
                  {releaseInfo.isNewer === false && <span style={{ marginLeft: 8, color: 'var(--success)' }}>✓ 已安装最新版本</span>}
                </div>
              </div>
              {releaseInfo.isNewer !== false && releaseInfo.assets?.length > 0 && (
                <div className="flex items-center gap-2 w-full">
                  <div ref={assetDropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <button
                      className="cmd-select"
                      style={{ width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                      onClick={() => {
                        if (showDropdown) { setShowDropdown(false); return }
                        if (assetDropdownRef.current) {
                          const rect = assetDropdownRef.current.getBoundingClientRect()
                          setDropdownUp(window.innerHeight - rect.bottom < 260)
                        }
                        setShowDropdown(true)
                      }}
                      disabled={downloading || !!downloadProgress}
                    >
                      {releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl)?.name || '选择版本'}
                    </button>
                    {showDropdown && (
                      <div style={{
                        position: 'absolute' as const, left: 0, right: 0,
                        background: 'var(--surface)', border: '1.5px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)',
                        maxHeight: 240, overflowY: 'auto' as const, zIndex: 300,
                        ...(dropdownUp ? { bottom: 'calc(100% + 2px)' } : { top: 'calc(100% + 2px)' })
                      }}>
                        {releaseInfo.assets.map(a => (
                          <div
                            key={a.downloadUrl}
                            style={{
                              padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                              background: a.downloadUrl === selectedAssetUrl ? 'var(--bg)' : hoveredAsset === a.downloadUrl ? 'var(--surface-hover)' : 'transparent',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }}
                            onClick={() => { setSelectedAssetUrl(a.downloadUrl); setShowDropdown(false) }}
                            onMouseEnter={() => setHoveredAsset(a.downloadUrl)}
                            onMouseLeave={() => setHoveredAsset('')}
                          >
                            {a.name} ({Math.round(a.size / 1024 / 1024)} MB)
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {downloading ? (
                    <button className="btn btn-secondary btn-sm" disabled>
                      <Loader2 size={14} className="spin" /> 下载中...
                    </button>
                  ) : downloadProgress ? (
                    <button className="btn btn-secondary btn-sm" disabled>其他引擎下载中</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={handleDownload}>下载并安装</button>
                  )}
                </div>
              )}
              {downloading && downloadProgress && (downloadProgress.phase === 'downloading' || downloadProgress.phase === 'extracting') && (
                <div className="flex items-center gap-2 w-full">
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {downloadProgress.phase === 'extracting'
                      ? `正在解压... ${downloadProgress.percent}%（${downloadProgress.received} / ${downloadProgress.total} 个文件）`
                      : `下载中 ${downloadProgress.percent}%（${Math.round((downloadProgress.received || 0) / 1024 / 1024)} / ${Math.round((downloadProgress.total || 0) / 1024 / 1024)} MB）`}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm text-danger"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => { window.api.cancelBackendDownload(); setDownloadProgress(null) }}
                    title="取消下载"
                  >
                    <X size={13} /> 取消
                  </button>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>尚未检查。点击下方按钮查询 {engineLabel} 最新发布。</div>
        )}
        <button className="btn btn-secondary w-full justify-center" onClick={handleCheck} disabled={checking || downloading}>
          <RefreshCw size={14} className={checking ? 'spin' : ''} /> {releaseInfo ? '重新检查' : `检查 ${engineLabel} 发布`}
        </button>
      </div>
    </div>
  )
}
