import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Send, Square, Paperclip, X, FileText, Bot, User, FolderOpen, Plus, Trash2, AlertCircle, HelpCircle, Wrench, Loader2, ChevronRight, ChevronDown, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, Pencil, Brain, RefreshCw, Eye, FilePlus2, FileSearch, TerminalSquare, Clock, CheckCircle2, XCircle, Search, GitBranch, RotateCcw, SlidersHorizontal, Undo2, Copy, Check } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { getToolDefinitions, executeToolCall } from '../utils/tools'
import { setWorkspaceRoot, getWorkspaceRoot } from '../tools/workspaceRoot'
import { setAgentSessionId } from '../tools/agentSession'
import { getFileReadPrompt } from '../tools/FileReadTool/prompt'
import { getFileWritePrompt } from '../tools/FileWriteTool/prompt'
import { getFileEditPrompt } from '../tools/FileEditTool/prompt'
import { getGlobPrompt } from '../tools/GlobTool/prompt'
import { getGrepPrompt } from '../tools/GrepTool/prompt'
import { getBashPrompt } from '../tools/BashTool/prompt'
import { getFileDeletePrompt } from '../tools/FileDeleteTool/prompt'
import { getTodoWritePrompt } from '../tools/TodoWriteTool/prompt'
import { getAskUserQuestionPrompt } from '../tools/AskUserQuestionTool/prompt'
import { getTaskGetPrompt } from '../tools/TaskGetTool/prompt'
import { getTaskListPrompt } from '../tools/TaskListTool/prompt'
import { getTaskOutputPrompt } from '../tools/TaskOutputTool/prompt'
import AgentFileTree from './AgentFileTree'

import AgentContextPanel from './AgentContextPanel'
import CodeBlock from './CodeBlock'
import AskUserQuestionModal from './AskUserQuestionModal'

import type { AgentMessage, AgentSession, AgentProject, Attachment, AgentTask, TodoUpdate } from '../../../shared/types'

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
// 行类型：equal(两列相同) / del(仅左列，删除) / ins(仅右列，新增) /
//         replace(同处一行：左=删除、右=新增，用于「删→增」改动的逐行对照)
type DiffRow = { type: 'equal' | 'del' | 'ins' | 'replace'; left: string | null; right: string | null; leftNum: number | null; rightNum: number | null }
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
  // 先生成「编辑脚本」（equal / del / ins 序列，del/ins 各自独立），便于后续配对成一行
  const script: { type: 'equal' | 'del' | 'ins'; ai: number; bj: number }[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { script.push({ type: 'equal', ai: i, bj: j }); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { script.push({ type: 'del', ai: i, bj: -1 }); i++ }
    else { script.push({ type: 'ins', ai: -1, bj: j }); j++ }
  }
  while (i < n) { script.push({ type: 'del', ai: i, bj: -1 }); i++ }
  while (j < m) { script.push({ type: 'ins', ai: -1, bj: j }); j++ }

  // 将相邻的「del 段 + ins 段」配对成 replace 行（左删右增、同处一行），实现严格逐行对齐：
  // 一眼即可看出某一行从什么改成了什么；段长不一致时剩余行仍按 del / ins 单独成行。
  const rows: DiffRow[] = []
  let lnum = 1, rnum = 1, k = 0
  while (k < script.length) {
    const s = script[k]!
    if (s.type === 'equal') {
      rows.push({ type: 'equal', left: a[s.ai]!, right: b[s.bj]!, leftNum: lnum, rightNum: rnum })
      k++; lnum++; rnum++
      continue
    }
    const dels: number[] = []
    const inss: number[] = []
    while (k < script.length && script[k]!.type !== 'equal') {
      if (script[k]!.type === 'del') dels.push(script[k]!.ai)
      else inss.push(script[k]!.bj)
      k++
    }
    const pairs = Math.min(dels.length, inss.length)
    for (let p = 0; p < pairs; p++) {
      rows.push({ type: 'replace', left: a[dels[p]!]!, right: b[inss[p]!]!, leftNum: lnum, rightNum: rnum })
      lnum++; rnum++
    }
    for (let p = pairs; p < dels.length; p++) {
      rows.push({ type: 'del', left: a[dels[p]!]!, right: null, leftNum: lnum, rightNum: null }); lnum++
    }
    for (let p = pairs; p < inss.length; p++) {
      rows.push({ type: 'ins', left: null, right: b[inss[p]!]!, leftNum: null, rightNum: rnum }); rnum++
    }
  }
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
              {(r.type === 'del' || r.type === 'replace') && <span className="agent-tool-diff-mark">-</span>}
              {r.left ?? ''}
            </pre>
            <span className="agent-tool-diff-num right">{r.rightNum ?? ''}</span>
            <pre className="agent-tool-diff-code right">
              {(r.type === 'ins' || r.type === 'replace') && <span className="agent-tool-diff-mark">+</span>}
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
// 注意：CodeBlock 渲染的是 <div> 结构，不能塞进 react-markdown 默认的
// <pre><code> 里（<div> 非法嵌套在 <pre> 中会被浏览器重排导致错位）。
// 因此块级代码需拦截整个 <pre>，从其中的 <code> 取出语言与文本再交给 CodeBlock；
// 行内代码（不在 <pre> 内）仍由 code 渲染器处理，保留 chat-code-in-line 样式。
function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '')
  const match = /language-(\w+)/.exec(className || '')
  if (match) {
    return <CodeBlock language={match[1]} value={text} />
  }
  if (text.includes('\n')) {
    return <CodeBlock language="" value={text} />
  }
  return <code className="chat-code-in-line">{text}</code>
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
  AskUserQuestion: { name: '提问用户', desc: '向用户提出选择题并收集答案', icon: HelpCircle },
}

// 工具「执行中」状态文案（替代通用的「执行中…」，显示具体动作，如 Edit 编辑中）
const TOOL_RUN_VERB: Record<string, string> = {
  Read: '读取中',
  Write: '写入中',
  Edit: '编辑中',
  Glob: '查找中',
  Grep: '搜索中',
  Bash: '执行中',
  Delete: '删除中',
  TodoWrite: '计划中',
  AskUserQuestion: '提问中',
  TaskGet: '查询任务中',
  TaskList: '列出任务中',
  TaskOutput: '读取输出中',
  get_datetime: '获取时间中',
  web_search: '搜索中',
  fetch_webpage: '抓取中',
}
function toolRunVerb(name: string): string {
  return TOOL_RUN_VERB[name] ?? '执行中'
}

// Agent 工作台暴露文件操作类工具 + Bash 执行（不调用联网 / 时间类工具）
const AGENT_FILE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'ListDir', 'Delete', 'TodoWrite', 'AskUserQuestion', 'TaskGet', 'TaskList', 'TaskOutput', 'GetBackgroundTaskOutput', 'ListBackgroundTasks']

// 需要人工确认的「破坏性」工具：Delete / Bash 默认开启；Write / Edit 可由项目开关追加
const APPROVAL_TOOLS = new Set(['Delete', 'Bash'])
const WRITE_EDIT_TOOLS = new Set(['Write', 'Edit'])
// 执行前需备份原文件、支持「一键撤销」的工具
const BACKUP_TOOLS = new Set(['Write', 'Edit', 'Delete'])
const BACKUP_MAX_BYTES = 2 * 1024 * 1024

// 构建系统提示词：自定义指令（按项目）优先，其后追加工具使用指引
function buildSystemContent(project: AgentProject): string {
  const toolPrompts = [
    getFileReadPrompt(),
    getFileWritePrompt(),
    getFileEditPrompt(),
    getGlobPrompt(),
    getGrepPrompt(),
    getBashPrompt(),
    getFileDeletePrompt(),
    getTodoWritePrompt(),
    getAskUserQuestionPrompt(),
    getTaskGetPrompt(),
    getTaskListPrompt(),
    getTaskOutputPrompt(),
  ].join('\n\n---\n\n')
  const base = `你是一个编码智能体，可以使用以下工具完成任务。注意：工具调用失败时请分析错误原因并修正参数后再试。如果同一工具连续失败多次，说明当前方法不可行，应改用其他方案或直接告知用户，不要反复重试。\n\n请仔细阅读每个工具的使用说明。\n\n${toolPrompts}`
  const custom = project.systemPrompt?.trim()
  return custom ? `${custom}\n\n${base}` : base
}

// 执行写/改/删前读取原文件内容作为撤销备份（仅内存保留，不落盘）
async function backupBeforeTool(args: Record<string, unknown>): Promise<{ path: string; content: string } | null> {
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
  if (!path) return null
  const abs = resolveWorkspacePath(path)
  try {
    const res = await window.api.readFile(abs, { maxBytes: BACKUP_MAX_BYTES })
    if (res.success && typeof res.content === 'string' && res.content.length < BACKUP_MAX_BYTES) {
      return { path: abs, content: res.content }
    }
  } catch { /* 读不到原文件（如新建文件）则不备份 */ }
  return null
}

