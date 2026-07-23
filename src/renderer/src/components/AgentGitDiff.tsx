import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, GitBranch, RefreshCw } from 'lucide-react'
import { fileMeta } from '../utils/fileIcon'

// Git 变更（只读 diff 查看）：解析 `git diff HEAD` 的 unified 输出并按行渲染。
// 解析算法参考 DeepSeek-Reasonix 的 diffRowsFromUnifiedDiff（保留真实行号）。
export interface GitFileChange {
  path: string
  status: string
  staged: boolean
  untracked: boolean
  binary: boolean
  diff: string
  content?: string
}
export interface GitChangesData {
  isRepo: boolean
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  error?: string
}

type DiffRow = { type: 'ctx' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number }

const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

// 把 unified diff 解析成带真实行号的行序列（忽略 diff/index/--- /+++ 等头部，只取 @@ 之后的内容）。
function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  for (const line of lines) {
    const h = HUNK_RE.exec(line)
    if (h) { oldLine = Number(h[1]); newLine = Number(h[2]); inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith('\\ No newline')) continue
    const marker = line[0]
    const text = (marker === ' ' || marker === '+' || marker === '-') ? line.slice(1) : line
    if (marker === '+') { rows.push({ type: 'add', text, newLine }); newLine++; continue }
    if (marker === '-') { rows.push({ type: 'del', text, oldLine }); oldLine++; continue }
    rows.push({ type: 'ctx', text, oldLine, newLine }); oldLine++; newLine++
  }
  return rows
}

// 未跟踪文件：无 diff，把整段内容按「全部新增」渲染。
function contentToRows(content: string): DiffRow[] {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  return lines.map((t, i) => ({ type: 'add' as const, text: t, newLine: i + 1 }))
}

const baseName = (p: string) => p.split('/').pop() || p
const dirName = (p: string) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : '' }

const STATUS_LABEL: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪' }

const MAX_ROWS = 40

