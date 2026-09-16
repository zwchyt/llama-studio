// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentSessionEffects —— 会话生命周期、工作区同步与记忆沉淀             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的九段 effect 与 refreshTasks（逻辑与注释未变）：
//   1. 项目列表持久化（跳过纯占位项目，防止干扰播种逻辑）
//   2. 启动播种：store 从磁盘载入历史项目后同步本地状态（仅一次）
//   3. pi 引擎：切换会话时释放旧 pi session（下次进入自动重建并注入历史）
//   4. refreshTasks：从后端拉取会话任务列表回写 currentPlanItems
//   5. 会话切换重置：请求计数 / 累计 token / 计划标题 / 计划项 / 滚动跟随
//   6. 工作区同步：setWorkspaceRootForSession + 主进程工作区根 + 认知地图构建
//   7. 里程碑写：Todo 计划全部收束时沉淀一条决策记录（归属校验 + 指纹防重）
//   8. 会话终局写：切换会话 / 项目时对旧会话做机械提炼沉淀
//   9. pi SDK 运行时预热（与启动拥堵窗口错峰）
//
// 自持私有 ref：seededRef / lastWorkspaceSetRef / lastCodeMapBuiltRef /
// planItemsSidRef / milestoneNotedRef / prevSessionRef / refreshTasksRef。
//
// 依赖注入采用「整域透传」：projects / run / ui / scroll 直接传各 hook 的返回值，
// 成员增删时本文件无需改动。注意 resetFollow 来自 scroll 域，故本 hook 须在
// useAgentScroll 之后调用。

import { useCallback, useEffect, useRef } from 'react'
import { agentConfig } from '../../../utils/agentConfig'
import { noteMilestone, noteSessionEnd } from '../../../utils/memoryWriter'
import { setWorkspaceRootForSession } from '../../../tools/workspaceRoot'
import { setAgentSessionId } from '../../../tools/agentSession'
import type { AgentProject, TodoUpdate } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'
import type { useAgentRunState } from './useAgentRunState'
import type { useAgentUiState } from './useAgentUiState'
import type { useAgentScroll } from './useAgentScroll'

