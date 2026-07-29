import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ChevronLeft, Search, X, File, Folder, FolderOpen, Check, Loader2, HardDrive } from 'lucide-react'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

interface AttachedFile {
  id: string
  path: string
  name: string
  isDir: boolean
}

interface AgentFilePickerProps {
  workspaceDir: string
  attached: AttachedFile[]
  onAttach: (entry: FileEntry) => void
  onRemove: (path: string) => void
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
  // 浏览系统文件：调原生对话框选取任意磁盘文件（面板导航只能到当前盘符根）
  onBrowseSystem?: () => void
}

function dirName(p: string) {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p
}

// 「此电脑」磁盘列表视图的路径哨兵：盘符根再向上导航时进入
const DRIVES_VIEW = '::drives::'

function parentDir(p: string) {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return ''
  const parent = norm.slice(0, idx)
  // 盘符根补斜杠（'C:' → 'C:/'）：避免 Node 端把 'C:' 解析为该盘当前目录
  return /^[A-Za-z]:$/.test(parent) ? parent + '/' : parent
}

export default function AgentFilePicker({ workspaceDir, attached, onAttach, onRemove, onClose, triggerRef, onBrowseSystem }: AgentFilePickerProps) {
  const [currentPath, setCurrentPath] = useState(workspaceDir)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([])
  const panelRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchExpanded, setSearchExpanded] = useState(false)

  const attachedByPath = useMemo(() => new Set(attached.map(a => a.path)), [attached])

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true)
    setSearchQuery('')
    setSearchExpanded(false)
    try {
      if (dir === DRIVES_VIEW) {
        // 「此电脑」视图：列出所有可用磁盘
        const res = await window.api.listDrives()
        setEntries((res.drives || []).map(d => ({ name: d.replace(/[\\/]+$/, ''), path: d.replace(/\\/g, '/'), isDir: true })))
      } else {
        const res = await window.api.expandFileTree(dir)
        if (res.success && res.children) {
          setEntries(res.children)
        } else {
          setEntries([])
        }
      }
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [])

  // Build breadcrumb trail
  useEffect(() => {
    if (currentPath === DRIVES_VIEW) { setBreadcrumbs([]); return }
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
    const crumbs: string[] = []
    for (let i = 0; i < parts.length; i++) {
      crumbs.push(parts.slice(0, i + 1).join('/'))
    }
    setBreadcrumbs(crumbs)
  }, [currentPath])

  useEffect(() => {
    if (currentPath) loadDir(currentPath)
  }, [currentPath, loadDir])

  useEffect(() => {
    if (searchExpanded) searchInputRef.current?.focus()
  }, [searchExpanded])

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter(e => e.name.toLowerCase().includes(q))
  }, [entries, searchQuery])

  const handleOpenDir = (path: string) => {
    setCurrentPath(path)
  }

  const handleGoUp = () => {
    if (currentPath === DRIVES_VIEW) return
    const parent = parentDir(currentPath)
    // 盘符根再向上：进入「此电脑」磁盘列表
    if (parent && parent !== currentPath) setCurrentPath(parent)
    else setCurrentPath(DRIVES_VIEW)
  }

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.isDir) {
      setCurrentPath(entry.path)
      return
    }
    if (attachedByPath.has(entry.path)) {
      onRemove(entry.path)
    } else {
      onAttach(entry)
    }
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef?.current?.contains(target)) return
      if (panelRef.current && !panelRef.current.contains(target)) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  return (
    <div className="agent-file-picker" ref={panelRef}>
      <div className="agent-file-picker-header">
        <div className="agent-file-picker-bread">
          {currentPath !== workspaceDir && currentPath !== DRIVES_VIEW && (
            <button className="agent-file-picker-up" onClick={handleGoUp} title="上级目录">
              <ChevronLeft size={13} />
            </button>
          )}
          {currentPath === DRIVES_VIEW ? (
            <>
              <button className="agent-file-picker-crumb agent-file-picker-crumb-root" onClick={() => setCurrentPath(workspaceDir)} title="回到工作目录">
                <FolderOpen size={11} />
              </button>
              <span className="agent-file-picker-sep">/</span>
              <span className="agent-file-picker-crumb agent-file-picker-crumb-active" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <HardDrive size={11} /> 此电脑
              </span>
            </>
          ) : breadcrumbs.length > 3 ? (
            <>
              <button className="agent-file-picker-crumb agent-file-picker-crumb-root" onClick={() => setCurrentPath(workspaceDir)}>
                <FolderOpen size={11} />
              </button>
              <span className="agent-file-picker-sep">/</span>
              <span className="agent-file-picker-crumb agent-file-picker-crumb-ellipsis">…</span>
              <span className="agent-file-picker-sep">/</span>
              {breadcrumbs.slice(-2).map((p, i) => (
                <span key={p}>
                  {i > 0 && <span className="agent-file-picker-sep">/</span>}
                  <button
                    className={`agent-file-picker-crumb ${p === currentPath ? 'agent-file-picker-crumb-active' : ''}`}
                    onClick={() => setCurrentPath(p)}
                  >
                    {dirName(p)}
                  </button>
                </span>
              ))}
            </>
          ) : (
            breadcrumbs.map((p, i) => (
              <span key={p}>
                {i > 0 && <span className="agent-file-picker-sep">/</span>}
                <button
                  className={`agent-file-picker-crumb ${p === currentPath ? 'agent-file-picker-crumb-active' : ''}`}
                  onClick={() => setCurrentPath(p)}
                >
                  {dirName(p)}
                </button>
              </span>
            ))
          )}
        </div>
        <div className="agent-file-picker-search-area">
          {onBrowseSystem && (
            <button className="agent-file-picker-search-btn" onClick={onBrowseSystem} title="浏览系统文件（任意磁盘）">
              <HardDrive size={13} />
            </button>
          )}
          {searchExpanded || searchQuery ? (
            <div className="agent-file-picker-search-wrap">
              <Search size={11} className="agent-file-picker-search-icon" />
              <input
                ref={searchInputRef}
                className="agent-file-picker-search"
                type="text"
                placeholder="搜索文件…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onBlur={() => { if (!searchQuery) setSearchExpanded(false) }}
              />
            </div>
          ) : (
            <button className="agent-file-picker-search-btn" onClick={() => setSearchExpanded(true)} title="搜索文件">
              <Search size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="agent-file-picker-body">
        {attached.length > 0 && (
          <div className="agent-file-picker-attachments">
            <div className="agent-file-picker-att-title">已选择</div>
            <div className="agent-file-picker-att-list">
              {attached.map(a => (
                <div className="agent-file-picker-att-item" key={a.path} title={a.path}>
                  {a.isDir ? <Folder size={10} /> : <File size={10} />}
                  <span className="agent-file-picker-att-name">{a.name}</span>
                  <button className="agent-file-picker-att-remove" onClick={() => onRemove(a.path)}>
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="agent-file-picker-grid-wrap">
          {loading ? (
            <div className="agent-file-picker-loading">
              <Loader2 size={14} className="spin" />
              加载中…
            </div>
          ) : filteredEntries.length > 0 ? (
            <div className="agent-file-picker-grid">
              {filteredEntries.map(entry => (
                <button
                  key={entry.path}
                  className={`agent-file-picker-entry ${attachedByPath.has(entry.path) ? 'attached' : ''}`}
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => { if (entry.isDir) handleOpenDir(entry.path) }}
                >
                  <span className="agent-file-picker-entry-icon">
                    {attachedByPath.has(entry.path) ? (
                      <Check size={11} />
                    ) : entry.isDir ? (
                      currentPath === DRIVES_VIEW ? <HardDrive size={11} /> : <Folder size={11} />
                    ) : (
                      <File size={11} />
                    )}
                  </span>
                  <span className="agent-file-picker-entry-name">{entry.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="agent-file-picker-empty">
              {searchQuery ? '无匹配文件' : '文件夹为空'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