// ── 工具结果与回传模型的截断 ──
// 存储 / 回传模型的最大长度（避免大文件、大 grep 撑爆上下文）
const TOOL_RESULT_LIMIT = 6000
function truncateToolResult(s: string, limit: number = TOOL_RESULT_LIMIT): { text: string; truncated: boolean; total: number } {
  if (s.length <= limit) return { text: s, truncated: false, total: s.length }
  const note = `\n…（结果过长已截断，仅显示前 ${limit} / 共 ${s.length} 字符）`
  return { text: s.slice(0, limit) + note, truncated: true, total: s.length }
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

// 耗时格式化：亚秒保留 ms、整秒以上用 s（必要时一位小数），比原始的「1234ms」更柔和易读
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
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
// 上下文窗口管理（本地 LLM 上下文固定且偏小，发送前需按 token 预算裁剪历史，
// 否则逐轮累加的工具结果会撑爆上下文 → 崩溃 / 胡言）。
// 仅裁剪「发送给模型」的内容；界面展示的 displayMsgs 保持完整。
// ═══════════════════════════════════════════════════════════════════════════
const AGENT_CTX_DEFAULT = 4096    // 取不到真实 n_ctx 时的兜底上下文大小
const AGENT_MAX_OUTPUT = 4096     // 与 chatStream 实际 max_tokens 一致
const AGENT_CTX_SAFETY = 256      // 预留安全余量（token）

// 粗略 token 估算：ASCII ~0.3 token/字符，CJK ~1.6 token/字符（偏保守，宁可多裁避免溢出）
function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) ascii++
    else if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else ascii += 0.5
  }
  return Math.ceil(ascii * 0.3 + cjk * 1.6) + 2
}

function estimateApiMsgTokens(m: ApiMessage): number {
  let text = ''
  if (typeof m.content === 'string') text = m.content
  else if (Array.isArray(m.content)) text = m.content.map(p => String((p as Record<string, unknown>).text ?? '')).join('')
  let extra = 0
  const tcs = (m as { tool_calls?: Array<{ function: { arguments: string } }> }).tool_calls
  if (Array.isArray(tcs)) extra = tcs.reduce((s, tc) => s + estimateTextTokens(tc.function?.arguments || ''), 0)
  return estimateTextTokens(text) + extra + 4
}

// 本次发送可用的 prompt token 预算（扣除输出预留 + 安全余量）
function computeContextBudget(nCtx: number): number {
  const ctx = nCtx && nCtx > 0 ? nCtx : AGENT_CTX_DEFAULT
  const reserve = Math.min(AGENT_MAX_OUTPUT, Math.max(1024, Math.floor(ctx * 0.3)))
  return Math.max(512, ctx - reserve - AGENT_CTX_SAFETY)
}

// 单条工具结果允许的最大字符数：随模型上下文预算伸缩（不再固定 6000），
// 避免大上下文模型也被无意义截断；小上下文模型仍受预算约束（至少 TOOL_RESULT_LIMIT）。
function toolResultCharLimit(budgetTokens: number): number {
  const n = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : AGENT_CTX_DEFAULT
  return Math.max(TOOL_RESULT_LIMIT, Math.floor(n * 3))
}

// 按「轮次」裁剪：保留 system + 最新的若干完整轮次，丢弃最早的轮次；
// 轮次以 user 消息为界切分，保证 tool_calls 与其 tool 结果不被拆散。
// 若仅剩的最新一轮仍超限，则进一步从最早的 tool 结果起截断内容（安全阀）。
function trimApiMessages(messages: ApiMessage[], budget: number): { messages: ApiMessage[]; dropped: number } {
  if (messages.length === 0) return { messages, dropped: 0 }
  const sys = messages[0] && messages[0].role === 'system' ? messages[0] : null
  const rest = sys ? messages.slice(1) : messages
  const turns: ApiMessage[][] = []
  let cur: ApiMessage[] | null = null
  for (const m of rest) {
    if (m.role === 'user') { cur = [m]; turns.push(cur) }
    else { (cur ??= []).push(m) }
  }
  const sysTok = sys ? estimateApiMsgTokens(sys) : 0
  const turnTok = turns.map(t => t.reduce((s, m) => s + estimateApiMsgTokens(m), 0))
  const kept: ApiMessage[][] = []
  let used = sysTok
  for (let i = turns.length - 1; i >= 0; i--) {
    if (used + turnTok[i] <= budget) { used += turnTok[i]; kept.unshift(turns[i]) }
    else { if (kept.length === 0) kept.unshift(turns[i]); break }
  }
  let result = sys ? [sys, ...kept.flat()] : kept.flat()
  const dropped = messages.length - result.length
  // 安全阀：最新一轮仍超预算时，从最旧起截断 tool 结果内容
  used = result.reduce((s, m) => s + estimateApiMsgTokens(m), 0)
  for (let i = 0; i < result.length && used > budget; i++) {
    const m = result[i]
    if (m.role === 'tool' && typeof m.content === 'string') {
      let text = m.content
      while (used > budget && text.length > 200) {
        text = text.slice(0, Math.floor(text.length * 0.6))
        result[i] = { ...m, content: text }
        used = result.reduce((s, mm) => s + estimateApiMsgTokens(mm), 0)
      }
    }
  }
  return { messages: result, dropped }
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
  // 仅当「正在流式」时才显示「思考中」转圈。注意不能用 !closed 参与判断：
  // 模型在「调用工具、不输出闭合 </think>」时 closed 恒为 false，若用 !closed 会让
  // 思考块永远转圈，直到下一轮才补上闭合标签。改为只看 isStreaming（= 真正流式且未闭合），
  // 流式一结束（进入工具执行阶段）思考块立即停止转圈。
  const thinking = isStreaming
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

  // 当 closed 从外部变为 true（如 toolCalls 到达），立即收起思考块，
  // 不等待 thinking->false 的 useEffect（可能滞后一帧）。
  useEffect(() => {
    if (closed && !thinking && !userToggledRef.current) {
      setExpanded(false)
      setVisible(false)
    }
  }, [closed, thinking])

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

// ── 流式元信息徽标（参考 pi-web 的模型输出文字流式设计）──
// 展示：模型名 + 预估 token 数 + 实时生成速度 t/s。
// t/s 以 ~300ms 间隔采样流式文本长度估算（4 字符/token 启发式），而非逐 token 计算，
// 避免高频重算导致数字抖动。
const StreamingBadge = React.memo(function StreamingBadge({ text, modelLabel }: { text: string; modelLabel?: string }) {
  const [tps, setTps] = useState<number | null>(null)
  const lenRef = useRef(text.length)
  lenRef.current = text.length
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    const id = setInterval(() => {
      const chars = lenRef.current
      if (chars === 0) { startRef.current = null; return }
      const now = Date.now()
      if (startRef.current === null) startRef.current = now
      const elapsed = (now - startRef.current) / 1000
      if (elapsed > 0.5) setTps(chars / 4 / elapsed)
    }, 300)
    return () => { clearInterval(id); setTps(null); startRef.current = null }
  }, [])
  const est = Math.round(text.length / 4)
  // 速度分级配色：>=50 青、>=30 绿、>=15 黄、其余 红（与 pi-web 一致）
  const bg = tps == null ? 'var(--text-muted)' : tps >= 50 ? '#53b3cb' : tps >= 30 ? '#9bc53d' : tps >= 15 ? '#f9c22e' : '#e01a4f'
  return (
    <div className="agent-stream-meta">
      {modelLabel && <span className="agent-stream-model">{modelLabel}</span>}
      {est > 0 && (
        <span className="agent-stream-tokens" title="流式期间预估 token 数">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
          </svg>
          {est}
        </span>
      )}
      {tps != null && (
        <span className="agent-stream-tps" style={{ background: bg }}>{tps.toFixed(1)} t/s</span>
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
  // 收起预览：>12 行显示前 12 行；2~12 行多行结果折叠为首行预览；单行无需收起。
  // 注意 collapsed 不能只按 >12 行判定，否则 ≤12 行的短结果点「收起」内容不变、按钮看似无效。
  const isLong = lineCount > 12
  const isMulti = lineCount > 1
  const shownText = expanded
    ? result
    : (isLong ? lines.slice(0, 12).join('\n') + '\n…' : (isMulti ? lines.slice(0, 1).join('\n') + '\n…' : result))
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">
          结果{truncated ? `（已截断，共 ${total} 字符）` : `（共 ${lineCount} 行）`}
        </span>
        <button className="agent-tool-subtoggle" onClick={() => setExpanded(v => !v)}>
          <ChevronRight size={11} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
          {expanded ? '收起' : (isLong ? `展开（显示前 12 / 共 ${lineCount} 行）` : (isMulti ? `展开（显示首行 / 共 ${lineCount} 行）` : '展开'))}
        </button>
      </div>
      {lined ? <LinedPre text={shownText} /> : <pre className="agent-tool-result-pre">{shownText}</pre>}
    </div>
  )
})

const ToolCallCard = React.memo(function ToolCallCard({ tc, index, total, onPreviewFile, canUndo, onUndo, defaultOpen }: { tc: NonNullable<AgentMessage['toolCalls']>[number]; index: number; total: number; onPreviewFile: (p: string) => void; canUndo?: boolean; onUndo?: () => void; defaultOpen?: boolean }) {
  const meta = TOOL_META[tc.name]
  const Icon = meta?.icon || Wrench
  // 状态：pending(待执行) / await_approval(待人工确认) / executing(执行中) / done(已完成)
  const status = tc.status || (tc.result != null ? 'done' : 'pending')
  const pending = status === 'pending'
  const awaiting = status === 'await_approval'
  const executing = status === 'executing'
  const done = status === 'done'
  const failed = done && !!tc.failed
  const canRestore = done && canUndo && !tc.restored && BACKUP_TOOLS.has(tc.name)
  const [expanded, setExpanded] = useState(defaultOpen ?? false)
  const parsed = (() => { try { return JSON.parse(tc.args || '{}') } catch { return null } })()
  const preview = getToolPreview(parsed)
  // 编辑工具的增删行数统计（显示在工具卡片上方，类似 git diff 的 +N -M）
  const editDiffStat = (() => {
    if (tc.name !== 'Edit') return null
    const o = parsed && typeof parsed.old_string === 'string' ? parsed.old_string : null
    const n = parsed && typeof parsed.new_string === 'string' ? parsed.new_string : null
    if (o == null || n == null) return null
    const rows = computeSplitDiff(o, n)
    const added = rows.filter(r => r.type === 'ins' || r.type === 'replace').length
    const removed = rows.filter(r => r.type === 'del' || r.type === 'replace').length
    if (added === 0 && removed === 0) return null
    return { added, removed }
  })()
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
          {editDiffStat && (
            <span className="agent-tool-diffstat" title={`新增 ${editDiffStat.added} 行，删除 ${editDiffStat.removed} 行`}>
              <span className="diff-add">+{editDiffStat.added}</span>
              <span className="diff-del">-{editDiffStat.removed}</span>
            </span>
          )}
          {awaiting ? (
            <span className="agent-tool-call-status confirm"><Clock size={12} /> 待确认</span>
          ) : pending ? (
            <span className="agent-tool-call-status wait"><Clock size={12} /> 待执行</span>
          ) : executing ? (
            <span className="agent-tool-call-status run"><Loader2 size={12} className="spin" /> {tc.name} {toolRunVerb(tc.name)}</span>
          ) : failed ? (
            <span className="agent-tool-call-status err"><XCircle size={12} /> 失败</span>
          ) : (
            <span className="agent-tool-call-status ok"><CheckCircle2 size={12} /> 完成</span>
          )}
          {done && tc.durationMs != null && (
            <span className="agent-tool-call-dur" title={`耗时 ${tc.durationMs} 毫秒`}>
              <Clock size={10} /> {formatDuration(tc.durationMs)}
            </span>
          )}
          {canRestore && (
            <button className="agent-tool-undo" onClick={(e) => { e.stopPropagation(); onUndo?.() }} title="撤销本次操作，恢复工具执行前的原文件内容">
              <Undo2 size={12} /> 恢复
            </button>
          )}
          {tc.restored && (
            <span className="agent-tool-restored"><Check size={12} /> 已恢复</span>
          )}
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
          {executing ? (
            <div className="agent-tool-result agent-tool-result-running"><span className="agent-tool-dots" /></div>
          ) : done ? (
            <ToolResultView result={tc.result!} truncated={tc.truncated} total={tc.resultTotal} lined={tc.name === 'Read'} />
          ) : null}
        </div>
      )}
    </div>
  )
})

