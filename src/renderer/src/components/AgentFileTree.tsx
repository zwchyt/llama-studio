import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen, Loader2, AlertCircle, RefreshCw,
  Code, Braces, FileText, Image, Palette, Settings, Terminal, FileCode
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
  loaded?: boolean
  truncated?: boolean
  total?: number
}

interface FileMeta { Icon: LucideIcon; color: string }

// 按扩展名映射图标与配色，避免所有文件都用统一的 File 图标
function fileMeta(name: string): FileMeta {
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

function updateNodeInTree(root: FileNode, targetPath: string, updates: Partial<FileNode>): FileNode {
  if (root.path === targetPath) return { ...root, ...updates }
  if (root.children) {
    return { ...root, children: root.children.map(child => updateNodeInTree(child, targetPath, updates)) }
  }
  return root
}

export default function AgentFileTree({ workspaceDir, onPreviewFile }: { workspaceDir: string; onPreviewFile?: (path: string) => void }) {
  const [tree, setTree] = useState<FileNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set())
  const [errorSet, setErrorSet] = useState<Set<string>>(new Set())

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchChildren = useCallback(async (path: string): Promise<{ children: FileNode[]; truncated: boolean; total: number } | { error: string }> => {
    const res = await window.api.expandFileTree(path)
    if (res.success && res.children) {
      const children: FileNode[] = res.children.map(c => ({ name: c.name, path: c.path, isDir: c.isDir }))
      return { children, truncated: !!res.truncated, total: res.total ?? children.length }
    }
    return { error: res.error || '展开目录失败' }
  }, [])

  const refreshDir = useCallback(async (path: string) => {
    const r = await fetchChildren(path)
    if ('error' in r) return // 静默：目录可能已被删除/移动
    setTree(prev => prev ? updateNodeInTree(prev, path, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
  }, [fetchChildren])

  const toggleExpand = useCallback(async (node: FileNode) => {
    if (!node.isDir) {
      // 文件：仅触发预览，不再把路径发到输入框
      onPreviewFile?.(node.path)
      return
    }

    const newExpanded = new Set(expanded)
    if (newExpanded.has(node.path)) {
      newExpanded.delete(node.path)
      setExpanded(newExpanded)
      return
    }

    if (!node.loaded) {
      setLoadingSet(prev => new Set(prev).add(node.path))
      setErrorSet(prev => { const s = new Set(prev); s.delete(node.path); return s })
      const r = await fetchChildren(node.path)
      if ('error' in r) {
        setTree(prev => prev ? updateNodeInTree(prev, node.path, { loaded: false }) : prev)
        setErrorSet(prev => new Set(prev).add(node.path))
      } else {
        setTree(prev => prev ? updateNodeInTree(prev, node.path, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
      }
      setLoadingSet(prev => { const s = new Set(prev); s.delete(node.path); return s })
    }

    newExpanded.add(node.path)
    setExpanded(newExpanded)
  }, [expanded, onPreviewFile, fetchChildren])

  // 根目录加载（workspaceDir 变化时）
  useEffect(() => {
    if (!workspaceDir) { setTree(null); setExpanded(new Set()); setErrorSet(new Set()); return }
    const name = workspaceDir.split('\\').pop()?.split('/').pop() || workspaceDir
    const root: FileNode = { name, path: workspaceDir, isDir: true, children: [], loaded: false }
    setTree(root)
    setExpanded(new Set([workspaceDir]))
    setErrorSet(new Set())
    ;(async () => {
      setLoadingSet(prev => new Set(prev).add(workspaceDir))
      const r = await fetchChildren(workspaceDir)
      if ('error' in r) {
        setTree(prev => prev ? updateNodeInTree(prev, workspaceDir, { loaded: true }) : prev)
        setErrorSet(prev => new Set(prev).add(workspaceDir))
      } else {
        setTree(prev => prev ? updateNodeInTree(prev, workspaceDir, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
      }
      setLoadingSet(prev => { const s = new Set(prev); s.delete(workspaceDir); return s })
    })()
  }, [workspaceDir, fetchChildren])

  // 自动监听目录变化：启动 watcher 并监听变更事件，刷新所有已展开节点（免去手动刷新按钮）
  useEffect(() => {
    if (!workspaceDir) return
    window.api.startAgentFileWatch(workspaceDir)
    const onChange = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        const dirs = [workspaceDir, ...Array.from(expandedRef.current).filter(p => p !== workspaceDir)]
        dirs.forEach(p => refreshDir(p))
      }, 300)
    }
    window.api.onAgentFileChanged(onChange)
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      window.api.removeAgentFileListeners()
      window.api.stopAgentFileWatch()
    }
  }, [workspaceDir, refreshDir])

  const renderNode = (node: FileNode, level: number) => {
    const isExpanded = expanded.has(node.path)
    const isLoading = loadingSet.has(node.path)
    const isError = errorSet.has(node.path)
    return (
      <div key={node.path}>
        <div
          className={`file-tree-node ${isError ? 'file-tree-node-error' : ''}`}
          style={{ paddingLeft: level * 16 }}
          onClick={() => toggleExpand(node)}
        >
          <span className="file-tree-arrow">
            {node.isDir ? (
              isLoading ? <Loader2 size={12} className="spin" /> : isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
            ) : (
              <span style={{ width: 12, display: 'inline-block' }} />
            )}
          </span>
          <span className="file-tree-icon">
            {node.isDir ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />)
              : (() => { const { Icon, color } = fileMeta(node.name); return <Icon size={14} style={{ color }} /> })()}
          </span>
          <span className="file-tree-name">{node.name}</span>
          {isError && <AlertCircle size={12} className="file-tree-error-icon" />}
        </div>
        {isError && (
          <div className="file-tree-error-row" style={{ paddingLeft: (level + 1) * 16 }} onClick={() => toggleExpand(node)}>
            <RefreshCw size={11} /> 展开失败，点击重试
          </div>
        )}
        {node.isDir && isExpanded && node.children?.map(child => renderNode(child, level + 1))}
        {node.isDir && isExpanded && node.truncated && (
          <div className="file-tree-truncated" style={{ paddingLeft: (level + 1) * 16 }}>
            目录文件过多，仅显示前 {node.children?.length ?? 0} / {node.total} 个
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title">
          <FolderOpen size={14} />
          文件浏览器
        </span>
      </div>
      <div className="file-tree-path" title={workspaceDir}>{workspaceDir}</div>
      <div className="file-tree-content">
        {!workspaceDir ? (
          <div className="file-tree-empty">点击上方的文件夹图标选择目录</div>
        ) : tree ? (
          <div className="file-tree-nodes">{renderNode(tree, 0)}</div>
        ) : (
          <div className="file-tree-loading">加载中...</div>
        )}
      </div>
    </div>
  )
}
