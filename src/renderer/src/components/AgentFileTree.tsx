import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, Loader2, AlertCircle, Copy, CornerDownLeft, Search, X
} from 'lucide-react'
import { fileMeta } from '../utils/fileIcon'
import { notify } from '../store/notificationStore'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
  loaded?: boolean
  truncated?: boolean
  total?: number
}

function updateNodeInTree(root: FileNode, targetPath: string, updates: Partial<FileNode>): FileNode {
  if (root.path === targetPath) return { ...root, ...updates }
  if (root.children) {
    return { ...root, children: root.children.map(child => updateNodeInTree(child, targetPath, updates)) }
  }
  return root
}

export default function AgentFileTree({ workspaceDir, onPreviewFile, onSendFileName, onFilesChanged }: { workspaceDir: string; onPreviewFile?: (path: string) => void; onSendFileName?: (name: string) => void; onFilesChanged?: () => void }) {
  const [tree, setTree] = useState<FileNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set())
  const [errorSet, setErrorSet] = useState<Set<string>>(new Set())
  // 右键菜单：文件与文件夹节点均可触发，{ x, y } 为屏幕坐标，name/path 为当前节点
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string; path: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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
    const onChange = (data?: { dir: string; filename: string }) => {
      // 忽略 .git 内部写入：git status/diff 等会刷新 .git/index，否则会与 Git 变更面板刷新形成回环。
      const fn = data?.filename || ''
      if (fn === '.git' || fn.startsWith('.git/') || fn.startsWith('.git\\')) return
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        const dirs = [workspaceDir, ...Array.from(expandedRef.current).filter(p => p !== workspaceDir)]
        dirs.forEach(p => refreshDir(p))
        onFilesChanged?.()
      }, 300)
    }
    window.api.onAgentFileChanged(onChange)
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      window.api.removeAgentFileListeners()
      window.api.stopAgentFileWatch()
    }
  }, [workspaceDir, refreshDir, onFilesChanged])

  // 复制文件完整路径到剪贴板（优先 navigator.clipboard，失败回退 execCommand）
  const copyPath = useCallback(async (path: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path)
      } else {
        const ta = document.createElement('textarea')
        ta.value = path
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      notify('已复制文件路径', 'success')
    } catch {
      notify('复制失败', 'error')
    }
  }, [])

  // 点击空白 / 右键别处 / 按下 Esc 时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      // 菜单内部点击不关闭，交给菜单项自身处理
      if (menuRef.current?.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    // 捕获阶段先于节点 onClick，避免关闭后立即触发展开等
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('contextmenu', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('contextmenu', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const renderNode = (node: FileNode, level: number) => {
    const isExpanded = expanded.has(node.path)
    const isLoading = loadingSet.has(node.path)
    const isError = errorSet.has(node.path)
    // 文件 / 文件夹节点右键：弹出自定义菜单（目录同样支持，菜单项对两者均适用）
    const onNodeContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY, name: node.name, path: node.path })
    }
    return (
      <div key={node.path}>
        <div
          className={`file-tree-node ${isError ? 'file-tree-node-error' : ''} ${level > 0 ? 'file-tree-node--sub' : ''} ${ctxMenu?.path === node.path ? 'file-tree-node--pinned' : ''}`}
          style={{ paddingLeft: level * 16 }}
          onClick={() => toggleExpand(node)}
          onContextMenu={onNodeContextMenu}
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
            展开失败，点击重试
          </div>
        )}
        {node.isDir && (
          <div className={`file-tree-children ${isExpanded ? 'open' : ''}`}>
            {node.children?.map(child => renderNode(child, level + 1))}
            {node.truncated && (
              <div className="file-tree-truncated" style={{ paddingLeft: (level + 1) * 16 }}>
                目录文件过多，仅显示前 {node.children?.length ?? 0} / {node.total} 个
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── 文件搜索/过滤：非空查询时用 listFlatFiles 拉平并按名称过滤，空查询回到树 ──
  const [query, setQuery] = useState('')
  const [flat, setFlat] = useState<{ name: string; path: string; relPath: string }[] | null>(null)
  const [flatLoading, setFlatLoading] = useState(false)
  const ensureFlat = useCallback(async () => {
    if (!workspaceDir) return
    setFlatLoading(true)
    try {
      const res = await window.api.listFlatFiles(workspaceDir, { maxDepth: 12, maxFiles: 3000 })
      setFlat(res.success && res.files ? res.files : [])
    } catch { setFlat([]) } finally { setFlatLoading(false) }
  }, [workspaceDir])
  useEffect(() => { setQuery(''); setFlat(null) }, [workspaceDir])
  useEffect(() => { if (query.trim() && flat === null && !flatLoading) void ensureFlat() }, [query, flat, flatLoading, ensureFlat])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !flat) return []
    return flat.filter(f => f.relPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)).slice(0, 300)
  }, [query, flat])

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title">
          <FolderOpen size={14} />
          文件浏览器
        </span>
      </div>
      <div className="file-tree-path">{workspaceDir}</div>
      {workspaceDir && (
        <div className="file-tree-search">
          <Search size={12} className="file-tree-search-icon" />
          <input
            className="file-tree-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件…"
            spellCheck={false}
          />
          {query && (
            <button className="file-tree-search-clear" onClick={() => setQuery('')} title="清除"><X size={11} /></button>
          )}
        </div>
      )}
      <div className="file-tree-content">
        {!workspaceDir ? (
          <div className="file-tree-empty">点击上方的文件夹图标选择目录</div>
        ) : query.trim() ? (
          flatLoading && flat === null ? (
            <div className="file-tree-loading">搜索中…</div>
          ) : results.length === 0 ? (
            <div className="file-tree-empty">无匹配文件</div>
          ) : (
            <div className="file-tree-nodes">
              {results.map(f => (
                <div className="file-tree-result" key={f.path} title={f.relPath} onClick={() => onPreviewFile?.(f.path)}>
                  {(() => { const { Icon, color } = fileMeta(f.name); return <Icon size={14} style={{ color }} /> })()}
                  <span className="file-tree-result-name">{f.name}</span>
                  <span className="file-tree-result-dir">{f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : ''}</span>
                </div>
              ))}
            </div>
          )
        ) : tree ? (
          <div className="file-tree-nodes">{renderNode(tree, 0)}</div>
        ) : (
          <div className="file-tree-loading">加载中...</div>
        )}
      </div>
      {ctxMenu && (() => {
        // 视口边界修正：菜单超出右/下边界时向左/上翻转，避免溢出被裁切
        const MENU_W = 168, MENU_H = 76
        const x = Math.min(ctxMenu.x, window.innerWidth - MENU_W - 8)
        const y = Math.min(ctxMenu.y, window.innerHeight - MENU_H - 8)
        return (
          <div
            ref={menuRef}
            className="file-tree-ctx-menu"
            style={{ left: Math.max(8, x), top: Math.max(8, y) }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="file-tree-ctx-item"
              onClick={() => { onSendFileName?.(ctxMenu.name); setCtxMenu(null) }}
            >
              <CornerDownLeft size={13} />
              发送到输入框
            </button>
            <button
              className="file-tree-ctx-item"
              onClick={() => { copyPath(ctxMenu.path); setCtxMenu(null) }}
            >
              <Copy size={13} />
              复制路径
            </button>
          </div>
        )
      })()}
    </div>
  )
}