const ToolCallGroup = React.memo(function ToolCallGroup({ toolCalls, onPreviewFile, canUndoFor, onUndo, cardDefaultOpen }: { toolCalls: NonNullable<AgentMessage['toolCalls']>; onPreviewFile: (p: string) => void; canUndoFor?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => boolean; onUndo?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => void; cardDefaultOpen?: boolean }) {
  return (
    <div className="agent-tool-list">
      {toolCalls.map((tc, i) => <ToolCallCard key={tc.id || i} tc={tc} index={i} total={toolCalls.length} onPreviewFile={onPreviewFile} canUndo={canUndoFor ? canUndoFor(tc) : false} onUndo={onUndo ? () => onUndo(tc) : undefined} defaultOpen={cardDefaultOpen} />)}
    </div>
  )
})

export default function AgentCodeView() {
  const cards = useStore(s => s.cards)
  const runningCard = cards.find(c => c.status === 'running')
  const apiBaseUrl = runningCard ? `http://127.0.0.1:${runningCard.template.serverPort}` : null
  const modelLabel = runningCard?.template.modelPath?.split(/[\\/]/).pop() || runningCard?.template.name || '模型'
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

  // 预览面板宽度：拖拽预览左边框时调整，文件树宽度固定不动
  const PREVIEW_MIN = 240, PREVIEW_MAX = 760
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_MIN)
  const [previewResizing, setPreviewResizing] = useState(false)
  const draggingRef = useRef<{ startX: number; startPreviewW: number } | null>(null)
  // rAF 节流：拖动期间把宽度写入 CSS 变量，避免每帧 React 重渲
  const rafRef = useRef<number | null>(null)
  const applyPreviewWidth = useCallback((w: number) => {
    const clamped = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, w))
    const root = document.querySelector('.agent-code-preview') as HTMLElement | null
    if (root) root.style.setProperty('--agent-preview-width', `${clamped}px`)
  }, [])

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = draggingRef.current
    if (!d) return
    lastClientXRef.current = e.clientX
    const dx = e.clientX - d.startX
    const next = d.startPreviewW - dx
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => applyPreviewWidth(next))
  }, [applyPreviewWidth])

  useEffect(() => {
    applyPreviewWidth(previewWidth)
  }, [previewWidth, applyPreviewWidth])

  const onDragEnd = useCallback(() => {
    const d = draggingRef.current
    if (d) {
      setPreviewWidth(Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, d.startPreviewW - (lastClientXRef.current - d.startX))))
    }
    draggingRef.current = null
    setPreviewResizing(false)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
  }, [onDragMove])

  const lastClientXRef = useRef(0)
  const startResize = (type: 'tree' | 'preview') => (e: React.PointerEvent) => {
    if (type === 'tree') return // 文件树宽度固定不动
    e.preventDefault()
    lastClientXRef.current = e.clientX
    draggingRef.current = { startX: e.clientX, startPreviewW: previewWidth }
    setPreviewResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
  }

  // Persist to store on every change（跳过纯占位项目，防止干扰 seededRef 逻辑）
  useEffect(() => {
    const hasRealContent = projects.some(p => p.sessions.length > 0 || p.workspaceDir)
    if (hasRealContent) setAgentProjects(projects)
  }, [projects, setAgentProjects])

  // 应用启动后，store 从磁盘载入历史项目时，把本地状态同步为已持久化的内容（仅一次）
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    if (storedProjects.length > 0) {
      // 仅当 loaded 数据含实际内容时才应用 + 加锁，避免空占位项目提前锁死
      const hasReal = storedProjects.some(p => p.sessions.length > 0 || p.workspaceDir)
      if (!hasReal) return
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
  // 「正在流式」与「正在执行工具」是两个不同状态：loading 覆盖整个 handleSend
  // （流式 + 工具循环），但 UI 需要区分二者——思考块只在「真正流式」时转圈，
  // 一旦模型返回工具调用、进入执行阶段，应停止转圈并展示工具卡片。
  const [streaming, setStreaming] = useState(false)
  // 输入框自动增高
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 聊天滚动容器 + 「是否贴底」标记（仅贴底时自动跟随滚动）
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 是否贴底（用于渲染「滚动到底部」浮动按钮；仅非贴底时显示）
  const [atBottom, setAtBottom] = useState(true)
  // 生成期间排队的发送（当前轮次结束后自动发出）
  const pendingSendRef = useRef<{ text: string; attachments: Attachment[] } | null>(null)
  // 始终持有最新的 handleSend，避免排队回调使用过期闭包（如切换了会话）
  const handleSendRef = useRef<(text?: string, attachments?: Attachment[]) => void>(() => { })
  // 中止控制：aborted 标记 + 当前流式 Promise 的 resolve，便于在停止时唤醒循环
  const abortRef = useRef<{ aborted: boolean; resolve: (() => void) | null }>({ aborted: false, resolve: null })
  const currentStreamIdRef = useRef<string | null>(null)
  // 历史输入回溯（↑ / ↓）
  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)
  // 附件 / 图片
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ctxBtnRef = useRef<HTMLButtonElement>(null)
  const promptBtnRef = useRef<HTMLButtonElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; isImage: boolean; dataUrl?: string; content?: string }>>([])
  const [treeOpen, setTreeOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [contextModalOpen, setContextModalOpen] = useState(false)

  // ── 窗口自适应（参考 Reasonix 按 viewport 实时约束面板宽度）──
  // 监听工作台可用宽度：窄窗时自动收起侧栏 / 预览，并把文件树宽度夹紧到不溢出，
  // 避免各面板固定 min-width 叠加导致整体被裁切或错乱。
  const viewBodyRef = useRef<HTMLDivElement | null>(null)
  // 用 ref 镜像 open 状态，避免 resize 回调闭包拿到过期值
  const treeOpenRef = useRef(treeOpen)
  treeOpenRef.current = treeOpen
  const adaptToWidth = useCallback(() => {
    // 不再自动收起右侧面板，由用户手动控制
  }, [])

  useLayoutEffect(() => {
    const el = viewBodyRef.current
    if (!el) return
    // 首次挂载即按当前宽度适配一次
    adaptToWidth()
    const ro = new ResizeObserver(() => {
      adaptToWidth()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [adaptToWidth])

  // 点击弹窗外 / Escape 关闭上下文下拉面板
  useEffect(() => {
    if (!contextModalOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        setContextModalOpen(false)
        return
      }
      // 点击弹窗内部不关闭
      const target = e.target as Node
      if (ctxBtnRef.current?.contains(target)) return
      const pop = document.querySelector('.agent-card-ctx')
      if (pop?.contains(target)) return
      setContextModalOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [contextModalOpen])

  // 任务清单（Todo / Task 工具的可视化面板）
  const [, setTasks] = useState<AgentTask[]>([])
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  // 上下文裁剪提示：当因窗口限制自动省略早期消息时显示（null = 未触发）
  const [ctxTrimInfo, setCtxTrimInfo] = useState<{ dropped: number } | null>(null)
  // 当前 TodoWrite 计划项（每次新调用替换，不累加）
  const [currentPlanItems, setCurrentPlanItems] = useState<TodoUpdate[]>([])

  // 点击任务卡片外部 / Escape 关闭
  useEffect(() => {
    if (!taskModalOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        setTaskModalOpen(false)
        setCurrentPlanItems([])
        return
      }
      const card = document.querySelector('.agent-task-card')
      if (card?.contains(e.target as Node)) return
      setTaskModalOpen(false)
      setCurrentPlanItems([])
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [taskModalOpen])

  // 会话级监控统计（上下文面板用）：请求数 / 累计 tokens
  const [reqCount, setReqCount] = useState(0)
  const [cumTokens, setCumTokens] = useState(0)
  // 破坏性工具审批：待确认请求（null = 无）+ 本轮「全部允许」标记 + Promise resolve 句柄
  const [approvalReq, setApprovalReq] = useState<{ id: string; name: string; args: string } | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const autoApproveRef = useRef(false)
  // 写/改/删前备份（仅内存，按 toolCall id 索引；刷新 / 重开应用后失效）
  const backupsRef = useRef<Record<string, { path: string; content: string }>>({})
  // 重生成 / 重发失败回滚快照
  const regenRollbackRef = useRef<{ sid: string; messages: AgentMessage[] } | null>(null)
  // 系统提示词编辑器弹窗状态
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [approveWriteEditDraft, setApproveWriteEditDraft] = useState(false)

  // 点击提示词面板外部 / Escape 关闭
  useEffect(() => {
    if (!promptModalOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        setPromptModalOpen(false)
        return
      }
      const pop = document.querySelector('.agent-card-prompt')
      if (pop?.contains(e.target as Node)) return
      if (promptBtnRef.current?.contains(e.target as Node)) return
      setPromptModalOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [promptModalOpen])

  // 用户消息内联编辑中的消息 id（null = 无）
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // 弹出审批弹窗并等待用户决定：true=允许，false=拒绝
  const waitForApproval = useCallback((info: { id: string; name: string; args: string }) => {
    return new Promise<boolean>((resolve) => {
      approvalResolveRef.current = resolve
      setApprovalReq(info)
    })
  }, [])
  const resolveApproval = useCallback((approved: boolean) => {
    const r = approvalResolveRef.current
    approvalResolveRef.current = null
    setApprovalReq(null)
    if (r) r(approved)
  }, [])
  const refreshTasks = useCallback(async () => {
    if (!activeSessionId) { setTasks([]); return }
    try {
      const res = await window.api.agentTaskList(activeSessionId)
      if (res.success) setTasks(res.tasks)
    } catch { /* 忽略：面板刷新失败不影响对话 */ }
  }, [activeSessionId])
  // 始终持有最新的 refreshTasks，避免 send 闭包使用过期引用
  const refreshTasksRef = useRef(refreshTasks)
  refreshTasksRef.current = refreshTasks
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [projRenamingId, setProjRenamingId] = useState<string | null>(null)
  const [projRenameText, setProjRenameText] = useState('')
  const projRenameInputRef = useRef<HTMLInputElement>(null)
  const msgEndRef = useRef<HTMLDivElement>(null)
  // 输入框区域高度（含附件托盘 / 上下文提示）：用于把「滚动到底部」按钮
  // 精确悬浮在输入框正上方，而不遮挡输入框。
  const chatInputAreaRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0]!
  const activeSession = activeProject.sessions.find(s => s.id === activeSessionId) || activeProject.sessions[0] || null
  // 工具调用组默认展开（显示工具卡片列表）；组内的单个工具卡片详情（参数/结果）
  // 是否默认展开由「设置 → 界面 → 工具调用卡片默认展开」开关控制（持久化）。
  const toolCardExpandedDefault = useStore(s => s.agentToolCardsExpanded)

  // 滚动时更新「是否贴底」标记（阈值 80px 内视为贴底）
  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = chatScrollRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      atBottomRef.current = true
      setAtBottom(true)
    }
  }, [])

  useEffect(() => {
    if (atBottomRef.current) {
      scrollToBottom()
    }
  }, [activeSession?.messages])

  // 测量输入框区域高度，写入 CSS 变量，使浮动按钮精确浮在输入框上方
  useEffect(() => {
    const el = chatInputAreaRef.current
    if (!el) return
    const apply = () => {
      const root = chatScrollRef.current?.closest('.agent-code-chat') as HTMLElement | null
      if (root) root.style.setProperty('--chat-input-h', `${el.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 切换会话时重置监控统计（请求数 / 累计 tokens）
  useEffect(() => {
    setReqCount(0)
    setCumTokens(0)
    // 切换会话后内容会变短/重置，先假定贴底（进入会话即滚到底部），
    // 真实滚动事件会在用户上滚时把按钮显示出来
    atBottomRef.current = true
    setAtBottom(true)
  }, [activeSessionId])

  // 将当前项目目录设为 Glob/Grep/Bash 等工具的默认工作目录
  useEffect(() => {
    setWorkspaceRoot(activeProject.workspaceDir)
    window.api?.setBashCwd(activeProject.workspaceDir || '').catch(() => { })
    // 同步到主进程，使 Read/Write/Edit/Delete/Glob/Grep 等工具将相对路径
    // 解析到工作区根目录，避免错位到应用进程的工作目录（process.cwd()）
    window.api?.setAgentWorkspace(activeProject.workspaceDir || '').catch(() => { })
  }, [activeProject.workspaceDir])

  // 将当前活动会话 id 写入工具上下文（Todo/Task 工具据此定位任务清单），并刷新面板
  useEffect(() => {
    setAgentSessionId(activeSessionId)
    refreshTasks()
  }, [activeSessionId, refreshTasks])

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

  // ── 输入框自动增高 ──
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [])

  // 把文本插入到输入框光标处（追加/插入文本，不触发发送）
  // 用于文件浏览器右键「发送到输入框」：插入文件名到当前光标位置
  const insertAtCursor = useCallback((text: string) => {
    const el = textareaRef.current
    if (!el) {
      setInput(prev => prev ? `${prev}\n${text}` : text)
      autoResize()
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    setInput(next)
    // 还原光标到插入文本之后，并聚焦输入框
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
      autoResize()
    })
  }, [autoResize])

  // ── 输入框 @ 文件补全 ──
  // 把 [start, end) 区间的文本替换为 text（用于选中文件时替换触发用的 @查询串）
  const replaceRange = useCallback((start: number, end: number, text: string) => {
    const el = textareaRef.current
    if (!el) {
      setInput(prev => prev.slice(0, start) + text + prev.slice(end))
      return
    }
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    setInput(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
      autoResize()
    })
  }, [autoResize])

  // 工作区文件缓存（扁平列表），按 workspaceDir 加载一次，过滤纯前端
  interface FlatFileEntry { name: string; path: string; relPath: string }
  const allFilesRef = useRef<FlatFileEntry[]>([])
  const atLoadedDirRef = useRef<string>('')
  const [atQuery, setAtQuery] = useState<string | null>(null) // 非空=浮层激活，存 @ 后的查询串
  const [atFiles, setAtFiles] = useState<FlatFileEntry[]>([]) // 当前过滤后的列表
  const atAnchorRef = useRef<number | null>(null) // @ 在 input 中的起始索引
  const atPopRef = useRef<HTMLDivElement>(null)

  // 首次需要时按工作区目录加载扁平文件列表（带上限保护，见主进程 list-flat-files）
  const ensureWorkspaceFiles = useCallback(async (dir: string) => {
    if (!dir || atLoadedDirRef.current === dir) return
    atLoadedDirRef.current = dir
    try {
      const res = await window.api.listFlatFiles(dir, { maxDepth: 12, maxFiles: 3000 })
      if (res.success && res.files) allFilesRef.current = res.files
      else allFilesRef.current = []
    } catch {
      allFilesRef.current = []
    }
  }, [])

  // 根据光标位置检测是否处于「@触发」状态：@ 前为空白或行首，@ 后无空白
  const detectAt = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (m) {
      const atStart = caret - (m[2]!.length + 1) // @ 符号的索引
      atAnchorRef.current = atStart
      setAtQuery(m[2]!)
      return true
    }
    atAnchorRef.current = null
    setAtQuery(null)
    return false
  }, [])

  // 按 atQuery 过滤工作区文件（匹配文件名或相对路径，不区分大小写）
  const filterAtFiles = useCallback((query: string) => {
    const q = query.toLowerCase()
    const all = allFilesRef.current
    const matched = q
      ? all.filter(f => f.name.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q))
      : all
    setAtFiles(matched.slice(0, 50))
  }, [])

  // 选中文件：把 @查询串 替换为文件名文本，插入到输入框，不发送
  const onPickAtFile = useCallback((entry: FlatFileEntry) => {
    const anchor = atAnchorRef.current
    if (anchor == null) { insertAtCursor(entry.name); setAtQuery(null); return }
    // 替换从 @ 到当前光标处的整段（即 @查询串）
    const caret = textareaRef.current?.selectionStart ?? input.length
    replaceRange(anchor, caret, entry.name)
    setAtQuery(null)
  }, [insertAtCursor, replaceRange, input.length])

  // 点击浮层外部 / 切换工作区关闭浮层
  useEffect(() => {
    if (atQuery === null) return
    const close = (e: MouseEvent) => {
      if (atPopRef.current?.contains(e.target as Node)) return
      setAtQuery(null)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [atQuery])

  // 切换工作区目录时重置文件缓存（下次输入 @ 重新加载）
  useEffect(() => {
    atLoadedDirRef.current = ''
    allFilesRef.current = []
    setAtQuery(null)
  }, [activeProject.workspaceDir])

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
    // 若正卡在「破坏性工具审批」弹窗，按停止等价于「拒绝」，避免挂死
    if (approvalResolveRef.current) approvalResolveRef.current(false)
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

  // 与 buildApiMessages 类似，但会把工具调用结果（toolCalls[].result）补成 role:'tool' 消息，
  // 用于「重新生成 / 重发」时基于已有历史（含工具执行记录）重建发送给模型的消息序列。
  function buildApiMessagesFull(messages: AgentMessage[]): ApiMessage[] {
    const out: ApiMessage[] = []
    for (const m of messages) {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant', content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } }))
        })
        for (const tc of m.toolCalls) out.push({ role: 'tool', tool_call_id: tc.id, content: tc.result ?? '' })
      } else if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
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

  // ── 核心生成循环（流式 + 工具执行）────────────────────────────
  // 从给定的「对话快照」（displayMsgs / apiMsgs）开始跑一轮：先流式生成，再按模型
  // 返回的工具调用逐个执行（含破坏性工具审批、写前备份），直到无工具调用或达到轮次上限。
  // handleSend / 重新生成 / 重发 都复用此函数，保证行为一致。
  const runAgentTurn = useCallback(async (
    pid: string,
    sid: string,
    startDisplay: AgentMessage[],
    startApiMsgs: ApiMessage[],
    opts: { port: number; tools: ReturnType<typeof getToolDefinitions>; userHasImages: boolean; ctxBudget: number; approveWriteEdit: boolean }
  ): Promise<{ errored: boolean; aborted: boolean }> => {
    const { port, tools, userHasImages, ctxBudget, approveWriteEdit } = opts
    const toolChoice = userHasImages ? 'none' : 'auto'
    let displayMsgs: AgentMessage[] = startDisplay
    let apiMsgs: ApiMessage[] = startApiMsgs
    let endedWithError = false
    // 每轮开始时重置「全部允许」标记，使审批弹窗仅对“本次生成”生效
    autoApproveRef.current = false
    setReqCount(c => c + 1)
    setLoading(true)
    abortRef.current.aborted = false
    // 确保 Todo/Task 工具在工具循环执行前能定位到正确的会话任务清单
    setAgentSessionId(sid)

    // 局部工具状态更新（直接改写闭包内的 displayMsgs，并同步提交 React）
    const patchToolCall = (liveId: string, tcId: string, patch: Partial<NonNullable<AgentMessage['toolCalls']>[number]>) => {
      displayMsgs = displayMsgs.map(m => m.id === liveId ? {
        ...m,
        toolCalls: (m.toolCalls || []).map(t => t.id === tcId ? { ...t, ...patch } : t)
      } : m)
    }
    const commitToolCall = (liveId: string, tcId: string, patch: Partial<NonNullable<AgentMessage['toolCalls']>[number]>) => {
      patchToolCall(liveId, tcId, patch)
      flushSync(() => { updateSessionInProject(pid, sid, { messages: displayMsgs }) })
    }

    try {
      let turn = 0
      // 工具失败跟踪：防止模型无限重试同一工具调用
      const toolFailCount = new Map<string, number>()
      const failedCalls = new Set<string>()
      // 不再限制工具调用轮次：循环在模型不再返回工具调用（break）或用户点击停止（abort）时自然结束，
      // 避免“已达到最大工具调用轮次”打断本就需要多步工具协作的复杂任务。
      while (true) {
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
              if (data.toolCalls?.length) {
                toolCalls = data.toolCalls
                // 在流式结束时检测 TodoWrite，提前打开计划卡片
                //（与工具执行循环解耦，避免 React 18 批处理导致 true/false 合并）
                const todoWriteCall = data.toolCalls.find((tc: any) => tc.function?.name === 'TodoWrite')
                if (todoWriteCall) {
                  setTaskModalOpen(true)
                  // 解析本次 TodoWrite 的计划项（不累加历史任务）
                  try {
                    const args = JSON.parse(todoWriteCall.function.arguments)
                    if (args.todos?.length) setCurrentPlanItems(args.todos)
                  } catch { /* 忽略解析错误 */ }
                }
              }
              if (data.error) streamError = data.error
              // 累计本会话 tokens（prompt + completion），供上下文监控面板展示
              if (data.usage) setCumTokens(c => c + (data.usage!.promptTokens || 0) + (data.usage!.completionTokens || 0))
              // 确保最终内容落盘（节流可能跳过了最后一次增量）
              updateSessionInProject(pid, sid, { messages: displayMsgs })
              window.api.removeChatStreamListener()
              abortRef.current.resolve = null
              // 流式结束：进入工具执行阶段，停止「正在流式」标记，
              // 让思考块停止转圈、工具卡片显示「Edit 编辑中」等执行中状态
              flushSync(() => {
                setStreaming(false)
              })
              resolve()
            }
          }
          setStreaming(true)
          window.api.onChatStreamChunk(onChunk)
          const trimmed = trimApiMessages(apiMsgs, ctxBudget)
          setCtxTrimInfo(trimmed.dropped > 0 ? { dropped: trimmed.dropped } : null)
          window.api.chatStream({ streamId, port, body: { messages: trimmed.messages, tools, tool_choice: toolChoice, stream: true, temperature: 0.3, max_tokens: 4096 } })
            .catch((e: any) => { window.api.removeChatStreamListener(); streamError = e?.message || String(e); setStreaming(false); abortRef.current.resolve = null; resolve() })
        })
        currentStreamIdRef.current = null

        // 用户中止：标记当前助手消息为「已停止」并退出循环
        if (abortRef.current.aborted) {
          displayMsgs = displayMsgs.map(m => m.id === liveId ? { ...m, stopped: true } : m)
          updateSessionInProject(pid, sid, { messages: displayMsgs })
          break
        }

        if (toolCalls && toolCalls.length) {
          // 第一阶段：展示工具调用计划（所有工具状态为 pending）
          const assistMsg: AgentMessage = { id: liveId, role: 'assistant', content: streamedText, toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments, status: 'pending' as const })) }
          displayMsgs = displayMsgs.slice(0, -1).concat(assistMsg)
          // 强制同步提交 DOM，确保用户立即看到工具卡片列表（待执行状态）
          flushSync(() => {
            updateSessionInProject(pid, sid, { messages: displayMsgs })
          })
          // 立即滚动到底部，确保工具卡片在视口内可见
          scrollToBottom()
          apiMsgs.push({ role: 'assistant', content: streamedText || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments } })) } as ApiMessage)
          // 第二阶段：逐个执行工具（pi-web 风格：状态驱动）
          for (const tc of toolCalls) {
            // ── 破坏性工具审批：Delete / Bash 默认需要人工确认；Write / Edit 可由项目开关追加 ──
            const needsApproval = APPROVAL_TOOLS.has(tc.function.name) || (approveWriteEdit && WRITE_EDIT_TOOLS.has(tc.function.name))
            if (needsApproval && !autoApproveRef.current) {
              commitToolCall(liveId, tc.id, { status: 'await_approval' })
              const approved = await waitForApproval({ id: tc.id, name: tc.function.name, args: tc.function.arguments })
              if (abortRef.current.aborted) {
                commitToolCall(liveId, tc.id, { status: 'done', result: JSON.stringify({ error: '已停止' }), failed: true })
                break
              }
              if (!approved) {
                const rejected = JSON.stringify({ error: '用户已拒绝该工具调用（需要人工确认的操作）' })
                commitToolCall(liveId, tc.id, { status: 'done', result: rejected, failed: true })
                apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: rejected })
                continue
              }
            }
            // ── 写 / 改 / 删前备份原文件（支持一键撤销）──
            if (BACKUP_TOOLS.has(tc.function.name)) {
              const backup = await backupBeforeTool(parseToolArgs(tc.function.arguments))
              if (backup) backupsRef.current[tc.id] = backup
            }
            // ★ 设置工具状态为 executing → flushSync 同步提交 React 渲染
            commitToolCall(liveId, tc.id, { status: 'executing' })
            // ★ 同步通知 store 工具执行阶段（驱动状态栏即时渲染）
            flushSync(() => { useStore.getState().setAgentPhase({ kind: 'running_tools', tools: [{ name: tc.function.name, verb: toolRunVerb(tc.function.name) }] }) })
            scrollToBottom()

            let toolResult: string
            let failed = false
            try { const args = parseToolArgs(tc.function.arguments); toolResult = await executeToolCall(tc.function.name, args) } catch (e: any) { toolResult = JSON.stringify({ error: e?.message || String(e) }); failed = true }
            if (!failed && isToolErrorResult(toolResult)) failed = true

            // ── 工具失败跟踪：防止模型无限重试 ──
            if (failed) {
              const toolName = tc.function.name
              const curFail = (toolFailCount.get(toolName) || 0) + 1
              toolFailCount.set(toolName, curFail)
              const callKey = `${toolName}::${tc.function.arguments}`
              const isExactRetry = failedCalls.has(callKey)
              failedCalls.add(callKey)
              const warnings: string[] = []
              if (isExactRetry) warnings.push('该工具已使用完全相同参数尝试过并失败')
              if (curFail >= 3) warnings.push(`${toolName} 已连续失败 ${curFail} 次`)
              if (warnings.length > 0) {
                toolResult += `\n\n【${warnings.join('；')}。请改用其他方法，或直接向用户说明情况。不要继续重试。】`
              }
            } else {
              toolFailCount.set(tc.function.name, 0)
            }

            // 工具执行完成：更新消息状态（flushSync 确保 DOM 即时提交后再滚动，防止布局偏移）
            const capped = truncateToolResult(toolResult, toolResultCharLimit(opts.ctxBudget))
            flushSync(() => { commitToolCall(liveId, tc.id, { status: 'done', result: capped.text, truncated: capped.truncated, resultTotal: capped.total, failed }) })
            apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: capped.text })
            scrollToBottom()
            // TodoWrite 执行完毕后立即刷新任务数据，弹窗内容随之更新
            if (tc.function.name === 'TodoWrite') {
              refreshTasksRef.current()
            }
          }
          if (abortRef.current.aborted) break
          // ★ 工具执行完毕，清除 store 阶段状态
          useStore.getState().setAgentPhase(null)
          // 工具执行后刷新任务清单
          refreshTasksRef.current()
          continue
        }

        // 最终文本回复
        if (!streamedText) {
          const errText = streamError ? `模型调用失败：${streamError}` : '（无内容返回）'
          if (streamError) endedWithError = true
          displayMsgs = displayMsgs.slice(0, -1).concat({ id: liveId, role: 'assistant', content: errText })
          updateSessionInProject(pid, sid, { messages: displayMsgs })
        }
        break
      }
    } catch (e: any) {
      console.error('[AgentCode] send error', e)
      endedWithError = true
      updateSessionInProject(pid, sid, { messages: [...displayMsgs, { id: newMsgId(), role: 'assistant' as const, content: '发送失败：' + (e?.message || String(e)) }] })
    } finally {
      abortRef.current.resolve = null
      currentStreamIdRef.current = null
      useStore.getState().setAgentPhase(null)
      setLoading(false)
      setStreaming(false)
      // 本轮结束后，自动发送排队中的消息
      const pending = pendingSendRef.current
      pendingSendRef.current = null
      if (pending && (pending.text.trim() || pending.attachments.length)) {
        setTimeout(() => handleSendRef.current(pending.text || undefined, pending.attachments), 0)
      }
    }
    return { errored: endedWithError, aborted: abortRef.current.aborted }
  }, [updateSessionInProject, waitForApproval])

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

    // 立即清空输入框并复位高度：消息已成功加入会话，避免输入框残留刚发出的内容
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

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

    // 构建系统提示（含项目自定义指令）与工具集
    const systemMsg: ApiMessage = { role: 'system', content: buildSystemContent(activeProject) }
    const apiMsgs = [systemMsg, ...buildApiMessages(displayMsgs)]
    // 上下文预算：依据服务端真实 n_ctx（取不到则兜底 4096）预留输出与安全余量，
    // 用于发送前裁剪历史，避免超出本地模型的固定上下文窗口
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    // 多模态（图片）与 tools 冲突，含图片时关闭工具调用；否则仅暴露文件操作类工具
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))

    await runAgentTurn(pid, sid, displayMsgs, apiMsgs, {
      port: runningCard.template.serverPort,
      tools,
      userHasImages,
      ctxBudget,
      approveWriteEdit: !!activeProject.approveWriteEdit,
    })
  }, [input, attachedFiles, loading, apiBaseUrl, runningCard, activeProjectId, activeSessionId, activeSession, activeProject, updateSessionInProject, runAgentTurn])

  // 始终持有最新的 handleSend，供排队回调使用，避免过期闭包
  handleSendRef.current = handleSend

  // ── 消息级操作：复制 / 重新生成 / 重发 / 分支 / 编辑 / 撤销 ──
  const copyMessage = useCallback(async (content: string) => {
    // 复制时剥离思考链（<think>…</think>），只保留模型正文；
    // 用户消息无思考链，过滤后内容不变
    const plain = parseThinkSegments(content).filter(s => s.type === 'text').map(s => s.value).join('')
    try { await navigator.clipboard.writeText(plain); notify('已复制到剪贴板', 'success') }
    catch { notify('复制失败', 'error') }
  }, [])

  // 重新生成 / 重发失败回滚：依据 runAgentTurn 返回结果，恢复原有消息
  const rollbackIfFailed = (r: { errored: boolean; aborted: boolean }) => {
    if (!r.errored || r.aborted) { regenRollbackRef.current = null; return }
    const rb = regenRollbackRef.current
    regenRollbackRef.current = null
    if (rb && rb.sid === activeSessionId) {
      updateSessionInProject(activeProjectId, activeSessionId, { messages: rb.messages })
      notify('重新生成失败，已恢复原有回复', 'error')
    }
  }

  // 重新生成：截断到该助手消息之前（保留其前置 user 轮），重跑一轮
  const regenerateAt = useCallback(async (msgId: string) => {
    if (loading || !runningCard || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0) return
    const base = msgs.slice(0, idx)
    if (base.length === 0) return
    regenRollbackRef.current = { sid: activeSessionId, messages: msgs.map(m => ({ ...m })) }
    updateSessionInProject(activeProjectId, activeSessionId, { messages: base })
    const systemMsg: ApiMessage = { role: 'system', content: buildSystemContent(activeProject) }
    const apiMsgs = [systemMsg, ...buildApiMessagesFull(base)]
    const lastUser = [...base].reverse().find(m => m.role === 'user')
    const userHasImages = !!(lastUser?.attachments?.some(a => a.type === 'image' && a.dataUrl))
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))
    const r = await runAgentTurn(activeProjectId, activeSessionId, base, apiMsgs, {
      port: runningCard.template.serverPort, tools, userHasImages, ctxBudget, approveWriteEdit: !!activeProject.approveWriteEdit,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runAgentTurn])

  // 重发：截断保留到该 user 消息（含），重新生成其回复
  const resendAt = useCallback(async (msgId: string) => {
    if (loading || !runningCard || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0 || msgs[idx]!.role !== 'user') return
    const base = msgs.slice(0, idx + 1)
    regenRollbackRef.current = { sid: activeSessionId, messages: msgs.map(m => ({ ...m })) }
    updateSessionInProject(activeProjectId, activeSessionId, { messages: base })
    const systemMsg: ApiMessage = { role: 'system', content: buildSystemContent(activeProject) }
    const apiMsgs = [systemMsg, ...buildApiMessagesFull(base)]
    const userHasImages = !!(msgs[idx]!.attachments?.some(a => a.type === 'image' && a.dataUrl))
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))
    const r = await runAgentTurn(activeProjectId, activeSessionId, base, apiMsgs, {
      port: runningCard.template.serverPort, tools, userHasImages, ctxBudget, approveWriteEdit: !!activeProject.approveWriteEdit,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runAgentTurn])

  // 分支：从指定 user 消息处复制出一条新会话（不自动运行）
  const branchAt = useCallback((msgId: string) => {
    if (!activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0 || msgs[idx]!.role !== 'user') return
    const branchMsgs = msgs.slice(0, idx + 1).map(m => ({ ...m }))
    const branchSess: AgentSession = { id: uniqueId('sess'), title: activeSession.title + ' (分支)', messages: branchMsgs }
    setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, sessions: [...p.sessions, branchSess] } : p))
    setActiveSessionId(branchSess.id)
    notify('已创建分支对话', 'success')
  }, [activeSession, activeProjectId, setProjects, setActiveSessionId])

  // 编辑用户消息：进入内联编辑（保存时截断其后所有消息，不自动发送）
  const editAt = useCallback((msgId: string) => {
    const m = activeSession?.messages.find(x => x.id === msgId)
    if (!m || m.role !== 'user') return
    setEditingMsgId(msgId)
    setEditDraft(m.content)
  }, [activeSession])

  const confirmEdit = useCallback(() => {
    if (!editingMsgId || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === editingMsgId)
    if (idx < 0) { setEditingMsgId(null); return }
    const newContent = editDraft
    const updated = msgs.slice(0, idx).concat({ ...msgs[idx]!, content: newContent })
    updateSessionInProject(activeProjectId, activeSessionId, { messages: updated })
    setEditingMsgId(null)
  }, [editingMsgId, editDraft, activeSession, activeProjectId, activeSessionId, updateSessionInProject])

  // 一键撤销：把工具执行前的原文件内容写回（仅当前会话内存备份有效）
  const handleUndo = useCallback(async (msgId: string, tcId: string) => {
    const b = backupsRef.current[tcId]
    if (!b) return
    const res = await window.api.writeFile(b.path, b.content)
    if (!res.success) { notify('恢复失败：' + (res.error || '未知错误'), 'error'); return }
    delete backupsRef.current[tcId]
    setProjects(prev => prev.map(p => p.id === activeProjectId ? {
      ...p,
      sessions: p.sessions.map(s => s.id === activeSessionId ? {
        ...s,
        messages: s.messages.map(m => m.id === msgId ? {
          ...m,
          toolCalls: (m.toolCalls || []).map(t => t.id === tcId ? { ...t, restored: true, backupPath: undefined } : t)
        } : m)
      } : s)
    } : p))
    notify('已恢复文件：' + dirName(b.path), 'success')
  }, [activeProjectId, activeSessionId, setProjects])

  // 系统提示词编辑器
  const openPromptModal = useCallback(() => {
    const next = !promptModalOpen
    setPromptModalOpen(next)
    if (next) {
      setPromptDraft(activeProject.systemPrompt ?? '')
      setApproveWriteEditDraft(!!activeProject.approveWriteEdit)
    }
  }, [activeProject, promptModalOpen])

  const saveSystemPrompt = useCallback(() => {
    updateProject(activeProjectId, { systemPrompt: promptDraft, approveWriteEdit: approveWriteEditDraft })
    setPromptModalOpen(false)
    notify('已保存系统提示词', 'success')
  }, [activeProjectId, promptDraft, approveWriteEditDraft, updateProject])

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

  // 始终持有最新 atQuery，供异步加载回调读取（避免闭包陈旧）
  const atQueryRef = useRef<string>('')
  useEffect(() => { atQueryRef.current = atQuery ?? '' }, [atQuery])

  // 输入框 onChange：更新文本 + 自动增高，并检测 @ 触发文件补全浮层
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const caret = e.target.selectionStart ?? value.length
    setInput(value)
    autoResize()
    const dir = activeProject.workspaceDir
    if (!dir) { setAtQuery(null); return }
    if (detectAt(value, caret)) {
      // 先确保文件列表已加载（按工作区缓存），再过滤
      ensureWorkspaceFiles(dir).finally(() => {
        // 输入框可能在加载期间又变化，仅当仍处于激活状态才过滤
        if (atAnchorRef.current != null) filterAtFiles(atQueryRef.current ?? '')
      })
    }
  }, [autoResize, detectAt, ensureWorkspaceFiles, filterAtFiles, activeProject.workspaceDir])

  // 兼容 arguments 为字符串或已解析对象两种情况，避免 JSON.parse(object) 抛错
  function parseToolArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw === 'string' && raw.trim()) {
      try { return JSON.parse(raw) } catch { return {} }
    }
    return {}
  }

  const renderToolCalls = (toolCalls: NonNullable<AgentMessage['toolCalls']>, msgId: string) => (
    <ToolCallGroup
      toolCalls={toolCalls}
      cardDefaultOpen={toolCardExpandedDefault}
      onPreviewFile={openPreview}
      canUndoFor={(tc) => !!backupsRef.current[tc.id]}
      onUndo={(tc) => handleUndo(msgId, tc.id)}
    />
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
          <button ref={ctxBtnRef} className={`agent-code-topbar-btn ${contextModalOpen ? 'active' : ''}`} onClick={() => setContextModalOpen(v => !v)} title="上下文窗口">上下文</button>
          <button className={`agent-code-topbar-btn ${taskModalOpen ? 'active' : ''}`} onClick={() => { const next = !taskModalOpen; setTaskModalOpen(next); if (next) refreshTasks() }} title="任务计划">计划</button>
          <button ref={promptBtnRef} className={`agent-code-topbar-btn ${promptModalOpen ? 'active' : ''}`} onClick={openPromptModal} title="自定义系统提示词"><SlidersHorizontal size={12} /> 提示词</button>
          <button className="chat-collapse-btn" onClick={() => { setContextModalOpen(false); setTreeOpen(v => !v) }} title={treeOpen ? '收起面板' : '展开面板'} style={{ marginTop: 0, width: 28, height: 28 }}>
            {treeOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        </div>

      </div>

      <div ref={viewBodyRef} className={`agent-code-body ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
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
                <div className="agent-welcome-hint">
                  <span>⏎ 发送</span>
                  <span className="agent-welcome-atfile">@ 文件</span>
                </div>
                <div className="agent-welcome-suggestions">
                  {AGENT_SUGGESTIONS.map((s) => (
                    <button key={s} className="agent-suggestion" onClick={() => sendSuggestion(s)}>{s}</button>
                  ))}
                </div>
              </div>
            ) : activeSession.messages.map((msg, i) => {
              const isLast = i === activeSession.messages.length - 1
              // 核心修复：一旦消息已携带 toolCalls，说明模型已经完成思考并决定调用工具，
              // 此时 ThinkBlock 绝不应再显示“思考中”转圈，无论 streaming 状态如何。
              const hasToolCalls = !!(msg.toolCalls?.length)
              const streamingThis = streaming && isLast && msg.role === 'assistant' && !hasToolCalls
              return (
                <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
                  {msg.role !== 'user' && (
                    <div className="chat-msg-avatar"><Bot size={14} /></div>
                  )}
                  <div className="chat-msg-body">
                    {msg.role === 'user' ? (
                      editingMsgId === msg.id ? (
                        <div className="chat-msg-bubble chat-msg-edit">
                          <textarea className="agent-msg-edit-area" value={editDraft} onChange={e => setEditDraft(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmEdit(); if (e.key === 'Escape') setEditingMsgId(null) }} />
                          <div className="agent-msg-edit-actions">
                            <button className="btn btn-primary btn-xs" onClick={confirmEdit}>保存</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setEditingMsgId(null)}>取消</button>
                          </div>
                        </div>
                      ) : msg.content ? (
                        <>
                          <div className="chat-msg-bubble chat-msg-markdown"><AgentMarkdown content={msg.content} /></div>
                          <div className="chat-msg-actions">
                            <button className="chat-msg-action-btn" title="复制" onClick={() => copyMessage(msg.content)}><Copy size={13} /></button>
                            <button className="chat-msg-action-btn" title="编辑" onClick={() => editAt(msg.id)} disabled={loading}><Pencil size={13} /></button>
                            <button className="chat-msg-action-btn" title="重发" onClick={() => resendAt(msg.id)} disabled={loading}><Send size={13} /></button>
                            <button className="chat-msg-action-btn" title="从此处分支" onClick={() => branchAt(msg.id)} disabled={loading}><GitBranch size={13} /></button>
                          </div>
                        </>
                      ) : null
                    ) : (
                      <>
                        {msg.stopped && (
                          <div className="chat-msg-stopped-badge">
                            <Square size={10} />
                            <span>已停止生成</span>
                          </div>
                        )}
                        {/* 流式期间：模型名 + 预估 token + 实时 t/s 徽标（参考 pi-web） */}
                        {streamingThis && (
                          <StreamingBadge text={msg.content || ''} modelLabel={modelLabel} />
                        )}
                        {streamingThis && !msg.content ? (
                          <div className="chat-msg-bubble chat-msg-thinking-wait">
                            <Loader2 size={14} className="spin" />
                            <span className="chat-msg-thinking-text">模型思考中…</span>
                          </div>
                        ) : (
                          parseThinkSegments(msg.content || '').map((seg, j) =>
                            seg.type === 'think'
                              ? <ThinkBlock key={`t-${j}`} value={seg.value} closed={seg.closed || !streamingThis || hasToolCalls} isStreaming={streamingThis && !seg.closed} />
                              : <div key={`m-${j}`} className={`chat-msg-bubble chat-msg-markdown${streamingThis ? ' chat-msg-bubble--streaming' : ''}`}><AgentMarkdown content={seg.value} /></div>
                          )
                        )}
                        {/* 工具调用结果卡片 */}
                        {hasToolCalls ? renderToolCalls(msg.toolCalls!, msg.id) : null}
                        {/* 流式进行中或工具调用消息不展示操作按钮 */}
                        {!streamingThis && !hasToolCalls && (
                          <div className="chat-msg-actions">
                            <button className="chat-msg-action-btn" title="复制" onClick={() => copyMessage(msg.content || '')}><Copy size={13} /></button>
                            {isLast && !loading && (
                              <button className="chat-msg-action-btn" title="重新生成" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                            )}
                            {isLast && (msg.stopped || (msg.content && (msg.content.startsWith('模型调用失败') || msg.content.startsWith('发送失败')))) && !loading && (
                              <button className="chat-msg-action-btn" title="重试" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                            )}
                          </div>
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
          {/* 任务计划卡片（浮动在聊天区右上角） */}
          {taskModalOpen && (
            <div className="agent-task-card">
              <div className="agent-task-card-header">
                <span>任务计划</span>
              </div>
              <div className="agent-task-card-body">
                {currentPlanItems.length === 0 ? (
                  <div className="agent-task-card-empty">暂无计划</div>
                ) : (
                  currentPlanItems.map((item, i) => (
                    <div key={item.id || i} className="agent-task-card-item">
                      <div className="agent-task-card-row">
                        <span className="agent-task-card-id">{item.id ? `#${item.id}` : `#${i + 1}`}</span>
                        <span className={`task-status ${item.status || 'pending'}`}>{item.status || 'pending'}</span>
                      </div>
                      <div className="agent-task-card-subject">{item.content || item.description || ''}</div>
                      {item.notes ? <div className="agent-task-card-notes">{item.notes}</div> : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          {/* 上下文卡片（浮动在聊天区右上角） */}
          {contextModalOpen && (
            <div className="agent-task-card agent-card-ctx">
              <div className="agent-task-card-header">
                <span>上下文窗口</span>
              </div>
              <div className="agent-task-card-body">
                <AgentContextPanel
                  templateId={runningCard?.template.id ?? null}
                  startedAt={runningCard?.startedAt}
                  requests={reqCount}
                  cumTokens={cumTokens}
                />
              </div>
            </div>
          )}
          {/* 提示词卡片（浮动在聊天区右上角） */}
          {promptModalOpen && (
            <div className="agent-task-card agent-card-prompt">
              <div className="agent-task-card-header">
                <span>系统提示词 · {activeProject.title}</span>
              </div>
              <div className="agent-task-card-body agent-card-prompt-body">
                <p className="agent-prompt-hint">为该项目的智能体追加自定义指令（如「只用中文回复」「优先最小改动」）。留空则使用默认工具指引。</p>
                <textarea className="agent-prompt-textarea" value={promptDraft} onChange={e => setPromptDraft(e.target.value)} placeholder="例如：你只允许使用中文；修改文件时优先给出最小改动；不要随意运行删除命令。" />
                <label className="agent-prompt-check">
                  <input type="checkbox" checked={approveWriteEditDraft} onChange={e => setApproveWriteEditDraft(e.target.checked)} />
                  对写入 / 编辑（Write / Edit）也要求人工确认
                </label>
              </div>
              <div className="agent-card-prompt-footer">
                <button className="btn btn-ghost btn-xs" onClick={() => { setPromptDraft(''); setApproveWriteEditDraft(false) }}>重置默认</button>
                <button className="btn btn-ghost btn-xs" onClick={() => setPromptModalOpen(false)}>取消</button>
                <button className="btn btn-primary btn-xs" onClick={saveSystemPrompt}>保存</button>
              </div>
            </div>
          )}
          {/* 滚动到底部浮动按钮：仅当消息列表较长且用户已向上滚动（非贴底）时显示。
              置于 .agent-code-chat（非滚动容器）内，用 --chat-input-h 变量精确浮在输入框上方。 */}
          {!atBottom && (
            <button className="chat-scroll-bottom-btn" onClick={() => scrollToBottom(true)} title="滚动到底部">
              <ChevronDown size={18} />
            </button>
          )}
          <div className="chat-input-area" ref={chatInputAreaRef}>
            {atQuery !== null && (
              <div className="chat-at-file-pop" ref={atPopRef}>
                {atFiles.length === 0 ? (
                  <div className="chat-at-empty">无匹配文件</div>
                ) : (
                  atFiles.map(f => (
                    <button className="chat-at-item" key={f.path} onClick={() => onPickAtFile(f)} title={f.path}>
                      <FileText size={13} />
                      <span className="chat-at-name">{f.name}</span>
                      <span className="chat-at-rel">{f.relPath}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {ctxTrimInfo && (
              <div className="agent-ctx-trim-note" title="为保证不超出本地模型的上下文窗口，已自动省略最早的若干条对话（仅影响发送给模型的内容，界面历史保持完整）">
                <AlertCircle size={12} /> 已因上下文窗口限制自动省略最早 {ctxTrimInfo.dropped} 条消息
              </div>
            )}
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
              <textarea ref={textareaRef} className="chat-input" placeholder={apiBaseUrl ? '输入自然语言指令，或添加附件 / 图片…' : '请先启动模型'} rows={1} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown} disabled={!apiBaseUrl} />
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
          <div className="agent-code-right-body">
                <div className="agent-code-tree">
                  <AgentFileTree workspaceDir={activeProject.workspaceDir} onPreviewFile={openPreview} onSendFileName={(name) => insertAtCursor(name)} />
                </div>
                <div className={`agent-code-resize-handle${previewResizing ? ' agent-code-resize-handle--active' : ''}`} onPointerDown={startResize('preview')} title="拖动调整预览宽度" />
                <div className={`agent-code-preview-group ${openTabs.length === 0 ? 'collapsed' : ''}`}>
                  <div className="agent-code-preview">
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

      {/* 破坏性工具审批弹窗 */}
      {approvalReq && (
        <div className="modal-overlay" onClick={() => resolveApproval(false)}>
          <div className="modal agent-approve-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <AlertCircle size={20} style={{ color: 'var(--warning)', flexShrink: 0 }} />
              <span className="modal-title">需要确认：{TOOL_META[approvalReq.name]?.name || approvalReq.name}</span>
            </div>
            <div className="modal-body">
              <p className="agent-approve-desc">该操作具有破坏性，执行前需要你人工确认：</p>
              <div className="agent-approve-detail">
                <div className="agent-approve-detail-row"><span>工具</span><code>{approvalReq.name}</code></div>
                <div className="agent-approve-detail-row">
                  <span>参数</span>
                  <pre className="agent-approve-args">{formatToolArgs(approvalReq.args) || '(无)'}</pre>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => resolveApproval(false)}>拒绝</button>
              <button className="btn btn-ghost" onClick={() => { autoApproveRef.current = true; resolveApproval(true) }}>本次全部允许</button>
              <button className="btn btn-primary" onClick={() => resolveApproval(true)}>允许</button>
            </div>
          </div>
        </div>
      )}

      <AskUserQuestionModal />

    </div>
  )
}
