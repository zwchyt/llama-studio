import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { Bell, BellOff, Activity, Type, Volume2, Check, Brain } from 'lucide-react'
import { SOUND_OPTIONS, previewSound } from '../utils/sound'
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
            开启：助手回复完成时播放提示音。关闭：不播放提示音。
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
            选择助手回复完成时的提示音类型。点击会自动预览。
          </p>
          <div className="st-seg st-seg--fill">
            {SOUND_OPTIONS.map(opt => {
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
    </div>
  )
}
