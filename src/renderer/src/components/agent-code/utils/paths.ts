// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：路径处理（文件名提取、目录提取、相对路径按工作区解析）                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

import { getWorkspaceRootForSession } from '../../../tools/workspaceRoot'

export function dirName(p: string) { return p.split('\\').pop()?.split('/').pop() || p }

export const pathDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')

// 将工具参数中的相对路径按当前工作区解析为绝对路径（用于点击预览）
export function resolveWorkspacePath(p: string): string {
  if (!p) return ''
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')) return p
  const root = getWorkspaceRootForSession()
  if (!root) return p
  return root.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '')
}
