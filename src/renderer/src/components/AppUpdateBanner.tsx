import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { X, Download, Loader2, RotateCw } from 'lucide-react'

export default function AppUpdateBanner() {
  const {
    appReleaseInfo, appUpdateDismissed, setAppUpdateDismissed,
    appDownloadProgress, setAppDownloadProgress
  } = useStore(
    s => ({
      appReleaseInfo: s.appReleaseInfo,
      appUpdateDismissed: s.appUpdateDismissed,
      setAppUpdateDismissed: s.setAppUpdateDismissed,
      appDownloadProgress: s.appDownloadProgress,
      setAppDownloadProgress: s.setAppDownloadProgress,
    }),
    shallow
  )

  const [downloading, setDownloading] = useState(false)
  const [downloadedPath, setDownloadedPath] = useState('')
  const [installing, setInstalling] = useState(false)

  // Listen for download progress
  useEffect(() => {
    window.api.onAppDownloadProgress((data) => {
      setAppDownloadProgress(data)
    })
    return () => {
      window.api.removeAppDownloadListener()
    }
  }, [setAppDownloadProgress])

  // Auto-dismiss when no update is available
  if (!appReleaseInfo || !appReleaseInfo.available || appUpdateDismissed) return null

  const handleDownload = async () => {
    if (!appReleaseInfo.assetUrl) {
      notify('当前发布没有找到可下载的安装包', 'error')
      return
    }
    setDownloading(true)
    setAppDownloadProgress({ percent: 0, phase: 'downloading' })
    try {
      const res = await window.api.downloadAppUpdate({
        url: appReleaseInfo.assetUrl,
        assetName: appReleaseInfo.assetName
      })
      if (res.success && res.path) {
        setDownloadedPath(res.path)
        notify(`${appReleaseInfo.releaseName} 下载完成，点击「安装更新」以完成安装`, 'success')
      } else {
        notify(`下载失败：${res.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      notify(`下载失败：${String(e)}`, 'error')
    } finally {
      setDownloading(false)
      setAppDownloadProgress(null)
    }
  }

  const handleInstall = async () => {
    if (!downloadedPath) return
    setInstalling(true)
    try {
      const res = await window.api.installAppUpdate({ installerPath: downloadedPath })
      if (!res.success) {
        notify(`安装失败：${res.error || '未知错误'}`, 'error')
        setInstalling(false)
      }
      // If successful, the app will quit shortly
    } catch (e) {
      notify(`安装失败：${String(e)}`, 'error')
      setInstalling(false)
    }
  }

  const handleDismiss = () => {
    setAppUpdateDismissed(true)
    if (downloading) {
      window.api.cancelAppDownload()
      setDownloading(false)
      setAppDownloadProgress(null)
    }
  }

  const isDownloading = downloading || (appDownloadProgress?.phase === 'downloading')
  const isDownloaded = appDownloadProgress?.phase === 'downloaded' || downloadedPath
  const progressPercent = appDownloadProgress?.percent ?? 0

  return (
    <div className="update-banner" style={{ background: 'var(--accent)', color: '#fff' }}>
      {installing ? (
        <Loader2 size={14} className="spin" />
      ) : isDownloading ? (
        <Loader2 size={14} className="spin" />
      ) : isDownloaded ? (
        <Download size={14} />
      ) : (
        <RotateCw size={14} />
      )}
      <span>
        {installing ? (
          <strong>正在安装更新...</strong>
        ) : isDownloading ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <strong>正在下载 {appReleaseInfo.releaseName}</strong>
            <div className="hub-progress-bar" style={{ width: 100, height: 6, flexShrink: 0, background: 'rgba(255,255,255,0.25)' }}>
              <div className="hub-progress-fill" style={{ width: `${progressPercent}%`, background: '#fff' }} />
            </div>
            <span>{progressPercent}%</span>
          </span>
        ) : isDownloaded ? (
          <span>
            <strong>{appReleaseInfo.releaseName}</strong> 已下载 —{' '}
            <button onClick={handleInstall} style={{ fontWeight: 600, textDecoration: 'underline' }}>
              安装更新
            </button>
          </span>
        ) : (
          <span>
            <strong>{appReleaseInfo.releaseName}</strong> 可用（当前版本 {appReleaseInfo.currentVersion}）—{' '}
            <button onClick={() => window.api.openExternal(appReleaseInfo.releaseUrl)}>
              查看发布
            </button>
            {' · '}
            {appReleaseInfo.assetUrl ? (
              <button onClick={handleDownload}>
                下载并安装
              </button>
            ) : (
              <span style={{ opacity: 0.7 }}>当前平台暂无自动安装包</span>
            )}
          </span>
        )}
      </span>
      {installing ? (
        <span className="dismiss" style={{ opacity: 0.5 }}><Loader2 size={14} className="spin" /></span>
      ) : (
        <button className="dismiss" onClick={handleDismiss} title="关闭">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
