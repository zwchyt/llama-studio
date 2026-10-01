import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlignJustifyIcon, ArrowUpDownIcon, CheckIcon, ChevronRightIcon, ChevronsDownIcon, ChevronsUpIcon, ChevronsLeftRightIcon, CopyIcon, DiffIcon, FileCheckIcon, FilePenIcon, FileSearchIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, GitCommitHorizontalIcon, GitCompareIcon, HistoryIcon, MinusIcon, PlusIcon, RefreshCwIcon, SearchIcon, WrapTextIcon, XIcon } from '@animateicons/react/lucide'
import { fileMeta } from '../utils/fileIcon'
import { usePopoverDismiss } from '../utils/usePopoverDismiss'
import type { AniIconHandle } from './agent-code/types'
import type { ElementType } from 'react'

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

type DiffRow = { type: 'ctx' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number; highlights?: { start: number; end: number }[] }
// 一个 hunk（改动区）：记录其在 diff 中的行范围与对应的真实行号，用于计算 hunk 之间「未改动行」的真实间隔。
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; firstRow: number; lastRow: number }
// 渲染单元：hunk = 一段改动（含上下文）；gap = 两个 hunk 之间按真实行号算出的未改动间隔。
type DiffBlock =
  | { kind: 'hunk'; rows: DiffRow[] }
  | { kind: 'gap'; count: number; startLine: number; endLine: number }

// 同时捕获 old/new 的起止行号（含行数），供「未改动间隔」按真实行号计算。
const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

// 把 unified diff 解析成带真实行号的行序列（忽略 diff/index/--- /+++ 等头部，只取 @@ 之后的内容），
// 同时记录每个 hunk 的行号范围。git 默认 3 行上下文会把大段未改动切成多个独立 hunk，
// 因此「N 个隐藏的行」必须按 hunk 之间的真实行号差计算，而不是按 diff 上下文行数。
function parseUnifiedDiff(diff: string): { rows: DiffRow[]; hunks: Hunk[] } {
  const rows: DiffRow[] = []
  const hunks: Hunk[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let cur: Hunk | null = null
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  for (const line of lines) {
    const h = HUNK_RE.exec(line)
    if (h) {
      oldLine = Number(h[1]); newLine = Number(h[3])
      inHunk = true
      cur = { oldStart: oldLine, oldCount: h[2] ? Number(h[2]) : 1, newStart: newLine, newCount: h[4] ? Number(h[4]) : 1, firstRow: rows.length, lastRow: rows.length - 1 }
      hunks.push(cur)
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('\\ No newline')) continue
    const marker = line[0]
    const text = (marker === ' ' || marker === '+' || marker === '-') ? line.slice(1) : line
    if (marker === '+') { rows.push({ type: 'add', text, newLine }); newLine++; if (cur) cur.lastRow = rows.length - 1; continue }
    if (marker === '-') { rows.push({ type: 'del', text, oldLine }); oldLine++; if (cur) cur.lastRow = rows.length - 1; continue }
    rows.push({ type: 'ctx', text, oldLine, newLine }); oldLine++; newLine++
    if (cur) cur.lastRow = rows.length - 1
  }
  return { rows, hunks }
}

// 未跟踪文件：无 diff，把整段内容按「全部新增」渲染。
function contentToRows(content: string): DiffRow[] {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  return lines.map((t, i) => ({ type: 'add' as const, text: t, newLine: i + 1 }))
}

const baseName = (p: string) => p.split('/').pop() || p
const dirName = (p: string) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : '' }

const STATUS_LABEL: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪' }

// ── 顶部第 1 区：作用域（默认未提交，选择持久化）──
type GitScope = 'uncommitted' | 'unstaged' | 'staged' | 'committed' | 'branch'
const SCOPE_ORDER: GitScope[] = ['uncommitted', 'unstaged', 'staged', 'committed', 'branch']
const SCOPE_LABEL: Record<GitScope, string> = {
  uncommitted: '未提交', unstaged: '未暂存', staged: '已暂存', committed: '已提交', branch: '分支',
}
// 作用域菜单项图标（与文件树那套一样：整行 hover 驱动图标动画）
const SCOPE_ICON: Record<GitScope, ElementType> = {
  uncommitted: GitCompareIcon, unstaged: FilePenIcon, staged: FileCheckIcon, committed: HistoryIcon, branch: GitBranchIcon,
}
const readScope = (): GitScope => {
  const v = localStorage.getItem('agent-git-scope')
  return SCOPE_ORDER.includes(v as GitScope) ? (v as GitScope) : 'uncommitted'
}

// ── 顶部第 3 区：diff 排版。堆叠＝现有上下结构；拆分＝左旧右新；自动换行与前两者可叠加 ──
type DiffMode = 'stacked' | 'split'

// 提交历史的一条（git log 输出，主进程按 \x1f 切字段）
type GitCommitItem = { hash: string; shortHash: string; author: string; time: number; subject: string }

// 拆分视图的一行：左右两栏各自的源行；上下文行两侧同现，纯增/纯删则另一侧留空
type SplitPair = { left?: DiffRow; right?: DiffRow }

// 把堆叠行序列折叠成左右配对：连续 del 段与紧随的 add 段按序配对，多出来的单边成行
function toSplitPairs(rows: DiffRow[]): SplitPair[] {
  const out: SplitPair[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]!
    if (r.type === 'ctx') { out.push({ left: r, right: r }); i++; continue }
    const dels: DiffRow[] = []
    while (i < rows.length && rows[i]!.type === 'del') { dels.push(rows[i]!); i++ }
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i]!.type === 'add') { adds.push(rows[i]!); i++ }
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) out.push({ left: dels[k], right: adds[k] })
  }
  return out
}

