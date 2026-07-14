// 当前 Agent 工作台活动项目的根目录，供 Glob/Grep 工具在未提供 path 时作为默认搜索根。
let workspaceRoot = ''

export function setWorkspaceRoot(dir: string): void {
  workspaceRoot = dir || ''
}

export function getWorkspaceRoot(): string {
  return workspaceRoot
}
