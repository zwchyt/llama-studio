import React, { useCallback, useRef, forwardRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import { HardDriveIcon, FolderOpenIcon } from '@animateicons/react/lucide'
import { playEvent } from '../utils/sound'
import {
  NAV_SECTIONS,
  TOOLS_ENTRY,
  GROUPED_VIEWS,
  groupedHasRunning,
  resolveToolsEntryView
} from '../utils/navConfig'
import type { NavDef } from '../utils/navConfig'
import '../styles/sidebar.css'

// 导航清单已统一收敛到 utils/navConfig.ts：NAV_SECTIONS 是常驻项，
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

function BackendNavItem({ b, isActive, onSwitch }: { b: { name: string; path?: string }; isActive: boolean; onSwitch: () => void }) {
  const iconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void } | null>(null)

  const handleMouseEnter = useCallback(() => {
    iconRef.current?.startAnimation()
  }, [])

  const handleMouseLeave = useCallback(() => {
    iconRef.current?.stopAnimation()
  }, [])

  return (
    <button
      className="nav-item"
      onClick={() => {
        // 后端切换不切视图，所以不走 App.tsx 的导航音对照表，单独给一个「勾上」音
        if (!isActive) playEvent('check')
        onSwitch()
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <HardDriveIcon ref={iconRef as any} size={16} className="nav-animate-icon" />
      <span className="sidebar-backend-name">
        <span className="sidebar-backend-name-text">{b.name}</span>
        {isActive && <span className="nav-active-dot" />}
      </span>
    </button>
  )
}

export default function Sidebar() {
  const { collapsed, collapsing, hoverExpanded, hoverExpandEnabled, setHoverExpanded } = useSidebarStore()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { view, setView, backends, backendsStatus, activeBackend, setActiveBackend, paths, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, backends: s.backends, backendsStatus: s.backendsStatus, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, paths: s.paths, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
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

  // 与顶栏同一套点亮语义：常驻项只要运行就变绿，其余项仅当前选中页变绿
  const isRunning = (item: NavDef) =>
    (item.runningSource === 'models' && hasRunningModels) ||
    (item.runningSource === 'llama' && !!activeChatUrl)
  const shouldHighlight = (item: NavDef) => isRunning(item) && (item.persistent || view === item.key)

  // 「工具箱」入口：落在任一被收纳的界面里即算激活；其中有运行中的界面时点一颗绿点
  const toolsActive = GROUPED_VIEWS.has(view)
  const toolsRunning = groupedHasRunning(hasRunningModels, activeChatUrl)

  function switchBackend(name: string) {
    const b = backends.find((x) => x.name === name)
    if (!b) return
    setActiveBackend(b)
    // 参数集 schema 由 App 的 activeBackend watcher 统一拉取，此处不再重复请求，
    // 避免快速切换后端时新旧响应乱序覆盖
  }
  return (
    <div
      className={`sidebar-wrapper${isCollapsed ? ' collapsed' : ''}${collapsing ? ' collapsing' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <nav className="sidebar">
        {/* ── 常驻导航项（清单见 utils/navConfig.ts） ── */}
        {NAV_SECTIONS.map((section, si) => (
          <React.Fragment key={section.label}>
            <span className="nav-section-label" style={{ marginTop: si === 0 ? 0 : 12 }}>{section.label}</span>
            {section.items.map((item) => (
              <NavItem
                key={item.key}
                icon={item.icon}
                label={item.label}
                active={view === item.key}
                onClick={() => setView(item.key)}
                style={shouldHighlight(item) ? { color: 'var(--success)' } : {}}
              >
                {view === item.key && <span className="nav-active-dot" />}
                {shouldHighlight(item) && <span className="nav-dot" />}
              </NavItem>
            ))}
          </React.Fragment>
        ))}

        {/* ── 工具箱：低频界面统一收进这一页，页内用二级导航切换 ── */}
        <span className="nav-section-label" style={{ marginTop: 12 }}>更多</span>
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

        {backends.length > 0 && (
          <>
            <span className="nav-section-label" style={{ marginTop: 12 }}>后端</span>
            {backends.map((b) => (
              <BackendNavItem
                key={b.name}
                b={b}
                isActive={activeBackend?.name === b.name}
                onSwitch={() => switchBackend(b.name)}
              />
            ))}
          </>
        )}
        {backends.length === 0 && (
          <>
            <span className="nav-section-label" style={{ marginTop: 12 }}>后端</span>
            <div className="sidebar-no-backend-hint" style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {backendsStatus === 'loading' ? '扫描后端中…' : <>未找到后端。<br />请在设置中下载。</>}
            </div>
          </>
        )}
        {paths && (
          <div className="sidebar-bottom-section" style={{ marginTop: 'auto', paddingTop: 12 }}>
            <span className="nav-section-label">本地目录</span>
            <NavItem
              icon={FolderOpenIcon}
              label="打开 /backend"
              onClick={() => window.api.openFolder(paths.backend)}
            />
            <NavItem
              icon={FolderOpenIcon}
              label="打开 /models"
              onClick={() => window.api.openFolder(paths.models)}
            />
            <NavItem
              icon={FolderOpenIcon}
              label="打开 /images"
              onClick={() => window.api.openFolder(paths.chatImages)}
            />
            <NavItem
              icon={FolderOpenIcon}
              label="打开 /pdf_exports"
              onClick={() => window.api.openFolder(paths.chatPdfExports)}
            />
            <NavItem
              icon={FolderOpenIcon}
              label="打开 /chat-templates"
              onClick={() => window.api.openFolder(paths.chatTemplates)}
            />
          </div>
        )}
      </nav>
    </div>
  )
}
