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

// 绝对路径 → 工作区相对路径（仅用于展示）。
// 工具结果里的 `File:` 头是绝对路径，直接摆进卡片头部会把真正要看的文件名挤掉；
// 转成相对路径后头部只留项目内的那一段。不在工作区内的路径原样返回。
// 点击预览时再由 resolveWorkspacePath 还原成绝对路径，所以这里只影响显示。
export function toWorkspaceRelative(p: string): string {
  if (!p) return p
  const root = getWorkspaceRootForSession()
  if (!root) return p
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const rootNorm = norm(root)
  const fileNorm = p.replace(/\\/g, '/')
  // Windows 盘符大小写可能不一致，比较时忽略大小写
  if (fileNorm.toLowerCase() === rootNorm.toLowerCase()) return '.'
  if (fileNorm.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
    return fileNorm.slice(rootNorm.length + 1)
  }
  return p
}
