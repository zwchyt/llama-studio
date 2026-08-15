import type { ElementType } from 'react'
import { Palette } from 'lucide-react'
import { FileCodeIcon, CodeIcon, CodeXmlIcon, FileTextIcon, ImageIcon, SettingsIcon, TerminalIcon, FileIcon } from '@animateicons/react/lucide'

export interface FileMeta { Icon: ElementType; color: string }

// 按扩展名映射图标与配色（文件树 AgentFileTree 与 Git diff 面板 AgentGitDiff 共用，
// 保证同一文件在两处显示相同的图标与颜色）。
// 动态图标优先：animateicons 无 Braces（json）对应项 → CodeXml 近似替代；
// 无 Palette（css）对应项 → 保留 lucide 静态。
export function fileMeta(name: string): FileMeta {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  switch (ext) {
    case '.ts': case '.tsx': return { Icon: FileCodeIcon, color: '#3178c6' }
    case '.js': case '.jsx': case '.mjs': case '.cjs': return { Icon: FileCodeIcon, color: '#e8a33d' }
    case '.json': return { Icon: CodeXmlIcon, color: '#cbcb41' }
    case '.md': case '.markdown': case '.txt': case '.rst': case '.log': return { Icon: FileTextIcon, color: '#9aa0a6' }
    case '.css': case '.scss': case '.less': case '.sass': return { Icon: Palette, color: '#563d7c' }
    case '.html': case '.htm': return { Icon: CodeIcon, color: '#e34c26' }
    case '.py': case '.go': case '.rs': case '.java': case '.c': case '.cpp': case '.h': return { Icon: CodeIcon, color: '#519aba' }
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.svg': case '.webp': case '.bmp': case '.ico': return { Icon: ImageIcon, color: '#a074c4' }
    case '.yml': case '.yaml': return { Icon: SettingsIcon, color: '#cb171e' }
    case '.sh': case '.bash': case '.zsh': case '.ps1': return { Icon: TerminalIcon, color: '#4eaa25' }
    case '.pdf': return { Icon: FileTextIcon, color: '#d40f0f' }
    default: return { Icon: FileIcon, color: 'var(--text-muted)' }
  }
}