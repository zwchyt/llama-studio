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
import { useStore } from '../store/useStore'
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

export default function ToolsHub() {
  const { view, setView, hasRunningModels, activeChatUrl } = useStore(
    (s) => ({
      view: s.view,
      setView: s.setView,
      hasRunningModels: s.cards.some((c) => c.status === 'running'),
      activeChatUrl: s.activeChatUrl
    }),
    shallow
  )

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
