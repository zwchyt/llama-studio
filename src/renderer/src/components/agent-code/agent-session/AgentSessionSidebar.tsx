// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentSessionSidebar —— 左侧「工作区（通用 / 编码）/ 会话」列表          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 本轮重构：模式不再是「改造当前会话的开关」，而是**工作区切换**。
//   · 顶部：通用 | 编码 分段切换（只切下方列表与右侧面板，不碰任何会话）；
//   · 通用模式：一条扁平的聊天历史列表（无项目、无目录、无展开箭头）；
//   · 编码模式：项目 → 会话树（含新建项目 / 导入会话 / 目录切换）。
// 两种模式各自维护自己的列表与选中项（指针在 useAgentProjects 里按模式分槽），
// 切回来自然恢复上次选中的会话与面板状态。
//
// 说明：本组件是「受控视图」——所有状态与回调仍由上层持有，组件只负责渲染与派发。
// 这样做是为了在拆分文件的同时不改变任何状态归属与更新时序。

import React from 'react'
import { FolderOpenIcon, FolderIcon, TrashIcon, UploadIcon, PlusIcon, DownloadIcon, PencilIcon, CodeIcon, MessageSquareIcon, MessageSquarePlusIcon } from '@animateicons/react/lucide'
import { TopbarBtn } from '../agent-message'
import { CHAT_WORKSPACE_ID } from '../../../../../shared/types'
import type { AgentMode, AgentProject, AgentSession } from '../../../../../shared/types'

export type AgentSessionSidebarProps = {
  /** 当前工作区模式 */
  mode: AgentMode
  /** 切换工作区模式：只切列表与面板，不改任何会话 */
  switchMode: (m: AgentMode) => void
  /** 通用模式的聊天列表（来自通用工作区的 sessions） */
  chatSessions: AgentSession[]
  /** 编码模式的项目列表（真实工作区） */
  codeProjects: AgentProject[]
  activeProjectId: string
  activeSessionId: string
  setActiveProjectId: (v: string) => void
  setActiveSessionId: (v: string) => void
  /** 在当前模式新建会话（通用 → 通用工作区；编码 → 活动项目） */
  createSessionInCurrentMode: () => void
  /** 通用 → 编码：基于某条聊天新建编码会话（复制上下文，原聊天保留） */
  forkChatToCode: (sessId: string) => void
  // ── 编码模式专属：项目操作 ──
  projectWrapRefs: React.RefObject<Map<string, HTMLDivElement | null>>
  createProject: () => void
  toggleProjectExpanded: (p: AgentProject) => void
  changeProjectDir: (projId: string) => void
  deleteProject: (id: string) => void
  importSessionToProject: (projId: string) => void
  addSessionToProject: (projId: string) => void
  // ── 会话操作（两种模式共用） ──
  exportSession: (sessId: string) => void
  deleteSession: (projId: string, sessId: string) => void
  // ── 项目重命名 ──
  projRenamingId: string | null
  setProjRenamingId: (v: string | null) => void
  projRenameText: string
  setProjRenameText: (v: string) => void
  projRenameInputRef: React.RefObject<HTMLInputElement | null>
  confirmProjRename: () => void
  // ── 会话重命名 ──
  sessRenamingId: string | null
  setSessRenamingId: (v: string | null) => void
  sessRenameText: string
  setSessRenameText: (v: string) => void
  sessRenameInputRef: React.RefObject<HTMLInputElement | null>
  startSessRename: (sessId: string, currentTitle: string) => void
  confirmSessRename: (projId: string, sessId: string) => void
}

