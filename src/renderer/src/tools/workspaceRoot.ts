// 当前 Agent 工作台活动会话的「工作区根目录」注册表。
//
// 设计为「按会话 id 绑定」而非全局单例：每个会话独立保存自己的 workspaceRoot，
// 工具执行时按当前会话 id 取根。这样即使界面在多个项目/会话间切换，
// 某条工具调用仍能解析到它所属会话的正确根目录，避免旧实现里
// 「全局单根被最后激活的项目覆盖 → 工具读到错误目录」的竞态（曾导致
// 分析目录时误读无关大文件、异常撑爆上下文）。
//
// 与 agentSession.ts 同构（均以 sessionId 为键）。工具内部通过
// getWorkspaceRootForSession(getAgentSessionId()) 解析根，无需层层传参。
import { getAgentSessionId } from './agentSession'

const rootsBySession = new Map<string, string>()

/** 为某个会话设置工作区根目录（通常在该会话成为活动时由 AgentCodeView 写入）。 */
export function setWorkspaceRootForSession(sessionId: string, dir: string): void {
  if (!sessionId) return
  rootsBySession.set(sessionId, dir || '')
}

/** 清除某个会话的根（会话销毁/切换时调用，避免 Map 无限增长）。 */
export function clearWorkspaceRootForSession(sessionId: string): void {
  if (!sessionId) return
  rootsBySession.delete(sessionId)
}

/**
 * 取当前活动会话绑定的工作区根目录。
 * 若当前会话未绑定根，回退到全局兜底（空串），由调用方提示用户先选择目录。
 */
export function getWorkspaceRootForSession(sessionId: string = getAgentSessionId()): string {
  return rootsBySession.get(sessionId) || ''
}
