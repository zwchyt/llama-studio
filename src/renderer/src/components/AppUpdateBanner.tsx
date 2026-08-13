import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { X, Download, Loader2, ArrowRight, Sparkles } from 'lucide-react'
import { type BannerSlotProps, useBannerClose, isVersionSkipped, skipVersion, UbProgress } from './updateBannerShared'

const SKIP_KEY = 'llama_studio_skip_app_version'

/** llama-studio 应用更新横幅是否应展示（供合并调度与组件自身共用同一判断） */
export function useAppUpdateVisible(): boolean {
  const { appReleaseInfo, appUpdateDismissed } = useStore(
    s => ({ appReleaseInfo: s.appReleaseInfo, appUpdateDismissed: s.appUpdateDismissed }),
    shallow
  )
  if (!appReleaseInfo || !appReleaseInfo.available || appUpdateDismissed) return false
  if (isVersionSkipped(SKIP_KEY, appReleaseInfo.latestVersion)) return false
  return true
}

export default function AppUpdateBanner({ hidden, switcher }: BannerSlotProps = {}) {
  const {
    appReleaseInfo, setAppUpdateDismissed,
    appDownloadProgress, setAppDownloadProgress
  } = useStore(
    s => ({
      appReleaseInfo: s.appReleaseInfo,
      setAppUpdateDismissed: s.setAppUpdateDismissed,
      appDownloadProgress: s.appDownloadProgress,
      setAppDownloadProgress: s.setAppDownloadProgress,
    }),
    shallow
  )

  const [downloading, setDownloading] = useState(false)
  const [downloadedPath, setDownloadedPath] = useState('')
  const [installing, setInstalling] = useState(false)
  const { closing, closeWithAnim } = useBannerClose(() => setAppUpdateDismissed(true))
  const visible = useAppUpdateVisible()

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
  if (!visible || !appReleaseInfo) return null

  const handleSkipVersion = () => {
    skipVersion(SKIP_KEY, appReleaseInfo.latestVersion)
    closeWithAnim()
  }

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
        assetName: appReleaseInfo.assetName,
        digest: appReleaseInfo.assetDigest || undefined
      })
      if (res.success && res.path) {
        setDownloadedPath(res.path)
        // 终态不依赖 IPC 事件与 invoke 回执的到达顺序：直接置为已下载，
        // 避免晚到的 phase:'downloading' 进度事件让横幅永远卡在 100% 转圈
        setAppDownloadProgress({ percent: 100, phase: 'downloaded' })
        notify(`${appReleaseInfo.releaseName} 下载完成，点击「安装更新」以完成安装`, 'success')
      } else {
        notify(`下载失败：${res.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      notify(`下载失败：${String(e)}`, 'error')
    } finally {
      setDownloading(false)
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
    if (downloading) {
      window.api.cancelAppDownload()
      setDownloading(false)
      setAppDownloadProgress(null)
    }
    closeWithAnim()
  }

  const isDownloading = !downloadedPath && (downloading || (appDownloadProgress?.phase === 'downloading'))
  const isDownloaded = !!downloadedPath || appDownloadProgress?.phase === 'downloaded'
  const progressPercent = appDownloadProgress?.percent ?? 0

  return (
    <div className={`update-banner${closing ? ' closing' : ''}`} style={hidden ? { display: 'none' } : undefined}>
      <span className="ub-badge">
        {installing || isDownloading ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />}
        llama-studio
      </span>
      {installing ? (
        <div className="ub-actions">
          <strong>正在安装更新...</strong>
        </div>
      ) : isDownloading ? (
        <div className="ub-actions">
          <span>正在下载 <strong>{appReleaseInfo.releaseName}</strong></span>
          <UbProgress percent={progressPercent} received={appDownloadProgress?.received} total={appDownloadProgress?.total} />
        </div>
      ) : isDownloaded ? (
        <div className="ub-actions">
          <span><strong>{appReleaseInfo.releaseName}</strong> 已下载完成</span>
          <button className="btn btn-primary btn-xs" onClick={handleInstall}>
            <Download size={12} /> 安装更新
          </button>
        </div>
      ) : (
        <div className="ub-actions">
          <span className="ub-version">
            发现新版本
            <span>v{appReleaseInfo.currentVersion}</span>
            <ArrowRight size={12} className="ub-arrow" />
            <span className="ub-new">v{appReleaseInfo.latestVersion}</span>
          </span>
          {appReleaseInfo.assetUrl ? (
            <button className="btn btn-primary btn-xs" onClick={handleDownload}>
              <Download size={12} /> 下载并安装
            </button>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>当前平台暂无自动安装包</span>
          )}
          <button className="btn btn-ghost btn-xs" onClick={() => window.api.openExternal(appReleaseInfo.releaseUrl)}>
            查看发布
          </button>
        </div>
      )}
      <div className="ub-right">
        {switcher}
        {installing ? (
          <span className="dismiss" style={{ opacity: 0.5 }}><Loader2 size={14} className="spin" /></span>
        ) : isDownloading ? (
          <button className="btn btn-ghost btn-xs" onClick={handleDismiss}>取消</button>
        ) : (
          <>
            {!isDownloaded && (
              <button className="btn btn-ghost btn-xs" onClick={handleSkipVersion}>
                跳过此版本
              </button>
            )}
            <button className="dismiss" onClick={handleDismiss}>
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