// 顶部按钮的浮层：.agent-git-header 带 overflow:hidden，浮层挂进 header 必被裁掉，
// 故统一 portal 到 body，按触发按钮的屏幕矩形定位；下方放不下就朝上翻。
function GitHeaderPopover({ open, btnRef, menuRef, panelClass, children }: {
  open: boolean
  btnRef: React.RefObject<HTMLElement | null>
  menuRef: React.RefObject<HTMLDivElement | null>
  panelClass: string
  children: React.ReactNode
}) {
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) return
    const el = menuRef.current
    const anchor = btnRef.current
    if (!el || !anchor) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
    const below = r.bottom + 4
    const top = below + h > window.innerHeight ? Math.max(8, r.top - h - 4) : below
    setStyle({ left, top, visibility: 'visible' })
  }, [open, btnRef, menuRef])
  if (!open) return null
  return createPortal(<div ref={menuRef} className={panelClass} style={style}>{children}</div>, document.body)
}

// ── 行内单词级差异高亮 ──
// 按单词/空白/标点拆分为 token
function tokenize(text: string): string[] {
  return text.match(/(\s+|[^\s\w]|\w+)/g) || []
}

// 简化版 LCS diff：对两个 token 序列求最长公共子序列，返回「变更区间」
function diffTokens(oldTokens: string[], newTokens: string[]): { oldHl: { start: number; end: number }[]; newHl: { start: number; end: number }[] } {
  const m = oldTokens.length
  const n = newTokens.length
  // DP 求 LCS 长度矩阵
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldTokens[i - 1] === newTokens[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  // 回溯标记哪些 token 属于公共子序列
  const oldMatch = new Array(m).fill(false)
  const newMatch = new Array(n).fill(false)
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      oldMatch[i - 1] = true
      newMatch[j - 1] = true
      i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  // 把非公共 token 转为字符索引区间
  function toHighlights(tokens: string[], matched: boolean[]): { start: number; end: number }[] {
    const hl: { start: number; end: number }[] = []
    let pos = 0
    for (let k = 0; k < tokens.length; k++) {
      const len = tokens[k].length
      if (!matched[k]) {
        // 合并相邻区间
        if (hl.length > 0 && hl[hl.length - 1].end === pos) {
          hl[hl.length - 1].end = pos + len
        } else {
          hl.push({ start: pos, end: pos + len })
        }
      }
      pos += len
    }
    return hl
  }
  return { oldHl: toHighlights(oldTokens, oldMatch), newHl: toHighlights(newTokens, newMatch) }
}

// 遍历 rows，找连续 del/add 配对，计算行内高亮区间
function computeInlineHighlights(rows: DiffRow[]): DiffRow[] {
  const result = rows.map(r => ({ ...r }))
  let i = 0
  while (i < result.length) {
    // 找连续 del 块
    if (result[i].type !== 'del') { i++; continue }
    const delStart = i
    while (i < result.length && result[i].type === 'del') i++
    const delEnd = i
    // 紧跟连续 add 块
    const addStart = i
    while (i < result.length && result[i].type === 'add') i++
    const addEnd = i
    const delCount = delEnd - delStart
    const addCount = addEnd - addStart
    // 仅当 del 和 add 行数相等时配对（单行或等量多行修改）
    if (delCount === 0 || addCount === 0 || delCount !== addCount) continue
    for (let k = 0; k < delCount; k++) {
      const oldToks = tokenize(result[delStart + k].text)
      const newToks = tokenize(result[addStart + k].text)
      const { oldHl, newHl } = diffTokens(oldToks, newToks)
      if (oldHl.length > 0) result[delStart + k].highlights = oldHl
      if (newHl.length > 0) result[addStart + k].highlights = newHl
    }
  }
  return result
}

// 渲染带高亮的代码文本
function renderCodeWithHighlights(text: string, highlights?: { start: number; end: number }[]): React.ReactNode {
  if (!highlights || highlights.length === 0) return text || ' '
  const parts: React.ReactNode[] = []
  let lastEnd = 0
  for (let i = 0; i < highlights.length; i++) {
    const { start, end } = highlights[i]
    if (start > lastEnd) parts.push(text.slice(lastEnd, start))
    parts.push(<span key={i} className="agent-git-hl">{text.slice(start, end)}</span>)
    lastEnd = end
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd))
  return parts.length > 0 ? parts : ' '
}