export function AgentSessionSidebar({
  mode, switchMode, chatSessions, codeProjects,
  activeProjectId, activeSessionId, setActiveProjectId, setActiveSessionId,
  createSessionInCurrentMode, forkChatToCode,
  projectWrapRefs, createProject, toggleProjectExpanded, changeProjectDir, deleteProject,
  importSessionToProject, addSessionToProject, exportSession, deleteSession,
  projRenamingId, setProjRenamingId, projRenameText, setProjRenameText, projRenameInputRef, confirmProjRename,
  sessRenamingId, setSessRenamingId, sessRenameText, setSessRenameText, sessRenameInputRef,
  startSessRename, confirmSessRename,
}: AgentSessionSidebarProps) {
  /** 会话行右侧的操作按钮组（导出 / 重命名 / 删除） */
  const sessionActions = (projId: string, s: AgentSession, compact = false) => (
    <span className="ac-icon-btn">
      <button className="agent-code-session-export" title="导出会话" onClick={e => { e.stopPropagation(); exportSession(s.id) }}><DownloadIcon size={compact ? 11 : 12} /></button>
      <button className="agent-code-session-rename" title="重命名" onClick={e => { e.stopPropagation(); startSessRename(s.id, s.title) }}><PencilIcon size={compact ? 11 : 12} /></button>
      <button className="agent-code-session-del" title="删除会话" onClick={e => { e.stopPropagation(); deleteSession(projId, s.id) }}><TrashIcon size={compact ? 11 : 12} /></button>
    </span>
  )

  return (
      <div className="agent-code-sidebar">
        {/* ── 工作区切换（通用 / 编码）──
            刻意不做成「全局开关」的观感：它是一个带说明的分段选择器，只决定下方列表的内容；
            任何已有会话都不会因为这里的选择而被改变类型。 */}
        <div className="agent-code-workspace-switch" role="tablist" aria-label="工作区模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'chat'}
            className={`agent-code-workspace-btn${mode === 'chat' ? ' active' : ''}`}
            onClick={() => switchMode('chat')}
            title="通用：普通聊天，没有项目与工作区"
          ><MessageSquareIcon size={13} />通用</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'code'}
            className={`agent-code-workspace-btn${mode === 'code' ? ' active' : ''}`}
            onClick={() => switchMode('code')}
            title="编码：项目工作区，带文件树与终端"
          ><CodeIcon size={13} />编码</button>
        </div>
        <div className="agent-code-workspace-hint">
          {mode === 'chat' ? '普通聊天 · 无工作区' : '项目工作区 · 文件与终端'}
        </div>

        {mode === 'chat' ? (
          /* ── 通用模式：轻量聊天历史，没有项目层级 ── */
          <>
            <TopbarBtn baseClass="agent-code-session-new-btn" icon={MessageSquarePlusIcon} size={14} onClick={createSessionInCurrentMode}>新建聊天</TopbarBtn>
            <div className="agent-code-sidebar-header">
              <span>聊天记录</span>
              <span className="agent-code-sidebar-count">{chatSessions.length}</span>
            </div>
            <div className="agent-code-session-list agent-code-chat-list">
              {chatSessions.map(s => (
                <div
                  key={s.id}
                  className={`agent-code-chat-item${s.id === activeSessionId ? ' active' : ''}`}
                  onClick={() => { setActiveProjectId(CHAT_WORKSPACE_ID); setActiveSessionId(s.id) }}
                >
                  {sessRenamingId === s.id ? (
                    <input
                      ref={sessRenameInputRef}
                      className="agent-code-rename-input"
                      value={sessRenameText}
                      onChange={e => setSessRenameText(e.target.value)}
                      onBlur={() => confirmSessRename(CHAT_WORKSPACE_ID, s.id)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => { if (e.key === 'Enter') confirmSessRename(CHAT_WORKSPACE_ID, s.id); if (e.key === 'Escape') setSessRenamingId(null) }}
                    />
                  ) : (
                    <>
                      <MessageSquareIcon size={13} className="agent-code-chat-icon" />
                      <span className="agent-code-session-title">{s.title}</span>
                      <span className="agent-code-mode-tag">通用</span>
                    </>
                  )}
                  <span className="ac-icon-btn">
                    {/* 单向转换：复制本聊天的上下文，新建一条编码会话；原聊天原样保留 */}
                    <button className="agent-code-session-fork" title="基于此聊天新建编码会话（复制上下文，原聊天保留）" onClick={e => { e.stopPropagation(); forkChatToCode(s.id) }}><CodeIcon size={11} /></button>
                  </span>
                  {sessionActions(CHAT_WORKSPACE_ID, s, true)}
                </div>
              ))}
              {chatSessions.length === 0 && (
                <div className="agent-code-chat-empty">还没有聊天，点上面「新建聊天」开始。</div>
              )}
            </div>
          </>
        ) : (
          /* ── 编码模式：项目 → 会话树 ── */
          <>
            <TopbarBtn baseClass="agent-code-session-new-btn" icon={FolderOpenIcon} size={14} onClick={createProject}>新建项目</TopbarBtn>
            <div className="agent-code-sidebar-header"><span>项目</span></div>
            <div className="agent-code-session-list">
              {codeProjects.map(p => (
                <div key={p.id} className="agent-code-project-group">
                  <div className={`agent-code-project-item ${p.id === activeProjectId ? 'active' : ''}`} onClick={() => {
                    toggleProjectExpanded(p)
                    // 切到其他项目时必须同步会话指针：否则 activeSessionId 仍指向旧项目的会话，
                    // 界面靠 || sessions[0] 兜底显示正常，但 handleSend 用悬空 sid 写会话 = 消息静默丢失。
                    if (p.id !== activeProjectId) {
                      setActiveProjectId(p.id)
                      setActiveSessionId(p.sessions[0]?.id ?? '')
                    }
                  }}>
                    {projRenamingId === p.id ? (
                      <input
                        ref={projRenameInputRef}
                        className="agent-code-rename-input"
                        value={projRenameText}
                        onChange={e => setProjRenameText(e.target.value)}
                        onBlur={confirmProjRename}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => { if (e.key === 'Enter') confirmProjRename(); if (e.key === 'Escape') setProjRenamingId(null) }}
                      />
                    ) : (
                      <>
                        <FolderIcon size={14} className="agent-code-project-icon" />
                        <span className="agent-code-session-title">{p.title}</span>
                        <span className="agent-code-mode-tag">编码</span>
                      </>
                    )}
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-del" title="切换项目目录" onClick={e => { e.stopPropagation(); changeProjectDir(p.id) }}><FolderOpenIcon size={13} /></button>
                    </span>
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-del" title="删除项目" onClick={e => { e.stopPropagation(); deleteProject(p.id) }}><TrashIcon size={13} /></button>
                    </span>
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-add" title="导入会话" onClick={e => { e.stopPropagation(); importSessionToProject(p.id) }}><UploadIcon size={13} /></button>
                    </span>
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-add" title="新建会话" onClick={e => { e.stopPropagation(); addSessionToProject(p.id) }}><PlusIcon size={13} /></button>
                    </span>
                  </div>
                  <div className={`agent-code-child-wrap ${p.expanded ? 'open' : ''}`} ref={el => { projectWrapRefs.current.set(p.id, el) }}>
                    <div className="agent-code-child-sessions">
                      {p.sessions.map(s => (
                        <div key={s.id} className={`agent-code-session-item ${s.id === activeSessionId && p.id === activeProjectId ? 'active' : ''}`} onClick={() => { setActiveProjectId(p.id); setActiveSessionId(s.id) }}>
                          {sessRenamingId === s.id ? (
                            <input
                              ref={sessRenameInputRef}
                              className="agent-code-rename-input"
                              value={sessRenameText}
                              onChange={e => setSessRenameText(e.target.value)}
                              onBlur={() => confirmSessRename(p.id, s.id)}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => { if (e.key === 'Enter') confirmSessRename(p.id, s.id); if (e.key === 'Escape') setSessRenamingId(null) }}
                            />
                          ) : (
                            <span className="agent-code-session-title">{s.title}</span>
                          )}
                          {sessionActions(p.id, s)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
  )
}
