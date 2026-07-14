import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Send, Square, Paperclip, X, FileText, Bot, User, FolderOpen, Plus, Trash2, AlertCircle, Wrench, Loader2, ChevronRight, ChevronDown, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, Pencil, Brain, RefreshCw, Eye, FilePlus2, FileSearch, TerminalSquare, Clock, CheckCircle2, XCircle, Search } from 'lucide-react'
import { useStore } from '../store/useStore'
import { safeCall } from '../utils/safeCall'
import { getToolDefinitions, executeToolCall } from '../utils/tools'
import { setWorkspaceRoot, getWorkspaceRoot } from '../tools/workspaceRoot'
import { getFileReadPrompt } from '../tools/FileReadTool/prompt'
import { getFileWritePrompt } from '../tools/FileWriteTool/prompt'
import { getFileEditPrompt } from '../tools/FileEditTool/prompt'
import { getGlobPrompt } from '../tools/GlobTool/prompt'
import { getGrepPrompt } from '../tools/GrepTool/prompt'
import { getBashPrompt } from '../tools/BashTool/prompt'
import { getFileDeletePrompt } from '../tools/FileDeleteTool/prompt'
import AgentFileTree from './AgentFileTree'
import CodeBlock from './CodeBlock'

import type { AgentMessage, AgentSession, AgentProject, Attachment } from '../../../shared/types'

type ApiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

let idCounter = 0
function newId(prefix = 'x') { return `${prefix}-${++idCounter}` }
function newMsgId() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
// 项目 / 会话 id 需要跨重启全局唯一：每个会话会落盘为独立文件，
// 若使用会归零的计数器 id，不同启动的会话可能映射到同一文件名而被互相覆盖。
function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function dirName(p: string) { return p.split('\\').pop()?.split('/').pop() || p }

// 工具头部预览摘要（参考 pi-web：显示文件名 / 命令 / 模式等主要参数；文件路径只取文件名）
function getToolPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  if (pick('command')) return pick('command').slice(0, 120)
  if (pick('file_path')) return dirName(pick('file_path'))
  if (pick('path')) return dirName(pick('path'))
  if (pick('pattern')) return pick('pattern')
  if (pick('query')) return pick('query')
  const keys = Object.keys(o)
  if (!keys.length) return ''
  const first = o[keys[0]!]
  return typeof first === 'string' ? first.slice(0, 120) : ''
}

// 由 old/new 文本计算「分栏 diff」：左列为原内容、右列为新内容，标注 +/-
type DiffRow = { type: 'equal' | 'del' | 'ins'; left: string | null; right: string | null; leftNum: number | null; rightNum: number | null }
function computeSplitDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length, m = b.length
  // LCS 动态规划
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0, j = 0, lnum = 1, rnum = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'equal', left: a[i]!, right: b[j]!, leftNum: lnum, rightNum: rnum }); i++; j++; lnum++; rnum++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', left: a[i]!, right: null, leftNum: lnum, rightNum: null }); i++; lnum++
    } else {
      rows.push({ type: 'ins', left: null, right: b[j]!, leftNum: null, rightNum: rnum }); j++; rnum++
    }
  }
  while (i < n) { rows.push({ type: 'del', left: a[i]!, right: null, leftNum: lnum, rightNum: null }); i++; lnum++ }
  while (j < m) { rows.push({ type: 'ins', left: null, right: b[j]!, leftNum: null, rightNum: rnum }); j++; rnum++ }
  return rows
}

// Edit 工具的分栏 diff 视图（左原内容 / 右新内容，带行号与 +/- 标记）
function ToolEditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = computeSplitDiff(oldText, newText)
  return (
    <div className="agent-tool-diff">
      <div className="agent-tool-diff-head">
        <span>原内容</span>
        <span>新内容</span>
      </div>
      <div className="agent-tool-diff-body">
        {rows.map((r, idx) => (
          <div className={`agent-tool-diff-row ${r.type}`} key={idx}>
            <span className="agent-tool-diff-num left">{r.leftNum ?? ''}</span>
            <pre className="agent-tool-diff-code left">
              {r.type === 'del' && <span className="agent-tool-diff-mark">-</span>}
              {r.left ?? ''}
            </pre>
            <span className="agent-tool-diff-num right">{r.rightNum ?? ''}</span>
            <pre className="agent-tool-diff-code right">
              {r.type === 'ins' && <span className="agent-tool-diff-mark">+</span>}
              {r.right ?? ''}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}

// 带行号的纯文本代码块（用于读取 / 写入文件的文本内容展示）
function LinedPre({ text, maxHeight }: { text: string; maxHeight?: number }) {
  const lines = text.split('\n')
  return (
    <div className="agent-tool-lined" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((line, i) => (
        <div className="agent-tool-lined-row" key={i}>
          <span className="agent-tool-lined-num">{i + 1}</span>
          <span className="agent-tool-lined-code">{line === '' ? ' ' : line}</span>
        </div>
      ))}
    </div>
  )
}

// ── Markdown 渲染（复用全局 CodeBlock 高亮，支持 GFM 表格/列表/math）────
function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '')
  const match = /language-(\w+)/.exec(className || '')
  if (match) {
    return <CodeBlock language={match[1]} value={text} />
  }
  if (text.includes('\n')) {
    return <CodeBlock language="" value={text} />
  }
  return <code className="chat-code-inline">{text}</code>
}

const AgentMarkdown = React.memo(function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{ code: MarkdownCode as any }}
    >
      {content}
    </ReactMarkdown>
  )
})

// ── 工具元信息：中文名 / 描述 / 图标（用于工具调用块展示）────
const TOOL_META: Record<string, { name: string; desc: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  Read: { name: '读取文件', desc: '读取文件内容（自动识别编码，带行号）', icon: Eye },
  Write: { name: '写入文件', desc: '将内容写入文件，自动创建父目录', icon: FilePlus2 },
  Edit: { name: '编辑文件', desc: '替换文件中的文本（支持整体替换）', icon: Pencil },
  Glob: { name: '查找文件', desc: '按文件名模式（glob）查找文件', icon: Search },
  Grep: { name: '搜索内容', desc: '按正则搜索文件内容，支持计数/文件模式', icon: FileSearch },
  Bash: { name: '执行命令', desc: '执行 shell 命令（终端、脚本、编译等）', icon: TerminalSquare },
  get_datetime: { name: '获取时间', desc: '获取当前日期与时间', icon: Clock },
  web_search: { name: '网络搜索', desc: '搜索网页并返回标题、链接与摘要', icon: Search },
  fetch_webpage: { name: '抓取网页', desc: '抓取网页内容并转为纯文本', icon: FileText },
}

	// Agent 工作台暴露文件操作类工具 + Bash 执行（不调用联网 / 时间类工具）
const AGENT_FILE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Delete']