const GitFileBlock = React.memo(function GitFileBlock({ file, onOpen, forceCollapsed, onStage, onUnstage, onDiscard, focused, hideDir, mode, wrap }: { file: GitFileChange; onOpen: (relPath: string, line?: number) => void; forceCollapsed: boolean; onStage?: (path: string) => void; onUnstage?: (path: string) => void; onDiscard?: (path: string) => void; focused?: boolean; hideDir?: boolean; mode: DiffMode; wrap: boolean }) {
  const parsed = useMemo(() => {
    if (file.untracked) {
      const r = contentToRows(file.content || '')
      return { rows: r, hunks: r.length ? [{ oldStart: 1, oldCount: r.length, newStart: 1, newCount: r.length, firstRow: 0, lastRow: r.length - 1 }] : [] }
    }
    return parseUnifiedDiff(file.diff)
  }, [file])
  const rows = parsed.rows
  const [collapsed, setCollapsed] = useState(forceCollapsed)
  // 顶部「全部展开/收起」变化时同步各文件的折叠态；单文件手动折叠不受影响（forceCollapsed 未变）。
  useEffect(() => { setCollapsed(forceCollapsed) }, [forceCollapsed])
  // 定位聚焦（来自消息底部文件变更汇总的跳转）：自动展开 + 滚动到位 + 短暂高亮
  const rootRef = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!focused) return
    setCollapsed(false)
    setFlash(true)
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [focused])
  // 高亮自行退场：与 focused 生命周期解耦，避免聚焦被父层提前消费时定时器被清、高亮永不结束
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [flash])
  const added = rows.filter(r => r.type === 'add').length
  const removed = rows.filter(r => r.type === 'del').length
  // 行内单词级高亮：仅改动行有高亮；对全量行计算，避免分段后行号/高亮错位。
  const highlighted = useMemo(() => computeInlineHighlights(rows), [rows])
  // 渲染单元：把 hunk 之间的「按真实行号计算的未改动间隔」做成可折叠的「N 个隐藏的行」提示。
  // 间隔数 = 下一个 hunk 起始行 − 当前 hunk 结束行 − 1（含两端各 3 行上下文），
  // 因此能正确反映几百行的真实间隔，而非 git 默认 3 行上下文切出的极小 ctx 段。
  const blocks = useMemo<DiffBlock[]>(() => {
    const hs = parsed.hunks
    const out: DiffBlock[] = []
    for (let h = 0; h < hs.length; h++) {
      const hk = hs[h]!
      out.push({ kind: 'hunk', rows: highlighted.slice(hk.firstRow, hk.lastRow + 1) })
      if (h + 1 < hs.length) {
        const next = hs[h + 1]!
        const gap = next.newStart - (hk.newStart + hk.newCount)
        if (gap > 0) out.push({ kind: 'gap', count: gap, startLine: hk.newStart + hk.newCount, endLine: next.newStart - 1 })
      }
    }
    // 文件开头（首个 hunk 之前）的大段未改动也折叠
    if (hs.length && hs[0]!.newStart > 1) {
      const lead = hs[0]!.newStart - 1
      if (lead > 0) out.unshift({ kind: 'gap', count: lead, startLine: 1, endLine: hs[0]!.newStart - 1 })
    }
    return out
  }, [parsed, highlighted])
  // 未改动区间是否就地展开（点击提示展开该段，默认折叠为提示）
  const [expandedGaps, setExpandedGaps] = useState<Record<number, boolean>>({})
  const [gapContent, setGapContent] = useState<Record<number, string[]>>({})
  // 展开 gap 时从磁盘读取对应行范围的真实代码
  useEffect(() => {
    for (const [key, isOpen] of Object.entries(expandedGaps)) {
      if (!isOpen || gapContent[Number(key)] !== undefined) continue
      const bi = Number(key)
      const block = blocks[bi]
      if (!block || block.kind !== 'gap') continue
      const startLine = block.startLine
      const count = block.count
      window.api.readFile(file.path, { offset: startLine, limit: count, raw: true }).then(r => {
        if (r.success && r.content) {
          setGapContent(prev => ({ ...prev, [bi]: r.content!.split('\n') }))
        }
      }).catch(() => {})
    }
  }, [expandedGaps, blocks, file.path, gapContent])

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
    <div className={`agent-git-file s-${file.status}${flash ? ' focus-flash' : ''}`} ref={rootRef}>
      <div className="agent-git-file-head" onClick={() => setCollapsed(c => !c)}>
        <ChevronRightIcon size={12} className={`agent-git-chev ${collapsed ? '' : 'open'}`} />
        <button
          className="agent-git-file-path"
          title={file.path}
          onClick={(e) => { e.stopPropagation(); onOpen(file.path) }}
        >
          <FileIcon size={11} style={{ color: fileColor }} />
          <span className="agent-git-file-name">{baseName(file.path)}</span>
          {dir && !hideDir && <span className="agent-git-file-dir">{dir}</span>}
        </button>
        <span className="agent-git-stat">
          <span className="add">+{added}</span>
          <span className="del">−{removed}</span>
        </span>
        <span className={`agent-git-badge s-${file.status}`} title={STATUS_LABEL[file.status] || file.status}>{file.status}</span>
        {canCopy && (
          <button className="agent-git-copy" onClick={copyDiff}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </button>
        )}
        {!file.staged && !file.untracked && onDiscard && (
          <button className="agent-git-copy agent-git-discard" title="取消更改（恢复到上次提交）" onClick={(e) => { e.stopPropagation(); onDiscard(file.path) }}>
            <HistoryIcon size={12} />
          </button>
        )}
        {!file.staged && onStage && (
          <button className="agent-git-copy agent-git-stage-add" title="暂存此文件" onClick={(e) => { e.stopPropagation(); onStage(file.path) }}>
            <PlusIcon size={12} />
          </button>
        )}
        {file.staged && onUnstage && (
          <button className="agent-git-copy agent-git-stage-remove" title="取消暂存" onClick={(e) => { e.stopPropagation(); onUnstage(file.path) }}>
            <MinusIcon size={12} />
          </button>
        )}
      </div>
      {!collapsed && (
        file.binary ? (
          <div className="agent-git-note">二进制文件，不显示文本差异。</div>
        ) : rows.length === 0 ? (
          <div className="agent-git-note">无文本差异（可能仅为模式/重命名变更）。</div>
        ) : (
          <div className={`agent-git-diff-body${mode === 'split' ? ' split-view' : ''}${wrap ? ' wrap-view' : ''}`}>
            {blocks.map((b, bi) => {
              if (b.kind === 'hunk') {
                // 拆分：连续 del/add 配成左右两栏，行号与词级高亮沿用同一批 rows，只是换网格
                if (mode === 'split') {
                  return toSplitPairs(b.rows).map((p, i) => (
                    <div
                      className="agent-git-row split"
                      key={`h-${bi}-${i}`}
                      title="跳转到源文件此行"
                      onClick={() => onOpen(file.path, p.right?.newLine ?? p.left?.oldLine)}
                    >
                      <span className={`agent-git-ln${p.left?.type === 'del' ? ' del' : ''}`}>{p.left?.oldLine ?? ''}</span>
                      <span className="agent-git-sign">{p.left?.type === 'del' ? '−' : ' '}</span>
                      <span className={`agent-git-code ${p.left ? p.left.type : 'pad'}`}>{p.left ? renderCodeWithHighlights(p.left.text, p.left.highlights) : ' '}</span>
                      <span className={`agent-git-ln${p.right?.type === 'add' ? ' add' : ''}`}>{p.right?.newLine ?? ''}</span>
                      <span className="agent-git-sign">{p.right?.type === 'add' ? '+' : ' '}</span>
                      <span className={`agent-git-code ${p.right ? p.right.type : 'pad'}`}>{p.right ? renderCodeWithHighlights(p.right.text, p.right.highlights) : ' '}</span>
                    </div>
                  ))
                }
                return b.rows.map((r, i) => (
                  <div
                    className={`agent-git-row ${r.type}`}
                    key={`h-${bi}-${i}`}
                    title="跳转到源文件此行"
                    onClick={() => onOpen(file.path, r.newLine ?? r.oldLine)}
                  >
                    <span className="agent-git-ln">{r.oldLine ?? ''}</span>
                    <span className="agent-git-ln">{r.newLine ?? ''}</span>
                    <span className="agent-git-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                    <span className="agent-git-code">{renderCodeWithHighlights(r.text, r.highlights)}</span>
                  </div>
                ))
              }
              // 未改动间隔：<10 行不显示折叠提示（两端上下文已随相邻 hunk 展示）；
              // ≥10 行（含第 10 行）才折叠为「N 个隐藏的行」，展开后显示行号区间。
              if (b.count < 10) return null
              const open = expandedGaps[bi]
              if (!open) {
                return (
                  <button key={`g-${bi}`} className="agent-git-more agent-git-hidden-hint" onClick={() => setExpandedGaps(s => ({ ...s, [bi]: true }))}>
                    <span className="agent-git-hint-text">{b.count} 个隐藏的行</span>
                    <span className="agent-git-code" />
                  </button>
                )
              }
              return (
                <React.Fragment key={`g-${bi}`}>
                  {gapContent[bi] ? gapContent[bi]!.map((line, li) => (
                    <div className={`agent-git-row${mode === 'split' ? ' split' : ''}`} key={`gl-${bi}-${li}`}>
                      <span className="agent-git-ln">{b.startLine + li}</span>
                      {mode === 'split' ? (
                        <>
                          <span className="agent-git-sign"> </span>
                          <span className="agent-git-code ctx">{line}</span>
                          <span className="agent-git-ln">{b.startLine + li}</span>
                          <span className="agent-git-sign"> </span>
                          <span className="agent-git-code ctx">{line}</span>
                        </>
                      ) : (
                        <>
                          <span className="agent-git-ln" />
                          <span className="agent-git-sign"> </span>
                          <span className="agent-git-code">{line}</span>
                        </>
                      )}
                    </div>
                  )) : <div className="agent-git-note">加载中…</div>}
                  <button className="agent-git-more" onClick={() => setExpandedGaps(s => ({ ...s, [bi]: false }))}>收起</button>
                </React.Fragment>
              )
            })}
          </div>
        )
      )}
    </div>
  )
})