const GitFileBlock = React.memo(function GitFileBlock({ file, onOpen, forceCollapsed }: { file: GitFileChange; onOpen: (relPath: string, line?: number) => void; forceCollapsed: boolean }) {
  const rows = useMemo(() => (file.untracked ? contentToRows(file.content || '') : parseUnifiedDiff(file.diff)), [file])
  const [collapsed, setCollapsed] = useState(forceCollapsed)
  // 顶部「全部展开/收起」变化时同步各文件的折叠态；单文件手动折叠不受影响（forceCollapsed 未变）。
  useEffect(() => { setCollapsed(forceCollapsed) }, [forceCollapsed])
  const [showAll, setShowAll] = useState(false)
  const added = rows.filter(r => r.type === 'add').length
  const removed = rows.filter(r => r.type === 'del').length
  const visible = showAll ? rows : rows.slice(0, MAX_ROWS)
  const hidden = rows.length - visible.length
  const dir = dirName(file.path)
  const { Icon: FileIcon, color: fileColor } = fileMeta(file.path)
  const [copied, setCopied] = useState(false)
  const canCopy = !file.binary && rows.length > 0
  const copyDiff = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = rows.map(r => (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + r.text).join('\n')
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* 剪贴板不可用 */ }
  }
  return (
    <div className={`agent-git-file s-${file.status}`}>
      <div className="agent-git-file-head" onClick={() => setCollapsed(c => !c)}>
        <ChevronRight size={12} className={`agent-git-chev ${collapsed ? '' : 'open'}`} />
        <button
          className="agent-git-file-path"
          title={file.path}
          onClick={(e) => { e.stopPropagation(); onOpen(file.path) }}
        >
          <FileIcon size={11} style={{ color: fileColor }} />
          <span className="agent-git-file-name">{baseName(file.path)}</span>
          {dir && <span className="agent-git-file-dir">{dir}</span>}
        </button>
        <span className="agent-git-stat">
          <span className="add">+{added}</span>
          <span className="del">−{removed}</span>
        </span>
        <span className={`agent-git-badge s-${file.status}`} title={STATUS_LABEL[file.status] || file.status}>{file.status}</span>
        {canCopy && (
          <button className="agent-git-copy" onClick={copyDiff}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
      {!collapsed && (
        file.binary ? (
          <div className="agent-git-note">二进制文件，不显示文本差异。</div>
        ) : rows.length === 0 ? (
          <div className="agent-git-note">无文本差异（可能仅为模式/重命名变更）。</div>
        ) : (
          <div className="agent-git-diff-body">
            {visible.map((r, i) => (
              <div
                className={`agent-git-row ${r.type}`}
                key={i}
                title="跳转到源文件此行"
                onClick={() => onOpen(file.path, r.newLine ?? r.oldLine)}
              >
                <span className="agent-git-ln">{r.oldLine ?? ''}</span>
                <span className="agent-git-ln">{r.newLine ?? ''}</span>
                <span className="agent-git-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                <span className="agent-git-code">{r.text || ' '}</span>
              </div>
            ))}
            {hidden > 0 && (
              <button className="agent-git-more" onClick={() => setShowAll(true)}>展开剩余 {hidden} 行</button>
            )}
            {showAll && rows.length > MAX_ROWS && (
              <button className="agent-git-more" onClick={() => setShowAll(false)}>收起</button>
            )}
          </div>
        )
      )}
    </div>
  )
})

export default function AgentGitDiff({ data, loading, onRefresh, onOpenFile, workspaceDir }: {
  data: GitChangesData | null
  loading: boolean
  onRefresh: () => void
  onOpenFile: (absPath: string, line?: number) => void
  workspaceDir: string
}) {
  const [allExpanded, setAllExpanded] = useState(false)  // 默认全部折叠（单文件级）
  // 分区级折叠：整段「已暂存的更改 / 更改」可各自收起
  const [sectionCollapsed, setSectionCollapsed] = useState<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false })
  const openFile = (relPath: string, line?: number) => {
    const root = workspaceDir.replace(/[\\/]+$/, '')
    onOpenFile(`${root}/${relPath}`, line)
  }
  const staged = data?.staged ?? []
  const unstaged = data?.unstaged ?? []
  const total = staged.length + unstaged.length
  const hasFiles = !!data?.isRepo && total > 0
  // 顶部总览：汇总所有文件的新增/删除行数
  const totals = useMemo(() => {
    let added = 0, removed = 0
    for (const f of [...staged, ...unstaged]) {
      const rows = f.untracked ? contentToRows(f.content || '') : parseUnifiedDiff(f.diff)
      for (const r of rows) { if (r.type === 'add') added++; else if (r.type === 'del') removed++ }
    }
    return { added, removed }
  }, [staged, unstaged])
  const renderGroup = (title: string, list: GitFileChange[], key: 'staged' | 'unstaged') => {
    if (list.length === 0) return null
    const collapsed = sectionCollapsed[key]
    return (
      <div className="agent-git-section">
        <div className="agent-git-section-head" onClick={() => setSectionCollapsed(s => ({ ...s, [key]: !s[key] }))}>
          <ChevronRight size={12} className={`agent-git-chev ${collapsed ? '' : 'open'}`} />
          <span className="agent-git-section-title">{title}</span>
          <span className="agent-git-section-count">{list.length}</span>
        </div>
        {!collapsed && list.map(f => <GitFileBlock key={`${key}-${f.path}`} file={f} onOpen={openFile} forceCollapsed={!allExpanded} />)}
      </div>
    )
  }
  return (
    <div className="agent-git">
      <div className="agent-git-header">
        <button
          className="agent-git-collapse-all"
          onClick={() => setAllExpanded(v => !v)}
          title={allExpanded ? '全部收起' : '全部展开'}
          disabled={!hasFiles}
        >
          {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        </button>
        <span className="agent-git-title"><GitBranch size={13} /> Git 变更</span>
        {data?.isRepo && (
          <span className="agent-git-summary">
            {total} 个文件
            {total > 0 && <span className="agent-git-total-stat"><span className="add">+{totals.added}</span><span className="del">−{totals.removed}</span></span>}
          </span>
        )}
        <span className="agent-git-spacer" />
        <button className="agent-git-refresh" onClick={() => onRefresh()} title="刷新">
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="agent-git-body">
        {loading && !data ? (
          <div className="agent-git-empty">正在读取变更…</div>
        ) : !data ? (
          <div className="agent-git-empty">—</div>
        ) : data.error ? (
          <div className="agent-git-empty">读取失败：{data.error}</div>
        ) : !data.isRepo ? (
          <div className="agent-git-empty">当前工作区不是 Git 仓库（未检测到 .git）。</div>
        ) : total === 0 ? (
          <div className="agent-git-empty">工作区没有未提交的改动。</div>
        ) : (
          <>
            {renderGroup('已暂存的更改', staged, 'staged')}
            {renderGroup('更改', unstaged, 'unstaged')}
          </>
        )}
      </div>
    </div>
  )
}
