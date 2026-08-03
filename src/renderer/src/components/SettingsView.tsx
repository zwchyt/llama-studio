import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import { HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal, Bell, BellOff, FolderPlus, Folder, Activity, Volume2, ImageDown, AlertTriangle, Check, Type, Cpu, X } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { ENGINE_LABELS, paramSetOf } from '../utils/engine'
import { SOUND_OPTIONS, previewSound } from '../utils/sound'
import type { ReleaseInfo } from '../../../shared/types'

import CommandsEditor from './CommandsEditor'
import FontSelector from './FontSelector'
import EngineDownloadSection from './EngineDownloadSection'
import { CURSOR_SCHEMES, getCursorSchemeId, applyCursorScheme, CURSOR_STORAGE_KEY, schemeCursorValue, type CursorRole } from '../cursor-theme'
import '../styles/settings.css'

const NOTIF_KEY = 'llama_studio_update_notify'

function getNotifPref(): 'banner' | 'manual' {
  try {
    const val = localStorage.getItem(NOTIF_KEY)
    if (val === 'banner' || val === 'manual') return val
  } catch (e) { console.error('读取通知偏好失败', e) }
  return 'banner'
}

export default function SettingsView() {
	  const { backends, activeBackend, setActiveBackend, setCommandsSchema, setBackends,
	    releaseInfo, checkingUpdate, downloadProgress, setDownloadProgress, setCheckingUpdate, setReleaseInfo,
    setModels, setImageModels, soundEnabled, setSoundEnabled, notificationSound, setNotificationSound, splashEnabled, setSplashEnabled, agentToolCardsExpanded, setAgentToolCardsExpanded, paramTooltipEnabled, setParamTooltipEnabled } = useStore(
    s => ({ backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, setBackends: s.setBackends, releaseInfo: s.releaseInfo, checkingUpdate: s.checkingUpdate, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, setCheckingUpdate: s.setCheckingUpdate, setReleaseInfo: s.setReleaseInfo, setModels: s.setModels, setImageModels: s.setImageModels, soundEnabled: s.soundEnabled, setSoundEnabled: s.setSoundEnabled, notificationSound: s.notificationSound, setNotificationSound: s.setNotificationSound, chatSidebarCollapsed: s.chatSidebarCollapsed, setChatSidebarCollapsed: s.setChatSidebarCollapsed, splashEnabled: s.splashEnabled, setSplashEnabled: s.setSplashEnabled, agentToolCardsExpanded: s.agentToolCardsExpanded, setAgentToolCardsExpanded: s.setAgentToolCardsExpanded, paramTooltipEnabled: s.paramTooltipEnabled, setParamTooltipEnabled: s.setParamTooltipEnabled }),
    shallow
  )
  const { hoverExpandEnabled, setHoverExpandEnabled } = useSidebarStore()
  const [downloading, setDownloading] = useState(false)
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('')
  const [expandedEditor, setExpandedEditor] = useState<string | null>(null)
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [showAssetDropdown, setShowAssetDropdown] = useState(false)
  const [dropdownUp, setDropdownUp] = useState(false)
  const [hoveredAsset, setHoveredAsset] = useState('')
  const assetDropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (assetDropdownRef.current && !assetDropdownRef.current.contains(e.target as Node)) {
        setShowAssetDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (tsAssetDropdownRef.current && !tsAssetDropdownRef.current.contains(e.target as Node)) {
        setShowTsAssetDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])
  const [extFolders, setExtFolders] = useState<string[]>([])
  const [imgFolders, setImgFolders] = useState<string[]>([])
  const [metricsPolling, setMetricsPolling] = useState(true)
  // TensorSharp 引擎发布信息（与 llama.cpp 共用同一条 check-updates / download-release 通道）
  const [tsReleaseInfo, setTsReleaseInfo] = useState<ReleaseInfo | null>(null)
  const [tsChecking, setTsChecking] = useState(false)
  const [tsDownloading, setTsDownloading] = useState(false)
  const [tsSelectedAssetUrl, setTsSelectedAssetUrl] = useState('')
  const [showTsAssetDropdown, setShowTsAssetDropdown] = useState(false)
  const [tsDropdownUp, setTsDropdownUp] = useState(false)
  const [tsHoveredAsset, setTsHoveredAsset] = useState('')
  const tsAssetDropdownRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const deletePopoverRef = useRef<HTMLDivElement>(null)
  const deleteConfirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!deleteTarget) return
    function handlePointer(e: MouseEvent) {
      if (deletePopoverRef.current && !deletePopoverRef.current.contains(e.target as Node)) {
        setDeleteTarget(null)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); setDeleteTarget(null) }
      if (e.key === 'Enter') { e.preventDefault(); confirmDelete() }
    }
    document.addEventListener('mousedown', handlePointer)
    window.addEventListener('keydown', handleKey)
    deleteConfirmRef.current?.focus()
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [deleteTarget])
  const [cursorScheme, setCursorScheme] = useState<string>(getCursorSchemeId())
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewScheme = CURSOR_SCHEMES.find(s => s.id === (previewId ?? cursorScheme)) || CURSOR_SCHEMES[0]
  const previewRoles: CursorRole[] = ['default', 'pointer', 'wait']
  const roleLabels: Record<CursorRole, string> = { default: '箭头', pointer: '手型', wait: '忙碌', progress: '后台', notAllowed: '禁止', move: '移动', help: '帮助' }
  function handleCursorSchemeChange(v: string) {
    setCursorScheme(v)
    applyCursorScheme(v)
    try { localStorage.setItem(CURSOR_STORAGE_KEY, v) } catch { /* ignore */ }
  }

  useEffect(() => {
    if (releaseInfo?.assets?.length && !selectedAssetUrl) {
      setSelectedAssetUrl(releaseInfo.assets[0].downloadUrl)
    }
  }, [releaseInfo, selectedAssetUrl])

  useEffect(() => {
    if (tsReleaseInfo?.assets?.length && !tsSelectedAssetUrl) {
      setTsSelectedAssetUrl(tsReleaseInfo.assets[0].downloadUrl)
    }
  }, [tsReleaseInfo, tsSelectedAssetUrl])

  useEffect(() => {
    window.api.listExternalModelFolders().then(setExtFolders).catch((e) => console.error('[listExternalModelFolders]', e))
    window.api.listImageModelFolders().then(setImgFolders).catch((e) => console.error('[listImageModelFolders]', e))
    window.api.getMetricsPolling().then(setMetricsPolling).catch((e) => console.error('[getMetricsPolling]', e))
  }, [])

  async function refreshModels() {
    const m = await safeCall(() => window.api.listModelsRefresh(), '刷新模型列表失败')
    if (m) setModels(m)
  }
  async function handleAddExtFolder() {
    const res = await safeCall(() => window.api.addExternalModelFolder(), '添加外部文件夹失败')
    if (res && res.success && res.folders) { setExtFolders(res.folders); await refreshModels() }
  }
  async function handleRemoveExtFolder(folder: string) {
    const res = await safeCall(() => window.api.removeExternalModelFolder(folder), '移除外部文件夹失败')
    if (res && res.folders) {
      setExtFolders(res.folders)
      await refreshModels()
    }
  }
  async function refreshImageModels() {
    const m = await safeCall(() => window.api.listImageModelsRefresh(), '刷新图片模型列表失败')
    if (m) setImageModels(m)
  }
  async function handleAddImgFolder() {
    const res = await safeCall(() => window.api.addImageModelFolder(), '添加图片模型文件夹失败')
    if (res && res.success && res.folders) { setImgFolders(res.folders); await refreshImageModels() }
  }
  async function handleRemoveImgFolder(folder: string) {
    const res = await safeCall(() => window.api.removeImageModelFolder(folder), '移除图片模型文件夹失败')
    if (res && res.folders) {
      setImgFolders(res.folders)
      await refreshImageModels()
    }
  }

  function handleNotifPref(pref: 'banner' | 'manual') {
    setNotifPref(pref)
    try { localStorage.setItem(NOTIF_KEY, pref) } catch (e) { console.error('保存通知偏好失败', e) }
  }

  async function handleSwitchBackend(name: string) {
    const b = backends.find(x => x.name === name)
    if (!b) return
    setActiveBackend(b)
    // 切换后端时按其类型加载默认参数集
    const cmds = await safeCall(() => window.api.getCommands(name, paramSetOf(b.kind)), '切换后端失败')
    if (cmds) setCommandsSchema(cmds)
  }

  async function handleDeleteBackend(name: string) {
    setDeleteTarget(name)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    const name = deleteTarget
    setDeleteTarget(null)
    const res = await safeCall(() => window.api.deleteBackend(name), '删除后端失败')
    if (res === null) return
    if (res.success) {
      const updated = await safeCall(() => window.api.listBackends(), '刷新后端列表失败')
      if (updated) setBackends(updated)
    } else notify('删除失败：' + res.error, 'error')
  }

  async function handleCheckUpdates() {
    setCheckingUpdate(true)
    try {
      const info = await window.api.checkUpdates('ggml-org/llama.cpp')
      setReleaseInfo(info)
    } finally {
      setCheckingUpdate(false)
    }
  }

  const handleDownload = async () => {
    if (!releaseInfo || !releaseInfo.assets?.length) return
    // 防止与其他引擎下载并发（主进程同一时刻只支持一个后端包下载）
    if (downloadProgress) return
    const asset = releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl) || releaseInfo.assets[0]
    setDownloading(true)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      // 版本目录名 = tag + 资源名去掉扩展名（llama.cpp 与 TensorSharp 统一）
      version: `${releaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name
    }), '下载后端失败')
    setDownloading(false)
    setDownloadProgress(null)
      if (res && res.success) {
        const backendsData = await safeCall(() => window.api.listBackends(), '刷新后端列表失败')
        if (backendsData) {
          setBackends(backendsData)
          if (backendsData.length > 0) setActiveBackend(backendsData[0])
        }
      } else if (res && !res.success && !res.cancelled) {
        notify(`下载失败：${res.error}`, 'error')
      }
    }

  // TensorSharp 走与 llama.cpp 完全相同的检查/下载通道，仅仓库名不同
  const TS_REPO = 'zhongkaifu/TensorSharp'
  async function handleCheckTsUpdates() {
    setTsChecking(true)
    try {
      const info = await window.api.checkUpdates(TS_REPO)
      setTsReleaseInfo(info)
    } finally {
      setTsChecking(false)
    }
  }

  const handleTsDownload = async () => {
    if (!tsReleaseInfo || !tsReleaseInfo.assets?.length) return
    // 防止与其他引擎下载并发（主进程同一时刻只支持一个后端包下载）
    if (downloadProgress) return
    const asset = tsReleaseInfo.assets.find(a => a.downloadUrl === tsSelectedAssetUrl) || tsReleaseInfo.assets[0]
    setTsDownloading(true)
    setDownloadProgress(null)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      // 版本目录名与 llama.cpp 一致：tag + 资源名去掉扩展名（如 v3.1.2.0-tensorsharp-server-…-win-x64-cuda）
      version: `${tsReleaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name
    }), '下载 TensorSharp 失败')
    setTsDownloading(false)
    setDownloadProgress(null)
    if (res && res.success) {
      notify('TensorSharp 安装完成', 'success')
      const backendsData = await safeCall(() => window.api.listBackends(), '刷新后端列表失败')
      if (backendsData) setBackends(backendsData)
      // 安装后立即复查版本状态，让“已是最新”徽标及时生效
      try {
        const info = await window.api.checkUpdates(TS_REPO)
        setTsReleaseInfo(info)
      } catch { /* 忽略复查失败 */ }
    } else if (res && !res.success && !res.cancelled) {
      notify(`下载失败：${res.error}`, 'error')
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">管理 llama.cpp 后端和配置</p>
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><Bell /> 更新通知</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            选择您希望如何获知 llama.cpp 新版本的通知方式。
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`launch-mode-btn ${notifPref === 'banner' ? 'active' : ''}`}
              onClick={() => handleNotifPref('banner')}
            >
              <Bell size={13} />
              自动显示横幅
            </button>
            <button
              className={`launch-mode-btn ${notifPref === 'manual' ? 'active' : ''}`}
              onClick={() => handleNotifPref('manual')}
            >
              <BellOff size={13} />
              仅手动检查
            </button>
          </div>
          {notifPref === 'manual' && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              更新横幅将不会自动显示。可随时使用下方的"立即检查"。
            </p>
          )}
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><Activity /> 模型监控轮询</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            每 2 秒向 llama-server 请求 <code>/slots</code> 与 <code>/metrics</code> 接口，获取实时 slot 状态（上下文用量、解码进度等）及 tok/s、KV 缓存占用等监控数据。
            关闭后停止轮询，监控面板将不再刷新。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={metricsPolling} onChange={async (e) => { const v = e.target.checked; try { await window.api.setMetricsPolling(v); setMetricsPolling(v) } catch { setMetricsPolling(!v) } }} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><Type /> 字体</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            选择全局字体预设，即时生效并自动保存。均为系统自带字体，无需下载。
          </p>
          <FontSelector />
        </div>
      </div>

      { }
        <div className="settings-section">
	        <div className="settings-section-title"><Volume2 /> 界面</div>
	        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            开启：助手回复完成时播放提示音。关闭：不播放提示音。
          </p>
	          <label className="toggle" style={{ marginTop: 4 }}>
	            <input
	              type="checkbox"
	              checked={soundEnabled}
	              onChange={() => setSoundEnabled(!soundEnabled)}
	            />
	            <span className="toggle-track"></span>
	            <span className="toggle-thumb"></span>
	          </label>
        </div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            选择助手回复完成时的提示音类型。点击会自动预览。
          </p>
          <div style={{ display: 'flex', gap: 6, width: '100%', flexWrap: 'wrap' }}>
            {SOUND_OPTIONS.map(opt => {
              const selected = notificationSound === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`launch-mode-btn${selected ? ' active' : ''}`}
                  style={{ flex: '1 1 auto', minWidth: 0, padding: '5px 8px', fontSize: 12, lineHeight: 1.3, textAlign: 'center' }}
                  onClick={() => { setNotificationSound(opt.id); previewSound(opt.id) }}
                  title={opt.description}
                >
                  {selected && <Check size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />}
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
        
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            开启：启动时播放开屏动画。关闭：直接进入主界面。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={splashEnabled}
              onChange={() => setSplashEnabled(!splashEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            开启：鼠标悬停在收起的导航栏上时自动展开。关闭：仅通过点击按钮展开。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={hoverExpandEnabled}
              onChange={() => setHoverExpandEnabled(!hoverExpandEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            开启：工具调用卡片展开，显示参数与结果详情。关闭：仅显示工具名称与状态。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={agentToolCardsExpanded}
              onChange={() => setAgentToolCardsExpanded(!agentToolCardsExpanded)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            开启：悬停参数时显示说明提示框。关闭：不显示提示框。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={paramTooltipEnabled}
              onChange={() => setParamTooltipEnabled(!paramTooltipEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            选择界面鼠标光标样式。悬停卡片可在下方预览区试用，点击应用并保存。部分样式可能只包含部分状态（如仅忙碌动画），其余状态使用系统默认光标。
          </p>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, width: '100%' }}
            onMouseLeave={() => setPreviewId(null)}
          >
            {CURSOR_SCHEMES.map(s => {
              const selected = s.id === cursorScheme
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`cursor-theme-card${selected ? ' selected' : ''}`}
                  onClick={() => handleCursorSchemeChange(s.id)}
                  onMouseEnter={() => setPreviewId(s.id)}
                  aria-pressed={selected}
                >
                  <span className="cursor-theme-card-name">{s.label}</span>
                  {selected && <span className="cursor-theme-card-check">✓</span>}
                  <span
                    className="cursor-theme-card-swatch"
                    style={{ cursor: schemeCursorValue(s.id, 'default') || 'default' }}
                  />
                </button>
              )
            })}
          </div>
          <div className="cursor-preview-box">
            <div className="cursor-preview-hint">预览区：在下方格子里移动鼠标，体验「{previewScheme.label}」的光标</div>
            <div className="cursor-preview-cells">
              {previewRoles.map(role => {
                const v = schemeCursorValue(previewId ?? cursorScheme, role)
                const fallback = role === 'pointer' ? 'pointer' : role === 'wait' ? 'wait' : 'default'
                return (
                  <div
                    key={role}
                    className="cursor-preview-cell"
                    style={{ cursor: v || fallback }}
                    title={roleLabels[role]}
                  >
                    <span className="cursor-preview-cell-label">{roleLabels[role]}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><Folder /> 外部模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加应用默认模型目录之外的文件夹。其中的文件（及子目录）将与已下载的模型一起显示在模型页面。文件保留在原位置——不会被复制。
          </p>
          {extFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置外部文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {extFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveExtFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddExtFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><ImageDown /> 图片模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加存放多模态投影仪文件（如 mmproj*.gguf）的文件夹。这些文件将作为图片模型出现在模板的 --mmproj 参数下拉中。
          </p>
          {imgFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置图片模型文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {imgFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveImgFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddImgFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><HardDrive /> 已安装的后端</div>
        {backends.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
            未安装后端。请在下方下载。
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {backends.map((b) => (
              <div key={b.name}>
                <div className="settings-row">
                  <div>
                    <div className="settings-row-label flex items-center gap-2">
                      {b.name}
                      {b.kind && b.kind !== 'other' && <span className={`version-badge${b.kind === 'tensorsharp' ? ' ts-badge' : ''}`}>{ENGINE_LABELS[b.kind] ?? b.kind}</span>}
                      {activeBackend?.name === b.name && <span className="version-badge active-version">当前使用</span>}
                      {!b.hasCommands && <span className="version-badge">回退架构</span>}
                    </div>
                    <div className="settings-row-sub mono">{b.exe || '未找到可执行文件'}</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSwitchBackend(b.name)}
                      disabled={activeBackend?.name === b.name}
                    >
                      设为当前
                    </button>
                    <button
                      className={`btn btn-ghost btn-sm flex items-center gap-1 ${expandedEditor === b.name ? 'btn-primary' : ''}`}
                      onClick={() => setExpandedEditor(expandedEditor === b.name ? null : b.name)}
                    >
                      <Terminal size={13} />
                      <ChevronDown size={12} style={{ transform: expandedEditor === b.name ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
                    </button>
                    <div style={{ position: 'relative' }}>
                      <button
                        className="btn btn-ghost btn-icon text-danger"
                        onClick={() => handleDeleteBackend(b.name)}
                      >
                        <Trash size={14} />
                      </button>
                      {deleteTarget === b.name && (
                        <div
                          ref={deletePopoverRef}
                          className="delete-popover"
                        >
                          <div className="delete-popover-header">
                            <AlertTriangle size={16} />
                            <span className="delete-popover-title">删除后端</span>
                          </div>
                          <div className="delete-popover-body">
                            确定删除后端 <b>{b.name}</b>？这将移除该文件夹中的所有文件，且不可撤销。
                          </div>
                          <div className="delete-popover-footer">
                            <button className="btn btn-ghost btn-sm" onClick={() => setDeleteTarget(null)}>取消</button>
                            <button ref={deleteConfirmRef} className="btn btn-danger btn-sm" onClick={confirmDelete}>删除</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {expandedEditor === b.name && (
                  <div className="ce-panel">
                    <CommandsEditor backendName={b.name} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><Download /> 可用更新</div>
        {checkingUpdate ? (
          <div className="flex items-center gap-2 text-sm py-4" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw size={14} className="spin" /> 正在检查 GitHub 发布...
          </div>
        ) : releaseInfo ? (
          releaseInfo.error ? (
            <div className="text-danger text-sm py-2">错误：{releaseInfo.error}</div>
          ) : releaseInfo.noRelease ? (
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>
              未检测到官方发布信息（GitHub 可能暂未发布，或接口返回为空）。
            </div>
          ) : releaseInfo.noPackage ? (
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>
              未检测到适用于当前平台 / 架构的官方发布包。
              {(releaseInfo.name || releaseInfo.tagName) && (
                <> 最新发布：{releaseInfo.name || releaseInfo.tagName}（{new Date(releaseInfo.publishedAt).toLocaleDateString()}）</>
              )}
            </div>
          ) : (
            <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div className="settings-row-label">{releaseInfo.name || releaseInfo.tagName}</div>
                <div className="settings-row-sub">
                  发布日期：{new Date(releaseInfo.publishedAt).toLocaleDateString()}
                  {releaseInfo.isNewer === false && <span style={{ marginLeft: 8, color: 'var(--success)' }}>✓ 已是最新</span>}
                </div>
              </div>
              {releaseInfo.isNewer !== false && releaseInfo.assets?.length > 0 && (
                <div className="flex items-center gap-2 w-full">
                  <div ref={assetDropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <button
                      className="cmd-select"
                      style={{ width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                      onClick={() => {
                        if (showAssetDropdown) { setShowAssetDropdown(false); return }
                        if (assetDropdownRef.current) {
                          const rect = assetDropdownRef.current.getBoundingClientRect()
                          setDropdownUp(window.innerHeight - rect.bottom < 260)
                        }
                        setShowAssetDropdown(true)
                      }}
                      disabled={downloading || !!downloadProgress}
                    >
                      {releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl)?.name || '选择版本'}
                    </button>
                    {showAssetDropdown && (
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
                            onClick={() => { setSelectedAssetUrl(a.downloadUrl); setShowAssetDropdown(false) }}
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
                    <button className="btn btn-primary btn-sm" onClick={handleDownload}>下载</button>
                  )}
                </div>
              )}
              {downloading && downloadProgress && (downloadProgress.phase === 'downloading' || downloadProgress.phase === 'extracting') && (
                <div className="flex items-center gap-2 w-full">
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {downloadProgress.phase === 'extracting'
                      ? '正在解压...'
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
          <div className="text-sm py-4" style={{ color: 'var(--text-muted)' }}>点击"立即检查"查询 GitHub。</div>
        )}
        <div className="mt-4 pt-4 border-t">
          <button className="btn btn-secondary w-full justify-center" onClick={handleCheckUpdates} disabled={checkingUpdate || downloading}>
            <RefreshCw size={14} className={checkingUpdate ? 'spin' : ''} /> 立即检查
          </button>
        </div>
        </div>

      { }
      <div className="settings-section">
        <div className="settings-section-title"><Cpu /> TensorSharp 引擎</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            TensorSharp.Server（OpenAI / Ollama 兼容推理服务器，支持多模态 / PDF / 视频）。与 llama.cpp 引擎并行安装、互不干扰；
            监听地址固定为 <code>http://0.0.0.0:5000</code>（官方硬编码），请勿同时运行两张 TensorSharp 模型卡或占用 5000 端口的服务。
          </p>
          {tsChecking ? (
            <div className="flex items-center gap-2 text-sm py-2" style={{ color: 'var(--text-muted)' }}>
              <RefreshCw size={14} className="spin" /> 正在检查 GitHub 发布...
            </div>
          ) : tsReleaseInfo ? (
            tsReleaseInfo.error ? (
              <div className="text-danger text-sm py-2">错误：{tsReleaseInfo.error}</div>
            ) : tsReleaseInfo.noPackage ? (
              <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>未检测到适用于当前平台的 TensorSharp 发布包。</div>
            ) : (
              <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '6px 0' }}>
                <div>
                  <div className="settings-row-label">{tsReleaseInfo.name || tsReleaseInfo.tagName}</div>
                  <div className="settings-row-sub">
                    发布日期：{new Date(tsReleaseInfo.publishedAt).toLocaleDateString()}
                    {tsReleaseInfo.isNewer === false && <span style={{ marginLeft: 8, color: 'var(--success)' }}>✓ 已安装最新版本</span>}
                  </div>
                </div>
                {tsReleaseInfo.isNewer !== false && tsReleaseInfo.assets?.length > 0 && (
                  <div className="flex items-center gap-2 w-full">
                    {/* 与 llama.cpp 区块一致的资产选择下拉（CPU / CUDA 等变体由用户自选） */}
                    <div ref={tsAssetDropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                      <button
                        className="cmd-select"
                        style={{ width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                        onClick={() => {
                          if (showTsAssetDropdown) { setShowTsAssetDropdown(false); return }
                          if (tsAssetDropdownRef.current) {
                            const rect = tsAssetDropdownRef.current.getBoundingClientRect()
                            setTsDropdownUp(window.innerHeight - rect.bottom < 260)
                          }
                          setShowTsAssetDropdown(true)
                        }}
                        disabled={tsDownloading || !!downloadProgress}
                      >
                        {tsReleaseInfo.assets.find(a => a.downloadUrl === tsSelectedAssetUrl)?.name || '选择版本'}
                      </button>
                      {showTsAssetDropdown && (
                        <div style={{
                          position: 'absolute' as const, left: 0, right: 0,
                          background: 'var(--surface)', border: '1.5px solid var(--border)',
                          borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)',
                          maxHeight: 240, overflowY: 'auto' as const, zIndex: 300,
                          ...(tsDropdownUp ? { bottom: 'calc(100% + 2px)' } : { top: 'calc(100% + 2px)' })
                        }}>
                          {tsReleaseInfo.assets.map(a => (
                            <div
                              key={a.downloadUrl}
                              style={{
                                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                                background: a.downloadUrl === tsSelectedAssetUrl ? 'var(--bg)' : tsHoveredAsset === a.downloadUrl ? 'var(--surface-hover)' : 'transparent',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                              }}
                              onClick={() => { setTsSelectedAssetUrl(a.downloadUrl); setShowTsAssetDropdown(false) }}
                              onMouseEnter={() => setTsHoveredAsset(a.downloadUrl)}
                              onMouseLeave={() => setTsHoveredAsset('')}
                            >
                              {a.name} ({Math.round(a.size / 1024 / 1024)} MB)
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {tsDownloading ? (
                      <button className="btn btn-secondary btn-sm" disabled>
                        <Loader2 size={14} className="spin" /> 下载中...
                      </button>
                    ) : downloadProgress ? (
                      <button className="btn btn-secondary btn-sm" disabled>其他引擎下载中</button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={handleTsDownload}>下载并安装</button>
                    )}
                  </div>
                )}
                {tsDownloading && downloadProgress && (downloadProgress.phase === 'downloading' || downloadProgress.phase === 'extracting') && (
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
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>尚未检查。点击下方按钮查询 TensorSharp 最新发布。</div>
          )}
          <button className="btn btn-secondary w-full justify-center" onClick={handleCheckTsUpdates} disabled={tsChecking || tsDownloading}>
            <RefreshCw size={14} className={tsChecking ? 'spin' : ''} /> {tsReleaseInfo ? '重新检查' : '检查 TensorSharp 发布'}
          </button>
        </div>
      </div>

      { }
      <EngineDownloadSection
        repo="TheTom/llama-cpp-turboquant"
        engineLabel="TurboQuant"
        description={
          <>
            llama.cpp 的 TurboQuant 分支：KV 缓存专用 turbo2 / turbo3 / turbo4 量化（Walsh-Hadamard 旋转，
            相对 f16 压缩 6.4x / 4.9x / 3.8x，需配合 Flash Attention），以及 TQ3_1S / TQ4_1S 模型权重量化。
            发布资产形如 <code>turboquant-plus-tqp-v0.3.0-windows-x64-cuda12.4.zip</code>，请按平台选择。
          </>
        }
      />
      <EngineDownloadSection
        repo="Anbeeld/beellama.cpp"
        engineLabel="BeeLlama"
        description={
          <>
            llama.cpp 的 BeeLlama 分支：KVarN 方差归一化 KV 量化（kvarn2~kvarn8）、KV 缓存精度尾
            （<code>--kv-tail-tokens</code>）、DFlash 自适应草稿深度与推理循环防护。发布资产形如
            <code>beellama-v0.4.2-bin-win-cuda-13.1-x64.zip</code>，请按平台选择。
            注意：bin 包不含 CUDA 运行时，若系统未安装对应版本的 CUDA，需额外下载同版本的
            <code>beellama-v0.4.2-cudart-win-cuda-13.1-x64.zip</code> 并手动解压进后端目录。
          </>
        }
      />
      </div>
    )
  }
