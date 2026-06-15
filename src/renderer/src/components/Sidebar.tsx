import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { LayoutGrid, Settings, FolderOpen, HardDrive, Search, Activity, Globe, Server, Bot, MessageSquare } from 'lucide-react'
export default function Sidebar() {
  const { view, setView, backends, activeBackend, setActiveBackend, setCommandsSchema, paths, activeChatUrl, piWebUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, paths: s.paths, activeChatUrl: s.activeChatUrl, piWebUrl: s.piWebUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
    shallow
  )

  async function switchBackend(name: string) {
    const b = backends.find((x) => x.name === name)
    if (!b) return
    setActiveBackend(b)
    const cmds = await window.api.getCommands(name)
    if (cmds) setCommandsSchema(cmds)
  }
  return (
    <nav className="sidebar">
      {/* ── 导航 ── */}
      <span className="nav-section-label">导航</span>
      <button
        className={`nav-item ${view === 'cards' ? 'active' : ''}`}
        onClick={() => setView('cards')}
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <LayoutGrid size={16} />
        我的模板
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'models' ? 'active' : ''}`}
        onClick={() => setView('models')}
      >
        <HardDrive size={16} />
        模型
      </button>
      <button
        className={`nav-item ${view === 'hub' ? 'active' : ''}`}
        onClick={() => setView('hub')}
      >
        <Search size={16} />
        模型中心
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
        llama-server
        {activeChatUrl && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'chat' ? 'active' : ''}`}
        onClick={() => setView('chat')}
        title="原生聊天界面"
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <MessageSquare size={16} />
        聊天
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'monitoring' ? 'active' : ''}`}
        onClick={() => setView('monitoring')}
        style={hasRunningModels ? { color: 'var(--success)' } : {}}
      >
        <Activity size={16} />
        模型运行数据
        {hasRunningModels && <span className="nav-dot" />}
      </button>
      <button
        className={`nav-item ${view === 'piweb' ? 'active' : ''}`}
        onClick={() => setView('piweb')}
        title={piWebUrl ? '打开 pi-web' : '暂无运行中的 pi-web'}
        style={piWebUrl ? { color: 'var(--success)' } : {}}
      >
        <Globe size={16} />
        pi-web
        {piWebUrl && <span className="nav-dot" />}
      </button>

      {/* ── 系统 ── */}
      <span className="nav-section-label" style={{ marginTop: 12 }}>系统</span>
      <button
        className={`nav-item ${view === 'agents' ? 'active' : ''}`}
        onClick={() => setView('agents')}
      >
        <Bot size={16} />
        AI Agent
      </button>
      <button
        className={`nav-item ${view === 'settings' ? 'active' : ''}`}
        onClick={() => setView('settings')}
      >
        <Settings size={16} />
        设置
      </button>
      <button
        className={`nav-item ${view === 'about' ? 'active' : ''}`}
        onClick={() => setView('about')}
      >
        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', width: 16, textAlign: 'center' }}>i</span>
        关于
      </button>
      {backends.length > 0 && (
        <>
          <span className="nav-section-label" style={{ marginTop: 12 }}>后端</span>
          {backends.map((b) => (
            <button
              key={b.name}
              className={`nav-item ${activeBackend?.name === b.name ? 'active' : ''}`}
              onClick={() => switchBackend(b.name)}
              title={b.path}
            >
              <HardDrive size={16} />
              <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.name}>
                {b.name}
              </span>
            </button>
          ))}
        </>
      )}
      {backends.length === 0 && (
        <>
          <span className="nav-section-label" style={{ marginTop: 12 }}>后端</span>
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            未找到后端。<br />请在设置中下载。
          </div>
        </>
      )}
      {paths && (
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.backend)} title={paths.backend}>
            <FolderOpen size={16} />
            打开 /backend
          </button>
          <button className="nav-item" onClick={() => window.api.openFolder(paths.models)} title={paths.models}>
            <FolderOpen size={16} />
            打开 /models
          </button>
        </div>
      )}
    </nav>
  )
}
