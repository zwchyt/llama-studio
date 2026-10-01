// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentSessionSidebar —— 「对话 / 工作台」的项目目录与会话列表            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 渲染位置：经 portal 挂进应用左侧导航栏底部的槽位（AGENT_SESSION_SLOT_ID），
// 状态与回调仍由 AgentCodeView 持有，本组件依旧是受控视图。
//
// 模式（通用 / 编码）归属**工作区**，不归属会话：
//   · 编码模式 = 真实项目（有 workspaceDir），下挂编码会话；
//   · 通用模式 = 唯一一条「伪项目」（CHAT_WORKSPACE_ID，workspaceDir 恒为空），
//     下挂普通聊天会话。这样复用既有的 project → sessions 结构，不必另起平行数据结构。
// 切换入口已升到导航栏的「对话 / 工作台」两项（原来的分段控件删除），本组件只按 mode
// 决定下方渲染哪一份列表。
//
// 说明：过滤词与项目「⋯」菜单开合是纯视图本地的交互状态（只决定渲染哪些行），留在本组件。

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpenIcon, FolderIcon, TrashIcon, UploadIcon, PlusIcon, DownloadIcon, PencilIcon, CodeIcon, EllipsisIcon, MessageSquareIcon, MessageSquarePlusIcon, SearchIcon, XIcon } from '@animateicons/react/lucide'
import { TopbarBtn } from '../agent-message'
import { CHAT_WORKSPACE_ID } from '../../../../../shared/types'
import type { AgentMode, AgentProject, AgentSession } from '../../../../../shared/types'

/** 应用左侧导航栏底部那个槽的 DOM id：AgentCodeViewLayout 把本组件 portal 到这里，
 *  Sidebar.tsx 负责渲染这个空槽。 */
export const AGENT_SESSION_SLOT_ID = 'sidebar-agent-slot'

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

/** 列表排序：按最后活跃倒序（最新的在最上面）。时间解析不出来的（外部导入的 id 格式）
 *  按最旧处理，落到列表底部，不与真实活跃时间抢位置。 */
