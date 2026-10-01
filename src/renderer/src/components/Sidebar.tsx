import React, { useCallback, useRef, forwardRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import {
  NAV_ITEMS,
  TOOLS_ENTRY,
  GROUPED_VIEWS,
  groupedHasRunning,
  navKeyOf,
  resolveToolsEntryView
} from '../utils/navConfig'
import type { NavDef } from '../utils/navConfig'
import { AGENT_SESSION_SLOT_ID } from './agent-code/agent-session/AgentSessionSidebar'
import '../styles/sidebar.css'

// 导航清单已统一收敛到 utils/navConfig.ts：NAV_ITEMS 是常驻项（平铺 8 行），
// 收进「工具箱」页的低频界面在 TOOL_GROUPS 里。本组件只负责渲染。

interface NavItemProps {
  icon: React.ElementType
  label: string
  active?: boolean
  onClick?: () => void
  style?: React.CSSProperties
  children?: React.ReactNode
  className?: string
}

const NavItem = forwardRef<{ startAnimation: () => void; stopAnimation: () => void }, NavItemProps>(
  ({ icon: Icon, label, active, onClick, style, children, className = '' }, ref) => {
    const innerRef = useRef<{ startAnimation: () => void; stopAnimation: () => void } | null>(null)

    React.useImperativeHandle(ref, () => ({
      startAnimation: () => innerRef.current?.startAnimation(),
      stopAnimation: () => innerRef.current?.stopAnimation(),
    }))

    const handleMouseEnter = useCallback(() => {
      innerRef.current?.startAnimation()
    }, [])

    const handleMouseLeave = useCallback(() => {
      innerRef.current?.stopAnimation()
    }, [])

    return (
      <button
        className={`nav-item ${active ? 'active' : ''} ${className}`}
        onClick={onClick}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <Icon ref={innerRef as any} size={16} className="nav-animate-icon" />
        <span>{label}</span>
        {children}
      </button>
    )
  }
)

NavItem.displayName = 'NavItem'

export default function Sidebar() {
  const { collapsed, collapsing, hoverExpanded, hoverExpandEnabled, setHoverExpanded } = useSidebarStore()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { view, setView, agentMode, setAgentMode, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, agentMode: s.agentMode, setAgentMode: s.setAgentMode, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
    shallow
  )

  // 鼠标进入收起的侧边栏 → 延迟后展开
  const handleMouseEnter = useCallback(() => {
    if (!collapsed || !hoverExpandEnabled) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHoverExpanded(true), 120)
  }, [collapsed, hoverExpandEnabled, setHoverExpanded])

  // 鼠标离开 → 立即收起（仅收起状态下的悬浮展开）
  const handleMouseLeave = useCallback(() => {
    if (!collapsed) return
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    if (hoverExpanded) setHoverExpanded(false)
  }, [collapsed, hoverExpanded, setHoverExpanded])

  const isCollapsed = collapsed && !hoverExpanded
  const isHoverExpanded = hoverExpanded

  // 点亮语义：常驻项只要运行就变绿，其余项仅当前选中页变绿
  const isRunning = (item: NavDef) =>
    (item.runningSource === 'models' && hasRunningModels) ||
    (item.runningSource === 'llama' && !!activeChatUrl)
  // 「对话 / 工作台」共用 agent-code 这一个 view，只有工作区模式能把它们分开
  const isActiveItem = (item: NavDef) => view === item.key && (!item.mode || agentMode === item.mode)
  const shouldHighlight = (item: NavDef) => isRunning(item) && (item.persistent || isActiveItem(item))
  const openItem = (item: NavDef) => {
    // 模式相同就别写 store：写了会白刷一轮订阅者，而切换本身是空操作
    if (item.mode && item.mode !== agentMode) setAgentMode(item.mode)
    setView(item.key)
  }

  // 「工具箱」入口：落在任一被收纳的界面里即算激活；其中有运行中的界面时点一颗绿点
  const toolsActive = GROUPED_VIEWS.has(view)
  const toolsRunning = groupedHasRunning(hasRunningModels, activeChatUrl)
  return (
    <div
      className={`sidebar-wrapper${isCollapsed ? ' collapsed' : ''}${collapsing ? ' collapsing' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <nav className="sidebar">
        {/* ── 常驻导航项：清单与顺序见 utils/navConfig.ts 的 NAV_ITEMS，平铺不分节、没有小标题 ── */}
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={navKeyOf(item)}
            icon={item.icon}
            label={item.label}
            active={isActiveItem(item)}
            onClick={() => openItem(item)}
            style={shouldHighlight(item) ? { color: 'var(--success)' } : {}}
          >
            {isActiveItem(item) && <span className="nav-active-dot" />}
            {shouldHighlight(item) && <span className="nav-dot" />}
          </NavItem>
        ))}

        {/* ── 工具箱：低频界面统一收进这一页，页内用二级导航切换 ── */}
        <NavItem
          icon={TOOLS_ENTRY.icon}
          label={TOOLS_ENTRY.label}
          active={toolsActive}
          onClick={() => setView(resolveToolsEntryView())}
          style={toolsRunning ? { color: 'var(--success)' } : {}}
        >
          {toolsActive && <span className="nav-active-dot" />}
          {toolsRunning && <span className="nav-dot" />}
        </NavItem>

        {/* ── Agent Code 的项目 / 会话列表 ──
            状态与组件本体仍归 AgentCodeView，渲染时经 portal 挂进这个槽位
            （见 agent-code/agent-view/AgentCodeViewLayout.tsx）。槽放在最后，
            所以它始终跟着导航项下方。 */}
        <div className="sidebar-agent-slot" id={AGENT_SESSION_SLOT_ID} />
      </nav>
    </div>
  )
}
