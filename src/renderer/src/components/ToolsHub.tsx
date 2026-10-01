/**
 * 工具箱：把低频界面集中到一页，页内用左侧二级导航切换。
 *
 * 之所以不是下拉菜单：下拉会把名称藏起来，与「一眼看清所有导航名称」的目标相反。
 * 这里左侧始终列出全部被收进来的界面，右侧渲染选中界面的真实组件。
 *
 * 选中态由全局 view 驱动（而不是本组件内部 state）：这样从别处
 * setView('ocr') 跳进来时能自动落在对应工具上，导航音效也照常按 view 触发。
 */
import React, { useEffect, useMemo, useRef } from 'react'
import type { ElementType } from 'react'
import { HardDriveIcon, FolderOpenIcon } from '@animateicons/react/lucide'
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
import type { NavDef, ViewKey } from '../utils/navConfig'
import { renderViewComponent } from '../views/viewRegistry'
import '../styles/toolshub.css'

type AnimHandle = { startAnimation: () => void; stopAnimation: () => void }

function ToolNavItem({ def, active, running, onSelect }: {
  def: NavDef
  active: boolean
  running: boolean
  onSelect: () => void
}) {
  const iconRef = useRef<AnimHandle | null>(null)
  const IconComp = def.icon
  return (
    <button
      type="button"
      className={`toolhub-item${active ? ' active' : ''}`}
      onClick={onSelect}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <span
        className="toolhub-ico"
        style={active
          ? { background: def.color, color: '#fff', boxShadow: `0 2px 8px ${def.color}55` }
          : { background: `${def.color}1c`, color: def.color }}
      >
        <IconComp
          ref={(el) => { iconRef.current = el ? (el as unknown as AnimHandle) : null }}
          className="nav-animate-icon"
          size={14}
        />
      </span>
      <span className="toolhub-item-label">{def.label}</span>
      {running && <span className="toolhub-run-dot" />}
      {active && (
        <span
          className="toolhub-active-dot"
          style={{ background: def.color, boxShadow: `0 0 0 3px ${def.color}38` }}
        />
      )}
    </button>
  )
}

/** 后端 / 本地目录的行：不切视图、只执行一个动作，但外观与悬停动画对齐 ToolNavItem */
function ToolActionItem({ icon: Icon, label, color, active, title, onClick }: {
  icon: ElementType
  label: string
  color: string
  active?: boolean
  title?: string
  onClick: () => void
}) {
  const iconRef = useRef<AnimHandle | null>(null)
  return (
    <button
      type="button"
      className={`toolhub-item${active ? ' active' : ''}`}
      title={title}
      onClick={onClick}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <span
        className="toolhub-ico"
        style={active
          ? { background: color, color: '#fff', boxShadow: `0 2px 8px ${color}55` }
          : { background: `${color}1c`, color }}
      >
        <Icon
          ref={(el) => { iconRef.current = el ? (el as unknown as AnimHandle) : null }}
          className="nav-animate-icon"
          size={14}
        />
      </span>
      <span className="toolhub-item-label">{label}</span>
      {active && (
        <span
          className="toolhub-active-dot"
          style={{ background: color, boxShadow: `0 0 0 3px ${color}38` }}
        />
      )}
    </button>
  )
}

