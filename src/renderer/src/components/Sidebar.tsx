import React, { useCallback, useEffect, useRef, forwardRef } from 'react'
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
import { playNavSound } from '../utils/sound'
import { AGENT_SESSION_SLOT_ID } from './agent-code/agent-session/slotId'
import { preloadViewOnHover } from '../views/viewRegistry'
import '../styles/sidebar.css'

// 导航清单已统一收敛到 utils/navConfig.ts：NAV_ITEMS 是常驻项（平铺 8 行），
// 收进「工具箱」页的低频界面在 TOOL_GROUPS 里。本组件只负责渲染。

interface NavItemProps {
  icon: React.ElementType
  label: string
  active?: boolean
  onClick?: () => void
  /** 鼠标移入时触发：用于提前拉取该视图的 chunk（见 views/viewRegistry 的 preloadViewOnHover） */
  onHover?: () => void
  style?: React.CSSProperties
  children?: React.ReactNode
  className?: string
}

const NavItem = forwardRef<{ startAnimation: () => void; stopAnimation: () => void }, NavItemProps>(
  ({ icon: Icon, label, active, onClick, onHover, style, children, className = '' }, ref) => {
    const innerRef = useRef<{ startAnimation: () => void; stopAnimation: () => void } | null>(null)

    React.useImperativeHandle(ref, () => ({
      startAnimation: () => innerRef.current?.startAnimation(),
      stopAnimation: () => innerRef.current?.stopAnimation(),
    }))

    const handleMouseEnter = useCallback(() => {
      innerRef.current?.startAnimation()
      onHover?.()
    }, [onHover])

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
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const { view, setView, agentMode, setAgentMode, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, agentMode: s.agentMode, setAgentMode: s.setAgentMode, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
    shallow
  )

  // ── 悬浮展开 / 收起：必须走原生 mouseenter / mouseleave，不能用 React 合成事件 ──
  // 会话列表是经 portal 挂进 .sidebar-agent-slot 的（见 AgentCodeViewLayout 的 createPortal）：
  // DOM 上它是 .sidebar-wrapper 的后代，React 树里却属于另一棵子树。合成 mouseleave 沿
  // fiber 树判定归属，于是「从导航项滑到列表」会被误判成离开整个侧栏——列表还没点就先收起；
  // 反过来「从列表直接滑出侧栏」时，列表不在 React 祖先链上，事件又根本不来。
  // 原生事件按 DOM 子树判定，两个方向都正确：整个侧栏（含 portal 进来的列表）算一个整体，
  // 只有指针真正离开它的 DOM 子树才收起。
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    // 进入收起的侧栏 → 延迟后展开
    const onEnter = () => {
      if (!collapsed || !hoverExpandEnabled) return
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => setHoverExpanded(true), 120)
    }
    // 真正离开 → 立即收起（仅收起状态下的悬浮展开）
    const onLeave = () => {
      if (!collapsed) return
      if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
      if (hoverExpanded) setHoverExpanded(false)
    }
    el.addEventListener('mouseenter', onEnter)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mouseenter', onEnter)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [collapsed, hoverExpandEnabled, hoverExpanded, setHoverExpanded])

  // 卸载时清掉待触发的展开定时器，别让它落到已经卸掉的侧栏上
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])

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
    if (item.mode && item.mode !== agentMode) {
      // 「对话 / 工作台」共用 agent-code：互切时 view 不变，App 那层收不到信号，这里补一声
      // （view 真变了就交给 App 播，免得同一次点击响两次）
      if (view === item.key) playNavSound(navKeyOf(item))
      setAgentMode(item.mode)
    }
    setView(item.key)
  }

  // 「工具箱」入口：落在任一被收纳的界面里即算激活；其中有运行中的界面时点一颗绿点
  const toolsActive = GROUPED_VIEWS.has(view)
  const toolsRunning = groupedHasRunning(hasRunningModels, activeChatUrl)
  return (
    <div
      ref={wrapperRef}
      className={`sidebar-wrapper${isCollapsed ? ' collapsed' : ''}${collapsing ? ' collapsing' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
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
            onHover={() => preloadViewOnHover(item.key)}
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