// ── 工具结果与回传模型的截断 ──
// 存储 / 回传模型的最大长度（避免大文件、大 grep 撑爆上下文）
const TOOL_RESULT_LIMIT = 6000
function truncateToolResult(s: string): { text: string; truncated: boolean; total: number } {
  if (s.length <= TOOL_RESULT_LIMIT) return { text: s, truncated: false, total: s.length }
  const note = `\n…（结果过长已截断，仅显示前 ${TOOL_RESULT_LIMIT} / 共 ${s.length} 字符）`
  return { text: s.slice(0, TOOL_RESULT_LIMIT) + note, truncated: true, total: s.length }
}

// 将工具参数格式化为可读 JSON（参数可能为压缩单行字符串或已解析对象）
function formatToolArgs(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw)
    return JSON.stringify(obj, null, 2)
  } catch {
    return raw
  }
}

// 判断工具返回是否为错误结果（工具自身或异常包装均可能返回 { error: ... }）
function isToolErrorResult(s: string): boolean {
  try {
    const o = JSON.parse(s)
    return !!(o && typeof o === 'object' && 'error' in o)
  } catch {
    return false
  }
}

// 将工具参数中的相对路径按当前工作区解析为绝对路径（用于点击预览）
function resolveWorkspacePath(p: string): string {
  if (!p) return ''
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')) return p
  const root = getWorkspaceRoot()
  if (!root) return p
  return root.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '')
}

// ═══════════════════════════════════════════════════════════════════════════
// 以下展示组件提升到「模块作用域」，保证 React.memo 身份稳定。
// 流式期间 AgentCodeView 整页会以 ~100ms 频率重渲染；若这些组件定义在组件内部，
// 每次重渲染都会拿到新的函数身份 → React 视为不同组件而重新挂载，导致：
//   1) React.memo 完全失效；2) ThinkBlock 内部节流状态被重置；
//   3) 已完成消息（工具 diff / KaTeX）被反复重算 → 卡顿。
// 提升到模块作用域后，非流式消息因 props 不变被 memo 跳过，卡顿消除。
// ═══════════════════════════════════════════════════════════════════════════

// ── 思考链（reasoning）解析：把含 <think>...</think> 的内容拆成「思考 / 正文」片段 ──
type ContentSegment = { type: 'text'; value: string } | { type: 'think'; value: string; closed: boolean }
function parseThinkSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  let rest = content
  while (rest.length > 0) {
    const openIdx = rest.indexOf('<think>')
    if (openIdx === -1) {
      if (rest.trim()) segments.push({ type: 'text', value: rest })
      break
    }
    if (openIdx > 0 && rest.slice(0, openIdx).trim()) {
      segments.push({ type: 'text', value: rest.slice(0, openIdx) })
    }
    rest = rest.slice(openIdx + '<think>'.length)
    const closeIdx = rest.indexOf('</think>')
    if (closeIdx === -1) {
      segments.push({ type: 'think', value: rest, closed: false })
      break
    }
    segments.push({ type: 'think', value: rest.slice(0, closeIdx), closed: true })
    rest = rest.slice(closeIdx + '</think>'.length)
  }
  return segments
}

// 思考块渲染节流间隔（参考原生聊天 ChatView 的 THINK_THROTTLE_MS）
const THINK_THROTTLE_MS = 120

