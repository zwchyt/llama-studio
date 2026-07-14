import React, { useState, useCallback, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { safeCall } from '../utils/safeCall'
import { LayoutGrid, Settings, FolderOpen, HardDrive, Search, Activity, Server, Bot, MessageSquare, Terminal, Info, FileText, Gauge, PanelLeftClose, PanelLeftOpen, Code } from 'lucide-react'

function BackendNavItem({ b, isActive, onSwitch }: { b: { name: string; path?: string }; isActive: boolean; onSwitch: () => void }) {
  return (
    <button
      className={`nav-item ${isActive ? 'active' : ''}`}
      onClick={onSwitch}
    >
      <HardDrive size={16} />
      <span className="sidebar-backend-name">
        <span className="sidebar-backend-name-text">{b.name}</span>
        {isActive && <span className="nav-active-dot" />}
      </span>
    </button>
  )
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const [collapsing, setCollapsing] = useState(false)
  const [hoverExpanded, setHoverExpanded] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { view, setView, backends, activeBackend, setActiveBackend, setCommandsSchema, paths, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, paths: s.paths, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
    shallow
  )

  // 手动切换收起/展开
  function toggleCollapse() {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null }

    if (collapsed) {
      // 展开：用浮层飞入（sidebar 保持 220px 布局，不跟随 wrapper 宽度过渡），
      // wrapper 过渡到 220px 结束后，切回正常流——宽度一致无重排
      setHoverExpanded(true)
      setCollapsed(false)
      setCollapsing(false)
      hoverTimer.current = setTimeout(() => setHoverExpanded(false), 250)
    } else {
      // 收起：分两步避免图标跳动
      // 1. 立即加 collapsed 让 wrapper 开始宽度过渡（220→50），但 collapsing=true 阻止内部样式突变
      // 2. 过渡结束（250ms）后去掉 collapsing，内部样式瞬间生效——此时 wrapper 已 50px，
      //    图标从左边缘跳到居中仅 15px，远小于之前的 100px，基本不可见
      setCollapsed(true)
      setCollapsing(true)
      setHoverExpanded(false)
      collapseTimer.current = setTimeout(() => setCollapsing(false), 250)
    }
  }

  // 鼠标进入收起的侧边栏 → 延迟后展开
  const handleMouseEnter = useCallback(() => {
    if (!collapsed) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHoverExpanded(true), 120)
  }, [collapsed])

  // 鼠标离开 → 立即收起（仅收起状态下的悬浮展开；展开过渡中不干扰）
  const handleMouseLeave = useCallback(() => {
    if (!collapsed) return
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    if (hoverExpanded) setHoverExpanded(false)
  }, [collapsed, hoverExpanded])

  const isCollapsed = collapsed && !hoverExpanded
  const isHoverExpanded = hoverExpanded

  async function switchBackend(name: string) {
    const b = backends.find((x) => x.name === name)
    if (!b) return
    setActiveBackend(b)
    const cmds = await safeCall(() => window.api.getCommands(name), '切换后端失败')
    if (cmds) setCommandsSchema(cmds)
  }
  return (
    <div
      className={`sidebar-wrapper${isCollapsed ? ' collapsed' : ''}${collapsing ? ' collapsing' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <nav className="sidebar">
      {/* 收起/展开切换按钮 */}
      <button
        className="sidebar-toggle"
        onClick={toggleCollapse}
        title={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        {collapsed && !hoverExpanded ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      {/* ── 导航 ── */}
      <span className="nav-section-label">导航</span>
      <button
        className={`nav-item ${view === 'cards' ? 'active' : ''}`}
        onClick={() => setView('cards')}
        title="我的模板"
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <LayoutGrid size={16} />
        <span>我的模板</span>
        {view === 'cards' && <span className="nav-active-dot" />}
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'models' ? 'active' : ''}`}
        onClick={() => setView('models')}
        title="模型"
      >
        <HardDrive size={16} />
        <span>模型</span>
        {view === 'models' && <span className="nav-active-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'hub' ? 'active' : ''}`}
        onClick={() => setView('hub')}
        title="模型中心"
      >
        <Search size={16} />
        <span>模型中心</span>
        {view === 'hub' && <span className="nav-active-dot" />}
      </button>

      {/* ── 服务 ── */}
      <span className="nav-section-label" style={{ marginTop: 12 }}>服务</span>
      <button
        className={`nav-item ${view === 'llama' ? 'active' : ''}`}
        onClick={() => setView('llama')}
        title={activeChatUrl ? '打开聊天界面' : '暂无活跃会话'}
        style={activeChatUrl ? { color: 'var(--success)' } : {}}
      >
        <Server size={16} />
        <span>llama-server</span>
        {view === 'llama' && <span className="nav-active-dot" />}
        {activeChatUrl && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'chat' ? 'active' : ''}`}
        onClick={() => setView('chat')}
        title="聊天"
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <MessageSquare size={16} />
        <span>聊天</span>
        {view === 'chat' && <span className="nav-active-dot" />}
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'monitoring' ? 'active' : ''}`}
        onClick={() => setView('monitoring')}
        title="模型运行数据"
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <Activity size={16} />
        <span>模型运行数据</span>
        {view === 'monitoring' && <span className="nav-active-dot" />}
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'benchmark' ? 'active' : ''}`}
        onClick={() => setView('benchmark')}
        title="性能测试"
      >
        <Gauge size={16} />
        <span>性能测试</span>
        {view === 'benchmark' && <span className="nav-active-dot" />}
      </button>

      <button
        className={`nav-item ${view === 'terminal' ? 'active' : ''}`}
        onClick={() => setView('terminal')}
        title="终端"
      >
        <Terminal size={16} />
        <span>终端</span>
        {view === 'terminal' && <span className="nav-active-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'ocr' ? 'active' : ''}`}
        onClick={() => setView('ocr')}
        title={hasRunningModels ? 'OCR 文字识别' : '暂无运行中的模型'}
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <FileText size={16} />
        <span>OCR</span>
        {view === 'ocr' && <span className="nav-active-dot" />}
        {hasRunningModels && <span className="nav-dot" />}
      </button>

      {/* ── 工作台 ── */}
      <span className="nav-section-label" style={{ marginTop: 12 }}>工作台</span>
      <button
        className={`nav-item ${view === 'agent-code' ? 'active' : ''}`}
        onClick={() => setView('agent-code')}
        title="Agent Code 工作台"
      >
        <Code size={16} />
        <span>Agent Code 工作台</span>
        {view === 'agent-code' && <span className="nav-active-dot" />}
      </button>

      {/* ── 系统 ── */}
      <span className="nav-section-label" style={{ marginTop: 12 }}>系统</span>
      <button
        className={`nav-item ${view === 'agents' ? 'active' : ''}`}
        onClick={() => setView('agents')}
        title="AI Agent"
      >
        <Bot size={16} />
        <span>AI Agent</span>
        {view === 'agents' && <span className="nav-active-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'settings' ? 'active' : ''}`}
        onClick={() => setView('settings')}
        title="设置"
      >
        <Settings size={16} />
        <span>设置</span>
        {view === 'settings' && <span className="nav-active-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'about' ? 'active' : ''}`}
        onClick={() => setView('about')}
        title="关于"
      >
        <Info size={16} />
        <span>关于</span>
        {view === 'about' && <span className="nav-active-dot" />}
      </button>
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
          <button className="nav-item" onClick={() => window.api.openFolder(paths.backend)} title={paths.backend}>
            <FolderOpen size={16} />
            <span>打开 /backend</span>
          </button>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.models)} title={paths.models}>
            <FolderOpen size={16} />
            <span>打开 /models</span>
          </button>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.chatImages)} title={paths.chatImages}>
            <FolderOpen size={16} />
            <span>打开 /images</span>
          </button>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.chatPdfExports)} title={paths.chatPdfExports}>
            <FolderOpen size={16} />
            <span>打开 /pdf_exports</span>
          </button>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.chatTemplates)} title={paths.chatTemplates}>
            <FolderOpen size={16} />
            <span>打开 /chat-templates</span>
          </button>
        </div>
      )}
      </nav>
    </div>
  )
}
