/**
 * 工具箱：把低频界面集中到一页。
 *
 * 导航不占左侧栏，全部收进页面顶部一条：上排是组标签（一级），下排是当前组的条目（二级），
 * 切换都在顶部完成，下方整块留给内容。
 *
 * 选中态由全局 view 驱动（而不是本组件内部 state）：这样从别处
 * setView('ocr') 跳进来时能自动落在对应工具上，导航音效也照常按 view 触发。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { useBubbleTip } from './useBubbleTip'
import '../styles/toolshub.css'

type AnimHandle = { startAnimation: () => void; stopAnimation: () => void }

/** 顶部导航的分组：前几组是「工具组」（组内条目各自对应一个 view），
 *  后两组是动作组（后端 / 本地目录），点了只执行动作、不切视图。 */
type HubGroup =
  | { label: string; kind: 'views'; items: NavDef[] }
  | { label: string; kind: 'backends' }
  | { label: string; kind: 'folders' }

function ToolNavItem({ def, active, onSelect }: {
  def: NavDef
  active: boolean
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
      {/* 这里同样只表达「当前在哪一项」，不再挂「有服务在跑」的跟随提示 */}
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
  // 原生 title 换自定义气泡（与导航栏同款）：已有图标 hover 动画，走 showTip/hideTip 合并进去
  const { tipNode, showTip, hideTip } = useBubbleTip()
  return (
    <button
      type="button"
      className={`toolhub-item${active ? ' active' : ''}`}
      aria-label={title ?? label}
      onClick={onClick}
      onMouseEnter={(e) => { iconRef.current?.startAnimation(); if (title) showTip(title, e.currentTarget) }}
      onMouseLeave={() => { iconRef.current?.stopAnimation(); hideTip() }}
    >
      {tipNode}
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

  // 顶部导航的分组清单：工具组 + 两个动作组（「本地目录」要有 paths 才出现）
  const railGroups: HubGroup[] = [
    ...TOOL_GROUPS.map((g) => ({ label: g.label, kind: 'views' as const, items: g.items })),
    { label: '后端', kind: 'backends' as const },
    ...(paths ? [{ label: '本地目录', kind: 'folders' as const }] : [])
  ]

  // 当前展示的组：默认跟随 view 所属的组；切到「后端 / 本地目录」这类无 view 的组时，
  // 用本地态临时覆盖（view 一变回某个工具组就自动让位）。
  const [manualGroup, setManualGroup] = useState<string | null>(null)
  useEffect(() => {
    if (TOOL_GROUPS.some((g) => g.items.some((i) => i.key === active))) setManualGroup(null)
  }, [active])
  const viewGroupLabel = TOOL_GROUPS.find((g) => g.items.some((i) => i.key === active))?.label
  const shownGroupLabel = manualGroup ?? viewGroupLabel ?? TOOL_GROUPS[0].label
  const shownGroup = railGroups.find((g) => g.label === shownGroupLabel) ?? railGroups[0]

  // 点组标签：工具组顺手落到该组第一项（否则会出现「切了组、内容还是上一组」）；动作组只切列表
  const selectGroup = (g: HubGroup) => {
    if (g.kind === 'views') {
      setManualGroup(null)
      if (!g.items.some((i) => i.key === active)) setView(g.items[0].key)
    } else {
      setManualGroup(g.label)
    }
  }

  const activeDef = NAV_DEF_BY_KEY[active]
  const IconComp = activeDef?.icon as ElementType | undefined
  const content = useMemo(() => renderViewComponent(active), [active])

  return (
    <div className="toolhub">
      <header className="toolhub-top">
        <div className="toolhub-top-bar">
          <span className="toolhub-top-title">工具箱</span>
          <span className="toolhub-top-count">{GROUPED_VIEWS.size}</span>
          <span className="toolhub-top-sep" aria-hidden="true" />

          {/* 一级：组标签，横向排在顶部 */}
          <div className="toolhub-groups" role="tablist" aria-label="工具箱分组">
            {railGroups.map((g) => {
              const on = g.label === shownGroupLabel
              return (
                <button
                  key={g.label}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`toolhub-gtab${on ? ' active' : ''}`}
                  onClick={() => selectGroup(g)}
                >
                  {g.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* 二级：当前组的条目，同样横向排在顶部 */}
        <div className="toolhub-chips">
          {shownGroup.kind === 'views' &&
            shownGroup.items.map((def) => (
              <ToolNavItem
                key={def.key}
                def={def}
                active={def.key === active}
                onSelect={() => setView(def.key)}
              />
            ))}

          {/* 后端：不切视图，点了只把该后端设为当前 */}
          {shownGroup.kind === 'backends' &&
            (backends.length > 0 ? (
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
              <p className="toolhub-chips-empty">
                {backendsStatus === 'loading' ? '扫描后端中…' : <>未找到后端。<br />可在「后端与引擎」里下载。</>}
              </p>
            ))}

          {/* 本地目录：只打开系统文件管理器 */}
          {shownGroup.kind === 'folders' &&
            folders.map((f) => (
              <ToolActionItem
                key={f.label}
                icon={FolderOpenIcon}
                color="#f59e0b"
                label={`打开 ${f.label}`}
                onClick={() => window.api.openFolder(f.path)}
              />
            ))}
        </div>
      </header>

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
          {viewGroupLabel && <span className="toolhub-crumb-path">工具箱 / {viewGroupLabel}</span>}
        </div>
        <div className="toolhub-body" key={active}>{content}</div>
      </section>
    </div>
  )
}
