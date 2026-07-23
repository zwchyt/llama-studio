import { File, Code, Braces, FileText, Image, Palette, Settings, Terminal, FileCode } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface FileMeta { Icon: LucideIcon; color: string }

// 按扩展名映射图标与配色（文件树 AgentFileTree 与 Git diff 面板 AgentGitDiff 共用，
// 保证同一文件在两处显示相同的图标与颜色）。
export function fileMeta(name: string): FileMeta {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  switch (ext) {
    case '.ts': case '.tsx': return { Icon: FileCode, color: '#3178c6' }
    case '.js': case '.jsx': case '.mjs': case '.cjs': return { Icon: FileCode, color: '#e8a33d' }
    case '.json': return { Icon: Braces, color: '#cbcb41' }
    case '.md': case '.markdown': case '.txt': case '.rst': case '.log': return { Icon: FileText, color: '#9aa0a6' }
    case '.css': case '.scss': case '.less': case '.sass': return { Icon: Palette, color: '#563d7c' }
    case '.html': case '.htm': return { Icon: Code, color: '#e34c26' }
    case '.py': case '.go': case '.rs': case '.java': case '.c': case '.cpp': case '.h': return { Icon: Code, color: '#519aba' }
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.svg': case '.webp': case '.bmp': case '.ico': return { Icon: Image, color: '#a074c4' }
    case '.yml': case '.yaml': return { Icon: Settings, color: '#cb171e' }
    case '.sh': case '.bash': case '.zsh': case '.ps1': return { Icon: Terminal, color: '#4eaa25' }
    case '.pdf': return { Icon: FileText, color: '#d40f0f' }
    default: return { Icon: File, color: 'var(--text-muted)' }
  }
}
