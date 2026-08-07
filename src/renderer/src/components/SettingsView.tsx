import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { Bell, BellOff, Activity, Type, Volume2, Check } from 'lucide-react'
import { SOUND_OPTIONS, previewSound } from '../utils/sound'

import FontSelector from './FontSelector'
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
    splashEnabled, setSplashEnabled, agentToolCardsExpanded, setAgentToolCardsExpanded,
    paramTooltipEnabled, setParamTooltipEnabled
  } = useStore(
    s => ({ soundEnabled: s.soundEnabled, setSoundEnabled: s.setSoundEnabled, notificationSound: s.notificationSound, setNotificationSound: s.setNotificationSound, splashEnabled: s.splashEnabled, setSplashEnabled: s.setSplashEnabled, agentToolCardsExpanded: s.agentToolCardsExpanded, setAgentToolCardsExpanded: s.setAgentToolCardsExpanded, paramTooltipEnabled: s.paramTooltipEnabled, setParamTooltipEnabled: s.setParamTooltipEnabled }),
    (a, b) => a.soundEnabled === b.soundEnabled && a.setSoundEnabled === b.setSoundEnabled && a.notificationSound === b.notificationSound && a.setNotificationSound === b.setNotificationSound && a.splashEnabled === b.splashEnabled && a.setSplashEnabled === b.setSplashEnabled && a.agentToolCardsExpanded === b.agentToolCardsExpanded && a.setAgentToolCardsExpanded === b.setAgentToolCardsExpanded && a.paramTooltipEnabled === b.paramTooltipEnabled && a.setParamTooltipEnabled === b.setParamTooltipEnabled
  )
  const { hoverExpandEnabled, setHoverExpandEnabled } = useSidebarStore()
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [metricsPolling, setMetricsPolling] = useState(true)
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
    window.api.getMetricsPolling().then(setMetricsPolling).catch((e) => console.error('[getMetricsPolling]', e))
  }, [])

  function handleNotifPref(pref: 'banner' | 'manual') {
    setNotifPref(pref)
    try { localStorage.setItem(NOTIF_KEY, pref) } catch (e) { console.error('保存通知偏好失败', e) }
  }

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">界面与行为偏好设置</p>
        </div>
      </div>

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
              更新横幅将不会自动显示。可随时在「后端与引擎」页使用"立即检查"。
            </p>
          )}
        </div>
      </div>

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

      <div className="settings-section">
        <div className="settings-section-title"><Type /> 字体</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            选择全局字体预设，即时生效并自动保存。均为系统自带字体，无需下载。
          </p>
          <FontSelector />
        </div>
      </div>

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
    </div>
  )
}
