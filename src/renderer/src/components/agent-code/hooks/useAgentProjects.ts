// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentProjects —— 工作区（项目）/ 会话的列表状态与增删改              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的项目会话域，逻辑与注释均未改动；本轮新增「工作区模式」。
//
// ── 模式模型（本轮重构的核心）──
// 模式（通用 / 编码）归属**工作区**，不归属会话：
//   · 编码模式 = 真实项目（有 workspaceDir），下挂编码会话；
//   · 通用模式 = 唯一一条「伪项目」（CHAT_WORKSPACE_ID，workspaceDir 恒为空），
//     下挂普通聊天会话。这样复用既有的 project → sessions 结构，不必另起平行数据结构。
// 因此「切模式」= 切当前模式的可见列表 + 把会话指针重置到该模式的空白会话
// （详见下方 switchMode 的注释：切模式回到该模式的初始界面，不自动进入上次的会话），
// **不改变任何会话对象**，通用聊天不会因为切到编码模式就变成编码上下文。
//
// 每模式独立维护的指针：activeIds = { code: {pid,sid}, chat: {pid,sid} }。
// 切模式重置会话指针、保留工作区指针（编码模式有多个项目时不会被重置）。
//
// 自持：projects（全量，含两种模式）、mode、activeIds、projectWrapRefs。
// 外部输入：仅 storedProjects（zustand 里持久化的列表，作为初始值）。
// 对外输出：projects / visibleProjects（当前模式可见）/ mode / switchMode、
//           活动工作区与会话指针及其派生对象、以及各增删改回调。
//
// 注意：projects 的「持久化到 store」与「从 store 水合」两个 effect 仍留在
// useAgentSessionEffects，通过本 hook 返回的 projects / setProjects 工作。

