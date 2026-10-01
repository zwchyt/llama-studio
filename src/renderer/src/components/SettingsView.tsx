import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import { Bell, BellOff, Activity, Type, Volume2, Check, Brain, Image as ImageIcon } from 'lucide-react'
import { PACK_OPTIONS, previewSound } from '../utils/sound'
import { dataUrlToBlobUrl } from '../utils/audioUrl'
import { agentConfig, setAgentConfigOverride } from '../utils/agentConfig'

import FontSelector from './FontSelector'
// 音色下拉改用项目统一的自定义下拉组件（不再用原生 <select>，避免系统原生弹层样式）
import CustomSelect from './CustomSelect'
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

/** 背景库的一张缩略图：组件挂载时才找主进程要 240px 小图。
 *  刻意不回读原图——整库原图一次走 IPC 是几十 MB，设置页会白卡一下。 */
function BgThumb({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.getBackgroundThumb(name)
      .then(r => { if (alive && r.success && r.dataUrl) setUrl(r.dataUrl) })
      .catch(() => { /* 单张解码失败就留空格，不连累整列 */ })
    return () => { alive = false }
  }, [name])
  return url ? <img className="st-bg-img" src={url} alt="" /> : <span className="st-bg-img st-bg-img--empty" />
}

export default function SettingsView() {
  const {
    soundEnabled, setSoundEnabled, notificationSound, setNotificationSound,
    splashEnabled, setSplashEnabled,
    paramTooltipEnabled, setParamTooltipEnabled,
    ttsEngine, setTtsEngine, ttsEdgeVoice, setTtsEdgeVoice, ttsRate, setTtsRate,
  } = useStore(
    s => ({ soundEnabled: s.soundEnabled, setSoundEnabled: s.setSoundEnabled, notificationSound: s.notificationSound, setNotificationSound: s.setNotificationSound, splashEnabled: s.splashEnabled, setSplashEnabled: s.setSplashEnabled, paramTooltipEnabled: s.paramTooltipEnabled, setParamTooltipEnabled: s.setParamTooltipEnabled, ttsEngine: s.ttsEngine, setTtsEngine: s.setTtsEngine, ttsEdgeVoice: s.ttsEdgeVoice, setTtsEdgeVoice: s.setTtsEdgeVoice, ttsRate: s.ttsRate, setTtsRate: s.setTtsRate }),
    (a, b) => a.soundEnabled === b.soundEnabled && a.setSoundEnabled === b.setSoundEnabled && a.notificationSound === b.notificationSound && a.setNotificationSound === b.setNotificationSound && a.splashEnabled === b.splashEnabled && a.setSplashEnabled === b.setSplashEnabled && a.paramTooltipEnabled === b.paramTooltipEnabled && a.setParamTooltipEnabled === b.setParamTooltipEnabled && a.ttsEngine === b.ttsEngine && a.setTtsEngine === b.setTtsEngine && a.ttsEdgeVoice === b.ttsEdgeVoice && a.setTtsEdgeVoice === b.setTtsEdgeVoice && a.ttsRate === b.ttsRate && a.setTtsRate === b.setTtsRate
  )
  const { hoverExpandEnabled, setHoverExpandEnabled } = useSidebarStore()
  // Edge 音色列表（进设置页且选了 Edge 引擎时才拉，失败不阻塞界面）
  const [edgeVoices, setEdgeVoices] = useState<Array<{ name: string; label: string; gender: string; locale: string }>>([])
  const [voiceErr, setVoiceErr] = useState('')
  // 试听失败与「列表获取失败」分开存：混在一个状态里会让报错张冠李戴，
  // 之前就是试听失败却显示成「音色列表获取失败」，把排查方向带偏了
  const [previewErr, setPreviewErr] = useState('')
  const [voicePreviewing, setVoicePreviewing] = useState(false)
  // 试听用的 blob URL：CSP 的 media-src 不含 data:，必须转成 blob 才能播放；用完要释放
  const previewBlobRef = useRef<string | null>(null)
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [metricsPolling, setMetricsPolling] = useState(true)
  // ── 界面背景 ──
  // 图库＝背景目录里的图片文件；背景状态存在全局 store（根节点铺图要用，不只是本页）。
  const { backgroundImage, backgroundStrength, setBackgroundImage, setBackgroundStrength } = useStore(
    s => ({ backgroundImage: s.backgroundImage, backgroundStrength: s.backgroundStrength, setBackgroundImage: s.setBackgroundImage, setBackgroundStrength: s.setBackgroundStrength }),
    shallow
  )
  const [bgImages, setBgImages] = useState<string[]>([])
  const [bgDir, setBgDir] = useState('')
  const [bgErr, setBgErr] = useState('')
  const refreshBgLibrary = () => {
    window.api.listBackgrounds().then(list => {
      setBgImages(list)
      // 正在用的那张被从文件管理器里删掉了：立刻摘下来回纯色，否则界面还在铺一张
      // 已经不存在的图，而且要等切走再切回本页重挂载才反应过来。
      const cur = useStore.getState().backgroundImage
      if (cur && !list.includes(cur)) setBackgroundImage(null)
    }).catch((e) => console.error('[listBackgrounds]', e))
  }
  useEffect(() => {
    refreshBgLibrary()
    // 目录真实位置 dev 在项目里、打包后在 userData 下，所以显示回来而不是写死在文案里
    window.api.getBackgroundsDir().then(setBgDir).catch((e) => console.error('[getBackgroundsDir]', e))
    // 在资源管理器里删图/丢图，本页不会自己知道：窗口一回前台就重读目录
    const onWinFocus = () => refreshBgLibrary()
    window.addEventListener('focus', onWinFocus)
    return () => window.removeEventListener('focus', onWinFocus)
  }, [])
  async function pickBackgroundImage() {
    setBgErr('')
    try {
      const r = await window.api.importBackground()
      if (!r.success) {
        // 用户按取消不算错误，什么都不提示
        if (r.error && r.error !== '已取消') setBgErr(`导入失败：${r.error}`)
        return
      }
      refreshBgLibrary()
      // 导入即应用，省掉「先导入、再回来点缩略图」那一下
      if (r.fileName) setBackgroundImage(r.fileName)
    } catch (e) {
      setBgErr(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  async function removeBackground(name: string) {
    setBgErr('')
    try {
      const r = await window.api.deleteBackground(name)
      if (!r.success) { setBgErr(`删除失败：${r.error ?? '未知错误'}`); return }
      // 删的正是当前用的那张：先摘下来，不然界面还铺着一张已经不存在的图
      if (name === backgroundImage) setBackgroundImage(null)
      refreshBgLibrary()
    } catch (e) {
      setBgErr(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const [cursorScheme, setCursorScheme] = useState<string>(getCursorSchemeId())
  const [previewId, setPreviewId] = useState<string | null>(null)
  // 长期记忆：三态合成一个控件（关闭 / 自动写入 / 写入前确认）。
  // 初值取配置单例（含 localStorage 覆盖项）。此前该开关只有默认值、没有任何 UI 入口，
  // 想关掉只能在 DevTools 里手写 localStorage('agentConfigOverrides') 并重启。
  const [memMode, setMemMode] = useState<'off' | 'auto' | 'confirm'>(
    () => (agentConfig.longTermMemoryEnabled ? agentConfig.memoryWriteMode : 'off')
  )
  const previewScheme = CURSOR_SCHEMES.find(s => s.id === (previewId ?? cursorScheme)) || CURSOR_SCHEMES[0]

  // Edge 音色列表：仅在选了 Edge 引擎时拉一次（在线接口，失败只提示不阻塞）
  useEffect(() => {
    if (ttsEngine !== 'edge' || edgeVoices.length > 0) return
    // 防御：preload 只在窗口创建时执行一次，改了 preload 必须完全重启应用（只热重载
    // renderer 不够），否则 window.api 上还没有这个方法。直接调用会抛出未捕获异常，
    // 把整个设置页打崩——所以先探测再调用，给一句能指导操作的提示。
    if (typeof window.api?.edgeTtsVoices !== 'function') {
      setVoiceErr('主进程尚未加载 Edge TTS 接口（preload 改动需完全重启应用，热重载无效）')
      return
    }
    let alive = true
    window.api.edgeTtsVoices()
      .then(v => { if (alive) setEdgeVoices(v.filter(x => x.locale.startsWith('zh'))) })
      .catch(e => { if (alive) setVoiceErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [ttsEngine, edgeVoices.length])

  // 试听当前音色 + 语速：与消息朗读走同一条合成路径，听到的就是实际效果
  const previewVoice = async (): Promise<void> => {
    if (voicePreviewing) return
    setVoicePreviewing(true)
    try {
      if (typeof window.api?.edgeTtsSynthesize !== 'function') {
        throw new Error('主进程尚未加载 Edge TTS 接口（preload 改动需完全重启应用）')
      }
      const dataUrl = await window.api.edgeTtsSynthesize({ text: '这是一段语音试听，用来挑选音色和语速。', voice: ttsEdgeVoice, rate: ttsRate })
      // 必须先转 blob URL：CSP 的 media-src 是 'self' blob:，不含 data:，
      // 直接把 data URL 喂给 <audio> 会被拒（play() 抛 NotSupportedError）
      if (previewBlobRef.current) { try { URL.revokeObjectURL(previewBlobRef.current) } catch { /* ignore */ } }
      const url = dataUrlToBlobUrl(dataUrl)
      previewBlobRef.current = url
      const a = new Audio(url)
      a.onended = () => setVoicePreviewing(false)
      a.onerror = () => setVoicePreviewing(false)
      await a.play()
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : String(e))
      setVoicePreviewing(false)
    }
  }
  const previewRoles: CursorRole[] = ['default', 'pointer', 'wait']
  const roleLabels: Record<CursorRole, string> = { default: '箭头', pointer: '手型', wait: '忙碌', progress: '后台', notAllowed: '禁止', move: '移动', help: '帮助' }
  function handleCursorSchemeChange(v: string) {
    setCursorScheme(v)
    applyCursorScheme(v)
    try { localStorage.setItem(CURSOR_STORAGE_KEY, v) } catch { /* ignore */ }
  }

  useEffect(() => {
    window.api.getMetricsPolling().then(setMetricsPolling).catch((e) => console.error('[getMetricsPolling]', e))
  }, [])

  function handleNotifPref(pref: 'banner' | 'manual') {
    setNotifPref(pref)
    try { localStorage.setItem(NOTIF_KEY, pref) } catch (e) { console.error('保存通知偏好失败', e) }
  }

  return (
    <div className="max-w-3xl settings-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">界面与行为偏好设置</p>
        </div>
      </div>

      <div className="settings-section st-accent--notify">
        <div className="settings-section-title"><Bell /> 更新通知</div>
        <div className="st-block">
          <p className="st-desc">
            选择您希望如何获知 llama.cpp 新版本的通知方式。
          </p>
          <div className="st-seg">
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
            <p className="st-note">
              更新横幅将不会自动显示。可随时在「后端与引擎」页使用"立即检查"。
            </p>
          )}
        </div>
      </div>

      <div className="settings-section st-accent--metrics">
        <div className="settings-section-title"><Activity /> 模型监控轮询</div>
        <div className="st-block">
          <p className="st-desc">
            每 2 秒向 llama-server 请求 <code>/slots</code> 与 <code>/metrics</code> 接口，获取实时 slot 状态（上下文用量、解码进度等）及 tok/s、KV 缓存占用等监控数据。
            关闭后停止轮询，监控面板将不再刷新。
          </p>
          <label className="toggle st-toggle">
            <input type="checkbox" checked={metricsPolling} onChange={async (e) => { const v = e.target.checked; try { await window.api.setMetricsPolling(v); setMetricsPolling(v) } catch { setMetricsPolling(!v) } }} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
      </div>

      <div className="settings-section st-accent--font">
        <div className="settings-section-title"><Type /> 字体</div>
        <div className="st-block">
          <p className="st-desc">
            选择全局字体预设，即时生效并自动保存。均为系统自带字体，无需下载。
          </p>
          <FontSelector />
        </div>
      </div>

      <div className="settings-section st-accent--memory">
        <div className="settings-section-title"><Brain /> Agent 长期记忆</div>
        <div className="st-block">
          <p className="st-desc">
            智能体在会话中沉淀的结论（用户纠正与偏好、已验证命令、改动热点、决策记录等）
            会按工作区跨会话累积，并在新建会话时注入系统提示词。
          </p>
          <p className="st-desc">
            沉淀规则是机械的（正则命中与计数阈值），误报不少，所以默认选「写入前确认」：
            候选先进待确认队列，在顶栏「记忆」面板里逐条采纳或忽略，不确认就不落库。
          </p>
          <div className="st-seg st-seg--fill">
            {([['off', '关闭'], ['confirm', '写入前确认（推荐）'], ['auto', '自动写入']] as const).map(([id, label]) => {
              const selected = memMode === id
              return (
                <button
                  key={id}
                  type="button"
                  className={`launch-mode-btn st-seg-btn${selected ? ' active' : ''}`}
                  onClick={() => {
                    setMemMode(id)
                    // 两项配置合成一个控件：off 只动总开关，auto/confirm 打开总开关并设置写入方式。
                    // setAgentConfigOverride 就地改写单例 + 落 localStorage，已 import agentConfig
                    // 的读取方（memoryWriter / useAgentLoop …）下一次读取就是新值。
                    if (id === 'off') {
                      setAgentConfigOverride('longTermMemoryEnabled', false)
                    } else {
                      setAgentConfigOverride('longTermMemoryEnabled', true)
                      setAgentConfigOverride('memoryWriteMode', id)
                    }
                  }}
                >
                  {selected && <Check size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />}
                  {label}
                </button>
              )
            })}
          </div>
          <p className="st-note">
            关闭后停止沉淀与注入；已有条目和待确认队列都保留，可在「记忆」面板查看、归档、删除或清空。
          </p>
        </div>
      </div>

      <div className="settings-section st-accent--ui">
        <div className="settings-section-title"><Volume2 /> 界面</div>
        <div className="st-block">
          <p className="st-desc">
            开启：助手回复完成、模型服务就绪、图像与语音生成结束等事件播放提示音。关闭：全部不播放。
          </p>
          <label className="toggle st-toggle">
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={() => setSoundEnabled(!soundEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="st-block">
          <p className="st-desc st-desc--sm">
            选择提示音的音色风格（同一事件在不同风格下听感不同）。点击会自动试听。
          </p>
          <div className="st-seg st-seg--fill">
            {PACK_OPTIONS.map(opt => {
              const selected = notificationSound === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`launch-mode-btn st-seg-btn${selected ? ' active' : ''}`}
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

        {/* ── 消息朗读（TTS）── */}
        <div className="settings-section-title st-subtitle" style={{ marginTop: 16 }}><Volume2 /> 消息朗读</div>
        <div className="st-block">
          <p className="st-desc st-desc--sm">
            消息上的朗读按钮用哪种声音。Edge 是微软的在线神经网络音色，比系统自带的自然很多（约 1.5 秒出音）；断网或接口异常时自动回退到系统语音。
          </p>
          <div className="st-seg st-seg--fill">
            {([['edge', 'Edge 在线语音（推荐）'], ['system', '系统内置语音']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`launch-mode-btn st-seg-btn${ttsEngine === id ? ' active' : ''}`}
                onClick={() => setTtsEngine(id)}
              >
                {ttsEngine === id && <Check size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />}
                {label}
              </button>
            ))}
          </div>
        </div>

        {ttsEngine === 'edge' && (
          <div className="st-block">
            <p className="st-desc st-desc--sm">
              音色（{edgeVoices.length > 0 ? `${edgeVoices.length} 个中文音色` : '加载中…'}）
            </p>
            <div className="st-row-inline">
              <CustomSelect
                className="st-select-wrap"
                buttonClass="st-select-btn"
                panelClass="st-select-panel"
                itemClass="st-select-item"
                aria-label="音色"
                value={ttsEdgeVoice}
                onChange={setTtsEdgeVoice}
                options={(edgeVoices.length > 0
                  ? edgeVoices
                  : [{ name: ttsEdgeVoice, label: ttsEdgeVoice.split('-')[2]?.replace(/Neural$/, '') || ttsEdgeVoice, gender: '', locale: '' }]
                ).map(v => ({
                  value: v.name,
                  label: `${v.label}${v.gender ? `（${v.gender}）` : ''} · ${v.locale}`
                }))}
              />
              <button
                type="button"
                className="launch-mode-btn"
                onClick={previewVoice}
                disabled={voicePreviewing}
              >
                {voicePreviewing ? '合成中…' : '试听'}
              </button>
            </div>
            {voiceErr && <p className="st-error">音色列表获取失败：{voiceErr}</p>}
            {previewErr && <p className="st-error">试听失败：{previewErr}</p>}
          </div>
        )}

        <div className="st-block">
          <p className="st-desc st-desc--sm">
            语速：{ttsRate.toFixed(2)}×（1.00 为原速；原来的固定值是 2.00×，偏快且放大机械感）
          </p>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={ttsRate}
            onChange={(e) => setTtsRate(parseFloat(e.target.value))}
            className="st-range"
          />
        </div>

        <div className="st-block">
          <p className="st-desc">
            开启：启动时播放开屏动画。关闭：直接进入主界面。
          </p>
          <label className="toggle st-toggle">
            <input
              type="checkbox"
              checked={splashEnabled}
              onChange={() => setSplashEnabled(!splashEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="st-block">
          <p className="st-desc">
            开启：鼠标悬停在收起的导航栏上时自动展开。关闭：仅通过点击按钮展开。
          </p>
          <label className="toggle st-toggle">
            <input
              type="checkbox"
              checked={hoverExpandEnabled}
              onChange={() => setHoverExpandEnabled(!hoverExpandEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="st-block">
          <p className="st-desc">
            开启：悬停参数时显示说明提示框。关闭：不显示提示框。
          </p>
          <label className="toggle st-toggle">
            <input
              type="checkbox"
              checked={paramTooltipEnabled}
              onChange={() => setParamTooltipEnabled(!paramTooltipEnabled)}
            />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </label>
        </div>
        <div className="st-block">
          <p className="st-desc">
            选择界面鼠标光标样式。悬停卡片可在下方预览区试用，点击应用并保存。部分样式可能只包含部分状态（如仅忙碌动画），其余状态使用系统默认光标。
          </p>
          <div
            className="st-cursor-grid"
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

      {/* ── 界面背景 ── */}
      <div className="settings-section st-accent--ui">
        <div className="settings-section-title"><ImageIcon /> 界面背景</div>
        <div className="st-block">
          <p className="st-desc">
            选一张图铺在整个界面背后：导航栏、对话区、各视图面板这几层改成半透明磨砂把图透出来，
            气泡与代码块保持实心，免得字压在花上。点缩略图立即切换，选「无背景」回到纯色。
          </p>
          <p className="st-desc st-desc--sm">
            图片库就是这个目录：<code>{bgDir || 'src/renderer/public/backgrounds'}</code>
            。往里面丢图就会出现在下方列表；目录本身入库，图片被 .gitignore 排除，不会上传仓库。
            鼠标移到缩略图左上角出现「×」，点一下即删掉这张图（进系统回收站，误删还能捞回）；在文件管理器里增删过，窗口重新获得焦点就会重读列表。
          </p>
          <div className="st-bg-grid">
            <div className="st-bg-card">
              <button
                type="button"
                className={`st-bg-pick${!backgroundImage ? ' selected' : ''}`}
                onClick={() => setBackgroundImage(null)}
                aria-pressed={!backgroundImage}
              >
                <span className="st-bg-frame st-bg-frame--none" />
                <span className="st-bg-card-name">无背景</span>
              </button>
              {!backgroundImage && <span className="st-bg-card-check">✓</span>}
            </div>
            {bgImages.map(name => {
              const selected = name === backgroundImage
              return (
                <div className="st-bg-card" key={name}>
                  <button
                    type="button"
                    className={`st-bg-pick${selected ? ' selected' : ''}`}
                    onClick={() => setBackgroundImage(name)}
                    title={name}
                    aria-pressed={selected}
                  >
                    <span className="st-bg-frame"><BgThumb name={name} /></span>
                    <span className="st-bg-card-name">{name}</span>
                  </button>
                  {/* 指针进到这张卡才浮出来（见 settings.css 的 :hover/:focus-within） */}
                  <button
                    type="button"
                    className="st-bg-del"
                    onClick={() => { void removeBackground(name) }}
                    title={`从背景目录删除 ${name}`}
                    aria-label={`删除 ${name}`}
                  >
                    ×
                  </button>
                  {selected && <span className="st-bg-card-check">✓</span>}
                </div>
              )
            })}
          </div>
          {bgImages.length === 0 && (
            <p className="st-note">目录里还没有图片：可以点「导入图片…」选一张，或直接把文件放进上面那个目录。</p>
          )}
          <div className="st-row-inline">
            <button type="button" className="launch-mode-btn" onClick={pickBackgroundImage}>导入图片…</button>
            <button
              type="button"
              className="launch-mode-btn"
              onClick={() => {
                setBgErr('')
                window.api.openBackgroundsDir()
                  .then(r => { if (!r.success) setBgErr(`打开失败：${r.error ?? '未知错误'}`) })
                  .catch((e) => setBgErr(`打开失败：${String(e)}`))
              }}
            >
              打开背景目录
            </button>
          </div>
          {bgErr && <p className="st-error">{bgErr}</p>}
        </div>
        <div className="st-block">
          <p className="st-desc st-desc--sm">
            背景强度：{backgroundStrength}（面板透出程度。0 = 面板实心、几乎看不出有图；100 = 面板最透、图最明显。黑暗主题下同一数值会更压图——浅字要底下够暗才读得清。拖动立即生效）
          </p>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={backgroundStrength}
            onChange={(e) => setBackgroundStrength(parseFloat(e.target.value))}
            className="st-range"
          />
        </div>
      </div>
    </div>
  )
}
