import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal, Bell, BellOff, FolderPlus, Folder, Activity, Volume2, ImageDown } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import CommandsEditor from './CommandsEditor'
import ConfirmModal from './ConfirmModal'
import { CURSOR_SCHEMES, getCursorSchemeId, applyCursorScheme, CURSOR_STORAGE_KEY, schemeCursorValue, type CursorRole } from '../cursor-theme'

const NOTIF_KEY = 'hexllama_update_notify'

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
	    setModels, setImageModels, soundEnabled, setSoundEnabled, chatSidebarCollapsed, setChatSidebarCollapsed, splashEnabled, setSplashEnabled } = useStore(
	    s => ({ backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, setBackends: s.setBackends, releaseInfo: s.releaseInfo, checkingUpdate: s.checkingUpdate, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, setCheckingUpdate: s.setCheckingUpdate, setReleaseInfo: s.setReleaseInfo, setModels: s.setModels, setImageModels: s.setImageModels, soundEnabled: s.soundEnabled, setSoundEnabled: s.setSoundEnabled, chatSidebarCollapsed: s.chatSidebarCollapsed, setChatSidebarCollapsed: s.setChatSidebarCollapsed, splashEnabled: s.splashEnabled, setSplashEnabled: s.setSplashEnabled }),
    shallow
  )
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
  const [extFolders, setExtFolders] = useState<string[]>([])
  const [imgFolders, setImgFolders] = useState<string[]>([])
  const [metricsPolling, setMetricsPolling] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
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
    const cmds = await safeCall(() => window.api.getCommands(name), '切换后端失败')
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
      const info = await window.api.checkUpdates()
      setReleaseInfo(info)
    } finally {
      setCheckingUpdate(false)
    }
  }

  const handleDownload = async () => {
    if (!releaseInfo || !releaseInfo.assets?.length) return
    const asset = releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl) || releaseInfo.assets[0]
    setDownloading(true)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
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
    } else if (res && !res.success) {
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
            每秒向 llama-server 请求 <code>/slots</code> 接口获取实时 slot 状态（上下文用量、解码进度等）。
            关闭可减少约 35% 的 HTTP 轮询开销，tok/s 数据仍通过日志实时解析不受影响。
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
	        <div className="settings-section-title"><Volume2 /> 界面</div>
	        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
	          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
	            聊天界面：助手回复完成时播放提示音。
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
	        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
	          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            默认收起聊天界面的会话侧边栏，为消息区域留出更多空间。
          </p>
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={chatSidebarCollapsed}
              onChange={() => setChatSidebarCollapsed(!chatSidebarCollapsed)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            启动时播放开屏动画（积木塔崩落效果）。关闭后将直接进入主界面。
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
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveExtFolder(f)} title="移除文件夹">
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
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveImgFolder(f)} title="移除文件夹">
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
                      title="编辑 commands.json"
                    >
                      <Terminal size={13} />
                      <ChevronDown size={12} style={{ transform: expandedEditor === b.name ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon text-danger"
                      onClick={() => handleDeleteBackend(b.name)}
                      title="删除后端"
                    >
                      <Trash size={14} />
                    </button>
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
                  {downloading || downloadProgress ? (
                    <button className="btn btn-secondary btn-sm" disabled>
                      <Loader2 size={14} className="spin" /> 下载中...
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={handleDownload}>下载</button>
                  )}
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

        <ConfirmModal
          open={!!deleteTarget}
          title="删除后端"
          message={`确定删除后端 "${deleteTarget}"？这将移除该文件夹中的所有文件。`}
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      </div>
    )
  }