export default function ToolsHub() {
  const { view, setView, hasRunningModels, activeChatUrl, backends, backendsStatus, activeBackend, setActiveBackend, paths } = useStore(
    (s) => ({
      view: s.view,
      setView: s.setView,
      hasRunningModels: s.cards.some((c) => c.status === 'running'),
      activeChatUrl: s.activeChatUrl,
      backends: s.backends,
      backendsStatus: s.backendsStatus,
      activeBackend: s.activeBackend,
      setActiveBackend: s.setActiveBackend,
      paths: s.paths
    }),
    shallow
  )

  // 侧栏那份「本地目录」原样搬过来，顺序与名称保持一致
  const folders: { label: string; path: string }[] = paths ? [
    { label: '/backend', path: paths.backend },
    { label: '/models', path: paths.models },
    { label: '/images', path: paths.chatImages },
    { label: '/pdf_exports', path: paths.chatPdfExports },
    { label: '/chat-templates', path: paths.chatTemplates },
  ] : []

  // ToolsHub 只在 view ∈ GROUPED_VIEWS 时渲染，兜底分支仅防御异常值
  const active: ViewKey = GROUPED_VIEWS.has(view) ? view : TOOLS_FALLBACK_VIEW

  // 记住上次打开的界面：下次点「工具箱」直接回到这里，不用每次重新找
  useEffect(() => {
    try { localStorage.setItem(TOOLS_LAST_VIEW_STORAGE_KEY, active) } catch { /* ignore */ }
  }, [active])

  const activeDef = NAV_DEF_BY_KEY[active]
  const activeGroupLabel = TOOL_GROUPS.find((g) => g.items.some((i) => i.key === active))?.label
  const IconComp = activeDef?.icon as ElementType | undefined
  const content = useMemo(() => renderViewComponent(active), [active])

  return (
    <div className="toolhub">
      <aside className="toolhub-rail">
        <div className="toolhub-rail-head">
          <span className="toolhub-rail-title">工具箱</span>
          <span className="toolhub-rail-count">{GROUPED_VIEWS.size}</span>
        </div>
        <nav className="toolhub-rail-nav">
          {TOOL_GROUPS.map((group) => (
            <div className="toolhub-group" key={group.label}>
              <span className="toolhub-group-label">{group.label}</span>
              {group.items.map((def) => (
                <ToolNavItem
                  key={def.key}
                  def={def}
                  active={def.key === active}
                  running={
                    (def.runningSource === 'models' && hasRunningModels) ||
                    (def.runningSource === 'llama' && !!activeChatUrl)
                  }
                  onSelect={() => setView(def.key)}
                />
              ))}
            </div>
          ))}

          {/* ── 后端 / 本地目录 ──
              原先挂在左侧导航栏里；导航栏收成纯导航后搬到这里，和「后端与引擎」「模型文件夹」
              这些同域的界面挨在一起。两组都不切视图，点了只执行动作。 */}
          <div className="toolhub-group">
            <span className="toolhub-group-label">后端</span>
            {backends.length > 0 ? (
              backends.map((b) => (
                <ToolActionItem
                  key={b.name}
                  icon={HardDriveIcon}
                  color="#3b82f6"
                  label={b.name}
                  active={activeBackend?.name === b.name}
                  title={activeBackend?.name === b.name ? '当前后端' : '设为当前后端'}
                  onClick={() => {
                    if (activeBackend?.name === b.name) return
                    // 切后端不切视图，所以不走导航音对照表，单独给一个「勾上」音
                    playEvent('check')
                    setActiveBackend(b)
                    // 参数集 schema 由 App 的 activeBackend watcher 统一拉取，这里不重复请求，
                    // 免得快速切换时新旧响应乱序覆盖
                  }}
                />
              ))
            ) : (
              <p className="toolhub-rail-empty">
                {backendsStatus === 'loading' ? '扫描后端中…' : <>未找到后端。<br />可在「后端与引擎」里下载。</>}
              </p>
            )}
          </div>
          {paths && (
            <div className="toolhub-group">
              <span className="toolhub-group-label">本地目录</span>
              {folders.map((f) => (
                <ToolActionItem
                  key={f.label}
                  icon={FolderOpenIcon}
                  color="#f59e0b"
                  label={`打开 ${f.label}`}
                  onClick={() => window.api.openFolder(f.path)}
                />
              ))}
            </div>
          )}
        </nav>
      </aside>

      <section className="toolhub-main">
        <div className="toolhub-crumb">
          {IconComp && activeDef && (
            <span
              className="toolhub-crumb-ico"
              style={{ background: `${activeDef.color}1c`, color: activeDef.color }}
            >
              <IconComp size={13} />
            </span>
          )}
          <span className="toolhub-crumb-name">{activeDef?.label ?? '工具箱'}</span>
          {activeGroupLabel && <span className="toolhub-crumb-path">工具箱 / {activeGroupLabel}</span>}
        </div>
        <div className="toolhub-body" key={active}>{content}</div>
      </section>
    </div>
  )
}
