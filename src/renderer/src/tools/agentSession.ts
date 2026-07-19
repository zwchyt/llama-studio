// 当前 Agent 工作台活动会话的 id，供 Todo/Task 系列工具在未显式传入 sessionId 时，
// 定位要操作哪个会话的任务清单；同时作为 workspaceRoot.ts 按会话取根的键。
let agentSessionId = ''

export function setAgentSessionId(id: string): void {
  agentSessionId = id || ''
}

export function getAgentSessionId(): string {
  return agentSessionId
}
