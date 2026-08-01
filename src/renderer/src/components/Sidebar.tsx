import React, { useCallback, useRef } from 'react'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import { safeCall } from '../utils/safeCall'
import { LayoutGrid, Settings, FolderOpen, HardDrive, Search, Activity, Server, Bot, MessageSquare, Terminal, Info, FileText, Gauge, Code, Wrench, BookOpen, AudioLines } from 'lucide-react'
import '../styles/sidebar.css'

function BackendNavItem({ b, isActive, onSwitch }: { b: { name: string; path?: string }; isActive: boolean; onSwitch: () => void }) {
  return (
    <button
      className="nav-item"
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
    const cmds = await safeCall(() => window.api.getCommands(name, b.kind === 'tensorsharp' ? 'tensorsharp' : 'llamacpp'), '切换后端失败')
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
        <button
          className={`nav-item ${view === 'cards' ? 'active' : ''}`}
          onClick={() => setView('cards')}
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
        >
          <HardDrive size={16} />
          <span>模型</span>
          {view === 'models' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'hub' ? 'active' : ''}`}
          onClick={() => setView('hub')}
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
        >
          <Gauge size={16} />
          <span>性能测试</span>
          {view === 'benchmark' && <span className="nav-active-dot" />}
        </button>

        <button
          className={`nav-item ${view === 'terminal' ? 'active' : ''}`}
          onClick={() => setView('terminal')}
        >
          <Terminal size={16} />
          <span>终端</span>
          {view === 'terminal' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'ocr' ? 'active' : ''}`}
          onClick={() => setView('ocr')}
          style={hasRunningModels ? { color: 'var(--success)' } : {}}
        >
          <FileText size={16} />
          <span>OCR</span>
          {view === 'ocr' && <span className="nav-active-dot" />}
          {hasRunningModels && <span className="nav-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'model-tools' ? 'active' : ''}`}
          onClick={() => setView('model-tools')}
        >
          <Wrench size={16} />
          <span>模型工具</span>
          {view === 'model-tools' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'knowledge' ? 'active' : ''}`}
          onClick={() => setView('knowledge')}
        >
          <BookOpen size={16} />
          <span>知识库</span>
          {view === 'knowledge' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'tts' ? 'active' : ''}`}
          onClick={() => setView('tts')}
        >
          <AudioLines size={16} />
          <span>语音合成</span>
          {view === 'tts' && <span className="nav-active-dot" />}
        </button>

        {/* ── 工作台 ── */}
        <span className="nav-section-label" style={{ marginTop: 12 }}>工作台</span>
        <button
          className={`nav-item ${view === 'agent-code' ? 'active' : ''}`}
          onClick={() => setView('agent-code')}
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
        >
          <Bot size={16} />
          <span>AI Agent</span>
          {view === 'agents' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'settings' ? 'active' : ''}`}
          onClick={() => setView('settings')}
        >
          <Settings size={16} />
          <span>设置</span>
          {view === 'settings' && <span className="nav-active-dot" />}
        </button>
        <button
          className={`nav-item ${view === 'about' ? 'active' : ''}`}
          onClick={() => setView('about')}
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
            <button className="nav-item" onClick={() => window.api.openFolder(paths.backend)}>
              <FolderOpen size={16} />
              <span>打开 /backend</span>
            </button>
            <button className="nav-item" onClick={() => window.api.openFolder(paths.models)}>
              <FolderOpen size={16} />
              <span>打开 /models</span>
            </button>
            <button className="nav-item" onClick={() => window.api.openFolder(paths.chatImages)}>
              <FolderOpen size={16} />
              <span>打开 /images</span>
            </button>
            <button className="nav-item" onClick={() => window.api.openFolder(paths.chatPdfExports)}>
              <FolderOpen size={16} />
              <span>打开 /pdf_exports</span>
            </button>
            <button className="nav-item" onClick={() => window.api.openFolder(paths.chatTemplates)}>
              <FolderOpen size={16} />
              <span>打开 /chat-templates</span>
            </button>
          </div>
        )}
      </nav>
    </div>
  )
}
