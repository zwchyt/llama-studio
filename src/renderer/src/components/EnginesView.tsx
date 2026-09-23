import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal, AlertTriangle, Cpu } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { ENGINE_LABELS, ENGINE_REPOS, paramSetOf } from '../utils/engine'
import type { SdCudartStatus } from '../../../shared/types'
import CommandsEditor from './CommandsEditor'
import EngineDownloadSection from './EngineDownloadSection'
import AssetVersionSelect from './AssetVersionSelect'
// 本页样式完全自包含：全部规则（含骨架）都在 engines.css 内并作用域在 .engines-view 下，
// 因此这里**不再**引用 settings.css —— 改这个文件不可能影响到设置页 / 模型文件夹页。
import '../styles/engines.css'

/**
 * 后端与引擎视图：管理已安装后端、下载 llama.cpp / TensorSharp / 各分支引擎。
 * 从原「设置」页拆出，减少设置页内容堆叠。
 * 外观由 ../styles/engines.css 提供（全部作用域在 .engines-view 下，只影响本页）。
 */
export default function EnginesView() {
  const {
    backends, backendsStatus, activeBackend, setActiveBackend, setCommandsSchema, setBackends,
    releaseInfo, checkingUpdate, downloadProgress, setDownloadProgress, setCheckingUpdate, setReleaseInfo,
    engineReleases, setEngineRelease
  } = useStore(
    s => ({ backends: s.backends, backendsStatus: s.backendsStatus, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, setBackends: s.setBackends, releaseInfo: s.releaseInfo, checkingUpdate: s.checkingUpdate, downloadProgress: s.downloadProgress, setDownloadProgress: s.setDownloadProgress, setCheckingUpdate: s.setCheckingUpdate, setReleaseInfo: s.setReleaseInfo, engineReleases: s.engineReleases, setEngineRelease: s.setEngineRelease }),
    shallow
  )

  const dlActive = downloadProgress && (downloadProgress.phase === 'downloading' || downloadProgress.phase === 'extracting' || downloadProgress.phase === 'verifying' || downloadProgress.phase === 'paused') ? downloadProgress : null
  const llamaBusy = !!dlActive && dlActive.engine === 'llamacpp'
  const tsBusy = !!dlActive && dlActive.engine === 'tensorsharp'

  const [downloading, setDownloading] = useState(false)
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('')
  const [expandedEditor, setExpandedEditor] = useState<string | null>(null)
  // 版本下拉的展开/定位/外部点击关闭全部由 AssetVersionSelect 内部托管（portal + fixed 定位）

  // TensorSharp 引擎发布信息（与 llama.cpp 共用同一条 check-updates / download-release 通道）
  const TS_REPO = ENGINE_REPOS.tensorsharp
  const tsReleaseInfo = engineReleases[TS_REPO] ?? null
  const [tsChecking, setTsChecking] = useState(false)
  const [tsDownloading, setTsDownloading] = useState(false)
  const [tsSelectedAssetUrl, setTsSelectedAssetUrl] = useState('')

  // stable-diffusion.cpp CUDA 运行时下载状态（cudart 包独立通道）
  const [sdCudartBusy, setSdCudartBusy] = useState(false)
  const [sdCudartPercent, setSdCudartPercent] = useState(0)
  const [sdCudartInstalled, setSdCudartInstalled] = useState<SdCudartStatus | null>(null)

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

  useEffect(() => {
    window.api.onSdCudartProgress((d) => { setSdCudartPercent(d.percent ?? 0) })
    return () => window.api.removeSdCudartProgressListener()
  }, [])

  // CUDA 运行时状态检查：主进程会顺带比对 GitHub 上游的最新发布时间 / 资产 sha256，
  // 据此判断本地副本是否过期（不只是「dll 在不在」）
  const refreshSdCudart = React.useCallback(async (backendName: string) => {
    try {
      const res = await window.api.checkSdCudartInstalled(backendName)
      setSdCudartInstalled(res ?? null)
    } catch { setSdCudartInstalled(null) }
  }, [])

  useEffect(() => {
    const sdBackend = backends.find(b => b.kind === 'sdcpp')
    if (!sdBackend) { setSdCudartInstalled(null); return }
    void refreshSdCudart(sdBackend.name)
  }, [backends, refreshSdCudart])

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

  async function handleSwitchBackend(name: string) {
    const b = backends.find(x => x.name === name)
    if (!b) return
    setActiveBackend(b)
    // 切换后端时按其类型加载默认参数集
    const cmds = await safeCall(() => window.api.getCommands(name, paramSetOf(b.kind)), '切换后端失败')
    if (cmds) setCommandsSchema(cmds)
  }

  function handleDeleteBackend(name: string) {
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
    if (downloadProgress) return
    const asset = releaseInfo.assets.find(a => a.downloadUrl === selectedAssetUrl) || releaseInfo.assets[0]
    setDownloading(true)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      version: `${releaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name,
      digest: asset.digest
    }), '下载后端失败')
    setDownloading(false)
    if (res && res.paused) return
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

  async function handleCheckTsUpdates() {
    setTsChecking(true)
    try {
      const info = await window.api.checkUpdates(TS_REPO)
      setEngineRelease(TS_REPO, info)
    } finally {
      setTsChecking(false)
    }
  }

  const handleTsDownload = async () => {
    if (!tsReleaseInfo || !tsReleaseInfo.assets?.length) return
    if (downloadProgress) return
    const asset = tsReleaseInfo.assets.find(a => a.downloadUrl === tsSelectedAssetUrl) || tsReleaseInfo.assets[0]
    setTsDownloading(true)
    setDownloadProgress(null)
    const res = await safeCall(() => window.api.downloadRelease({
      url: asset.downloadUrl,
      version: `${tsReleaseInfo.tagName}-${asset.name.replace(/\.(zip|tar\.gz)$/, '')}`,
      assetName: asset.name,
      digest: asset.digest
    }), '下载 TensorSharp 失败')
    setTsDownloading(false)
    if (res && res.paused) return
    setDownloadProgress(null)
    if (res && res.success) {
      notify('TensorSharp 安装完成', 'success')
      const backendsData = await safeCall(() => window.api.listBackends(), '刷新后端列表失败')
      if (backendsData) setBackends(backendsData)
      try {
        const info = await window.api.checkUpdates(TS_REPO)
        setEngineRelease(TS_REPO, info)
      } catch { /* 忽略复查失败 */ }
    } else if (res && !res.success && !res.cancelled) {
      notify(`下载失败：${res.error}`, 'error')
    }
  }

  // 下载 stable-diffusion.cpp 的 CUDA 运行时包并合并进已安装的 sd 引擎目录
  async function handleInstallSdCudart() {
    if (sdCudartBusy) return
    const releaseInfo = engineReleases['leejet/stable-diffusion.cpp'] ?? null
    const asset = releaseInfo?.cudartAsset
    const sdBackend = backends.find(b => b.kind === 'sdcpp')
    if (!asset || !sdBackend) return
    setSdCudartBusy(true)
    setSdCudartPercent(0)
    const res = await safeCall(() => window.api.installSdCudart({
      url: asset.downloadUrl,
      assetName: asset.name,
      backendName: sdBackend.name,
      digest: asset.digest
    }), '下载 CUDA 运行时失败')
    setSdCudartBusy(false)
    if (res && res.success) {
      const verified = res.verified ? '验证通过' : '验证失败'
      const dllInfo = res.found?.length ? `（${res.found.join(', ')}）` : ''
      notify(`CUDA 运行时已安装 ${verified}${dllInfo}，重启模板后生效`, 'success')
      await refreshSdCudart(sdBackend.name)
    } else if (res && !res.success) {
      notify(`安装失败：${res.error}`, 'error')
    }
  }

  return (
    <div className="max-w-3xl engines-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">后端与引擎</h1>
          <p className="page-subtitle">管理已安装的后端与引擎下载</p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><HardDrive /> 已安装的后端</div>
        {backends.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
            {backendsStatus === 'loading' ? '正在扫描后端…' : '未安装后端。请在下方下载。'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {backends.map((b) => (
              <div key={b.name}>
                <div className={`settings-row backend-row ev-eng--${b.kind ?? 'other'}`}>
                  <div>
                    <div className="settings-row-label flex items-center gap-2">
                      {b.name}
                      {b.kind && b.kind !== 'other' && (
                        <span className={`version-badge ev-badge--engine ev-eng--${b.kind}`}>{ENGINE_LABELS[b.kind] ?? b.kind}</span>
                      )}
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

      <div className="settings-section ev-card--engine ev-eng--llamacpp">
        <div className="settings-section-title"><Download /> 可用更新</div>
        <p className="ev-desc" style={{ marginBottom: 12 }}>
          llama.cpp 基础引擎：GGML/GGUF 大模型推理后端，支持 CPU 与 CUDA 加速，安装后可在「我的模板」创建文本模型卡。
        </p>
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
            <div className="ev-release">
              <div>
                <div className="ev-release-name">{releaseInfo.name || releaseInfo.tagName}</div>
                <div className="ev-release-meta">
                  <span className="ev-release-date">发布日期：{new Date(releaseInfo.publishedAt).toLocaleDateString()}</span>
                  {releaseInfo.isNewer === false && <span className="ev-latest">✓ 已是最新</span>}
                </div>
              </div>
              {releaseInfo.isNewer !== false && releaseInfo.assets?.length > 0 && (
                <div className="ev-asset-row">
                  <AssetVersionSelect
                    assets={releaseInfo.assets}
                    value={selectedAssetUrl}
                    onChange={setSelectedAssetUrl}
                    disabled={downloading || !!downloadProgress}
                  />
                  {downloading || llamaBusy ? (
                    <button className="btn btn-secondary btn-sm" disabled>
                      <Loader2 size={14} className="spin" /> 下载中...
                    </button>
                  ) : dlActive ? (
                    <button className="btn btn-secondary btn-sm" disabled>其他引擎下载中</button>
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
        <div className="ev-check-block">
          <button className="btn btn-secondary w-full justify-center" onClick={handleCheckUpdates} disabled={checkingUpdate || downloading}>
            <RefreshCw size={14} className={checkingUpdate ? 'spin' : ''} /> 立即检查
          </button>
        </div>
      </div>

      <div className="settings-section ev-card--engine ev-eng--tensorsharp">
        <div className="settings-section-title"><Cpu /> TensorSharp 引擎</div>
        <div className="ev-body">
          <p className="ev-desc">
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
              <div className="ev-release">
                <div>
                  <div className="ev-release-name">{tsReleaseInfo.name || tsReleaseInfo.tagName}</div>
                  <div className="ev-release-meta">
                    <span className="ev-release-date">发布日期：{new Date(tsReleaseInfo.publishedAt).toLocaleDateString()}</span>
                    {tsReleaseInfo.isNewer === false && <span className="ev-latest">✓ 已安装最新版本</span>}
                  </div>
                </div>
                {tsReleaseInfo.isNewer !== false && tsReleaseInfo.assets?.length > 0 && (
                  <div className="ev-asset-row">
                    <AssetVersionSelect
                      assets={tsReleaseInfo.assets}
                      value={tsSelectedAssetUrl}
                      onChange={setTsSelectedAssetUrl}
                      disabled={tsDownloading || !!downloadProgress}
                    />
                    {tsDownloading || tsBusy ? (
                      <button className="btn btn-secondary btn-sm" disabled>
                        <Loader2 size={14} className="spin" /> 下载中...
                      </button>
                    ) : dlActive ? (
                      <button className="btn btn-secondary btn-sm" disabled>其他引擎下载中</button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={handleTsDownload}>下载并安装</button>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>尚未检查。点击下方按钮查询 TensorSharp 最新发布。</div>
          )}
          <div className="ev-check-block">
            <button className="btn btn-secondary w-full justify-center" onClick={handleCheckTsUpdates} disabled={tsChecking || tsDownloading}>
              <RefreshCw size={14} className={tsChecking ? 'spin' : ''} /> {tsReleaseInfo ? '重新检查' : '检查 TensorSharp 发布'}
            </button>
          </div>
        </div>
      </div>

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
      <EngineDownloadSection
        repo="leejet/stable-diffusion.cpp"
        engineLabel="stable-diffusion.cpp"
        description="扩散模型（SD / FLUX / Wan / Qwen-Image 等）推理引擎，提供文生图/图生图接口，安装后可在「图像生成」中使用。"
        extra={
          <div className="ev-subpanel">
            <div className="ev-subpanel-title"><Cpu /> CUDA 运行时</div>
            <p className="ev-subpanel-hint">
              缺少运行库时安装即可启用 GPU，重启后生效。是否已过期按 GitHub 上游的最新发布时间与包校验值判断，
              上游发新版后会提示重新下载。
            </p>
            {(() => {
              const sdBackend = backends.find(b => b.kind === 'sdcpp')
              const releaseInfo = engineReleases['leejet/stable-diffusion.cpp'] ?? null
              const asset = releaseInfo?.cudartAsset
              if (!sdBackend) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>请先安装 stable-diffusion.cpp 引擎。</div>
              if (!asset) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未检测到 CUDA 运行时发布包（此包仅 Windows 提供）。</div>
              const st = sdCudartInstalled
              const up = st?.upstream ?? null
              const upTime = up?.publishedAt ?? up?.updatedAt ?? null
              const upTimeText = upTime ? new Date(upTime).toLocaleString('zh-CN') : '未知'
              const localTimeText = st?.local?.installedAt ? new Date(st.local.installedAt).toLocaleString('zh-CN') : '无记录'
              // 上游查询失败（离线 / API 超限）时不能谎报“已是最新”，只说明无法确认
              const upstreamUnavailable = !!st && !up
              // 检查尚未返回（st 为 null）时也允许下载：无法确认新鲜度时不锁死入口
              const showDownload = !st || st.needsUpdate
              // 状态行三态：未安装 / 已过期 / 已是最新（上游查询失败时归到「未安装」的弱态）
              const statusClass = !st ? '' : !st.installed ? 'ev-status--muted' : st.stale ? 'ev-status--warn' : 'ev-status--ok'
              return (
                <>
                  <span className="ev-meta">
                    <b>{up?.assetName || asset.name}</b>（约 {((up?.size || asset.size) / 1024 / 1024).toFixed(0)}MB）
                    {' · 上游发布 '}{upTimeText}
                  </span>
                  {!st ? (
                    <div className="ev-status ev-status--muted">正在检查上游版本…</div>
                  ) : !st.installed ? (
                    <div className={`ev-status ${statusClass}`}>
                      未安装{st.missing?.length ? '，缺少 ' + st.missing.join(', ') : ''}
                    </div>
                  ) : st.stale ? (
                    <div className={`ev-status ${statusClass}`}>
                      本地副本已过期（{st.reasons.join('；')}）
                    </div>
                  ) : (
                    <div className={`ev-status ${statusClass}`}>
                      CUDA 运行时已是最新（{st.found?.join(', ')}）
                    </div>
                  )}
                  {st && (
                    <span className="ev-meta">
                      本地安装时间 {localTimeText}
                      {up?.releaseTag ? ` · 上游版本 ${up.releaseTag}` : ''}
                      {up?.commitAt ? ` · 最近提交 ${new Date(up.commitAt).toLocaleDateString('zh-CN')}` : ''}
                      {upstreamUnavailable ? ' · 无法访问 GitHub，暂不判定是否过期' : ''}
                    </span>
                  )}
                  <div className="ev-actions">
                    {sdCudartBusy ? (
                      <button className="btn btn-secondary btn-sm" disabled>
                        <Loader2 size={14} className="spin" /> 下载安装中... {sdCudartPercent}%
                      </button>
                    ) : showDownload ? (
                      <button
                        className={st?.installed ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                        onClick={handleInstallSdCudart}
                      >
                        <Download size={13} /> {st?.installed ? '重新下载 CUDA 运行时' : '下载并安装 CUDA 运行时'}
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-sm" disabled>CUDA 运行时已是最新</button>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        }
      />
      <EngineDownloadSection
        repo="0xShug0/audio.cpp"
        engineLabel="audio.cpp"
        description={
          <>
            audio.cpp：TTS / ASR / 音乐生成 / 声音克隆推理引擎，内置 WebUI（模型安装 / 加载 / 生成均在页内完成），
            安装后可在「音频工作室」中使用。发布资产形如 <code>audiocpp-windows-cuda-portable-&lt;hash&gt;.zip</code>，
            请按平台选择。注意：Windows 主包不含 CUDA 运行时，若系统未安装对应版本的 CUDA，
            需额外下载同版本的 <code>audiocpp-windows-cuda-runtime-*.zip</code> 并手动解压进后端目录。
          </>
        }
      />
    </div>
  )
}