// ── 数形视图：把变更文件按目录层级组织成可折叠树 ──
type GitTreeNode =
  | { kind: 'dir'; name: string; path: string; children: GitTreeNode[] }
  | { kind: 'file'; name: string; path: string; file: GitFileChange }

function buildGitTree(files: GitFileChange[]): GitTreeNode[] {
  const root: Extract<GitTreeNode, { kind: 'dir' }> = { kind: 'dir', name: '', path: '', children: [] }
  for (const f of files) {
    const segs = f.path.split('/')
    let cur = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!
      let next = cur.children.find((c): c is Extract<GitTreeNode, { kind: 'dir' }> => c.kind === 'dir' && c.name === seg)
      if (!next) {
        next = { kind: 'dir', name: seg, path: cur.path ? `${cur.path}/${seg}` : seg, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    cur.children.push({ kind: 'file', name: baseName(f.path), path: f.path, file: f })
  }
  // 目录在前、文件在后，各自按名称排序（目录树的自然阅读顺序）
  const sortRec = (n: Extract<GitTreeNode, { kind: 'dir' }>) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const c of n.children) if (c.kind === 'dir') sortRec(c)
  }
  sortRec(root)
  return root.children
}

function countTreeFiles(node: GitTreeNode): number {
  if (node.kind === 'file') return 1
  return node.children.reduce((s, c) => s + countTreeFiles(c), 0)
}

// 递归目录节点：折叠状态由父层 collapsedDirs 集合统一管理（重渲染不丢）。
// 叶子文件复用 GitFileBlock（hideDir：目录信息由树的层级体现，叶子上不再重复）。
function GitTreeDir({ node, depth, collapsedDirs, toggleDir, renderFile }: {
  node: Extract<GitTreeNode, { kind: 'dir' }>
  depth: number
  collapsedDirs: Set<string>
  toggleDir: (path: string) => void
  renderFile: (file: GitFileChange, depth: number) => React.ReactNode
}) {
  const open = !collapsedDirs.has(node.path)
  const fileCount = countTreeFiles(node)
  return (
    <div className="agent-git-tree-dir">
      <div className="agent-git-tree-head" style={{ paddingLeft: depth * 14 }} onClick={() => toggleDir(node.path)}>
        <ChevronRightIcon size={12} className={`agent-git-chev ${open ? 'open' : ''}`} />
        {open ? <FolderOpenIcon size={13} className="agent-git-tree-folder" /> : <FolderIcon size={13} className="agent-git-tree-folder" />}
        <span className="agent-git-tree-name">{node.name}</span>
        <span className="agent-git-tree-count">{fileCount}</span>
      </div>
      {open && node.children.map(c =>
        c.kind === 'dir'
          ? <GitTreeDir key={`d-${c.path}`} node={c} depth={depth + 1} collapsedDirs={collapsedDirs} toggleDir={toggleDir} renderFile={renderFile} />
          : <React.Fragment key={`f-${c.path}`}>{renderFile(c.file, depth + 1)}</React.Fragment>
      )}
    </div>
  )
}

