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
// 说明：本组件是「受控视图」——所有数据状态与回调仍由上层持有，组件只负责渲染与派发。
// 这样做是为了在拆分文件的同时不改变任何状态归属与更新时序。
// 例外：过滤词与项目「⋯」菜单开合是纯视图本地的交互状态（只决定渲染哪些行），留在本组件。

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpenIcon, FolderIcon, TrashIcon, UploadIcon, PlusIcon, DownloadIcon, PencilIcon, CodeIcon, EllipsisIcon, MessageSquareIcon, MessageSquarePlusIcon, SearchIcon, XIcon } from '@animateicons/react/lucide'
import { TopbarBtn } from '../agent-message'
import { CHAT_WORKSPACE_ID } from '../../../../../shared/types'
import type { AgentMode, AgentProject, AgentSession } from '../../../../../shared/types'

/** ── 视图级辅助（纯展示派生，不触碰上层状态）── */

/** 会话的「最后活跃」时间：从既有 id 派生——消息 id 由 newMsgId 内嵌十进制
    Date.now()，会话 id 由 uniqueId 内嵌 base36 时间戳。导入的会话若 id 来自
    外部（两种格式都对不上）则返回 null，该行不显示时间，不做猜测。 */
function sessionLastActive(s: AgentSession): number | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = /^msg-(\d+)-/.exec(s.messages[i]!.id)
    if (m) return Number(m[1])
  }
  const sess = /^sess-([0-9a-z]+)-/.exec(s.id)
  if (sess) {
    const ms = parseInt(sess[1]!, 36)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return null
}

/** 相对时间文案（紧凑式）：分 / 时 / 天，一周以上退化为 M-D。
    刻意压到 3 个字符内——侧栏最窄 160px 时行右侧还要放 3~4 个操作按钮，
    文案长一点就会把整簇挤出容器；完整时间放在 title tooltip 里。 */