const ThinkBlock = React.memo(function ThinkBlock({ value, closed, isStreaming }: { value: string; closed: boolean; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming ?? false)
  const [visible, setVisible] = useState(isStreaming ?? false)
  const userToggledRef = useRef(false)
  const thinking = !closed || isStreaming
  const bodyRef = useRef<HTMLDivElement>(null)

  // 流式期间对 Markdown 渲染做节流（参考原生聊天）：用 setInterval 固定间隔同步渲染内容，
  // 避免每个 token 都触发长文本 + KaTeX 重解析。注意必须用 setInterval 而非「重置型
  // setTimeout」——否则在持续流式（value 频繁变化）时定时器不断被重置，导致显示卡住不动。
  const [renderValue, setRenderValue] = useState(value)
  useEffect(() => {
    if (!thinking) {
      setRenderValue(value)
      return
    }
    setRenderValue(value)
    const timer = setInterval(() => setRenderValue(value), THINK_THROTTLE_MS)
    return () => clearInterval(timer)
  }, [value, thinking])

  useEffect(() => {
    if (userToggledRef.current) return
    if (thinking) {
      setVisible(true)
      requestAnimationFrame(() => setExpanded(true))
      return
    }
    setExpanded(false)
    setVisible(false)
  }, [thinking])

  const prevThinkingRef = useRef(thinking)
  useEffect(() => {
    if (prevThinkingRef.current && !thinking) userToggledRef.current = false
    prevThinkingRef.current = thinking
  }, [thinking])

  const handleToggle = () => {
    userToggledRef.current = true
    if (expanded) { setExpanded(false); setVisible(false) }
    else { setVisible(true); requestAnimationFrame(() => setExpanded(true)) }
  }

  const wasStopped = !thinking && !closed
  return (
    <div className={`chat-think ${thinking ? 'thinking' : ''} ${expanded ? 'expanded' : ''} ${wasStopped ? 'stopped' : ''}`}>
      <button className="chat-think-toggle" onClick={handleToggle}>
        {thinking ? (<span className="chat-think-status"><RefreshCw size={12} className="spin" /> 思考中</span>)
          : wasStopped ? (<span className="chat-think-status"><Brain size={12} /> 思考已中断</span>)
          : (<span className="chat-think-status"><Brain size={12} /> 思考过程</span>)}
        <ChevronDown size={13} className={`chat-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
	      {visible && (
	        <div className={`chat-think-body ${expanded ? 'open' : ''}`} ref={bodyRef}>
	          {/* 收起 300ms 内保留 Markdown 子树不动，让 max-height 过渡在已有 DOM 上跑；
	              流式期间父组件已不会再高频重渲染（store 节流 + 模块级 memo），
	              因此过渡期间 Markdown 不会被重解析，不会卡。 */}
	          {renderValue ? <AgentMarkdown content={renderValue} /> : '（空）'}
	        </div>
	      )}
    </div>
  )
})

const ToolArgsView = React.memo(function ToolArgsView({ name, args, onPreviewFile }: { name: string; args: string; onPreviewFile: (p: string) => void }) {
  const parsed = (() => { try { return JSON.parse(args) } catch { return null } })()
  const filePath = parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : ''
  const isFileEdit = !!parsed && (name === 'Write' || name === 'Edit')
  if (isFileEdit) {
    return (
      <div className="agent-tool-args">
        {name === 'Write' && typeof parsed!.content === 'string' && (
          <div className="agent-tool-content">
            <div className="agent-tool-content-head"><span>写入内容</span></div>
            <LinedPre text={parsed!.content} maxHeight={360} />
          </div>
        )}
        {name === 'Edit' && typeof parsed!.old_string === 'string' && typeof parsed!.new_string === 'string' && (
          <ToolEditDiff oldText={parsed!.old_string} newText={parsed!.new_string} />
        )}
        {filePath && (
          <div className="agent-tool-filebar">
            <button className="agent-tool-call-path" title={filePath} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(filePath)) }}>
              <FileText size={11} /> {dirName(filePath)}
            </button>
          </div>
        )}
      </div>
    )
  }
  const formatted = formatToolArgs(args)
  if (!formatted && !filePath) return null
  return (
    <div className="agent-tool-args">
      {formatted && <pre className="agent-tool-args-pre">{formatted}</pre>}
      {filePath && (
        <div className="agent-tool-filebar">
          <button className="agent-tool-call-path" title={filePath} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(filePath)) }}>
            <FileText size={11} /> {dirName(filePath)}
          </button>
        </div>
      )}
    </div>
  )
})

const ToolResultView = React.memo(function ToolResultView({ result, truncated, total, lined }: { result: string; truncated?: boolean; total?: number; lined?: boolean }) {
  const lines = result.split('\n')
  const lineCount = lines.length
  const [expanded, setExpanded] = useState(lineCount <= 20 && result.length <= 1600)
  const collapsed = lineCount > 12
  const shownText = expanded ? result : (collapsed ? lines.slice(0, 12).join('\n') + '\n…' : result)
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">
          结果{truncated ? `（已截断，共 ${total} 字符）` : `（共 ${lineCount} 行）`}
        </span>
        <button className="agent-tool-subtoggle" onClick={() => setExpanded(v => !v)}>
          <ChevronRight size={11} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
          {expanded ? '收起' : (collapsed ? `展开（显示前 12 / 共 ${lineCount} 行）` : '展开')}
        </button>
      </div>
      {lined ? <LinedPre text={shownText} /> : <pre className="agent-tool-result-pre">{shownText}</pre>}
    </div>
  )
})

const ToolCallCard = React.memo(function ToolCallCard({ tc, index, total, onPreviewFile }: { tc: NonNullable<AgentMessage['toolCalls']>[number]; index: number; total: number; onPreviewFile: (p: string) => void }) {
  const meta = TOOL_META[tc.name]
  const Icon = meta?.icon || Wrench
  const running = tc.result === undefined
  const failed = !running && !!tc.failed
  const [expanded, setExpanded] = useState(running)
  const parsed = (() => { try { return JSON.parse(tc.args || '{}') } catch { return null } })()
  const preview = getToolPreview(parsed)
  const bashCmd = (() => {
    if (tc.name !== 'Bash') return null
    const c = parsed && typeof parsed.command === 'string' ? parsed.command : null
    return c && c.length > 400 ? c.slice(0, 400) + '\n…' : c
  })()
  return (
    <div className={`agent-tool-call tool-${tc.name.toLowerCase()}`}>
      <div className="agent-tool-call-head" onClick={() => setExpanded(v => !v)}>
        <Icon size={13} />
        <span className="agent-tool-call-name">{tc.name}</span>
        {preview && <span className="agent-tool-call-preview" title={preview}>{preview}</span>}
        {total > 1 && <span className="agent-tool-call-step">步骤 {index + 1}/{total}</span>}
        <span className="agent-tool-call-meta">
          {running ? (
            <span className="agent-tool-call-status run"><Loader2 size={12} className="spin" /> 执行中…</span>
          ) : failed ? (
            <span className="agent-tool-call-status err"><XCircle size={12} /> 失败</span>
          ) : (
            <span className="agent-tool-call-status ok"><CheckCircle2 size={12} /> 完成</span>
          )}
          {!running && tc.durationMs != null && <span className="agent-tool-call-dur">{tc.durationMs}ms</span>}
          <ChevronRight size={12} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
        </span>
      </div>
      {expanded && (
        <div className="agent-tool-call-body">
          {tc.name === 'Bash' && bashCmd && (
            <div className="agent-tool-bash">
              <div className="agent-tool-bash-bar"><TerminalSquare size={11} /> 命令</div>
              <pre className="agent-tool-bash-cmd">{bashCmd}</pre>
            </div>
          )}
          {tc.name !== 'Bash' && <ToolArgsView name={tc.name} args={tc.args} onPreviewFile={onPreviewFile} />}
          {running ? (
            <div className="agent-tool-result agent-tool-result-running"><span className="agent-tool-dots" /></div>
          ) : (
            <ToolResultView result={tc.result!} truncated={tc.truncated} total={tc.resultTotal} lined={tc.name === 'Read'} />
          )}
        </div>
      )}
    </div>
  )
})

const ToolCallGroup = React.memo(function ToolCallGroup({ toolCalls, defaultOpen, onPreviewFile }: { toolCalls: NonNullable<AgentMessage['toolCalls']>; defaultOpen?: boolean; onPreviewFile: (p: string) => void }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="agent-tool-group">
      <button className="agent-tool-group-head" onClick={() => setOpen(v => !v)}>
        <ChevronDown size={13} className={`agent-tool-chev ${open ? 'open' : ''}`} />
        <Wrench size={12} />
        <span>工具调用{toolCalls.length > 1 ? `（${toolCalls.length}）` : ''}</span>
      </button>
      {open && (
        <div className="agent-tool-list">
          {toolCalls.map((tc, i) => <ToolCallCard key={tc.id || i} tc={tc} index={i} total={toolCalls.length} onPreviewFile={onPreviewFile} />)}
        </div>
      )}
    </div>
  )
})

export default function AgentCodeView() {
  const cards = useStore(s => s.cards)
  const runningCard = cards.find(c => c.status === 'running')
  const apiBaseUrl = runningCard ? `http://127.0.0.1:${runningCard.template.serverPort}` : null
  const storedProjects = useStore(s => s.agentProjects)
  const setAgentProjects = useStore(s => s.setAgentProjects)

  // 默认占位项目使用固定哨兵 id，便于在用户创建真实项目后将其自动移除
  const DEFAULT_PROJECT_ID = '__agent_default_project__'
  function freshProject(name = '新项目'): AgentProject {
    return { id: DEFAULT_PROJECT_ID, title: name, workspaceDir: '', expanded: true, sessions: [] }
  }
  // 判断是否为「尚未被使用」的空占位项目（未指定目录、无会话）
  function isPlaceholderProject(p: AgentProject): boolean {
    return p.id === DEFAULT_PROJECT_ID && !p.workspaceDir && p.sessions.length === 0
  }

  const [projects, setProjects] = useState<AgentProject[]>(() =>
    storedProjects.length > 0 ? storedProjects : [freshProject('新项目')]
  )

  // 文件预览状态（预览面板显示在文件树右侧独立列）
  const PREVIEW_MAX_BYTES = 128 * 1024
  // 多文件预览标签：可同时打开多个文件并在标签间切换
  interface PreviewTab {
    path: string
    name: string
    content: string | null
    lines: number | null
    truncated: boolean
    loading: boolean
    error: string | null
  }
  const [openTabs, setOpenTabs] = useState<PreviewTab[]>([])
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  const openTabsRef = useRef<PreviewTab[]>([])
  useEffect(() => { openTabsRef.current = openTabs }, [openTabs])
  const activeTab = openTabs.find(t => t.path === activeTabPath) || null
  const isPreviewMarkdown = /\.(md|markdown)$/i.test(activeTabPath || '')

  const openPreview = useCallback(async (path: string) => {
    const name = dirName(path)
    // 已打开则仅切换到该标签，不重复读取
    setOpenTabs(prev => {
      if (prev.some(t => t.path === path)) return prev
      return [...prev, { path, name, content: null, lines: null, truncated: false, loading: true, error: null }]
    })
    setActiveTabPath(path)
    const res = await window.api.readFile(path, { maxBytes: PREVIEW_MAX_BYTES })
    setOpenTabs(prev => prev.map(t => t.path === path ? {
      ...t,
      loading: false,
      error: res.success ? null : (res.error || '读取失败'),
      content: res.success ? (res.content || '') : null,
      lines: res.success ? (res.lines ?? 0) : null,
      truncated: !!res.truncated,
    } : t))
  }, [])

  const closeTab = useCallback((path: string) => {
    const next = openTabsRef.current.filter(t => t.path !== path)
    setOpenTabs(next)
    setActiveTabPath(cur => {
      if (cur !== path) return cur
      return next.length ? next[next.length - 1].path : null
    })
  }, [])

  // 文件树 / 预览面板宽度可调（拖拽左侧边框）；聊天区有最小宽度兜底，避免输入框被遮挡
  const TREE_MIN = 120, TREE_MAX = 480
  const PREVIEW_MIN = 240, PREVIEW_MAX = 760
  const [treeWidth, setTreeWidth] = useState(280)
  const [previewWidth, setPreviewWidth] = useState(360)
  const draggingRef = useRef<{ type: 'tree' | 'preview'; startX: number; startTreeW: number; startPreviewW: number } | null>(null)

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = draggingRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (d.type === 'tree') {
		      // 树拖拽：只改变树宽，预览保持自身宽度跟随树一起平移（整体平移）
		      setTreeWidth(Math.max(TREE_MIN, Math.min(TREE_MAX, d.startTreeW - dx)))
    } else {
		      // 预览拖拽：只改变预览宽度，文件树保持不变（不带动树）
		      const pw = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, d.startPreviewW - dx))
		      setPreviewWidth(pw)
		    }
  }, [])

  const onDragEnd = useCallback(() => {
    draggingRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
  }, [onDragMove])

  const startResize = (type: 'tree' | 'preview') => (e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = { type, startX: e.clientX, startTreeW: treeWidth, startPreviewW: previewWidth }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
  }

  // Persist to store on every change
  useEffect(() => { setAgentProjects(projects) }, [projects, setAgentProjects])

  // 应用启动后，store 从磁盘载入历史项目时，把本地状态同步为已持久化的内容（仅一次）
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    if (storedProjects.length > 0) {
      setProjects(storedProjects)
      setActiveProjectId(storedProjects[0]!.id)
      setActiveSessionId(storedProjects[0]!.sessions[0]?.id || '')
      seededRef.current = true
    }
  }, [storedProjects])
  const [activeProjectId, setActiveProjectId] = useState(projects[0]!.id)
  const [activeSessionId, setActiveSessionId] = useState(projects[0]!.sessions[0]?.id || '')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  // 输入框自动增高
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 聊天滚动容器 + 「是否贴底」标记（仅贴底时自动跟随滚动）
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 生成期间排队的发送（当前轮次结束后自动发出）
  const pendingSendRef = useRef<{ text: string; attachments: Attachment[] } | null>(null)
  // 始终持有最新的 handleSend，避免排队回调使用过期闭包（如切换了会话）
  const handleSendRef = useRef<(text?: string, attachments?: Attachment[]) => void>(() => {})
  // 中止控制：aborted 标记 + 当前流式 Promise 的 resolve，便于在停止时唤醒循环
  const abortRef = useRef<{ aborted: boolean; resolve: (() => void) | null }>({ aborted: false, resolve: null })
  const currentStreamIdRef = useRef<string | null>(null)
  // 历史输入回溯（↑ / ↓）
  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)
  // 附件 / 图片
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; isImage: boolean; dataUrl?: string; content?: string }>>([])
  const [treeOpen, setTreeOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [projRenamingId, setProjRenamingId] = useState<string | null>(null)
  const [projRenameText, setProjRenameText] = useState('')
  const projRenameInputRef = useRef<HTMLInputElement>(null)
  const msgEndRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0]!
  const activeSession = activeProject.sessions.find(s => s.id === activeSessionId) || activeProject.sessions[0] || null
  // 最后一次含工具调用的消息下标，仅该组工具默认展开，其余折叠以减少噪音
  // 工具调用组默认展开（显示工具卡片列表）；卡片详情（参数/结果）仍默认折叠，点击卡片头部再展开
  const toolGroupDefaultOpen = true

  // 滚动时更新「是否贴底」标记（阈值 80px 内视为贴底）
  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  useEffect(() => {
    // 仅当用户已接近底部时才自动跟随，向上翻看历史时不被拽回底部
    if (atBottomRef.current) {
      msgEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [activeSession?.messages])

  // 将当前项目目录设为 Glob/Grep/Bash 等工具的默认工作目录
  useEffect(() => {
    setWorkspaceRoot(activeProject.workspaceDir)
    window.api?.setBashCwd(activeProject.workspaceDir || '').catch(() => {})
  }, [activeProject.workspaceDir])

  const updateProject = useCallback((id: string, upd: Partial<AgentProject>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...upd } : p))
  }, [])

  const updateSessionInProject = useCallback((projId: string, sessId: string, upd: Partial<AgentSession>) => {
    setProjects(prev => prev.map(p => p.id === projId ? ({ ...p, sessions: p.sessions.map(s => s.id === sessId ? ({ ...s, ...upd }) : s) }) : p))
  }, [])

  const createProject = useCallback(async () => {
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return
    const name = dirName(res.path)
    const proj: AgentProject = { id: uniqueId('proj'), title: name, workspaceDir: res.path, expanded: true, sessions: [{ id: uniqueId('sess'), title: '对话 1', messages: [] }] }
    // 创建真实项目后，自动移除仍处于空状态的默认占位项目（避免与新建项目并存）
    setProjects(prev => [...prev.filter(p => !isPlaceholderProject(p)), proj])
    setActiveProjectId(proj.id)
    setActiveSessionId(proj.sessions[0]!.id)
  }, [])

  const deleteProject = useCallback((id: string) => {
    const fallbackProj = freshProject('新项目')
    setProjects(prev => {
      const next = prev.filter(p => p.id !== id)
      if (next.length === 0) return [fallbackProj]
      return next
    })
    setActiveProjectId(prev => prev === id ? fallbackProj.id : prev)
    setActiveSessionId(prev => prev === id ? '' : prev)
  }, [])

  const addSessionToProject = useCallback((projId: string) => {
    const sess: AgentSession = { id: uniqueId('sess'), title: `对话 ${Date.now().toString(36).slice(-4)}`, messages: [] }
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
    setActiveSessionId(sess.id)
  }, [])

  const deleteSession = useCallback((projId: string, sessId: string) => {
    const fallbackId = uniqueId('sess')
    setProjects(prev => prev.map(p => p.id !== projId ? p : {
      ...p,
      sessions: (() => {
        const next = p.sessions.filter(s => s.id !== sessId)
        if (next.length === 0) next.push({ id: fallbackId, title: '对话 1', messages: [] })
        return next
      })()
    }))
    setActiveSessionId(prev => prev === sessId ? fallbackId : prev)
  }, [])

  const handleFileSelect = useCallback((path: string) => {
    setInput(prev => prev ? `${prev}\n${path}` : path)
  }, [])

  // ── 输入框自动增高 ──
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [])

  // ── 附件 / 图片 ──
  async function readAttachmentFile(file: File): Promise<{ isImage: boolean; dataUrl?: string; text: string }> {
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)
    if (isImage) {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result as string)
        r.onerror = () => rej(r.error)
        r.readAsDataURL(file)
      })
      return { isImage: true, dataUrl, text: '' }
    }
    const text = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result as string)
      r.onerror = () => rej(r.error)
      r.readAsText(file)
    })
    return { isImage: false, text }
  }

  const handleAttachmentSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (e.target) e.target.value = ''  // 允许重复选同名文件
    if (files.length === 0) return
    const read = await Promise.all(files.map(readAttachmentFile))
    const next = files.map((f, i) => ({
      id: newId('att'),
      name: f.name,
      isImage: read[i]!.isImage,
      dataUrl: read[i]!.dataUrl,
      content: read[i]!.text,
    }))
    setAttachedFiles(prev => [...prev, ...next])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachedFiles(prev => prev.filter(a => a.id !== id))
  }, [])

  // ── 历史输入回溯（↑ / ↓）──
  const recallHistory = useCallback((dir: number) => {
    const hist = inputHistoryRef.current
    if (hist.length === 0) return
    let idx = historyIdxRef.current
    if (idx === -1) idx = hist.length - 1
    else idx = idx + dir
    if (idx < 0) idx = 0
    if (idx >= hist.length) { historyIdxRef.current = -1; setInput(''); autoResize(); return }
    historyIdxRef.current = idx
    setInput(hist[idx]!)
    autoResize()
  }, [autoResize])

  // ── 停止生成（中止当前流式 + 退出工具循环）──
  const handleStop = useCallback(() => {
    abortRef.current.aborted = true
    if (currentStreamIdRef.current) window.api.abortChatStream(currentStreamIdRef.current)
    window.api.removeChatStreamListener()
    const resolve = abortRef.current.resolve
    if (resolve) { resolve(); abortRef.current.resolve = null }
    currentStreamIdRef.current = null
    setLoading(false)
  }, [])

  // 为已有/默认项目选择或切换工作目录（默认项目 sessions:[] 且 workspaceDir:'' 时也可使用）
  const changeProjectDir = useCallback(async (projId: string) => {
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return
    const proj = projects.find(p => p.id === projId)
    // 若仍为默认占位标题，则一并更新为目录名；已手动重命名的项目保留原标题
    const patch: Partial<AgentProject> = { workspaceDir: res.path }
    if (proj && proj.title === '新项目') patch.title = dirName(res.path)
    updateProject(projId, patch)
  }, [projects, updateProject])

  const startProjRename = (id: string, currentTitle: string) => {
    setProjRenameText(currentTitle)
    setProjRenamingId(id)
    setTimeout(() => projRenameInputRef.current?.focus(), 0)
  }

  const confirmProjRename = () => {
    const text = projRenameText.trim()
    if (text && projRenamingId) updateProject(projRenamingId, { title: text })
    setProjRenamingId(null)
  }

  const startRename = () => {
    if (!activeSession) return
    setRenameText(activeSession.title)
    setRenaming(true)
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }

  const confirmRename = () => {
    const text = renameText.trim()
    if (text) updateSessionInProject(activeProjectId, activeSessionId, { title: text })
    setRenaming(false)
  }

  function buildApiMessages(messages: AgentMessage[]): ApiMessage[] {
    const out: ApiMessage[] = []
    for (const m of messages) {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant', content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } }))
        })
      } else if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        // 多模态：图片作为 image_url，文本文件拼接到正文
        const hasImage = m.attachments.some(a => a.type === 'image' && a.dataUrl)
        if (hasImage) {
          const parts: Array<Record<string, unknown>> = []
          if (m.content) parts.push({ type: 'text', text: m.content })
          for (const a of m.attachments) {
            if (a.type === 'image' && a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
            else if (a.type === 'file' && a.content) parts.push({ type: 'text', text: `\n\nName: ${a.name}\nContents:\n\n=====\n${a.content}\n=====` })
          }
          out.push({ role: 'user', content: parts })
        } else {
          let text = m.content
          for (const a of m.attachments) {
            if (a.type === 'file' && a.content) text += `\n\nName: ${a.name}\nContents:\n\n=====\n${a.content}\n=====`
          }
          out.push({ role: 'user', content: text })
        }
      } else {
        out.push({ role: m.role, content: m.content })
      }
    }
    return out
  }

  const handleSend = useCallback(async (overrideText?: string, overrideAttachments?: Attachment[]) => {
    const attachmentsForSend: Attachment[] = overrideAttachments ?? attachedFiles.map(a => ({
      name: a.name,
      type: a.isImage ? 'image' : 'file',
      dataUrl: a.isImage ? a.dataUrl : undefined,
      content: a.isImage ? undefined : a.content,
    }))
    const text = (overrideText ?? input).trim()
    const hasAttach = attachmentsForSend.length > 0
    if (!apiBaseUrl || !runningCard) {
      // 模型未启动：把建议文本保留在输入框，待启动后手动发送
      if (text) setInput(text)
      return
    }
    if (loading) {
      // 生成 / 工具执行期间：把当前输入排队，待本轮结束后自动发送
      pendingSendRef.current = { text: overrideText ?? input, attachments: attachmentsForSend }
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      setAttachedFiles([])
      return
    }
    if (!text && !hasAttach) return
    // 仅发送「实时输入」时清空输入框；排队消息（override）属于独立消息，不清空用户正在撰写的新内容
    if (overrideText === undefined) {
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    }

    const pid = activeProjectId
    // 确保存在活动会话：默认项目可能尚无会话（sessions:[]），首次发送时就地创建，避免「按两次才发送」
    let sid = activeSessionId
    let baseMessages: AgentMessage[] = activeSession ? activeSession.messages : []
    if (!activeSession) {
      sid = uniqueId('sess')
      const freshSess: AgentSession = {
        id: sid,
        title: text.slice(0, 40),
        messages: []
      }
      setProjects(prev => prev.map(p => p.id === pid ? { ...p, sessions: [...p.sessions, freshSess] } : p))
      setActiveSessionId(sid)
      baseMessages = freshSess.messages
    }

    // 记录历史输入（仅文本），供 ↑ / ↓ 回溯
    if (text) {
      const hist = inputHistoryRef.current
      if (hist[hist.length - 1] !== text) hist.push(text)
      historyIdxRef.current = -1
    }

    // 构建附件（已在上文算好 attachmentsForSend）
    const attachments = attachmentsForSend
    const userHasImages = attachments.some(a => a.type === 'image' && a.dataUrl)
    if (overrideText === undefined) setAttachedFiles([])

    const userMsg: AgentMessage = { id: newMsgId(), role: 'user', content: text, attachments: attachments.length ? attachments : undefined }
    // 仅在该会话尚无任何用户消息时，用首条消息自动生成标题（后续不再覆盖，保留手动重命名）
    const shouldAutoTitle = !baseMessages.some(m => m.role === 'user')
    let displayMsgs: AgentMessage[] = [...baseMessages, userMsg]
    updateSessionInProject(pid, sid, {
      messages: displayMsgs,
      ...(shouldAutoTitle ? { title: (text || '附件对话').slice(0, 40) } : {})
    })
    setLoading(true)
    abortRef.current.aborted = false

	    const port = runningCard.template.serverPort

	    // 构建工具使用指引的系统提示
	    const toolPrompts = [
	      getFileReadPrompt(),
	      getFileWritePrompt(),
	      getFileEditPrompt(),
	      getGlobPrompt(),
	      getGrepPrompt(),
	      getBashPrompt(),
	      getFileDeletePrompt(),
	    ].join('\n\n---\n\n')
	    const systemMsg: ApiMessage = { role: 'system', content: `你是一个编码智能体，可以使用以下工具完成任务。请仔细阅读每个工具的使用说明。\n\n${toolPrompts}` }

	    let apiMsgs: ApiMessage[] = [systemMsg, ...buildApiMessages(displayMsgs)]
	    let maxTurns = 10
    let turn = 0

    // 多模态（图片）与 tools 冲突，含图片时关闭工具调用；否则仅暴露文件操作类工具
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))
    const toolChoice = userHasImages ? 'none' : 'auto'

    try {
      while (maxTurns-- > 0) {
        if (abortRef.current.aborted) break
        const streamId = `agent-${sid}-${++turn}`
        currentStreamIdRef.current = streamId
        const liveId = newMsgId()
        // 先种一颗空的助手消息，用于流式（打字机）填充
        displayMsgs = [...displayMsgs, { id: liveId, role: 'assistant', content: '' }]
        updateSessionInProject(pid, sid, { messages: displayMsgs })

        let streamedText = ''
        let toolCalls: { id: string; function: { name: string; arguments: string } }[] | undefined
        let streamError: string | undefined
        // 流式落盘节流：参考原生聊天，每 ~100ms 同步一次到 store，
        // 避免长思考链逐 token 触发整页重渲染与 KaTeX 重解析导致卡顿
        let lastFlush = 0
        const STREAM_FLUSH_MS = 100

        await new Promise<void>((resolve) => {
          abortRef.current.resolve = resolve
          const onChunk = (data: any) => {
            if (data.streamId !== streamId) return
            if (typeof data.delta === 'string' && data.delta) {
              streamedText += data.delta
              displayMsgs = displayMsgs.slice(0, -1).concat({ id: liveId, role: 'assistant', content: streamedText })
              // 节流：仅每 ~100ms 落盘一次，避免逐 token 整页重渲染
              const now = performance.now()
              if (now - lastFlush >= STREAM_FLUSH_MS) {
                lastFlush = now
                updateSessionInProject(pid, sid, { messages: displayMsgs })
              }
            }
            if (data.done) {
              if (data.toolCalls?.length) toolCalls = data.toolCalls
              if (data.error) streamError = data.error
              // 确保最终内容落盘（节流可能跳过了最后一次增量）
              updateSessionInProject(pid, sid, { messages: displayMsgs })
              window.api.removeChatStreamListener()
              abortRef.current.resolve = null
              resolve()
            }
          }
          window.api.onChatStreamChunk(onChunk)
          window.api.chatStream({ streamId, port, body: { messages: apiMsgs, tools, tool_choice: toolChoice, stream: true, temperature: 0.3, max_tokens: 4096 } })
            .catch((e: any) => { window.api.removeChatStreamListener(); streamError = e?.message || String(e); abortRef.current.resolve = null; resolve() })
        })
        currentStreamIdRef.current = null

        // 用户中止：标记当前助手消息为「已停止」并退出循环
        if (abortRef.current.aborted) {
          displayMsgs = displayMsgs.map(m => m.id === liveId ? { ...m, stopped: true } : m)
          updateSessionInProject(pid, sid, { messages: displayMsgs })
          break
        }

        if (toolCalls && toolCalls.length) {
          // 展示工具调用
          const assistMsg: AgentMessage = { id: liveId, role: 'assistant', content: streamedText, toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments, result: undefined })) }
          displayMsgs = displayMsgs.slice(0, -1).concat(assistMsg)
          updateSessionInProject(pid, sid, { messages: displayMsgs })
          apiMsgs.push({ role: 'assistant', content: streamedText || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments } })) } as ApiMessage)
          for (const tc of toolCalls) {
            let toolResult: string
            let failed = false
            const t0 = performance.now()
            try { const args = parseToolArgs(tc.function.arguments); toolResult = await executeToolCall(tc.function.name, args) } catch (e: any) { toolResult = JSON.stringify({ error: e?.message || String(e) }); failed = true }
            if (!failed && isToolErrorResult(toolResult)) failed = true
            const durationMs = Math.round(performance.now() - t0)
            // 截断后再存储 / 回传模型，避免大文件、大 grep 撑爆上下文
            const capped = truncateToolResult(toolResult)
            const idx = displayMsgs.findIndex(m => m.id === liveId)
            if (idx >= 0) {
              const m = displayMsgs[idx]!
              const newTcs = (m.toolCalls || []).map(t => t.id === tc.id ? { ...t, result: capped.text, truncated: capped.truncated, resultTotal: capped.total, failed, durationMs } : t)
              displayMsgs = displayMsgs.slice(0, idx).concat({ ...m, toolCalls: newTcs }).concat(displayMsgs.slice(idx + 1))
              updateSessionInProject(pid, sid, { messages: displayMsgs })
            }
            apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: capped.text })
          }
          continue
        }

        // 最终文本回复
        if (!streamedText) {
          displayMsgs = displayMsgs.slice(0, -1).concat({ id: liveId, role: 'assistant', content: streamError ? `模型调用失败：${streamError}` : '（无内容返回）' })
          updateSessionInProject(pid, sid, { messages: displayMsgs })
        }
        break
      }
      if (maxTurns <= 0 && !abortRef.current.aborted) {
        updateSessionInProject(pid, sid, { messages: [...displayMsgs, { id: newMsgId(), role: 'assistant' as const, content: '已达到最大工具调用轮次。' }] })
      }
    } catch (e: any) {
      console.error('[AgentCode] send error', e)
      updateSessionInProject(pid, sid, { messages: [...displayMsgs, { id: newMsgId(), role: 'assistant' as const, content: '发送失败：' + (e?.message || String(e)) }] })
    } finally {
      abortRef.current.resolve = null
      currentStreamIdRef.current = null
      setLoading(false)
      // 本轮结束后，自动发送排队中的消息
      const pending = pendingSendRef.current
      pendingSendRef.current = null
      if (pending && (pending.text.trim() || pending.attachments.length)) {
        setTimeout(() => handleSendRef.current(pending.text || undefined, pending.attachments), 0)
      }
    }
  }, [input, attachedFiles, loading, apiBaseUrl, runningCard, activeProjectId, activeSessionId, activeSession, updateSessionInProject])

  // 始终持有最新的 handleSend，供排队回调使用，避免过期闭包
  handleSendRef.current = handleSend

  // 欢迎页建议：模型已启动则直接发送，否则填入输入框待手动发送
  const AGENT_SUGGESTIONS = [
    '讲讲这个代码库的架构',
    '总结最近的 git 改动',
    '智能体的运行主循环在哪，它做了什么？',
    '找出并修复这个项目里的一个 bug',
  ]
  const sendSuggestion = useCallback((text: string) => {
    if (loading || !apiBaseUrl || !runningCard) {
      setInput(text)
      return
    }
    handleSend(text)
  }, [loading, apiBaseUrl, runningCard, handleSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合输入中（中文/日文输入法选词）不触发发送，避免误发消息
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    else if (e.key === 'ArrowUp' && !input) { e.preventDefault(); recallHistory(-1) }
    else if (e.key === 'ArrowDown' && !input) { e.preventDefault(); recallHistory(1) }
  }

  // 兼容 arguments 为字符串或已解析对象两种情况，避免 JSON.parse(object) 抛错
  function parseToolArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw === 'string' && raw.trim()) {
      try { return JSON.parse(raw) } catch { return {} }
    }
    return {}
  }

  const renderToolCalls = (toolCalls: NonNullable<AgentMessage['toolCalls']>, defaultOpen: boolean) => (
    <ToolCallGroup toolCalls={toolCalls} defaultOpen={defaultOpen} onPreviewFile={openPreview} />
  )

  // 工具组件（ToolArgsView / ToolResultView / ToolCallCard / ToolCallGroup）、
  // 思考链组件（parseThinkSegments / ThinkBlock）已提升到模块作用域（见行 208 之前），
  // 此处不再定义，避免身份不稳定导致的 React.memo 失效。


  return (
    <div className="agent-code-view">
      <div className="agent-code-topbar">
        <div className="agent-code-topbar-left">
          <button className="chat-collapse-btn" onClick={() => setSidebarOpen(v => !v)} title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} style={{ marginTop: 0, width: 28, height: 28 }}>
            {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          {renaming ? (
            <input ref={renameInputRef} className="agent-code-rename-input" value={renameText} onChange={e => setRenameText(e.target.value)} onBlur={confirmRename} onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenaming(false) }} />
          ) : (
            <span className="agent-code-topbar-title">{activeSession ? activeSession.title : activeProject.title}</span>
          )}
          {activeSession && <button className="btn btn-xs" onClick={startRename} title="修改标题"><Pencil size={12} /></button>}
        </div>
        <div className="agent-code-topbar-right">
          {!apiBaseUrl && <span className="agent-code-warning"><AlertCircle size={12} /> 请先启动模型</span>}
          <button className="btn btn-xs" onClick={() => setTreeOpen(v => !v)} title={treeOpen ? '收起文件树' : '展开文件树'}>
            {treeOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
          </button>
        </div>
      </div>

      <div className={`agent-code-body ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <div className="agent-code-sidebar-collapser">
        <div className="agent-code-sidebar">
          <button className="agent-code-session-new-btn" onClick={createProject}>
            <FolderOpen size={14} /> 新建项目
          </button>
          <div className="agent-code-sidebar-header"><span>项目</span></div>
          <div className="agent-code-session-list">
            {projects.map(p => (
              <div key={p.id} className="agent-code-project-group">
                <div className={`agent-code-project-item ${p.id === activeProjectId ? 'active' : ''}`} onClick={() => { setActiveProjectId(p.id); setActiveSessionId(p.sessions[0]?.id || '') }}>
                  <button className="agent-code-project-chevron" onClick={e => { e.stopPropagation(); updateProject(p.id, { expanded: !p.expanded }) }}>
                    {p.expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </button>
                  {projRenamingId === p.id ? (
                    <input
                      ref={projRenameInputRef}
                      className="agent-code-rename-input"
                      value={projRenameText}
                      onChange={e => setProjRenameText(e.target.value)}
                      onBlur={confirmProjRename}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => { if (e.key === 'Enter') confirmProjRename(); if (e.key === 'Escape') setProjRenamingId(null) }}
                    />
                  ) : (
                    <span className="agent-code-session-title">{p.title}</span>
                  )}
                  <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); changeProjectDir(p.id) }} title="选择 / 更改项目目录"><FolderOpen size={11} /></button>
                  <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); startProjRename(p.id, p.title) }} title="重命名项目"><Pencil size={11} /></button>
                  <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteProject(p.id) }} title="删除项目"><Trash2 size={11} /></button>
                </div>
                {p.expanded && (
                  <div className="agent-code-child-sessions">
                    {p.sessions.map(s => (
                      <div key={s.id} className={`agent-code-session-item ${s.id === activeSessionId && p.id === activeProjectId ? 'active' : ''}`} onClick={() => { setActiveProjectId(p.id); setActiveSessionId(s.id) }}>
                        <span className="agent-code-session-title">{s.title}</span>
                        <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteSession(p.id, s.id) }} title="删除"><Trash2 size={10} /></button>
                      </div>
                    ))}
                    <button className="agent-code-add-sess-btn" onClick={() => addSessionToProject(p.id)}><Plus size={11} /> 新建对话</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        </div>

        <div className="agent-code-chat">
          <div className="chat-messages" ref={chatScrollRef} onScroll={onChatScroll}>
            {!activeSession || activeSession.messages.length === 0 ? (
              <div className="agent-welcome">
                <div className="agent-welcome-title">一个编码智能体</div>
                <div className="agent-welcome-desc">描述任务，或随便问点什么。</div>
                <div className="agent-welcome-hint">⏎ 发送</div>
                <div className="agent-welcome-suggestions">
                  {AGENT_SUGGESTIONS.map((s) => (
                    <button key={s} className="agent-suggestion" onClick={() => sendSuggestion(s)}>{s}</button>
                  ))}
                </div>
              </div>
            ) : activeSession.messages.map((msg, i) => {
              const isLast = i === activeSession.messages.length - 1
              const streamingThis = loading && isLast && msg.role === 'assistant'
              return (
                <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
                  {msg.role !== 'user' && (
                    <div className="chat-msg-avatar"><Bot size={14} /></div>
                  )}
                  <div className="chat-msg-body">
                    {msg.toolCalls?.length ? renderToolCalls(msg.toolCalls, toolGroupDefaultOpen) : null}
                    {msg.role === 'user' ? (
                      msg.content ? <div className="chat-msg-bubble chat-msg-markdown"><AgentMarkdown content={msg.content} /></div> : null
                    ) : (
                      <>
                        {msg.stopped && (
                          <div className="chat-msg-stopped-badge">
                            <Square size={10} />
                            <span>已停止生成</span>
                          </div>
                        )}
                        {streamingThis && !msg.content ? (
                          <div className="chat-msg-bubble"><Loader2 size={14} className="spin" /></div>
                        ) : (
                          parseThinkSegments(msg.content || '').map((seg, j) =>
                            seg.type === 'think'
                              ? <ThinkBlock key={`t-${j}`} value={seg.value} closed={seg.closed} isStreaming={streamingThis && !seg.closed} />
                              : <div key={`m-${j}`} className="chat-msg-bubble chat-msg-markdown"><AgentMarkdown content={seg.value} /></div>
                          )
                        )}
                      </>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="chat-msg-avatar"><User size={14} /></div>
                  )}
                </div>
              )
            })}
            <div ref={msgEndRef} />
          </div>
          <div className="chat-input-area">
            {attachedFiles.length > 0 && (
              <div className="chat-attach-tray">
                {attachedFiles.map(att => (
                  <div className="chat-attach-chip" key={att.id}>
                    {att.isImage && att.dataUrl
                      ? <img src={att.dataUrl} className="chat-attach-thumb" alt={att.name} />
                      : <FileText size={14} className="chat-attach-fileicon" />}
                    <span className="chat-attach-name" title={att.name}>{att.name}</span>
                    <button className="chat-attach-remove" onClick={() => removeAttachment(att.id)} title="移除附件" disabled={loading}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-input-row">
              <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} disabled={!apiBaseUrl} title="添加附件 / 图片"><Paperclip size={15} /></button>
              <textarea ref={textareaRef} className="chat-input" placeholder={apiBaseUrl ? '输入自然语言指令，或添加附件 / 图片…' : '请先启动模型'} rows={1} value={input} onChange={e => { setInput(e.target.value); autoResize() }} onKeyDown={handleKeyDown} disabled={!apiBaseUrl} />
              {loading ? (
                <button className="btn btn-primary chat-send-btn" onClick={handleStop} title="停止生成"><Square size={16} /></button>
              ) : (
                <button className="btn btn-primary chat-send-btn" onClick={() => handleSend()} disabled={!input.trim() && attachedFiles.length === 0 || !apiBaseUrl} title="发送"><Send size={16} /></button>
              )}
            </div>
            <input ref={fileInputRef} type="file" multiple hidden onChange={handleAttachmentSelect} />
          </div>
        </div>

        <div className={`agent-code-right-collapser ${treeOpen ? '' : 'collapsed'}`}>
          <div className="agent-code-resize-handle" onPointerDown={startResize('tree')} title="拖动调整文件树宽度" />
          <div className="agent-code-tree" style={{ width: treeWidth }}>
            <div className="agent-code-tree-header">
              <span className="agent-code-tree-label">{activeProject.workspaceDir ? '📁 ' + dirName(activeProject.workspaceDir) : '未选择目录'}</span>
              <button className="btn btn-xs" onClick={() => changeProjectDir(activeProjectId)} title="选择 / 更改项目目录">
                <FolderOpen size={12} />
              </button>
            </div>
            <AgentFileTree workspaceDir={activeProject.workspaceDir} onPreviewFile={openPreview} />
          </div>
          <div className={`agent-code-preview-group ${openTabs.length === 0 ? 'collapsed' : ''}`}>
            <div className="agent-code-resize-handle" onPointerDown={startResize('preview')} title="拖动调整预览宽度（不影响聊天区）" />
            <div className="agent-code-preview" style={{ width: previewWidth }}>
              <div className="agent-code-preview-header">
                <div className="agent-code-preview-tabs">
                  {openTabs.map(t => (
                    <div
                      key={t.path}
                      className={`agent-code-preview-tab ${t.path === activeTabPath ? 'active' : ''}`}
                      onClick={() => setActiveTabPath(t.path)}
                      title={t.path}
                    >
                      <span className="agent-code-preview-tab-name">{t.name}</span>
                      <button
                        className="agent-code-preview-tab-close"
                        onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
                        title="关闭此文件"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
                <span className="agent-code-preview-actions">
                  <button className="btn btn-xs" onClick={() => activeTab && handleFileSelect(activeTab.path)} title="插入路径到输入框" disabled={!activeTab}>
                    <Plus size={12} />
                  </button>
                  <button className="btn btn-xs agent-code-preview-close" onClick={() => activeTab && closeTab(activeTab.path)} title="关闭预览" disabled={!activeTab}>
                    <X size={12} />
                  </button>
                </span>
              </div>
              <div className="agent-code-preview-body">
                {!activeTab ? null
                  : activeTab.loading ? <div className="file-tree-loading">读取中…</div>
                  : activeTab.error ? <div className="agent-code-preview-error">{activeTab.error}</div>
                  : isPreviewMarkdown ? (
                      <div className="agent-code-preview-md chat-msg-markdown">
                        <AgentMarkdown content={activeTab.content ?? ''} />
                      </div>
                    ) : (
                      <div className="agent-code-preview-code">
                        {(activeTab.content ?? '').split('\n').map((line, i) => (
                          <div className="agent-code-preview-line" key={i}>
                            <span className="agent-code-preview-ln">{i + 1}</span>
                            <span className="agent-code-preview-lc">{line || ' '}</span>
                          </div>
                        ))}
                      </div>
                    )}
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>
  )
}