import { useCallback, useMemo, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { safeCall } from '../../../utils/safeCall'
import { uniqueId } from '../utils/ids'
import { dirName } from '../utils/paths'
import {
  CHAT_WORKSPACE_ID, freshChatWorkspace, isChatWorkspace, normalizeProjects, projectMode,
} from '../../../../../shared/types'
import type { AgentMode, AgentProject, AgentSession } from '../../../../../shared/types'

/** 每模式的活动指针（工作区 id + 会话 id） */
type ModePointers = Record<AgentMode, { pid: string; sid: string }>

export function useAgentProjects({ storedProjects }: {
  storedProjects: AgentProject[]
}) {
  // 默认占位项目使用固定哨兵 id，便于在用户创建真实项目后将其自动移除
  const DEFAULT_PROJECT_ID = '__agent_default_project__'
  function freshProject(name = '新项目'): AgentProject {
    return { id: DEFAULT_PROJECT_ID, title: name, workspaceDir: '', expanded: true, sessions: [], mode: 'code' }
  }
  // 判断是否为「尚未被使用」的空占位项目（未指定目录、无会话）
  function isPlaceholderProject(p: AgentProject): boolean {
    return p.id === DEFAULT_PROJECT_ID && !p.workspaceDir && p.sessions.length === 0
  }
  /** 新建会话：标题按模式区分，通用模式叫「新聊天」更像聊天历史 */
  function newSession(mode: AgentMode): AgentSession {
    return { id: uniqueId('sess'), title: mode === 'chat' ? '新聊天' : '新会话', messages: [] }
  }
  /** 保证通用工作区存在且至少有一条会话：通用模式切过去必须能直接开聊，不能是空列表 */
  function ensureChatWorkspace(list: AgentProject[]): AgentProject[] {
    const idx = list.findIndex(isChatWorkspace)
    if (idx < 0) return [...list, { ...freshChatWorkspace(), sessions: [newSession('chat')] }]
    const p = list[idx]!
    if (p.sessions.length > 0) return list
    const next = [...list]
    next[idx] = { ...p, sessions: [newSession('chat')] }
    return next
  }
  /** 初始列表：有真实存档就用迁移后的存档，否则给「编码占位项目 + 通用工作区」 */
  function initialProjects(stored: AgentProject[]): AgentProject[] {
    const hasReal = stored.some(p => p.sessions.length > 0 || p.workspaceDir)
    return ensureChatWorkspace(hasReal ? normalizeProjects(stored) : [freshProject('新项目')])
  }

  const [projects, setProjects] = useState<AgentProject[]>(() => initialProjects(storedProjects))

  // ── 当前模式 + 每模式独立的活动指针 ──
  const [mode, setMode] = useState<AgentMode>('code')
  const [activeIds, setActiveIds] = useState<ModePointers>(() => {
    const pick = (m: AgentMode) => {
      const p = projects.find(x => projectMode(x) === m)
      return { pid: p?.id ?? '', sid: p?.sessions[0]?.id ?? '' }
    }
    return { code: pick('code'), chat: pick('chat') }
  })

  /** 当前模式的可见工作区列表（通用模式只有那条伪项目；编码模式只有真实项目） */
  const visibleProjects = useMemo(() => {
    const list = projects.filter(p => projectMode(p) === mode)
    // 兜底：列表为空时给一个临时对象（状态层有 ensure，正常不会走到这里）
    return list.length > 0 ? list : [mode === 'chat' ? freshChatWorkspace() : freshProject('新项目')]
  }, [projects, mode])

  // 指针解析：一律回落到该模式列表的第一个，避免出现「指针指向已删除对象」的悬空组合
  // （旧实现直接透传 state，悬空时 handleSend 会把消息写进虚空）。
  const activeProject = visibleProjects.find(p => p.id === activeIds[mode].pid) ?? visibleProjects[0]!
  const activeSession = activeProject.sessions.find(s => s.id === activeIds[mode].sid) ?? activeProject.sessions[0] ?? null
  const activeProjectId = activeProject.id
  const activeSessionId = activeSession?.id ?? ''

  // 用 ref 持有当前模式：两个指针 setter 的身份因此恒定，下游 hook（loop / messageActions /
  // slashActions / 侧栏 / 布局）的依赖数组不必跟着模式变；同时它们永远写入「调用时刻」的
  // 模式槽，不会因为某个闭包创建于切换之前而把指针写进另一个模式的槽里。
  const modeRef = useRef(mode)
  modeRef.current = mode
  const setActiveProjectId = useCallback((v: string) => {
    const m = modeRef.current
    setActiveIds(prev => ({ ...prev, [m]: { ...prev[m], pid: v } }))
  }, [])
  const setActiveSessionId = useCallback((v: string) => {
    const m = modeRef.current
    setActiveIds(prev => ({ ...prev, [m]: { ...prev[m], sid: v } }))
  }, [])

  /** 切换工作区模式。
      ── 行为约定 ──
      切模式 = 回到该模式的「初始界面」（欢迎页），**不自动进入上次的会话**。
      上次的会话仍然留在侧栏里，用户主动点它才进去（见 AgentSessionSidebar 里的
      setActiveSessionId 调用点）。

      实现方式：把当前指针落到目标工作区里一条**空白会话**上；没有空白会话就新建一条。
      空白会话 ⇒ activeSession.messages 为空 ⇒ 布局侧 chatEmpty 为真 ⇒ 渲染欢迎页。
      复用已有的空白会话（而不是每次新建），避免来回切模式堆出一串「新聊天」。

      工作区本身仍沿用该模式上次活动的那个（编码模式有多个项目时不会被重置），
      只重置会话指针。指针同时也就完成了「悬空纠正」—— 写进去的 pid/sid 必然存在。 */
  const switchMode = useCallback((next: AgentMode) => {
    // 已经是该模式：什么都不做。
    // 否则点一下「当前模式」那个按钮，就会把用户正在看的会话顶掉、跳去空白新会话。
    // （想在同一模式里开新会话，请用侧栏的「新建聊天 / 新建会话」。）
    if (next === modeRef.current) return
    setMode(next)
    const list = projects.filter(p => projectMode(p) === next)
    const proj = list.find(p => p.id === activeIds[next].pid) ?? list[0]
    if (!proj) return
    const blank = proj.sessions.find(s => s.messages.length === 0)
    if (blank) {
      setActiveIds(prev => ({ ...prev, [next]: { pid: proj.id, sid: blank.id } }))
      return
    }
    const sess = newSession(next)
    setProjects(prev => prev.map(p => p.id === proj.id ? { ...p, sessions: [...p.sessions, sess] } : p))
    setActiveIds(prev => ({ ...prev, [next]: { pid: proj.id, sid: sess.id } }))
  }, [projects, activeIds])

  const updateProject = useCallback((id: string, upd: Partial<AgentProject>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...upd } : p))
  }, [])

  // 子会话收起/展开动画用的 wrap 元素（按项目 id 缓存；内容始终挂载，scrollHeight 随时可读）
  const projectWrapRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  /** 按真实内容高度切换项目展开态：收起从 scrollHeight 收缩、展开过渡到 scrollHeight 后清 none。
   * 解决固定 max-height:600px 时「内容瞬失 + 空白慢收」的卡顿感，且不再裁剪多会话目录。 */
  const toggleProjectExpanded = useCallback((p: AgentProject) => {
    const wrap = projectWrapRefs.current.get(p.id)
    if (wrap) {
      if (p.expanded) {
        // 收起：先固定到当前真实高度并强制回流，再过渡到 0
        wrap.style.maxHeight = `${wrap.scrollHeight}px`
        void wrap.offsetHeight
        wrap.style.maxHeight = '0px'
      } else {
        // 展开：从 0 过渡到真实高度，过渡结束后清 none（避免上限裁剪）
        wrap.style.maxHeight = '0px'
        void wrap.offsetHeight
        wrap.style.maxHeight = `${wrap.scrollHeight}px`
        const onEnd = () => { wrap.style.maxHeight = 'none'; wrap.removeEventListener('transitionend', onEnd) }
        wrap.addEventListener('transitionend', onEnd, { once: true })
      }
    }
    updateProject(p.id, { expanded: !p.expanded })
  }, [updateProject])

  const updateSessionInProject = useCallback((projId: string, sessId: string, upd: Partial<AgentSession>) => {
    setProjects(prev => prev.map(p => p.id === projId ? ({ ...p, sessions: p.sessions.map(s => s.id === sessId ? { ...s, ...upd } : s) }) : p))
  }, [])

  const createProject = useCallback(async () => {
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return
    const name = dirName(res.path)
    const proj: AgentProject = { id: uniqueId('proj'), title: name, workspaceDir: res.path, expanded: true, sessions: [newSession('code')], mode: 'code' }
    // 创建真实项目后，自动移除仍处于空状态的默认占位项目（避免与新建项目并存）
    setProjects(prev => [...prev.filter(p => !isPlaceholderProject(p)), proj])
    setActiveIds(prev => ({ ...prev, code: { pid: proj.id, sid: proj.sessions[0]!.id } }))
  }, [])

  const deleteProject = useCallback((id: string) => {
    const target = projects.find(p => p.id === id)
    if (!target) return
    // 通用工作区不允许删除：它是通用模式唯一的容器，删了那个模式就没有列表了
    if (isChatWorkspace(target)) return
    const targetMode = projectMode(target)
    // 性能优化：提前计算删除后的结果，一次性更新所有状态，减少中间渲染
    const next = projects.filter(p => p.id !== id)
    // 每个模式都必须至少留一个工作区，否则切过去会是空列表
    if (!next.some(p => projectMode(p) === targetMode)) {
      next.push(targetMode === 'chat'
        ? { ...freshChatWorkspace(), sessions: [newSession('chat')] }
        : freshProject('新项目'))
    }
    setProjects(next)
    // 删掉的是该模式的活动工作区时，指针落到该模式的第一个工作区
    if (activeIds[targetMode].pid === id) {
      const fallback = next.find(p => projectMode(p) === targetMode)!
      setActiveIds(prev => ({ ...prev, [targetMode]: { pid: fallback.id, sid: fallback.sessions[0]?.id ?? '' } }))
    }
  }, [projects, activeIds])

  const exportSession = useCallback(async (sessId: string) => {
    try {
      const res = await window.api.exportAgentSession(sessId)
      if (res.canceled) return
      if (!res.success) { notify('导出失败：' + (res.error || '未知错误'), 'error'); return }
      notify('会话已导出', 'success')
    } catch (e) {
      notify('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }, [])

  const importSessionToProject = useCallback(async (projId: string) => {
    try {
      const res = await window.api.importAgentSession(projId)
      if (res.canceled) return
      if (!res.success || !res.session) { notify('导入失败：' + (res.error || '未知错误'), 'error'); return }
      const sess = res.session
      const proj = projects.find(p => p.id === projId)
      const projMode = projectMode(proj)
      setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
      setActiveIds(prev => ({ ...prev, [projMode]: { pid: projId, sid: sess.id } }))
      notify('会话已导入', 'success')
    } catch (e) {
      notify('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }, [projects])

  const addSessionToProject = useCallback((projId: string) => {
    const proj = projects.find(p => p.id === projId)
    if (!proj) return
    const projMode = projectMode(proj)
    const sess = newSession(projMode)
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
    // 在非活动项目上新建会话时同步切换项目：否则会话指针指向另一项目的会话（悬空组合）。
    setActiveIds(prev => ({ ...prev, [projMode]: { pid: projId, sid: sess.id } }))
  }, [projects])

  /** 在通用工作区新建一条会话并切过去（外部「纯聊天」请求 / 侧栏新建都用它）。
      会一并切到通用模式——新会话属于通用工作区，留在编码模式会看不到它。 */
  const openNewChatSession = useCallback((title?: string) => {
    // 先生成会话对象再写入：这样 pid/sid 一定是同一份数据，不会出现指针错位
    const sess: AgentSession = { id: uniqueId('sess'), title: title || '新聊天', messages: [] }
    setProjects(prev => {
      const idx = prev.findIndex(isChatWorkspace)
      if (idx < 0) return [...prev, { ...freshChatWorkspace(), sessions: [sess] }]
      const next = [...prev]
      next[idx] = { ...prev[idx]!, sessions: [...prev[idx]!.sessions, sess] }
      return next
    })
    setActiveIds(prev => ({ ...prev, chat: { pid: CHAT_WORKSPACE_ID, sid: sess.id } }))
    setMode('chat')
    return sess.id
  }, [])

  /** 在当前模式的默认工作区里新建一条会话（通用模式 → 通用工作区；编码模式 → 活动项目）。
      侧栏的「新建」按钮走这条，保证新会话永远归属当前模式。 */
  const createSessionInCurrentMode = useCallback(() => {
    if (mode === 'chat') { openNewChatSession(); return }
    addSessionToProject(activeProjectId)
  }, [mode, openNewChatSession, addSessionToProject, activeProjectId])

  const deleteSession = useCallback((projId: string, sessId: string) => {
    // 同 deleteProject：先算出删除后的会话列表，指针只能指向真实存在的会话，
    // 避免 fallback 会话未插入时指针悬空导致消息写进虚空。
    const proj = projects.find(p => p.id === projId)
    if (!proj) return
    const projMode = projectMode(proj)
    let next = proj.sessions.filter(s => s.id !== sessId)
    if (next.length === 0) next = [newSession(projMode)]
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: next } : p))
    if (activeIds[projMode].sid === sessId) {
      setActiveIds(prev => ({ ...prev, [projMode]: { ...prev[projMode], sid: next[0]!.id } }))
    }
  }, [projects, activeIds])

  /** ── 「基于此聊天新建编码会话」──
      把通用会话的上下文复制到一个**新建的编码项目**里，原聊天保持不变。
      这是两种模式之间唯一的单向通道：通用 → 编码，且只复制、不迁移。
      目标目录由用户现场选择；若已有项目使用同一目录则直接复用该项目。 */
  const forkChatToCode = useCallback(async (chatSessId: string) => {
    const chatWs = projects.find(isChatWorkspace)
    const src = chatWs?.sessions.find(s => s.id === chatSessId)
    if (!src) { notify('找不到要转换的聊天', 'error'); return null }
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return null
    const dir = res.path
    // 复制上下文：消息逐条浅拷贝（toolCalls / attachments 一并带上），压缩摘要也带上
    const copied = src.messages.map(m => ({ ...m }))
    const sess: AgentSession = {
      id: uniqueId('sess'),
      title: `${src.title}（编码）`,
      messages: copied,
      ...(src.memory ? { memory: { ...src.memory, coveredMsgIds: [...src.memory.coveredMsgIds] } } : {}),
    }
    const existing = projects.find(p => !isChatWorkspace(p) && p.workspaceDir === dir)
    let pid: string
    if (existing) {
      pid = existing.id
      setProjects(prev => prev.map(p => p.id === existing.id ? { ...p, sessions: [...p.sessions, sess] } : p))
    } else {
      const proj: AgentProject = {
        id: uniqueId('proj'), title: dirName(dir), workspaceDir: dir,
        expanded: true, sessions: [sess], mode: 'code',
      }
      pid = proj.id
      setProjects(prev => [...prev.filter(p => !isPlaceholderProject(p)), proj])
    }
    setActiveIds(prev => ({ ...prev, code: { pid, sid: sess.id } }))
    setMode('code')
    notify(`已基于该聊天新建编码会话（${copied.length} 条上下文已复制）`, 'success')
    return { pid, sid: sess.id }
  }, [projects])

  /** 用磁盘存档替换内存列表（仅启动播种时调用一次）：归一化后**按模式重建两个活动指针**。
      不能沿用 setProjects + setActiveProjectId 那套：那两个 setter 只写「当前模式」的槽，
      启动时当前模式固定是 code，通用模式的指针就播不进去。 */
  const hydrateProjects = useCallback((stored: AgentProject[]) => {
    const next = ensureChatWorkspace(normalizeProjects(stored))
    setProjects(next)
    const pick = (m: AgentMode) => {
      const p = next.find(x => projectMode(x) === m)
      return { pid: p?.id ?? '', sid: p?.sessions[0]?.id ?? '' }
    }
    setActiveIds({ code: pick('code'), chat: pick('chat') })
  }, [])

  /** 通用工作区（伪项目）；不存在时返回 null（状态层有 ensure，正常必有） */
  const chatWorkspace = useMemo(() => projects.find(isChatWorkspace) ?? null, [projects])
  /** 编码项目（真实工作区） */
  const codeProjects = useMemo(() => projects.filter(p => !isChatWorkspace(p)), [projects])

  return {
    projects, setProjects, visibleProjects, chatWorkspace, codeProjects,
    mode, switchMode, hydrateProjects,
    activeProjectId, setActiveProjectId,
    activeSessionId, setActiveSessionId, activeProject, activeSession,
    updateProject, projectWrapRefs, toggleProjectExpanded, updateSessionInProject,
    createProject, deleteProject, exportSession, importSessionToProject,
    addSessionToProject, createSessionInCurrentMode, openNewChatSession, deleteSession,
    forkChatToCode,
  }
}