function relTimeLabel(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}时`
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}天`
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}-${dt.getDate()}`
}

/** 列表行键盘导航：仅在焦点位于行本身时接管（不抢行内按钮/输入框的键）；
    方向键在相邻行之间移焦，Enter/Space 等价于点击该行。 */
function listKeyNav(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.target !== e.currentTarget) return
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  const row = e.currentTarget
  if (e.key === 'Enter' || e.key === ' ') { row.click(); return }
  const rows = Array.from(row.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-row]') ?? [])
  const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]
  next?.focus()
}

/** 列表过滤框（视图本地状态，仅决定渲染，不改任何数据） */
function SidebarFilter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="agent-code-sidebar-filter">
      <SearchIcon size={12} className="agent-code-sidebar-filter-icon" />
      <input
        className="agent-code-sidebar-filter-input"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onChange(''); (e.target as HTMLInputElement).blur() } }}
      />
      {value && <button type="button" className="agent-code-sidebar-filter-clear" title="清除" onClick={() => onChange('')}><XIcon size={11} /></button>}
    </div>
  )
}

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

  // ── 视图本地状态：过滤词与行「⋯」菜单开合 ──
  // 只影响"渲染哪些行 / 菜单是否展开"，不触碰任何会话数据，故留在本组件，不上引到 hooks。
  // rowMenuId 存项目 id 或会话 id（全局唯一，两种行共用一套开合逻辑与同一个外点判定 ref）。
  const [filter, setFilter] = useState('')
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const rowMenuWrapRef = useRef<HTMLSpanElement | null>(null)
  // 切模式时清空过滤：两种列表的内容毫无关系，带着旧词切过去只会看到一片"无匹配"。
  useEffect(() => { setFilter('') }, [mode])
  // 菜单的外点 / Esc 关闭：触发按钮与菜单同在 .agent-code-proj-menu-wrap 内，点包内不自动收，
  // 交给按钮自己的 onClick 做 toggle（同 id 收起），否则会「关了又开」。
  useEffect(() => {
    if (!rowMenuId) return
    const close = (e: Event) => {
      if (e.type === 'keydown') {
        if ((e as KeyboardEvent).key === 'Escape') setRowMenuId(null)
        return
      }
      if (rowMenuWrapRef.current?.contains(e.target as Node)) return
      setRowMenuId(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [rowMenuId])

  const q = filter.trim().toLowerCase()
  const filteredChats = useMemo(
    () => (q ? chatSessions.filter(s => s.title.toLowerCase().includes(q)) : chatSessions),
    [chatSessions, q],
  )
  // 项目命中 → 整项目原样保留；项目名不中但旗下会话命中 → 只列命中的会话。
  // 过滤期间项目一律展开（收起态下过滤结果不可见，等于白滤）。
  const filteredProjects = useMemo(() => {
    if (!q) return codeProjects
    return codeProjects
      .map(p => (p.title.toLowerCase().includes(q) ? p : { ...p, sessions: p.sessions.filter(s => s.title.toLowerCase().includes(q)) }))
      .filter(p => p.title.toLowerCase().includes(q) || p.sessions.length > 0)
  }, [codeProjects, q])

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
            <SidebarFilter value={filter} onChange={setFilter} placeholder="搜索聊天…" />
            <div className="agent-code-sidebar-header">
              <span>聊天记录</span>
              <span className="agent-code-sidebar-count">{q ? `${filteredChats.length}/${chatSessions.length}` : chatSessions.length}</span>
            </div>
            <div className="agent-code-session-list agent-code-chat-list" role="listbox" aria-label="聊天记录">
              {filteredChats.map(s => {
                const ts = sessionLastActive(s)
                return (
                <div
                  key={s.id}
                  data-row
                  role="option"
                  aria-selected={s.id === activeSessionId}
                  tabIndex={0}
                  onKeyDown={listKeyNav}
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
                      {ts && <span className="agent-code-session-time" title={`最后活跃 ${new Date(ts).toLocaleString('zh-CN')}`}>{relTimeLabel(ts)}</span>}
                    </>
                  )}
                  {/* 会话操作收进「⋯」菜单（与项目行同款）：原先 fork + 导出/重命名/删除
                      四个图标并排，窄侧栏里整簇挤出行容器。转换/导出/重命名是日常项，
                      删除会话置于菜单底部危险区，与其余项以分隔线隔离。 */}
                  <span className={`agent-code-proj-menu-wrap agent-code-chat-menu-wrap${rowMenuId === s.id ? ' open' : ''}`} ref={rowMenuId === s.id ? el => { rowMenuWrapRef.current = el } : undefined}>
                    <button
                      type="button"
                      className="agent-code-proj-menu-btn"
                      title="会话操作"
                      aria-haspopup="menu"
                      aria-expanded={rowMenuId === s.id}
                      onClick={e => { e.stopPropagation(); setRowMenuId(v => v === s.id ? null : s.id) }}
                    ><EllipsisIcon size={13} /></button>
                    {rowMenuId === s.id && (
                      <ul className="agent-code-proj-menu" role="menu" onClick={e => e.stopPropagation()}>
                        {/* 单向转换：复制本聊天的上下文，新建一条编码会话；原聊天原样保留 */}
                        <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); forkChatToCode(s.id) }}>
                          <CodeIcon size={12} />转为编码会话
                        </li>
                        <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); exportSession(s.id) }}>
                          <DownloadIcon size={12} />导出会话
                        </li>
                        <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); startSessRename(s.id, s.title) }}>
                          <PencilIcon size={12} />重命名
                        </li>
                        <li role="separator" className="agent-code-proj-menu-sep" />
                        <li role="menuitem" className="agent-code-proj-menu-item danger" onClick={() => { setRowMenuId(null); deleteSession(CHAT_WORKSPACE_ID, s.id) }}>
                          <TrashIcon size={12} />删除会话
                        </li>
                      </ul>
                    )}
                  </span>
                </div>
                )
              })}
            </div>
            {filteredChats.length === 0 && (
              <div className="agent-code-chat-empty">{q ? '无匹配聊天。' : '还没有聊天，点上面「新建聊天」开始。'}</div>
            )}
          </>
        ) : (
          /* ── 编码模式：项目 → 会话树 ── */
          <>
            <TopbarBtn baseClass="agent-code-session-new-btn" icon={FolderOpenIcon} size={14} onClick={createProject}>新建项目</TopbarBtn>
            <SidebarFilter value={filter} onChange={setFilter} placeholder="搜索项目与会话…" />
            <div className="agent-code-sidebar-header"><span>项目</span></div>
            <div className="agent-code-session-list" role="listbox" aria-label="项目会话">
              {filteredProjects.map(p => {
                // 过滤态强制展开：命中的会话若藏在收起的项目下，过滤等于没发生
                const open = p.expanded || !!q
                return (
                <div key={p.id} className="agent-code-project-group">
                  <div
                    className={`agent-code-project-item ${p.id === activeProjectId ? 'active' : ''}`}
                    data-row
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onKeyDown={listKeyNav}
                    onClick={() => {
                      toggleProjectExpanded(p)
                      // 切到其他项目时必须同步会话指针：否则 activeSessionId 仍指向旧项目的会话，
                      // 界面靠 || sessions[0] 兜底显示正常，但 handleSend 用悬空 sid 写会话 = 消息静默丢失。
                      if (p.id !== activeProjectId) {
                        setActiveProjectId(p.id)
                        setActiveSessionId(p.sessions[0]?.id ?? '')
                      }
                    }}
                  >
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
                    {/* 项目操作收进「⋯」菜单（原先四个图标常驻一行：窄侧栏里挤，且删除与日常操作无隔离）。
                        删除项目置于菜单底部危险区，与其余三项之间加分隔线。 */}
                    <span className={`agent-code-proj-menu-wrap${rowMenuId === p.id ? ' open' : ''}`} ref={rowMenuId === p.id ? el => { rowMenuWrapRef.current = el } : undefined}>
                      <button
                        type="button"
                        className="agent-code-proj-menu-btn"
                        title="项目操作"
                        aria-haspopup="menu"
                        aria-expanded={rowMenuId === p.id}
                        onClick={e => { e.stopPropagation(); setRowMenuId(v => v === p.id ? null : p.id) }}
                      ><EllipsisIcon size={13} /></button>
                      {rowMenuId === p.id && (
                        <ul className="agent-code-proj-menu" role="menu" onClick={e => e.stopPropagation()}>
                          <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); addSessionToProject(p.id) }}>
                            <PlusIcon size={12} />新建会话
                          </li>
                          <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); importSessionToProject(p.id) }}>
                            <UploadIcon size={12} />导入会话
                          </li>
                          <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); changeProjectDir(p.id) }}>
                            <FolderOpenIcon size={12} />切换项目目录
                          </li>
                          <li role="separator" className="agent-code-proj-menu-sep" />
                          <li role="menuitem" className="agent-code-proj-menu-item danger" onClick={() => { setRowMenuId(null); deleteProject(p.id) }}>
                            <TrashIcon size={12} />删除项目
                          </li>
                        </ul>
                      )}
                    </span>
                  </div>
                  <div className={`agent-code-child-wrap ${open ? 'open' : ''}`} ref={el => { projectWrapRefs.current.set(p.id, el) }}>
                    <div className="agent-code-child-sessions">
                      {p.sessions.map(s => {
                        const ts = sessionLastActive(s)
                        return (
                        <div
                          key={s.id}
                          data-row
                          role="option"
                          aria-selected={s.id === activeSessionId && p.id === activeProjectId}
                          tabIndex={0}
                          onKeyDown={listKeyNav}
                          className={`agent-code-session-item ${s.id === activeSessionId && p.id === activeProjectId ? 'active' : ''}`}
                          onClick={() => { setActiveProjectId(p.id); setActiveSessionId(s.id) }}
                        >
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
                            <>
                              <span className="agent-code-session-title">{s.title}</span>
                              {ts && <span className="agent-code-session-time" title={`最后活跃 ${new Date(ts).toLocaleString('zh-CN')}`}>{relTimeLabel(ts)}</span>}
                            </>
                          )}
                          {sessionActions(p.id, s)}
                        </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
            {filteredProjects.length === 0 && (
              <div className="agent-code-chat-empty">{q ? '无匹配项目。' : '还没有项目，点上面「新建项目」开始。'}</div>
            )}
          </>
        )}
      </div>
  )
}
