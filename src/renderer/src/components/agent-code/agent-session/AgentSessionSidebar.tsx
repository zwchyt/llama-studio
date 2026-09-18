// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentSessionSidebar —— 左侧「项目 / 会话」树                           ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 从 AgentCodeView.tsx 的 JSX 中原样搬出（结构与注释未改），仅把原来靠闭包读取的
// 状态与回调改为显式 props。
//
// 说明：本组件是「受控视图」——projects / activeProjectId / activeSessionId 与全部
// 重命名草稿仍由上层持有，组件只负责渲染与派发回调（上层为 AgentCodeView，状态
// 所有权见其 agent-session 相关区块）。这样做是为了在拆文件的同时不改变任何状态
// 归属与更新时序。

import React from 'react'
import { FolderOpenIcon, FolderIcon, TrashIcon, UploadIcon, PlusIcon, DownloadIcon, PencilIcon, CodeIcon, MessageSquareIcon } from '@animateicons/react/lucide'
import { TopbarBtn } from '../agent-message'
import type { AgentProject } from '../../../../../shared/types'

export type AgentSessionSidebarProps = {
  projects: AgentProject[]
  activeProjectId: string
  activeSessionId: string
  setActiveProjectId: (v: string) => void
  setActiveSessionId: (v: string) => void
  projectWrapRefs: React.RefObject<Map<string, HTMLDivElement | null>>
  createProject: () => void
  toggleProjectExpanded: (p: AgentProject) => void
  changeProjectDir: (projId: string) => void
  deleteProject: (id: string) => void
  importSessionToProject: (projId: string) => void
  addSessionToProject: (projId: string) => void
  exportSession: (sessId: string) => void
  deleteSession: (projId: string, sessId: string) => void
  // 项目重命名
  projRenamingId: string | null
  setProjRenamingId: (v: string | null) => void
  projRenameText: string
  setProjRenameText: (v: string) => void
  projRenameInputRef: React.RefObject<HTMLInputElement | null>
  confirmProjRename: () => void
  // 会话重命名
  sessRenamingId: string | null
  setSessRenamingId: (v: string | null) => void
  sessRenameText: string
  setSessRenameText: (v: string) => void
  sessRenameInputRef: React.RefObject<HTMLInputElement | null>
  startSessRename: (sessId: string, currentTitle: string) => void
  confirmSessRename: (projId: string, sessId: string) => void
  // 模式切换：false=编码模式（工作台全套控件），true=通用模式（会话级 AgentSession.plainChat）
  plainChat: boolean
  setPlainChat: (on: boolean) => void
}

export function AgentSessionSidebar({
  projects, activeProjectId, activeSessionId, setActiveProjectId, setActiveSessionId,
  projectWrapRefs, createProject, toggleProjectExpanded, changeProjectDir, deleteProject,
  importSessionToProject, addSessionToProject, exportSession, deleteSession,
  projRenamingId, setProjRenamingId, projRenameText, setProjRenameText, projRenameInputRef, confirmProjRename,
  sessRenamingId, setSessRenamingId, sessRenameText, setSessRenameText, sessRenameInputRef,
  startSessRename, confirmSessRename,
  plainChat, setPlainChat,
}: AgentSessionSidebarProps) {
  return (
      <div className="agent-code-sidebar">
        {/* 模式切换（当前会话）：通用模式只收掉编码专属控件，工具与系统提示词由主进程按 plainChat 重建 */}
        <div className="agent-code-mode-switch">
          <TopbarBtn baseClass="agent-code-mode-btn" active={!plainChat} icon={CodeIcon} size={14} onClick={() => setPlainChat(false)} title="编码模式：完整工作台（文件工具、终端、变更、审计、轨迹等）">编码模式</TopbarBtn>
          <TopbarBtn baseClass="agent-code-mode-btn" active={plainChat} icon={MessageSquareIcon} size={14} onClick={() => setPlainChat(true)} title="通用模式：隐藏编码相关控件，作为日常对话使用">通用模式</TopbarBtn>
        </div>
        <TopbarBtn baseClass="agent-code-session-new-btn" icon={FolderOpenIcon} size={14} onClick={createProject}>新建项目</TopbarBtn>
        <div className="agent-code-sidebar-header"><span>项目</span></div>
        <div className="agent-code-session-list">
          {projects.map(p => (
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
                  </>
                )}
                <span className="ac-icon-btn">
                  <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); changeProjectDir(p.id) }}><FolderOpenIcon size={13} /></button>
                </span>
                <span className="ac-icon-btn">
                  <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteProject(p.id) }}><TrashIcon size={13} /></button>
                </span>
                <span className="ac-icon-btn">
                  <button className="agent-code-session-add" onClick={e => { e.stopPropagation(); importSessionToProject(p.id) }} title="导入会话"><UploadIcon size={13} /></button>
                </span>
                <span className="ac-icon-btn">
                  <button className="agent-code-session-add" onClick={e => { e.stopPropagation(); addSessionToProject(p.id) }}><PlusIcon size={13} /></button>
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
                      <span className="ac-icon-btn">
                        <button className="agent-code-session-export" onClick={e => { e.stopPropagation(); exportSession(s.id) }}><DownloadIcon size={12} /></button>
                        <button className="agent-code-session-rename" onClick={e => { e.stopPropagation(); startSessRename(s.id, s.title) }}><PencilIcon size={12} /></button>
                        <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteSession(p.id, s.id) }}><TrashIcon size={12} /></button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
  )
}
