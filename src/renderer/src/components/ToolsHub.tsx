/**
 * 设置中心（原工具箱）整屏：左侧固定工具栏 + 右侧内容舞台。
 * 防闪烁三原则：分组标题纯静态、页面全量常驻（display 显隐）、代码未就绪不切页（见 ensureChunk）。
 */
import React, { useEffect, useDeferredValue, useRef, useState } from 'react'
import type { ElementType } from 'react'
import { ArrowLeftIcon, HardDriveIcon, FolderOpenIcon, SettingsIcon } from '@animateicons/react/lucide'
import { useStore } from '../store/useStore'
import { playEvent } from '../utils/sound'
import { shallow } from 'zustand/shallow'
import {
  GROUPED_VIEWS,
  NAV_DEF_BY_KEY,
  TOOL_GROUPS,
  TOOLS_FALLBACK_VIEW,
  TOOLS_LAST_VIEW_STORAGE_KEY
} from '../utils/navConfig'
import type { ViewKey } from '../utils/navConfig'
import { renderStageViewComponent, loadViewChunk } from '../views/viewRegistry'
import { useBubbleTip } from './useBubbleTip'
import '../styles/toolshub.css'

export default function ToolsHub({ backView }: { backView?: ViewKey } = {}) {
  const { view, setView, backends, backendsStatus, activeBackend, setActiveBackend, paths } = useStore(
    (s) => ({
      view: s.view,
      setView: s.setView,
      backends: s.backends,
      backendsStatus: s.backendsStatus,
      activeBackend: s.activeBackend,
      setActiveBackend: s.setActiveBackend,
      paths: s.paths
    }),
    shallow
  )

  // 整屏模式下的「返回主界面」落点：App 记住进工具箱前的界面；无记录时回模型管理
  const exitTarget: ViewKey = backView ?? 'cards'
  const { tipNode, showTip, hideTip } = useBubbleTip()

  const folders: { label: string; path: string }[] = paths ? [
    { label: '/backend', path: paths.backend },
    { label: '/models', path: paths.models },
    { label: '/images', path: paths.chatImages },
    { label: '/pdf_exports', path: paths.chatPdfExports },
    { label: '/chat-templates', path: paths.chatTemplates },
  ] : []

  // 兜底分支仅防御异常值
  const active: ViewKey = GROUPED_VIEWS.has(view) || view === 'settings' ? view : TOOLS_FALLBACK_VIEW

  // 记住上次打开的界面，下次进来直接回到这里
  useEffect(() => {
    try { localStorage.setItem(TOOLS_LAST_VIEW_STORAGE_KEY, active) } catch { /* ignore */ }
  }, [active])

  // chunk 就绪追踪：代码没就绪的页面不走快速显隐通道，宁可多显示旧内容一帧也不闪白
  const chunkPendingRef = useRef(new Set<ViewKey>())
  const [readyViews, setReadyViews] = useState<ViewKey[]>([])
  const ensureChunk = (v: ViewKey): void => {
    if (readyViews.includes(v) || chunkPendingRef.current.has(v)) return
    chunkPendingRef.current.add(v)
    const p = loadViewChunk(v)
    if (!p) {
      // 不在懒加载表里（eager/未知）：直接视为就绪
      setReadyViews((prev) => (prev.includes(v) ? prev : [...prev, v]))
      return
    }
    p.then(() => { setReadyViews((prev) => (prev.includes(v) ? prev : [...prev, v])) })
      .catch(() => { chunkPendingRef.current.delete(v) })
  }

  // 进入即全量预取（设置页也在列）
  useEffect(() => {
    ensureChunk('settings')
    GROUPED_VIEWS.forEach((v) => ensureChunk(v))
  }, [])

  // 代码未就绪的页面继续显示旧内容，就绪后由 deferred 提交自然换页
  const deferredActive = useDeferredValue(active)

  // 展示哪一页：目标页就绪 → 实时 active；未就绪 → 停在最近一个已就绪页（不闪空壳）
  const shown = readyViews.includes(active)
    ? active
    : readyViews.includes(deferredActive) ? deferredActive : null

  // 面包屑跟随 shown：标题与内容同帧换，避免新标题配旧内容的错位帧
  const shownDef = shown ? NAV_DEF_BY_KEY[shown] : undefined
  const StageIcon = shownDef?.icon as ElementType | undefined
  const shownGroupLabel = shown
    ? TOOL_GROUPS.find((g) => g.items.some((i) => i.key === shown))?.label
    : undefined

  // 全量常驻（含设置页）：切换 = 纯显隐；内存上界约 30~40MB，桌面应用可承受
  const aliveViews = React.useMemo<ViewKey[]>(
    () => ['settings' as ViewKey, ...Array.from(GROUPED_VIEWS)],
    []
  )

  // 页面元素按 view 缓存：常驻页面拿同一引用，重渲染时跳过整树重算
  const pageElCache = useRef(new Map<ViewKey, React.ReactNode>())

  return (
    <div className="toolhub">
      {/* ══ 左：固定工具栏（分组标题纯静态，切换只挪一个 .active） ══ */}
      <aside className="toolhub-rail">
        <div className="toolhub-rail-head">
          <button
            type="button"
            className="toolhub-back"
            aria-label="返回主界面"
            onClick={() => setView(exitTarget)}
            onMouseEnter={(e) => showTip('返回主界面', e.currentTarget)}
            onMouseLeave={hideTip}
          >
            {tipNode}
            <ArrowLeftIcon size={14} />
            <span>返回</span>
          </button>
          <span className="toolhub-rail-title">设置</span>
          <span className="toolhub-rail-count">{GROUPED_VIEWS.size}</span>
        </div>

        <div className="toolhub-rail-scroll">
          {/* 设置：侧栏顶部第一项（设置统一从工具箱进，主侧栏不再有独立入口） */}
          <button
            type="button"
            className={`toolhub-rail-item${active === 'settings' ? ' active' : ''}`}
            onClick={() => setView('settings')}
            onMouseEnter={() => ensureChunk('settings')}
          >
            <span
              className="toolhub-rail-ico"
              style={active === 'settings'
                ? { background: '#6b7280', color: '#fff' }
                : { background: '#6b72801c', color: '#6b7280' }}
            >
              <SettingsIcon size={13} />
            </span>
            <span className="toolhub-rail-item-label">设置</span>
            {active === 'settings' && <span className="toolhub-rail-dot" style={{ background: '#6b7280' }} />}
          </button>

          {TOOL_GROUPS.map((g) => (
            <React.Fragment key={g.label}>
              <div className="toolhub-rail-label">{g.label}</div>
              {g.items.map((def) => {
                const ItemIcon = def.icon as ElementType
                const on = active === def.key
                return (
                  <button
                    key={def.key}
                    type="button"
                    className={`toolhub-rail-item${on ? ' active' : ''}`}
                    onClick={() => setView(def.key)}
                    onMouseEnter={() => ensureChunk(def.key)}
                  >
                    <span
                      className="toolhub-rail-ico"
                      style={on
                        ? { background: def.color, color: '#fff' }
                        : { background: `${def.color}1c`, color: def.color }}
                    >
                      <ItemIcon size={13} />
                    </span>
                    <span className="toolhub-rail-item-label">{def.label}</span>
                    {on && <span className="toolhub-rail-dot" style={{ background: def.color }} />}
                  </button>
                )
              })}
            </React.Fragment>
          ))}

          {/* 后端（动作区）：不切视图，只把该后端设为当前 */}
          <div className="toolhub-rail-label">后端</div>
          {backends.length > 0 ? (
            backends.map((b) => {
              const on = activeBackend?.name === b.name
              return (
                <button
                  key={b.name}
                  type="button"
                  className={`toolhub-rail-item${on ? ' active' : ''}`}
                  onClick={() => {
                    if (on) return
                    playEvent('check')
                    setActiveBackend(b)
                  }}
                >
                  <span className="toolhub-rail-ico" style={{ background: '#3b82f61c', color: '#3b82f6' }}>
                    <HardDriveIcon size={13} />
                  </span>
                  <span className="toolhub-rail-item-label">{b.name}</span>
                  {on && <span className="toolhub-rail-dot" style={{ background: '#3b82f6' }} />}
                </button>
              )
            })
          ) : (
            <p className="toolhub-rail-empty">
              {backendsStatus === 'loading' ? '扫描后端中…' : '未找到后端，可在「后端与引擎」里下载'}
            </p>
          )}

          {/* 本地目录（动作区）：只打开系统文件管理器 */}
          {folders.length > 0 && (
            <>
              <div className="toolhub-rail-label">本地目录</div>
              {folders.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  className="toolhub-rail-item"
                  onClick={() => window.api.openFolder(f.path)}
                >
                  <span className="toolhub-rail-ico" style={{ background: '#f59e0b1c', color: '#f59e0b' }}>
                    <FolderOpenIcon size={13} />
                  </span>
                  <span className="toolhub-rail-item-label">{f.label}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </aside>

      {/* ══ 右：内容舞台（页面全部常驻，切换 = display 翻转） ══ */}
      <main className="toolhub-stage">
        <div className="toolhub-stage-bar">
          {StageIcon && shownDef && (
            <span
              className="toolhub-stage-ico"
              style={{ background: `${shownDef.color}1c`, color: shownDef.color }}
            >
              <StageIcon size={13} />
            </span>
          )}
          <span className="toolhub-stage-name">{shownDef?.label ?? '设置'}</span>
          {shownGroupLabel && <span className="toolhub-stage-path">设置 / {shownGroupLabel}</span>}
        </div>
        <div className="toolhub-stage-body">
          {/* 一个就绪页都还没有时（刚进整屏、代码在解压）：显示加载态而不是空白舞台 */}
          {readyViews.length === 0 ? (
            <div className="toolhub-stage-loading">正在加载设置…</div>
          ) : (
            aliveViews.map((v) => {
              let el = pageElCache.current.get(v)
              if (!el) {
                el = renderStageViewComponent(v)
                pageElCache.current.set(v, el)
              }
              return (
                <div
                  key={v}
                  className={`toolhub-page${v === shown ? ' visible' : ''}`}
                  inert={v === shown ? undefined : true}
                >
                  {el}
                </div>
              )
            })
          )}
        </div>
      </main>
    </div>
  )
}