export default function AgentGitDiff({ data, loading, onRefresh, onOpenFile, workspaceDir, focusPath, onFocusHandled, currentBranch, branches, checkoutBranch }: {
  data: GitChangesData | null
  loading: boolean
  onRefresh: () => void
  onOpenFile: (absPath: string, line?: number) => void
  workspaceDir: string
  // 定位目标（绝对路径）：打开面板后自动展开并滚到该文件的 diff；处理完毕后回调清除
  focusPath?: string | null
  onFocusHandled?: () => void
  // 「分支」作用域用：分支清单与当前分支来自 useAgentGit（与输入区那个分支选择器同一份状态），
  // checkout 也走它的回调，这样切换后输入区的分支名会一起更新
  currentBranch?: string | null
  branches?: string[]
  checkoutBranch?: (branch: string) => void | Promise<void>
}) {
  const [allExpanded, setAllExpanded] = useState(false)  // 默认全部折叠（单文件级）
  // 分区级折叠：整段「已暂存的更改 / 更改」可各自收起
  const [sectionCollapsed, setSectionCollapsed] = useState<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false })
  // 视图切换：数形（目录树）/ 列表（平铺）；选择持久化，下次打开保持
  const [view, setView] = useState<'tree' | 'list'>(() => (localStorage.getItem('agent-git-view') === 'tree' ? 'tree' : 'list'))
  const switchView = useCallback((v: 'tree' | 'list') => {
    setView(v)
    try { localStorage.setItem('agent-git-view', v) } catch { /* 存储不可用 */ }
  }, [])
  // ── 顶部五区所需状态 ──
  // 第 1 区：作用域（未提交/未暂存/已暂存/已提交/分支），选择持久化
  const [scope, setScope] = useState<GitScope>(readScope)
  const switchScope = useCallback((s: GitScope) => {
    setScope(s)
    try { localStorage.setItem('agent-git-scope', s) } catch { /* 存储不可用 */ }
  }, [])
  // 第 3 区：diff 排版。堆叠/拆分互斥，自动换行是可与两者叠加的独立勾选项
  const [mode, setMode] = useState<DiffMode>(() => (localStorage.getItem('agent-git-diff-mode') === 'split' ? 'split' : 'stacked'))
  const [wrap, setWrap] = useState(() => localStorage.getItem('agent-git-diff-wrap') === '1')
  const pickMode = useCallback((m: DiffMode) => {
    setMode(m)
    try { localStorage.setItem('agent-git-diff-mode', m) } catch { /* 存储不可用 */ }
  }, [])
  const toggleWrap = useCallback(() => {
    const next = !wrap
    setWrap(next)
    try { localStorage.setItem('agent-git-diff-wrap', next ? '1' : '0') } catch { /* 存储不可用 */ }
  }, [wrap])
  // 三个顶部浮层（作用域 / 显示模式 / 跳转文件）：一律 portal 到 body，点外与 Esc 交给同一个 hook 收
  const [scopeOpen, setScopeOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpQuery, setJumpQuery] = useState('')
  const scopeBtnRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const modeBtnRef = useRef<HTMLButtonElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const jumpBtnRef = useRef<HTMLButtonElement>(null)
  const jumpMenuRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(scopeOpen, setScopeOpen, scopeBtnRef, undefined, scopeMenuRef)
  usePopoverDismiss(modeOpen, setModeOpen, modeBtnRef, undefined, modeMenuRef)
  usePopoverDismiss(jumpOpen, setJumpOpen, jumpBtnRef, undefined, jumpMenuRef)
  // 菜单项图标动画：鼠标落在整行都要转，所以按 key 存句柄手动 start/stop
  // （图标不传 ref 时它只监听自身 hover，指针停在文字上是不会动的）
  const menuIconRefs = useRef(new Map<string, AniIconHandle>())
  const bindMenuIcon = (key: string) => (el: AniIconHandle | null) => {
    if (el) menuIconRefs.current.set(key, el)
    else menuIconRefs.current.delete(key)
  }
  const menuIconHover = (key: string) => ({
    onMouseEnter: () => menuIconRefs.current.get(key)?.startAnimation(),
    onMouseLeave: () => menuIconRefs.current.get(key)?.stopAnimation(),
  })
  // 第 1 区「已提交」：历史列表 + 就地展开某一次提交的 diff（首次点开才取数）
  const [commits, setCommits] = useState<GitCommitItem[] | null>(null)
  const [commitsError, setCommitsError] = useState<string | null>(null)
  const [openCommit, setOpenCommit] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<Record<string, GitFileChange[]>>({})
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null)
  useEffect(() => {
    if (scope !== 'committed' || !workspaceDir) return
    let alive = true
    setCommits(null); setCommitsError(null); setOpenCommit(null); setCommitDiffError(null)
    void window.api.gitLog(workspaceDir)
      .then(r => { if (!alive) return; if (r.error) setCommitsError(r.error); setCommits(r.commits) })
      .catch(e => { if (alive) setCommitsError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [scope, workspaceDir])
  const toggleCommit = useCallback(async (hash: string) => {
    if (openCommit === hash) { setOpenCommit(null); return }
    setOpenCommit(hash)
    setCommitDiffError(null)
    if (commitFiles[hash]) return
    try {
      const r = await window.api.gitCommitDiff(workspaceDir, hash)
      if (r.error) setCommitDiffError(r.error)
      setCommitFiles(prev => ({ ...prev, [hash]: r.files }))
    } catch (e) {
      setCommitDiffError(e instanceof Error ? e.message : String(e))
    }
  }, [openCommit, commitFiles, workspaceDir])
  // 分支切换走上层 useAgentGit 的回调（它会同步刷新输入区那个分支名），切完再取一次变更清单
  const handleCheckout = useCallback(async (branch: string) => {
    await checkoutBranch?.(branch)
    onRefresh()
  }, [checkoutBranch, onRefresh])
  // 打开文件回调固定引用：内联函数会击穿 GitFileBlock 的 memo，任意父层重渲染都会重渲染全部文件块
  const openFile = useCallback((relPath: string, line?: number) => {
    const root = workspaceDir.replace(/[\\/]+$/, '')
    onOpenFile(`${root}/${relPath}`, line)
  }, [workspaceDir, onOpenFile])
  // 暂存/取消暂存操作
  const handleStage = useCallback(async (path: string) => {
    const res = await window.api.gitStageFile(workspaceDir, path)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const handleUnstage = useCallback(async (path: string) => {
    const res = await window.api.gitUnstageFile(workspaceDir, path)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const handleDiscard = useCallback(async (path: string) => {
    const res = await window.api.gitDiscardFile(workspaceDir, path)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const handleStageAll = useCallback(async () => {
    const res = await window.api.gitStageAll(workspaceDir)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const handleUnstageAll = useCallback(async () => {
    const res = await window.api.gitUnstageAll(workspaceDir)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const handleDiscardAll = useCallback(async () => {
    const res = await window.api.gitDiscardAll(workspaceDir)
    if (res.success) onRefresh()
  }, [workspaceDir, onRefresh])
  const staged = data?.staged ?? []
  const unstaged = data?.unstaged ?? []
  const total = staged.length + unstaged.length
  // 当前作用域下的变更文件清单：第 2 区统计与第 4 区跳转列表都从它取；已提交/分支作用域没有工作区清单
  const scopeFiles = useMemo<GitFileChange[]>(() => {
    if (scope === 'staged') return staged
    if (scope === 'unstaged') return unstaged
    if (scope === 'uncommitted') return [...staged, ...unstaged]
    return []
  }, [scope, staged, unstaged])
  const isFileScope = scope === 'uncommitted' || scope === 'unstaged' || scope === 'staged'
  // 数形视图：两个分区各自的目录树（staged/unstaged 语义独立，树也各自构建）
  const stagedTree = useMemo(() => buildGitTree(staged), [staged])
  const unstagedTree = useMemo(() => buildGitTree(unstaged), [unstaged])
  // 定位目标匹配：绝对路径归一化（反斜杠→正斜杠、小写）后与各变更文件比对
  const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const focusRel = useMemo(() => {
    if (!focusPath || !data?.isRepo) return null
    const root = normPath(workspaceDir)
    const target = normPath(focusPath)
    const hit = [...staged, ...unstaged].find(f => `${root}/${normPath(f.path)}` === target || normPath(f.path) === target)
    return hit ? hit.path : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath, data, workspaceDir])
  // 数据就绪后消费定位请求（子组件已先完成展开+滚动）；未命中也消费，避免陈旧聚焦残留
  useEffect(() => {
    if (!focusPath || loading || !data) return
    const t = setTimeout(() => onFocusHandled?.(), 100)
    return () => clearTimeout(t)
  }, [focusPath, loading, data, onFocusHandled])
  // 顶部统计（第 2 区）与跳转列表（第 4 区）共用这一份逐文件增删行数，避免把 diff 再解析一遍
  const stats = useMemo(() => {
    const byPath = new Map<string, { added: number; removed: number }>()
    let added = 0, removed = 0
    for (const f of scopeFiles) {
      const rows = f.untracked ? contentToRows(f.content || '') : parseUnifiedDiff(f.diff).rows
      let a = 0, d = 0
      for (const r of rows) { if (r.type === 'add') a++; else if (r.type === 'del') d++ }
      if (!byPath.has(f.path)) byPath.set(f.path, { added: a, removed: d })
      added += a; removed += d
    }
    return { byPath, added, removed }
  }, [scopeFiles])
  // 跳转列表按路径去重（同一文件可同时出现在已暂存与未暂存两组里）
  const jumpFiles = useMemo(() => Array.from(new Map(scopeFiles.map(f => [f.path, f])).values()), [scopeFiles])
  const jumpList = useMemo(() => {
    const q = jumpQuery.trim().toLowerCase()
    const list = q ? jumpFiles.filter(f => f.path.toLowerCase().includes(q)) : jumpFiles
    return list.slice(0, 200)
  }, [jumpFiles, jumpQuery])
  const renderGroup = (title: string, list: GitFileChange[], key: 'staged' | 'unstaged', tree: GitTreeNode[], actions?: React.ReactNode) => {
    if (list.length === 0) return null
    const collapsed = sectionCollapsed[key]
    return (
      <div className="agent-git-section">
        <div className="agent-git-section-head" onClick={() => setSectionCollapsed(s => ({ ...s, [key]: !s[key] }))}>
          <ChevronRightIcon size={12} className={`agent-git-chev ${collapsed ? '' : 'open'}`} />
          <span className="agent-git-section-title">{title}</span>
          <span className="agent-git-section-count">{list.length}</span>
          {actions && <span className="agent-git-section-actions" onClick={e => e.stopPropagation()}>{actions}</span>}
        </div>
        {!collapsed && (view === 'tree'
          ? tree.map(n =>
              n.kind === 'dir'
                ? <GitTreeDir key={`d-${n.path}`} node={n} depth={0} collapsedDirs={collapsedDirs} toggleDir={toggleDir} renderFile={renderTreeFile} />
                : <React.Fragment key={`f-${n.path}`}>{renderTreeFile(n.file, 0)}</React.Fragment>)
          : list.map(f => <GitFileBlock key={`${key}-${f.path}`} file={f} onOpen={openFile} forceCollapsed={!allExpanded} onStage={handleStage} onUnstage={handleUnstage} onDiscard={handleDiscard} focused={focusRel === f.path || jumpTarget === f.path} mode={mode} wrap={wrap} />))}
      </div>
    )
  }
  // 数形视图的目录折叠集合（默认全部展开；集合里的是收起的目录）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  // 第 4 区「跳转到文件」：复用外部定位那套（自动展开＋滚动＋短暂高亮），
  // 消费后立刻清除标记，这样连着点同一个文件还能再滚一次
  const [jumpTarget, setJumpTarget] = useState<string | null>(null)
  const jumpToFile = useCallback((path: string) => {
    setJumpOpen(false)
    setSectionCollapsed({ staged: false, unstaged: false })
    setJumpTarget(path)
  }, [])
  useEffect(() => {
    if (!jumpTarget) return
    const t = setTimeout(() => setJumpTarget(null), 150)
    return () => clearTimeout(t)
  }, [jumpTarget])
  const renderTreeFile = useCallback((f: GitFileChange, depth: number) => (
    <div key={`tf-${f.path}`} style={{ paddingLeft: depth * 12 }}>
      <GitFileBlock file={f} onOpen={openFile} forceCollapsed={!allExpanded} onStage={handleStage} onUnstage={handleUnstage} onDiscard={handleDiscard} focused={focusRel === f.path || jumpTarget === f.path} hideDir mode={mode} wrap={wrap} />
    </div>
  ), [openFile, allExpanded, handleStage, handleUnstage, handleDiscard, focusRel, jumpTarget, mode, wrap])
  const branchListData = branches ?? []
  // 收起/展开按钮的可用性：文件作用域看当前清单，已提交作用域看有没有展开出文件块
  const canCollapse = scopeFiles.length > 0 || Object.keys(commitFiles).length > 0
  return (
    <div className="agent-git">
      <div className="agent-git-header">
        {/* ── 第 1 区：作用域菜单（未提交/未暂存/已暂存/已提交/分支），名称右侧上下箭头 ── */}
        <button
          ref={scopeBtnRef}
          className={`agent-git-menu-btn${scopeOpen ? ' on' : ''}`}
          onClick={() => setScopeOpen(v => !v)}
          title="切换变更范围"
        >
          <span className="agent-git-menu-text">{SCOPE_LABEL[scope]}</span>
          <ArrowUpDownIcon size={11} className="agent-git-menu-caret" />
        </button>
        {/* ── 第 2 区：修改统计（跟随当前作用域）── */}
        {data?.isRepo && (
          <span className="agent-git-summary">
            {isFileScope ? `${scopeFiles.length} 个文件` : scope === 'committed' ? `${commits === null ? '…' : commits.length} 条提交` : `${branchListData.length} 个分支`}
            {isFileScope && scopeFiles.length > 0 && <span className="agent-git-total-stat"><span className="add">+{stats.added}</span><span className="del">−{stats.removed}</span></span>}
          </span>
        )}
        <span className="agent-git-spacer" />
        {/* ── 第 3 区：Diff 显示模式（堆叠/拆分互斥，自动换行可叠加）── */}
        <button
          ref={modeBtnRef}
          className={`agent-git-menu-btn${modeOpen ? ' on' : ''}`}
          onClick={() => setModeOpen(v => !v)}
          title={mode === 'split' ? 'Diff 显示模式：拆分' : 'Diff 显示模式：堆叠'}
        >
          <DiffIcon size={12} />
          {wrap && <WrapTextIcon size={11} className="agent-git-menu-tag" />}
        </button>
        {/* ── 第 4 区：跳转到文件（带搜索，只在有变更文件清单的作用域出现）── */}
        {isFileScope && scopeFiles.length > 0 && (
          <button
            ref={jumpBtnRef}
            className={`agent-git-menu-btn${jumpOpen ? ' on' : ''}`}
            onClick={() => setJumpOpen(v => !v)}
            title="跳转到文件"
          >
            <FileSearchIcon size={12} />
          </button>
        )}
        {/* ── 第 5 区：全部收起 / 展开 ── */}
        <button
          className="agent-git-collapse-all"
          onClick={() => setAllExpanded(v => !v)}
          title={allExpanded ? '全部收起' : '全部展开'}
          disabled={!canCollapse}
        >
          {allExpanded ? <ChevronsUpIcon size={14} /> : <ChevronsDownIcon size={14} />}
        </button>
        {/* 保留在最右：视图切换（数形/列表，仅文件作用域）＋刷新 */}
        {isFileScope && (
          <div className="agent-git-viewswitch">
            <button className={view === 'tree' ? 'on' : ''} title="以数形方式查看（目录树）" onClick={() => switchView('tree')}>
              <FolderIcon size={12} />
            </button>
            <button className={view === 'list' ? 'on' : ''} title="以列表方式查看" onClick={() => switchView('list')}>
              <AlignJustifyIcon size={12} />
            </button>
          </div>
        )}
        <button className="agent-git-refresh" onClick={() => onRefresh()}>
          <RefreshCwIcon size={12} className={loading ? 'spin' : ''} />
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
        ) : scope === 'committed' ? (
          /* ── 已提交：历史列表，点一条就地展开该次提交的 diff ── */
          <div className="agent-git-commits">
            {commits === null ? (
              <div className="agent-git-empty">正在读取提交历史…</div>
            ) : commitsError ? (
              <div className="agent-git-empty">{commitsError}</div>
            ) : commits.length === 0 ? (
              <div className="agent-git-empty">这个仓库还没有提交。</div>
            ) : commits.map(c => (
              <div className="agent-git-commit" key={c.hash}>
                <div className="agent-git-commit-head" onClick={() => void toggleCommit(c.hash)}>
                  <ChevronRightIcon size={12} className={`agent-git-chev ${openCommit === c.hash ? 'open' : ''}`} />
                  <GitCommitHorizontalIcon size={12} className="agent-git-commit-dot" />
                  <span className="agent-git-commit-subject" title={c.subject}>{c.subject}</span>
                  <span className="agent-git-commit-meta">
                    <span className="agent-git-commit-hash">{c.shortHash}</span>
                    <span className="agent-git-commit-author">{c.author}</span>
                    <span className="agent-git-commit-time" title={new Date(c.time).toLocaleString('zh-CN')}>{new Date(c.time).toLocaleDateString('zh-CN')}</span>
                  </span>
                </div>
                {openCommit === c.hash && (
                  <div className="agent-git-commit-body">
                    {commitDiffError && <div className="agent-git-note">{commitDiffError}</div>}
                    {!commitFiles[c.hash] ? (
                      <div className="agent-git-note">正在读取该提交的差异…</div>
                    ) : commitFiles[c.hash]!.length === 0 ? (
                      <div className="agent-git-note">该提交没有文本差异。</div>
                    ) : (
                      commitFiles[c.hash]!.map(f => <GitFileBlock key={`${c.hash}-${f.path}`} file={f} onOpen={openFile} forceCollapsed={!allExpanded} mode={mode} wrap={wrap} />)
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : scope === 'branch' ? (
          /* ── 分支：本地分支清单，当前分支打勾，点一条即切换 ── */
          <div className="agent-git-branches">
            {branchListData.length === 0 ? (
              <div className="agent-git-empty">没有本地分支。</div>
            ) : branchListData.map(b => (
              <button
                className={`agent-git-branch${b === currentBranch ? ' on' : ''}`}
                key={b}
                disabled={b === currentBranch}
                onClick={() => void handleCheckout(b)}
              >
                <GitBranchIcon size={12} className="agent-git-branch-icon" />
                <span className="agent-git-branch-name">{b}</span>
                {b === currentBranch && <CheckIcon size={12} className="agent-git-branch-check" />}
              </button>
            ))}
          </div>
        ) : total === 0 ? (
          <div className="agent-git-empty">工作区没有未提交的改动。</div>
        ) : (
          <>
            {(scope === 'uncommitted' || scope === 'staged') && renderGroup('已暂存的更改', staged, 'staged', stagedTree, (
              <button className="agent-git-copy agent-git-stage-remove" title="取消所有暂存" onClick={handleUnstageAll}>
                <MinusIcon size={12} />
              </button>
            ))}
            {(scope === 'uncommitted' || scope === 'unstaged') && renderGroup('更改', unstaged, 'unstaged', unstagedTree, (
              <>
                <button className="agent-git-copy agent-git-discard" title="取消所有更改" onClick={handleDiscardAll}>
                  <HistoryIcon size={12} />
                </button>
                <button className="agent-git-copy agent-git-stage-add" title="暂存所有更改" onClick={handleStageAll}>
                  <PlusIcon size={12} />
                </button>
              </>
            ))}
          </>
        )}
      </div>
      {/* ── 三个顶部浮层：一律 portal 到 body（header 的 overflow:hidden 会裁掉内部绝对定位元素）── */}
      <GitHeaderPopover open={scopeOpen} btnRef={scopeBtnRef} menuRef={scopeMenuRef} panelClass="file-tree-ctx-menu">
        {SCOPE_ORDER.map(s => {
          const key = `scope-${s}`
          const Icon = SCOPE_ICON[s]
          return (
            <button key={s} className="file-tree-ctx-item" onClick={() => { switchScope(s); setScopeOpen(false) }} {...menuIconHover(key)}>
              <Icon ref={bindMenuIcon(key)} size={13} />
              <span>{SCOPE_LABEL[s]}</span>
              {s === scope && <CheckIcon size={13} className="agent-git-menu-check" />}
            </button>
          )
        })}
      </GitHeaderPopover>
      <GitHeaderPopover open={modeOpen} btnRef={modeBtnRef} menuRef={modeMenuRef} panelClass="file-tree-ctx-menu">
        <button className="file-tree-ctx-item" onClick={() => { pickMode('stacked'); setModeOpen(false) }} {...menuIconHover('mode-stacked')}>
          <AlignJustifyIcon ref={bindMenuIcon('mode-stacked')} size={13} />
          <span>堆叠</span>
          {mode === 'stacked' && <CheckIcon size={13} className="agent-git-menu-check" />}
        </button>
        <button className="file-tree-ctx-item" onClick={() => { pickMode('split'); setModeOpen(false) }} {...menuIconHover('mode-split')}>
          <ChevronsLeftRightIcon ref={bindMenuIcon('mode-split')} size={13} />
          <span>拆分</span>
          {mode === 'split' && <CheckIcon size={13} className="agent-git-menu-check" />}
        </button>
        <button className="file-tree-ctx-item" onClick={() => { toggleWrap(); setModeOpen(false) }} {...menuIconHover('mode-wrap')}>
          <WrapTextIcon ref={bindMenuIcon('mode-wrap')} size={13} />
          <span>自动换行</span>
          {wrap && <CheckIcon size={13} className="agent-git-menu-check" />}
        </button>
      </GitHeaderPopover>
      <GitHeaderPopover open={jumpOpen} btnRef={jumpBtnRef} menuRef={jumpMenuRef} panelClass="agent-git-jump">
        <div className="agent-git-jump-search">
          <SearchIcon size={11} className="agent-git-jump-search-icon" />
          <input
            className="agent-git-jump-input"
            value={jumpQuery}
            onChange={e => setJumpQuery(e.target.value)}
            placeholder="搜索变更文件…"
            spellCheck={false}
            autoFocus
          />
          {jumpQuery && <button className="agent-git-jump-clear" onClick={() => setJumpQuery('')}><XIcon size={11} /></button>}
        </div>
        <div className="agent-git-jump-list">
          {jumpList.length === 0 ? (
            <div className="agent-git-empty">无匹配文件</div>
          ) : jumpList.map(f => {
            const st = stats.byPath.get(f.path)
            const { Icon: FIcon, color: fColor } = fileMeta(f.path)
            return (
              <button className="agent-git-jump-item" key={f.path} title={f.path} onClick={() => jumpToFile(f.path)}>
                <FIcon size={11} style={{ color: fColor }} />
                <span className="agent-git-jump-name">{baseName(f.path)}</span>
                <span className="agent-git-jump-dir">{dirName(f.path)}</span>
                <span className="agent-git-stat">
                  <span className="add">+{st?.added ?? 0}</span>
                  <span className="del">−{st?.removed ?? 0}</span>
                </span>
              </button>
            )
          })}
        </div>
      </GitHeaderPopover>
    </div>
  )
}
