import React from 'react'
import { useStore } from '../store/useStore'
import { Loader2 } from 'lucide-react'

export default function AgentToolBar() {
  const phase = useStore(s => s.agentPhase)

  if (!phase) return null

  if (phase.kind === 'waiting_model') {
    return (
      <div className="agent-toolbar">
        <span className="agent-toolbar-icon"><Loader2 size={14} className="spin" /></span>
        <span className="agent-toolbar-text">等待模型响应...</span>
      </div>
    )
  }

  if (phase.kind === 'running_tools') {
    const toolNames = phase.tools.map(t => `${t.name} ${t.verb}`)
    const label = toolNames.length === 1
      ? toolNames[0]
      : toolNames.length <= 3
        ? toolNames.join('、')
        : `${toolNames.slice(0, 2).join('、')} (+${toolNames.length - 2})`
    return (
      <div className="agent-toolbar">
        <span className="agent-toolbar-icon"><Loader2 size={14} className="spin" /></span>
        <span className="agent-toolbar-text">{label}</span>
      </div>
    )
  }

  return null
}
