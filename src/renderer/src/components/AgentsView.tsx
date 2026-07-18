import React, { useEffect, useCallback, useState, useRef } from 'react'
import { useStore } from '../store/useStore'
import { RefreshCw, CheckCircle2, XCircle, FolderOpen, Play, Download, ArrowUpCircle, PackagePlus, ExternalLink } from 'lucide-react'
import type { AgentStatus } from '../store/useStore'
import '../styles/agents.css'

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
            <AgentRow key={agent.pkg} agent={agent} cwd={agentCwd} latestVersion={agentUpdates[agent.pkg]?.latest ?? null} onInstalled={fetchAgents} />
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

function AgentRow({ agent, cwd, latestVersion, onInstalled }: { agent: AgentStatus; cwd: string | null; latestVersion: string | null; onInstalled: () => void }) {
  const [launching, setLaunching] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [installing, setInstalling] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasUpdate = !!latestVersion

  async function handleInstall() {
    if (!agent.pkg) return
    setInstalling(true)
    try {
      const result = await window.api.installAgent(agent.pkg)
      if (!result.success) {
        console.error('[install-agent]', result.error)
        setInstalling(false)
        return
      }
      // Poll for installation completion (agent appears as installed)
      let attempts = 0
      pollRef.current = setInterval(async () => {
        attempts++
        try {
          const list = await window.api.listGlobalAgents() as AgentStatus[]
          const found = list.find(a => a.pkg === agent.pkg)
          if (found?.installed) {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setInstalling(false)
            onInstalled()
          } else if (attempts >= 60) {
            // Stop polling after ~5 minutes
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setInstalling(false)
          }
        } catch { /* ignore */ }
      }, 5000)
    } catch (e) {
      console.error('[install-agent]', e)
      setInstalling(false)
    }
  }

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
      {/* Agent logo */}
      <div
        style={{ position: 'relative', flexShrink: 0, width: 28, height: 28, cursor: agent.website ? 'pointer' : 'default' }}
        title={agent.website ? `访问官网：${agent.website}` : undefined}
        onClick={() => agent.website && window.api.openExternal(agent.website)}
      >
        {agent.logo ? (
          <img
            src={agent.logo}
            alt={agent.name}
            style={{
              width: 28, height: 28, borderRadius: 6,
              objectFit: 'cover',
              opacity: agent.installed ? 1 : 0.4,
            }}
          />
        ) : (
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'var(--bg)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: agent.installed ? 1 : 0.4,
          }}>
            {agent.installed ? (
              <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
            ) : (
              <XCircle size={16} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            )}
          </div>
        )}
        {/* Status dot */}
        <span style={{
          position: 'absolute', bottom: -2, right: -2,
          width: 10, height: 10, borderRadius: '50%',
          background: agent.installed ? 'var(--success)' : 'var(--text-muted)',
          opacity: agent.installed ? 1 : 0.35,
          border: '2px solid var(--surface)',
        }} />
        {/* External link badge */}
        {agent.website && (
          <span style={{
            position: 'absolute', top: -4, right: -6,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '1px 2px',
            display: 'flex', alignItems: 'center',
            opacity: 0,
            transition: 'opacity var(--transition)',
          }} className="agent-website-badge">
            <ExternalLink size={8} style={{ color: 'var(--text-muted)' }} />
          </span>
        )}
      </div>
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
      {/* Install button — always visible, disabled when installed or installing */}
      <button
        onClick={handleInstall}
        disabled={installing || agent.installed}
        title={installing ? '安装中，请在新终端窗口中等待完成…' : agent.installed ? `${agent.name} 已安装` : `安装 ${agent.name}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 12px', fontSize: 12, fontWeight: 600,
          background: agent.installed ? 'var(--bg)' : installing ? 'var(--bg)' : 'var(--accent)',
          color: agent.installed ? 'var(--success)' : installing ? 'var(--text-muted)' : 'var(--accent-fg)',
          border: agent.installed ? '1px solid var(--success)' : '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          cursor: (installing || agent.installed) ? 'default' : 'pointer',
          opacity: (installing && !agent.installed) ? 0.7 : 1,
          flexShrink: 0,
          transition: 'all var(--transition)',
        }}
      >
        {agent.installed ? (
          <><CheckCircle2 size={12} /> 已安装</>
        ) : installing ? (
          <><RefreshCw size={12} className="spin" /> 安装中…</>
        ) : (
          <><PackagePlus size={12} /> 安装</>
        )}
      </button>
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
