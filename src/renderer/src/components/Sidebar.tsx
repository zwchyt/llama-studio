import React, { useCallback, useRef, forwardRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import { safeCall } from '../utils/safeCall'
import { paramSetOf } from '../utils/engine'
import {
  LayoutDashboardIcon,
  HardDriveIcon, SearchIcon, ActivityIcon, ServerIcon,
  MessageSquareIcon, TerminalIcon, InfoIcon, FileTextIcon, CodeIcon,
  SettingsIcon, BookOpenIcon, AudioLinesIcon, ImageIcon, MicIcon,
  BrainIcon, ChartBarIcon, TrendingUpIcon, SlidersHorizontalIcon, FolderOpenIcon, BoxesIcon, CpuIcon
} from '@animateicons/react/lucide'
import '../styles/sidebar.css'

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
      onClick={onSwitch}
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

  const { view, setView, backends, activeBackend, setActiveBackend, setCommandsSchema, paths, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, paths: s.paths, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
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

  async function switchBackend(name: string) {
    const b = backends.find((x) => x.name === name)
    if (!b) return
    setActiveBackend(b)
    // 切换后端时按其类型加载默认参数集
    const cmds = await safeCall(() => window.api.getCommands(name, paramSetOf(b.kind)), '切换后端失败')
    if (cmds) setCommandsSchema(cmds)
  }
  return (
    <div
      className={`sidebar-wrapper${isCollapsed ? ' collapsed' : ''}${collapsing ? ' collapsing' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <nav className="sidebar">
        {/* ── 导航 ── */}
        <span className="nav-section-label">导航</span>
        <NavItem
          icon={LayoutDashboardIcon}
          label="我的模板"
          active={view === 'cards'}
          onClick={() => setView('cards')}
          style={hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'cards' && <span className="nav-active-dot" />}
          {hasRunningModels && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={BoxesIcon}
          label="模型"
          active={view === 'models'}
          onClick={() => setView('models')}
        >
          {view === 'models' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={SearchIcon}
          label="模型中心"
          active={view === 'hub'}
          onClick={() => setView('hub')}
        >
          {view === 'hub' && <span className="nav-active-dot" />}
        </NavItem>

        {/* ── 服务 ── */}
        <span className="nav-section-label" style={{ marginTop: 12 }}>服务</span>
        <NavItem
          icon={ServerIcon}
          label="llama-server"
          active={view === 'llama'}
          onClick={() => setView('llama')}
          style={view === 'llama' && activeChatUrl ? { color: 'var(--success)' } : {}}
        >
          {view === 'llama' && <span className="nav-active-dot" />}
          {view === 'llama' && activeChatUrl && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={MessageSquareIcon}
          label="聊天"
          active={view === 'chat'}
          onClick={() => setView('chat')}
          style={view === 'chat' && hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'chat' && <span className="nav-active-dot" />}
          {view === 'chat' && hasRunningModels && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={ActivityIcon}
          label="模型运行数据"
          active={view === 'monitoring'}
          onClick={() => setView('monitoring')}
          style={view === 'monitoring' && hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'monitoring' && <span className="nav-active-dot" />}
          {view === 'monitoring' && hasRunningModels && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={ChartBarIcon}
          label="性能测试"
          active={view === 'benchmark'}
          onClick={() => setView('benchmark')}
        >
          {view === 'benchmark' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={TrendingUpIcon}
          label="Token 统计"
          active={view === 'token-stats'}
          onClick={() => setView('token-stats')}
          style={view === 'token-stats' && hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'token-stats' && <span className="nav-active-dot" />}
          {view === 'token-stats' && hasRunningModels && <span className="nav-dot" />}
        </NavItem>

        <NavItem
          icon={TerminalIcon}
          label="终端"
          active={view === 'terminal'}
          onClick={() => setView('terminal')}
        >
          {view === 'terminal' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={FileTextIcon}
          label="OCR"
          active={view === 'ocr'}
          onClick={() => setView('ocr')}
          style={view === 'ocr' && hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'ocr' && <span className="nav-active-dot" />}
          {view === 'ocr' && hasRunningModels && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={SlidersHorizontalIcon}
          label="模型工具"
          active={view === 'model-tools'}
          onClick={() => setView('model-tools')}
        >
          {view === 'model-tools' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={BookOpenIcon}
          label="知识库"
          active={view === 'knowledge'}
          onClick={() => setView('knowledge')}
        >
          {view === 'knowledge' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={AudioLinesIcon}
          label="语音合成"
          active={view === 'tts'}
          onClick={() => setView('tts')}
        >
          {view === 'tts' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={MicIcon}
          label="语音转写"
          active={view === 'stt'}
          onClick={() => setView('stt')}
        >
          {view === 'stt' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={ImageIcon}
          label="图像生成"
          active={view === 'imagegen'}
          onClick={() => setView('imagegen')}
          style={view === 'imagegen' && hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          {view === 'imagegen' && <span className="nav-active-dot" />}
          {view === 'imagegen' && hasRunningModels && <span className="nav-dot" />}
        </NavItem>
        <NavItem
          icon={AudioLinesIcon}
          label="音频工作室"
          active={view === 'audiocpp'}
          onClick={() => setView('audiocpp')}
        >
          {view === 'audiocpp' && <span className="nav-active-dot" />}
        </NavItem>

        {/* ── 工作台 ── */}
        <span className="nav-section-label" style={{ marginTop: 12 }}>工作台</span>
        <NavItem
          icon={CodeIcon}
          label="Agent Code"
          active={view === 'agent-code'}
          onClick={() => setView('agent-code')}
        >
          {view === 'agent-code' && <span className="nav-active-dot" />}
        </NavItem>

        {/* ── 系统 ── */}
        <span className="nav-section-label" style={{ marginTop: 12 }}>系统</span>
        <NavItem
          icon={BrainIcon}
          label="AI Agent"
          active={view === 'agents'}
          onClick={() => setView('agents')}
        >
          {view === 'agents' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={CpuIcon}
          label="后端与引擎"
          active={view === 'engines'}
          onClick={() => setView('engines')}
        >
          {view === 'engines' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={FolderOpenIcon}
          label="模型文件夹"
          active={view === 'folders'}
          onClick={() => setView('folders')}
        >
          {view === 'folders' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={SettingsIcon}
          label="设置"
          active={view === 'settings'}
          onClick={() => setView('settings')}
        >
          {view === 'settings' && <span className="nav-active-dot" />}
        </NavItem>
        <NavItem
          icon={InfoIcon}
          label="关于"
          active={view === 'about'}
          onClick={() => setView('about')}
        >
          {view === 'about' && <span className="nav-active-dot" />}
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
              未找到后端。<br />请在设置中下载。
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