function byLastActiveDesc(a: AgentSession, b: AgentSession): number {
  return (sessionLastActive(b) ?? -Infinity) - (sessionLastActive(a) ?? -Infinity)
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
  /** 当前工作区模式：决定下方渲染聊天列表还是项目树（切换入口在导航栏） */
  mode: AgentMode
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
  mode, chatSessions, codeProjects,
  activeProjectId, activeSessionId, setActiveProjectId, setActiveSessionId,
  createSessionInCurrentMode, forkChatToCode,
  projectWrapRefs, createProject, toggleProjectExpanded, changeProjectDir, deleteProject,
  importSessionToProject, addSessionToProject, exportSession, deleteSession,
  projRenamingId, setProjRenamingId, projRenameText, setProjRenameText, projRenameInputRef, confirmProjRename,
  sessRenamingId, setSessRenamingId, sessRenameText, setSessRenameText, sessRenameInputRef,
  startSessRename, confirmSessRename,
}: AgentSessionSidebarProps) {
  // ── 视图本地状态：过滤词与行「⋯」菜单开合 ──
  // 只影响"渲染哪些行 / 菜单是否展开"，不触碰任何会话数据，故留在本组件，不上引到 hooks。
  // rowMenuId 存项目 id 或会话 id（全局唯一，两种行共用一套开合逻辑与同一个外点判定 ref）。
  const [filter, setFilter] = useState('')
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const rowMenuWrapRef = useRef<HTMLSpanElement | null>(null)
  // 两种模式的列表容器共用一个 ref（同一时刻只渲染其中一个），供下面「把活动会话滚进视野」用
  const listRef = useRef<HTMLDivElement | null>(null)
  const revealRow = (sid: string): void => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-sess-id]') ?? [])
    rows.find(el => el.getAttribute('data-sess-id') === sid)?.scrollIntoView({ block: 'nearest' })
  }
  // 冷启动 / 切模式 / 切换会话后把活动会话露出来一次：编码模式下它藏在收起的项目里就展开那个项目，
  // 再把行滚到视野内。按会话 id 记账只处理一次，之后用户自己收起或滚动都不再干预。
  const revealedRef = useRef<string | null>(null)
  useEffect(() => {
    const sid = activeSessionId
    if (!sid || revealedRef.current === sid) return
    if (mode === 'code') {
      const proj = codeProjects.find(p => p.sessions.some(s => s.id === sid))
      // 只处理当前活动项目：给别的项目改展开态会写进持久化，属于越权
      if (!proj || proj.id !== activeProjectId) return
      revealedRef.current = sid
      if (!proj.expanded) {
        toggleProjectExpanded(proj)
        // 展开是 .26s 的高度过渡，过渡中容器还没把行铺开，滚了也算不准 —— 等它结束再滚
        const wrap = projectWrapRefs.current.get(proj.id)
        if (wrap) wrap.addEventListener('transitionend', () => revealRow(sid), { once: true })
        else revealRow(sid)
        return
      }
    }
    revealedRef.current = sid
    requestAnimationFrame(() => revealRow(sid))
  }, [mode, activeSessionId, activeProjectId, codeProjects, projectWrapRefs, toggleProjectExpanded])
  /** 会话行右侧操作：与项目行/聊天行同款的「⋯」菜单（原先三个图标常驻一行，窄侧栏里挤，
   *  且删除与日常操作没有隔离）。删除收进菜单底部危险区，上方加分隔线。 */
  const sessionActions = (projId: string, s: AgentSession) => (
    <span className={`agent-code-proj-menu-wrap${rowMenuId === s.id ? ' open' : ''}`} ref={rowMenuId === s.id ? el => { rowMenuWrapRef.current = el } : undefined}>
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
          <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); exportSession(s.id) }}>
            <DownloadIcon size={12} />导出会话
          </li>
          <li role="menuitem" className="agent-code-proj-menu-item" onClick={() => { setRowMenuId(null); startSessRename(s.id, s.title) }}>
            <PencilIcon size={12} />重命名
          </li>
          <li role="separator" className="agent-code-proj-menu-sep" />
          <li role="menuitem" className="agent-code-proj-menu-item danger" onClick={() => { setRowMenuId(null); deleteSession(projId, s.id) }}>
            <TrashIcon size={12} />删除会话
          </li>
        </ul>
      )}
    </span>
  )
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
    () => [...(q ? chatSessions.filter(s => s.title.toLowerCase().includes(q)) : chatSessions)].sort(byLastActiveDesc),
    [chatSessions, q],
  )
  // 项目命中 → 整项目全列；项目名不中但旗下会话命中 → 只列命中的会话。
  // 过滤期间项目一律展开（收起态下过滤结果不可见，等于白滤）。
  const filteredProjects = useMemo(() => {
    const hit = (p: AgentProject) => p.title.toLowerCase().includes(q)
    return codeProjects
      .map(p => {
        const list = !q || hit(p) ? p.sessions : p.sessions.filter(s => s.title.toLowerCase().includes(q))
        return { ...p, sessions: [...list].sort(byLastActiveDesc) }
      })
      .filter(p => !q || hit(p) || p.sessions.length > 0)
  }, [codeProjects, q])

  return (
      <div className="agent-code-sidebar">
        {mode === 'chat' ? (
          /* ── 通用模式：轻量聊天历史，没有项目层级 ── */
          <>
            <TopbarBtn baseClass="agent-code-session-new-btn" icon={MessageSquarePlusIcon} size={14} onClick={createSessionInCurrentMode}>新建聊天</TopbarBtn>
            <SidebarFilter value={filter} onChange={setFilter} placeholder="搜索聊天…" />
            <div className="agent-code-sidebar-header">
              <span>聊天记录</span>
              <span className="agent-code-sidebar-count">{q ? `${filteredChats.length}/${chatSessions.length}` : chatSessions.length}</span>
            </div>
            <div className="agent-code-session-list agent-code-chat-list" role="listbox" aria-label="聊天记录" ref={listRef}>
              {filteredChats.map(s => {
                const ts = sessionLastActive(s)
                return (
                <div
                  key={s.id}
                  data-row
                  data-sess-id={s.id}
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
            <div className="agent-code-session-list" role="listbox" aria-label="项目会话" ref={listRef}>
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
                  {/* menu-open：会话行的「⋯」弹窗在这个折叠容器里，容器的 overflow:hidden 会把它裁掉，
                      所以菜单开着的时候临时解除裁剪（只对本已展开的项目生效，收起状态下解除会让隐形行漏出来接点击） */}
                  <div className={`agent-code-child-wrap ${open ? 'open' : ''}${open && rowMenuId ? ' menu-open' : ''}`} ref={el => { projectWrapRefs.current.set(p.id, el) }}>
                    <div className="agent-code-child-sessions">
                      {p.sessions.map(s => {
                        const ts = sessionLastActive(s)
                        return (
                        <div
                          key={s.id}
                          data-row
                          data-sess-id={s.id}
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
