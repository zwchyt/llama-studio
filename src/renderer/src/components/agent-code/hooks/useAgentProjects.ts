// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentProjects —— 项目 / 会话的列表状态与增删改                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的项目会话域（DEFAULT_PROJECT_ID / freshProject /
// isPlaceholderProject / projects 状态 / 活动指针 / 派生对象 / 增删改回调），
// 逻辑与注释均未改动。
//
// 自持：projects、activeProjectId、activeSessionId 三个 state，以及
//       projectWrapRefs（会话树展开动画的元素缓存）。
// 外部输入：仅 storedProjects（zustand 里持久化的项目列表，作为初始值）。
// 对外输出：projects 及其 setter、活动项目/会话指针与派生对象、以及
//           updateProject / toggleProjectExpanded / updateSessionInProject /
//           createProject / deleteProject / exportSession / importSessionToProject /
//           addSessionToProject / deleteSession。
//
// 注意：projects 的「持久化到 store」与「从 store 水合」两个 effect 仍留在
// AgentCodeView（它们同时依赖 seededRef 等会话初始化标志），通过本 hook 返回的
// projects / setProjects / setActiveProjectId / setActiveSessionId 工作。

import { useCallback, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { safeCall } from '../../../utils/safeCall'
import { uniqueId } from '../utils/ids'
import { dirName } from '../utils/paths'
import type { AgentProject, AgentSession } from '../../../../../shared/types'

export function useAgentProjects({ storedProjects }: {
  storedProjects: AgentProject[]
}) {
  // 默认占位项目使用固定哨兵 id，便于在用户创建真实项目后将其自动移除
  const DEFAULT_PROJECT_ID = '__agent_default_project__'
  function freshProject(name = '新项目'): AgentProject {
    return { id: DEFAULT_PROJECT_ID, title: name, workspaceDir: '', expanded: true, sessions: [] }
  }
  // 判断是否为「尚未被使用」的空占位项目（未指定目录、无会话）
  function isPlaceholderProject(p: AgentProject): boolean {
    return p.id === DEFAULT_PROJECT_ID && !p.workspaceDir && p.sessions.length === 0
  }

  const [projects, setProjects] = useState<AgentProject[]>(() =>
    storedProjects.length > 0 ? storedProjects : [freshProject('新项目')]
  )


  const [activeProjectId, setActiveProjectId] = useState(projects[0]!.id)
  const [activeSessionId, setActiveSessionId] = useState(projects[0]!.sessions[0]?.id || '')


  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0]!
  const activeSession = activeProject.sessions.find(s => s.id === activeSessionId) || activeProject.sessions[0] || null


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
    setProjects(prev => prev.map(p => p.id === projId ? ({ ...p, sessions: p.sessions.map(s => s.id === sessId ? ({ ...s, ...upd }) : s) }) : p))
  }, [])


  const createProject = useCallback(async () => {
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return
    const name = dirName(res.path)
    const proj: AgentProject = { id: uniqueId('proj'), title: name, workspaceDir: res.path, expanded: true, sessions: [{ id: uniqueId('sess'), title: '新会话', messages: [] }] }
    // 创建真实项目后，自动移除仍处于空状态的默认占位项目（避免与新建项目并存）
    setProjects(prev => [...prev.filter(p => !isPlaceholderProject(p)), proj])
    setActiveProjectId(proj.id)
    setActiveSessionId(proj.sessions[0]!.id)
  }, [])

  const deleteProject = useCallback((id: string) => {
    // 性能优化：提前计算删除后的结果，一次性更新所有状态，减少中间渲染
    const next = projects.filter(p => p.id !== id)
    const result = next.length === 0 ? [freshProject('新项目')] : next

    // 提前计算新的活动指针（在 setState 之前）
    let newActiveId = activeProjectId
    let newSessionId = activeSessionId
    if (activeProjectId === id) {
      const fallback = result[0]!
      newActiveId = fallback.id
      newSessionId = fallback.sessions[0]?.id ?? ''
    }

    // 批量更新：先更新项目列表，再按需更新活动指针
    setProjects(result)
    if (activeProjectId === id) {
      setActiveProjectId(newActiveId)
      setActiveSessionId(newSessionId)
    }
  }, [projects, activeProjectId, activeSessionId])

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
      setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
      setActiveProjectId(projId)
      setActiveSessionId(sess.id)
      notify('会话已导入', 'success')
    } catch (e) {
      notify('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }, [setProjects, setActiveProjectId, setActiveSessionId])

  const addSessionToProject = useCallback((projId: string) => {
    const sess: AgentSession = { id: uniqueId('sess'), title: '新会话', messages: [] }
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
    // 在非活动项目上新建会话时同步切换项目：否则会话指针指向另一项目的会话（悬空组合）。
    setActiveProjectId(projId)
    setActiveSessionId(sess.id)
  }, [])

  const deleteSession = useCallback((projId: string, sessId: string) => {
    // 同 deleteProject：先算出删除后的会话列表，activeSessionId 只能指向真实存在的会话，
    // 避免 fallback 会话未插入时指针悬空导致消息写进虚空。
    const proj = projects.find(p => p.id === projId)
    if (!proj) return
    let next = proj.sessions.filter(s => s.id !== sessId)
    if (next.length === 0) next = [{ id: uniqueId('sess'), title: '新会话', messages: [] }]
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: next } : p))
    if (activeSessionId === sessId) setActiveSessionId(next[0]!.id)
  }, [projects, activeSessionId])

  return {
    projects, setProjects, activeProjectId, setActiveProjectId,
    activeSessionId, setActiveSessionId, activeProject, activeSession,
    updateProject, projectWrapRefs, toggleProjectExpanded, updateSessionInProject,
    createProject, deleteProject, exportSession, importSessionToProject,
    addSessionToProject, deleteSession,
  }
}