export function useAgentSessionEffects({
  storedProjects, setAgentProjects, projects: projectsDomain, run, ui, scroll,
}: {
  storedProjects: AgentProject[]
  setAgentProjects: (projects: AgentProject[]) => void
  projects: ReturnType<typeof useAgentProjects>
  run: ReturnType<typeof useAgentRunState>
  ui: ReturnType<typeof useAgentUiState>
  scroll: ReturnType<typeof useAgentScroll>
}) {
  const {
    projects, setProjects, setActiveProjectId, setActiveSessionId,
    activeProject, activeProjectId, activeSessionId,
  } = projectsDomain
  const { piReadyRef } = run
  const {
    currentPlanItems, setCurrentPlanItems, planTitle,
    setReqCount, setCumTokens, setPlanTitle,
  } = ui
  const { resetFollow } = scroll

  // ── 私有 ref ──
  const seededRef = useRef(false)
  const lastWorkspaceSetRef = useRef<string>('')
  const lastCodeMapBuiltRef = useRef<string>('')
  // 记录这批计划项的归属会话（里程碑沉淀防串写用）
  const planItemsSidRef = useRef('')
  // 已沉淀过的收束状态指纹（同一份状态只沉淀一次）
  const milestoneNotedRef = useRef('')
  const prevSessionRef = useRef<{ pid: string; sid: string; dir: string } | null>(null)

  // Persist to store on every change（跳过纯占位项目，防止干扰 seededRef 逻辑）
  useEffect(() => {
    const hasRealContent = projects.some(p => p.sessions.length > 0 || p.workspaceDir)
    if (hasRealContent) {
      setAgentProjects(projects)
    } else {
      setAgentProjects([])
    }
  }, [projects, setAgentProjects])

  // 应用启动后，store 从磁盘载入历史项目时，把本地状态同步为已持久化的内容（仅一次）
  useEffect(() => {
    if (seededRef.current) return
    if (storedProjects.length > 0) {
      // 仅当 loaded 数据含实际内容时才应用 + 加锁，避免空占位项目提前锁死
      const hasReal = storedProjects.some(p => p.sessions.length > 0 || p.workspaceDir)
      if (!hasReal) return
      setProjects(storedProjects)
      setActiveProjectId(storedProjects[0]!.id)
      setActiveSessionId(storedProjects[0]!.sessions[0]?.id || '')
      seededRef.current = true
    }
  }, [storedProjects])

  // ── pi 引擎：切换会话时释放旧 pi session（下次进入自动重建并注入历史）──
  useEffect(() => {
    const prev = piReadyRef.current
    if (prev.ready && prev.sid !== activeSessionId) {
      window.api.piAgent.dispose(`pi-${prev.sid}`).catch(() => { })
      piReadyRef.current = { sid: '', ready: false }
    }
  }, [activeSessionId])

  const refreshTasks = useCallback(async () => {
    if (!activeSessionId) { setCurrentPlanItems([]); return }
    try {
      const res = await window.api.agentTaskList(activeSessionId)
      if (res.success) {
        // 修复①：后端持久化状态为权威来源，回写 currentPlanItems，
        // 使卡片渲染真实状态，而非仅依赖流式解析的临时快照。
        planItemsSidRef.current = activeSessionId // 记录这批计划项的归属会话（里程碑沉淀防串写用）
        setCurrentPlanItems(res.tasks
          .filter(t => t.status !== 'deleted')
          .map((t): TodoUpdate => ({
            id: t.id,
            content: t.subject,
            description: t.description,
            status: t.status as TodoUpdate['status'],
            priority: t.priority,
            activeForm: t.activeForm,
            notes: t.notes,
          })))
      }
    } catch { /* 忽略：面板刷新失败不影响对话 */ }
  }, [activeSessionId])

  // 始终持有最新的 refreshTasks，避免 send 闭包使用过期引用
  const refreshTasksRef = useRef(refreshTasks)
  refreshTasksRef.current = refreshTasks

  useEffect(() => {
    setReqCount(0)
    setCumTokens(0)
    setPlanTitle('')
    // 修复②：切换会话时清空计划项，避免上一个会话的待办残留显示在新会话
    planItemsSidRef.current = '' // 计划项已清空，无归属会话；待 refreshTasks 回写后重新登记
    setCurrentPlanItems([])
    resetFollow()
  }, [activeSessionId, resetFollow])

  useEffect(() => {
    const dir = activeProject.workspaceDir || ''
    const sid = activeSessionId
    // 性能优化：只在工作区+会话真正变化时才同步，避免删除项目时重复触发
    const key = `${sid}|${dir}`
    if (lastWorkspaceSetRef.current === key) return
    lastWorkspaceSetRef.current = key

    setWorkspaceRootForSession(sid, dir)
    // 工作区根同步给主进程（Read/Write 等文件工具的相对路径解析基准）。
    // Bash 已改用 pi 原生实现、cwd 固定为创建时工作区根，无需再同步 bash cwd。
    window.api?.setAgentWorkspace(dir).catch(() => { })
    // ── 认知地图：工作区变化时才构建（幂等；主进程内部有快照增量校验）──
    if (agentConfig.codeMapEnabled && dir) {
      if (lastCodeMapBuiltRef.current !== dir) {
        lastCodeMapBuiltRef.current = dir
        window.api?.codemapBuild?.(dir).catch(() => { })
      }
    }
  }, [activeProject.workspaceDir, activeSessionId])

  // ── 里程碑写（阶段 2.3）：Todo 计划全部收束（completed/cancelled 且至少一项完成）
  // 时沉淀一条决策记录。两层防护：
  //  · 归属校验：切换会话的瞬时渲染里 currentPlanItems 还是旧会话的（清空 setState
  //    下一轮才生效），若不校验会把旧计划写进新项目的记忆库；
  //  · 指纹防重：refreshTasks 每次回写新数组引用都会重触发 effect，存储侧合并虽
  //    不重复建条但每次 +0.05 置信度，反复触发会把 agent 条目虚推到 1.0，
  //    同一份收束状态（会话+条目+状态指纹）只沉淀一次。
  useEffect(() => {
    if (!agentConfig.longTermMemoryEnabled || currentPlanItems.length === 0) return
    if (planItemsSidRef.current !== activeSessionId) return // 计划项尚属另一会话的陈旧渲染，不沉淀
    const allSettled = currentPlanItems.every(t => t.status === 'completed' || t.status === 'cancelled')
    const anyDone = currentPlanItems.some(t => t.status === 'completed')
    if (allSettled && anyDone && activeProject.workspaceDir) {
      const fp = `${activeSessionId}|${currentPlanItems.map(t => `${t.id}:${t.status}`).join(',')}`
      if (milestoneNotedRef.current === fp) return
      milestoneNotedRef.current = fp
      noteMilestone(activeProject.workspaceDir, activeSessionId, planTitle, currentPlanItems)
    }
  }, [currentPlanItems, planTitle, activeProject.workspaceDir, activeSessionId])

  // ── 会话终局写（阶段 2.3）：切换会话 / 项目时对旧会话做机械提炼沉淀。
  // projects 在依赖中仅为取最新快照；未切换时（pid/sid 未变）直接早退，不重复沉淀。
  useEffect(() => {
    const prev = prevSessionRef.current
    prevSessionRef.current = { pid: activeProjectId, sid: activeSessionId, dir: activeProject.workspaceDir || '' }
    if (!agentConfig.longTermMemoryEnabled || !prev?.dir) return
    if (prev.pid === activeProjectId && prev.sid === activeSessionId) return
    const oldProj = projects.find(p => p.id === prev.pid)
    const oldSess = oldProj?.sessions.find(s => s.id === prev.sid)
    if (oldSess) noteSessionEnd(prev.dir, prev.sid, oldSess.title, oldSess.messages)
  }, [activeProjectId, activeSessionId, activeProject.workspaceDir, projects])

  useEffect(() => {
    setAgentSessionId(activeSessionId)
    refreshTasks()
  }, [activeSessionId, refreshTasks])

  // 进入 Agent Code 界面即预热 pi SDK 运行时（提前加载 pi 系 ESM 模块 + ModelRuntime，
  // 首次对话免一次性初始化等待）。失败静默：正常创建路径会重新初始化。
  // 注意：pi 包动态 import 的模块求值会同步阻塞 main 进程事件循环（实测约 1.1s，冷机更久），
  // 必须与启动拥堵窗口错峰：等浏览器空闲（requestIdleCallback）且至少 15s 后才执行——
  // 启动初期主进程正忙于首屏 IPC / Defender 磁盘扫描，此时插入同步阻塞会造成整窗"未响应"。
  useEffect(() => {
    const warm = (): void => {
      window.api?.piAgent?.warmup?.().catch(() => { })
    }
    let idleId: number | undefined
    const t = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(warm, { timeout: 20000 })
      else warm()
    }, 15000)
    return () => {
      clearTimeout(t)
      if (idleId !== undefined) cancelIdleCallback(idleId)
    }
  }, [])

  return { refreshTasks, refreshTasksRef, planItemsSidRef }
}
