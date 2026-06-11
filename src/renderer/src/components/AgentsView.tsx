import React, { useEffect, useCallback, useState } from 'react'
import { useStore } from '../store/useStore'
import { RefreshCw, CheckCircle2, XCircle, FolderOpen, Play, Download, ArrowUpCircle } from 'lucide-react'
import type { AgentStatus } from '../store/useStore'

export default function AgentsView() {
  const agentStatuses = useStore(s => s.agentStatuses)
  const agentsLoading = useStore(s => s.agentsLoading)
  const agentCwd = useStore(s => s.agentCwd)
  const agentUpdates = useStore(s => s.agentUpdates)
  const agentUpdatesLoading = useStore(s => s.agentUpdatesLoading)
  const setAgentStatuses = useStore(s => s.setAgentStatuses)
  const setAgentsLoading = useStore(s => s.setAgentsLoading)
  const setAgentCwd = useStore(s => s.setAgentCwd)
  const setAgentUpdates = useStore(s => s.setAgentUpdates)
  const setAgentUpdatesLoading = useStore(s => s.setAgentUpdatesLoading)

  const checkUpdates = useCallback(async (agents: AgentStatus[]) => {
    const installed = agents
      .filter(a => a.installed && a.version)
      .map(a => ({ pkg: a.pkg, version: a.version! }))
    if (installed.length === 0) return
    setAgentUpdatesLoading(true)
    try {
      const result = await window.api.checkAgentUpdates(installed)
      setAgentUpdates(result)
    } catch (e) {
      console.error('[checkAgentUpdates]', e)
    } finally {
      setAgentUpdatesLoading(false)
    }
  }, [setAgentUpdates, setAgentUpdatesLoading])

  const fetchAgents = useCallback(async () => {
    setAgentsLoading(true)
    try {
      const result = await window.api.listGlobalAgents() as AgentStatus[]
      setAgentStatuses(result)
      // After fetching, check for updates
      queueMicrotask(() => checkUpdates(result))
    } catch (e) {
      console.error('[listGlobalAgents]', e)
    } finally {
      setAgentsLoading(false)
    }
  }, [setAgentStatuses, setAgentsLoading, checkUpdates])

  useEffect(() => {
    if (agentStatuses.length === 0 && !agentsLoading) {
      fetchAgents()
    }
  }, [])

  async function pickDirectory() {
    try {
      const result = await window.api.selectDirectory()
      if (result?.path) setAgentCwd(result.path)
    } catch (e) {
      console.error('[selectDirectory]', e)
    }
  }

  const installedCount = agentStatuses.filter(a => a.installed).length
  const totalCount = agentStatuses.length
  const updateCount = Object.keys(agentUpdates).length

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>AI Agent</h2>
          <span style={{
            fontSize: 12, color: 'var(--text-muted)',
            background: 'var(--surface)', padding: '2px 10px',
            borderRadius: 12, border: '1px solid var(--border)'
          }}>
            {installedCount} / {totalCount} 已安装
          </span>
          {updateCount > 0 && (
            <span style={{
              fontSize: 12, fontWeight: 600,
              color: '#e67e22',
              background: '#fef3e2',
              padding: '2px 10px',
              borderRadius: 12,
              border: '1px solid #f5d6a8',
            }}>
              {updateCount} 个可更新
            </span>
          )}
          {agentUpdatesLoading && (
            <span style={{
              fontSize: 11, color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <RefreshCw size={12} className="spin" />
              检查更新中…
            </span>
          )}
        </div>
        <button
          onClick={fetchAgents}
          disabled={agentsLoading}
          title="刷新"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', fontSize: 13, fontWeight: 500,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
            cursor: agentsLoading ? 'wait' : 'pointer',
            transition: 'all var(--transition)',
            opacity: agentsLoading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={14} className={agentsLoading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {/* Directory picker */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '10px 14px',
        background: 'var(--surface)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
      }}>
        <FolderOpen size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>工作目录：</span>
        <span style={{
          flex: 1, fontSize: 13, fontFamily: 'monospace',
          color: agentCwd ? 'var(--text)' : 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {agentCwd || '请选择项目目录…'}
        </span>
        <button
          onClick={pickDirectory}
          style={{
            padding: '4px 12px', fontSize: 12, fontWeight: 500,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          选择目录
        </button>
      </div>

      {agentsLoading && agentStatuses.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <RefreshCw size={24} className="spin" style={{ marginBottom: 12 }} />
          <div>正在检测全局安装的 AI Agent…</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agentStatuses.map((agent) => (
            <AgentRow key={agent.pkg} agent={agent} cwd={agentCwd} latestVersion={agentUpdates[agent.pkg]?.latest ?? null} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 20, padding: '12px 16px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8, background: 'var(--surface)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
        <strong style={{ color: 'var(--text-secondary)' }}>检测方式：</strong>
        <code style={{ fontSize: 11, background: 'var(--bg)', padding: '1px 6px', borderRadius: 3 }}>npm list -g --depth=0</code>
        {' + '}npm registry API 版本比对
        <br />
        点击 <strong style={{ color: 'var(--text-secondary)' }}>启动</strong> 将在新的终端窗口中运行 Agent
        <br />
        点击 <strong style={{ color: 'var(--text-secondary)' }}>更新</strong> 将在新的终端窗口中执行更新命令
      </div>
    </div>
  )
}

function AgentRow({ agent, cwd, latestVersion }: { agent: AgentStatus; cwd: string | null; latestVersion: string | null }) {
  const [launching, setLaunching] = useState(false)
  const [updating, setUpdating] = useState(false)
  const hasUpdate = !!latestVersion

  async function handleLaunch() {
    if (!cwd || !agent.cmd) return
    setLaunching(true)
    try {
      const result = await window.api.launchAgent(agent.cmd, cwd)
      if (!result.success) {
        console.error('[launch-agent]', result.error)
      }
    } catch (e) {
      console.error('[launch-agent]', e)
    } finally {
      setTimeout(() => setLaunching(false), 600)
    }
  }

  async function handleUpdate() {
    if (!agent.pkg) return
    setUpdating(true)
    try {
      const result = await window.api.updateAgent(agent.pkg)
      if (!result.success) {
        console.error('[update-agent]', result.error)
      }
    } catch (e) {
      console.error('[update-agent]', e)
    } finally {
      setTimeout(() => setUpdating(false), 600)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px',
      background: 'var(--surface)',
      borderRadius: 'var(--radius-sm)',
      border: hasUpdate ? '1px solid #f5d6a8' : '1px solid var(--border)',
      transition: 'border-color var(--transition)',
    }}>
      {agent.installed ? (
        <CheckCircle2 size={18} style={{ color: 'var(--success)', flexShrink: 0 }} />
      ) : (
        <XCircle size={18} style={{ color: 'var(--text-muted)', opacity: 0.4, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 600,
          color: agent.installed ? 'var(--text)' : 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {agent.name}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {agent.pkg}
        </div>
      </div>
      {/* Version display */}
      {agent.installed && agent.version && (
        <span style={{
          fontSize: 11, fontWeight: 500, fontFamily: 'monospace',
          color: hasUpdate ? 'var(--text-muted)' : 'var(--success)',
          background: 'var(--bg)',
          padding: '2px 8px', borderRadius: 10,
          border: '1px solid var(--border)', flexShrink: 0,
        }}>
          v{agent.version}
        </span>
      )}
      {/* New version badge */}
      {hasUpdate && (
        <span style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
          color: '#e67e22',
          background: '#fef3e2',
          padding: '2px 8px', borderRadius: 10,
          border: '1px solid #f5d6a8', flexShrink: 0,
        }}>
          <ArrowUpCircle size={12} />
          v{latestVersion}
        </span>
      )}
      {!agent.installed && (
        <span style={{
          fontSize: 11, color: 'var(--text-muted)', opacity: 0.6, flexShrink: 0
        }}>
          未安装
        </span>
      )}
      {agent.installed && (
        <>
          <button
            onClick={handleUpdate}
            disabled={updating}
            title={hasUpdate ? `更新到 ${latestVersion}` : `更新 ${agent.name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', fontSize: 12, fontWeight: 500,
              background: hasUpdate ? '#fef3e2' : 'var(--bg)',
              color: updating ? 'var(--text-muted)' : hasUpdate ? '#e67e22' : 'var(--text-secondary)',
              border: hasUpdate ? '1px solid #f5d6a8' : '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              cursor: updating ? 'wait' : 'pointer',
              opacity: updating ? 0.6 : 1,
              flexShrink: 0,
              transition: 'all var(--transition)',
            }}
          >
            <Download size={12} />
            更新
          </button>
          <button
            onClick={handleLaunch}
            disabled={!cwd || launching}
            title={cwd ? `启动 ${agent.name}` : '请先选择工作目录'}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 12px', fontSize: 12, fontWeight: 600,
              background: cwd ? 'var(--accent)' : 'var(--bg)',
              color: cwd ? 'var(--accent-fg)' : 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              cursor: cwd ? 'pointer' : 'not-allowed',
              opacity: cwd ? 1 : 0.5,
              flexShrink: 0,
              transition: 'all var(--transition)',
            }}
          >
            <Play size={12} fill="currentColor" />
            启动
          </button>
        </>
      )}
    </div>
  )
}
