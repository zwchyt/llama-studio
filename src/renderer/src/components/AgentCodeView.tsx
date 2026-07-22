import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
import '../styles/monitoring.css'
import { Send, Square, X, FileText, Bot, User, Folder, FolderOpen, Plus, Trash2, AlertCircle, Wrench, Loader2, ChevronRight, ChevronDown, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, Pencil, Brain, RefreshCw, TerminalSquare, Clock, CheckCircle2, XCircle, GitBranch, RotateCcw, SlidersHorizontal, Undo2, Copy, Check, Code2, Bug, Sparkles, Cpu, Play } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import { playNotificationSound } from '../utils/sound'
import { safeCall } from '../utils/safeCall'
import { getToolDefinitions, executeToolCall, TOOL_METAS, APPROVAL_TOOLS, WRITE_EDIT_TOOLS, BACKUP_TOOLS } from '../utils/tools'
import { setWorkspaceRootForSession, getWorkspaceRootForSession } from '../tools/workspaceRoot'
import { setAgentSessionId } from '../tools/agentSession'
import { getFileReadPrompt } from '../tools/FileReadTool/prompt'
import { getFileWritePrompt } from '../tools/FileWriteTool/prompt'
import { getFileEditPrompt } from '../tools/FileEditTool/prompt'
import { getGlobPrompt } from '../tools/GlobTool/prompt'
import { getGrepPrompt } from '../tools/GrepTool/prompt'
import { getListDirPrompt } from '../tools/ListDirTool/prompt'
import { getAnalyzeDirPrompt } from '../tools/AnalyzeDirTool/prompt'
import { getBashPrompt } from '../tools/BashTool/prompt'
import { isDestructiveBashCommand } from '../tools/BashTool/BashTool'
import { getFileDeletePrompt } from '../tools/FileDeleteTool/prompt'
import { getTodoWritePrompt } from '../tools/TodoWriteTool/prompt'
import { getAskUserQuestionPrompt } from '../tools/AskUserQuestionTool/prompt'
import { askUserQuestionRegistry } from '../utils/askUserQuestionRegistry'
import { getTaskGetPrompt } from '../tools/TaskGetTool/prompt'
import { getTaskListPrompt } from '../tools/TaskListTool/prompt'
import { getTaskOutputPrompt } from '../tools/TaskOutputTool/prompt'
import AgentFileTree from './AgentFileTree'

import AgentContextPanel from './AgentContextPanel'
import CodeBlock from './CodeBlock'
import AskUserQuestionInline from './AskUserQuestionInline'
import AgentFilePicker from './AgentFilePicker'

import type { AgentMessage, AgentSession, AgentProject, Attachment, AgentTask, TodoUpdate, AgentSegment, CardState } from '../../../shared/types'
import '../styles/agent-code.css'

type ApiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

let idCounter = 0
function newId(prefix = 'x') { return `${prefix}-${++idCounter}` }
function newMsgId() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
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

function MarkdownPre({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

const SAFE_URL_RE = /^(https?:|mailto:)/i
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const url = typeof href === 'string' ? href : ''
  const safe = SAFE_URL_RE.test(url)
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        if (safe) window.api.openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

function remarkLinkifyUrls() {
  const URL_RE = /(https?:\/\/[^\s<>"')]+)/g
  const splitText = (value: string): any[] => {
    const out: any[] = []
    let last = 0
    let m: RegExpExecArray | null
    URL_RE.lastIndex = 0
    while ((m = URL_RE.exec(value)) !== null) {
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
      out.push({
        type: 'link',
        url: m[0],
        data: { hProperties: { href: m[0] } },
        children: [{ type: 'text', value: m[0] }],
      })
      last = m.index + m[0].length
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
    return out
  }
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child && child.type === 'text' && typeof child.value === 'string' && URL_RE.test(child.value)) {
          URL_RE.lastIndex = 0
          node.children.splice(i, 1, ...splitText(child.value))
          i += splitText(child.value).length - 1
        } else {
          visit(child)
        }
      }
    }
  }
  return (tree: any) => { visit(tree) }
}

function MarkdownCode({ className, children, node }: { className?: string; children?: React.ReactNode; node?: any }) {
  const nodeText: string | undefined = node?.children?.[0]?.value
  const nodeToText = (n: React.ReactNode): string => {
    if (n == null) return ''
    if (typeof n === 'string') return n
    if (typeof n === 'number') return String(n)
    if (Array.isArray(n)) return n.map(nodeToText).join('')
    if (typeof n === 'object' && 'props' in (n as any)) return nodeToText((n as any).props?.children)
    return ''
  }
  const text = (typeof nodeText === 'string' ? nodeText : nodeToText(children)).replace(/\n$/, '')
  const match = /language-([^\s]+)/.exec(className || '')
  if (match) {
    return <CodeBlock language={match[1]} value={text} />
  }
  if (text.includes('\n')) {
    return <CodeBlock language="" value={text} />
  }
  return <code className="chat-code-in-line">{text}</code>
}

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), 'align', 'style'],
    p: [...(defaultSchema.attributes?.p || []), 'align', 'style'],
    span: [...(defaultSchema.attributes?.span || []), 'style'],
    img: [...(defaultSchema.attributes?.img || []), 'width', 'height', 'style', 'loading'],
    table: [...(defaultSchema.attributes?.table || []), 'style'],
    td: [...(defaultSchema.attributes?.td || []), 'style', 'colspan', 'rowspan'],
    th: [...(defaultSchema.attributes?.th || []), 'style', 'colspan', 'rowspan'],
    '*': [...(defaultSchema.attributes?.['*'] || []), 'style'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || ['http', 'https']), 'data'],
  },
}

const AgentMarkdown = React.memo(function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkLinkifyUrls]}
      // 顺序关键：先 rehypeRaw 解析原始 HTML，再 rehypeSanitize 清洗（含模型注入的 HTML），
      // 最后由 rehypeKatex 渲染数学公式。KaTeX 的产物（大量 class 与 MathML 标签）不再经过
      // sanitize，避免被默认 schema 剥离导致公式无法渲染；同时未信任内容仍被 sanitize 保护。
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeKatex]}
      remarkRehypeOptions={{ allowDangerousHtml: true }}
      urlTransform={(url) => /^(https?:|mailto:|file:|data:)/i.test(url) ? url : defaultUrlTransform(url)}
      components={{ code: MarkdownCode as any, pre: MarkdownPre as any, a: MarkdownLink as any }}
    >
      {content}
    </ReactMarkdown>
  )
})

function preprocessReadmeHtml(src: string): string {
  return src ?? ''
}

const pathDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')
function renderPreviewMarkdown(content: string): string {
  return preprocessReadmeHtml(content ?? '')
}


// ── 工具元信息：中文名 / 描述 / 图标（用于工具调用块展示）────
// 工具分类/展示/权限元数据已集中到 utils/tools.ts 的 TOOL_METAS（单一事实来源）。
// 以下 helper 从元数据派生，替代原先散落的字符串 Set 与手写 Map。
const TOOL_META: Record<string, { name: string; desc: string; icon: React.ComponentType<{ size?: number; className?: string }> }> =
  Object.fromEntries(
    Object.entries(TOOL_METAS).map(([name, m]) => [name, { name: m.label, desc: '', icon: m.icon }])
  )

// 工具「执行中」状态文案（替代通用的「执行中…」，显示具体动作，如 Edit 编辑中）
function toolRunVerb(name: string): string {
  return TOOL_METAS[name]?.verb ?? '执行中'
}

// Agent 工作台暴露文件操作类工具 + Bash 执行（不调用联网 / 时间类工具）
const AGENT_FILE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'ListDir', 'AnalyzeDir', 'Delete', 'TodoWrite', 'AskUserQuestion', 'TaskGet', 'TaskList', 'TaskOutput', 'GetBackgroundTaskOutput', 'ListBackgroundTasks']

const BACKUP_MAX_BYTES = 2 * 1024 * 1024

// 发现项目说明文件（README / AGENTS.md / CLAUDE.md 等），并将其内容注入系统提示，
// 让模型开箱即知项目类型/约定/架构概览（参考 grok-build 的 AGENTS.md 逐级发现）。
// 仅在 workspaceDir 非空时尝试，失败/无文件时不阻断。
async function discoverProjectDocs(workspaceDir: string): Promise<string> {
  if (!workspaceDir) return ''
  const candidates = ['README.md', 'README', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']
  const parts: string[] = []
  for (const name of candidates) {
    try {
      const path = workspaceDir.replace(/\\/g, '/') + '/' + name
      const res = await window.api.readFile(path, { maxBytes: 8000 })
      if (res.success && res.content) {
        const title = name === 'README.md' || name === 'README' ? '项目说明（README）'
          : name === 'AGENTS.md' ? '项目智能体约定（AGENTS.md）'
            : name === 'CLAUDE.md' ? '项目智能体约定（CLAUDE.md）'
              : name === 'CONTRIBUTING.md' ? '贡献指南'
                : name
        parts.push(`## ${title}\n\n${res.content}`)
      }
    } catch { /* 文件不存在或无法读取，跳过 */ }
  }
  return parts.length ? `\n\n## 项目说明\n\n以下内容从工作区项目文件自动提取，供你了解项目的类型、结构和约定：\n\n${parts.join('\n\n---\n\n')}\n` : ''
}

// 构建系统提示词：自定义指令（按项目）优先，其后追加工具使用指引
async function buildSystemContent(project: AgentProject): Promise<string> {
  const toolPrompts = [
    getFileReadPrompt(),
    getFileWritePrompt(),
    getFileEditPrompt(),
    getGlobPrompt(),
    getGrepPrompt(),
    getBashPrompt(),
    getFileDeletePrompt(),
    getListDirPrompt(),
    getAnalyzeDirPrompt(),
    getTodoWritePrompt(),
    getAskUserQuestionPrompt(),
    getTaskGetPrompt(),
    getTaskListPrompt(),
    getTaskOutputPrompt(),
  ].join('\n\n---\n\n')
  const base = `你是 llama-studio 的编码智能体，运行在桌面 GUI 环境中。你的工作目录由用户在界面上选择。你的核心目标是通过工具调用协助用户完成软件工程任务。请仔细阅读以下行为准则。

## 操作安全分级

根据操作的可逆性和影响范围，分为三级：

- **安全操作（自由执行）**：读取文件、搜索内容、glob 查找文件、获取时间。这些操作不会修改任何状态，可直接执行。
- **需确认操作（等待用户审批）**：
  - \`Delete\`、\`Bash\` — 无论何时都需用户确认
  - \`Write\`、\`Edit\` — 取决于项目设置（可在项目面板中切换开关）
  对于这些工具，你发起调用后会弹出审批窗口等待用户决定。如果用户拒绝，会返回拒绝信息，请根据该信息调整方案。
- **备份保护**：\`Write\`、\`Edit\`、\`Delete\` 在执行前会自动备份原文件内容，支持一键撤销。

一次同意不是空白授权。即使之前允许过某个操作，后续每次调用仍需独立审批。

## 工具使用规范

优先使用专用工具而非 shell 命令：
- 读文件 → 使用 \`Read\` 工具（返回 \`行号 哈希|内容\` 格式的 **Hashline 锚点**，每行带内容指纹哈希，用于 Edit 精确定位）
- 写文件 → 使用 \`Write\` 工具（会自动创建父目录）
- 编辑文件 → 使用 \`Edit\` 工具（配合 Read 返回的 hashline：\`old_string\` 取 \`|\` 后的内容，可选 \`hashline\` 参数交叉验证）
- 搜索文件 → 使用 \`Glob\` 工具（按文件名模式匹配）
- 搜索内容 → 使用 \`Grep\` 工具（按正则搜索内容）
- 执行命令 → 使用 \`Bash\` 工具（终端、脚本、编译等）
- 删除文件 → 使用 \`Delete\` 工具

仅在真正需要 shell 执行时使用 \`Bash\`。禁止用 echo 或其他命令输出工具来与用户通信——所有回复应直接写在 response 文本中。

## 探索项目的高效策略

分析项目架构或定位代码时，**先建立全局视图，再只深入相关的部分**，不要盲目枚举：

- **先概览、后深入**：分析目录/项目功能时，**直接用 \`AnalyzeDir\`（项目根）一次得到完整概览**（目录树 + 入口文件 + 文件类型统计），配合 \`Grep\`/\`Glob\` 建立整体认知；确认了与任务相关的文件后，再针对性 \`Read\`。\`AnalyzeDir\` 已包含整棵树，无需再逐层探索。
- **禁止逐个 Read**：不要把一个目录下的所有文件逐一 \`Read\`。优先用 \`Grep\` 按关键词 / 入口符号定位，用 \`Glob\` 按文件名模式筛选，而不是通读。
- **一个目录只需一次 \`AnalyzeDir\`**：分析目录结构**只需调用一次 \`AnalyzeDir\`**，它已递归返回全树概览。严禁为了"看所有文件夹"而对每个子目录各发一条命令——这既浪费轮次又撑爆上下文。\`ListDir\` 与 \`AnalyzeDir\` 不要混用做同一件事：\`ListDir\` 只看单个目录单层（确认/核对路径），\`AnalyzeDir\` 做全局概览，二者择一即可。
- **严禁用 Bash 列目录、严禁 ListDir recursive 全树 dump**：查看目录结构一律用 \`AnalyzeDir\` / \`ListDir\`，**绝对禁止**用 \`Bash\` 执行 \`dir\` / \`ls\` 等命令来列目录（如 \`dir "路径"\` 这类命令是错误的枚举行为，会触发人工确认且绕过了专用工具）。**也不要**用 \`ListDir\` 的 \`recursive\` 参数一次性 dump 整棵树（会把成百上千文件灌入上下文）。\`Bash\` 仅用于真正需要 shell 执行的场景（运行程序、脚本、构建等），且需人工确认。
- **及时收敛**：在已有足够信息回答用户时，停止继续探索并直接给出结论，避免无意义的额外工具调用。

## 符号检索（高效定位函数/类/定义）

需要查找函数、类、接口等定义或引用时，不要逐一 Read 文件，而是用 \`Grep\` 按关键词定位：
- 查找函数/方法定义：\`Grep\` 模式 \`def 函数名\` 或 \`函数名=\` 或 \`function 函数名\`  
- 查找类定义：\`Grep\` 模式 \`class 类名\` 或 \`interface 类名\`  
- 查找引用/调用点：\`Grep\` 模式 \`函数名(\` 或 \`对象.方法(\`  
- 查找导入/导出：\`Grep\` 模式 \`from '模块名'\` 或 \`import {.*符号名.*}\`  
- 先用 \`output_mode: "files_with_matches"\`（默认）列命中文件，再针对性地 \`Read\` 具体段落，不要对全部命中文件逐一通读。
	
## 计划任务执行纪律

当你用 TodoWrite 创建了任务计划后，必须**严格按任务顺序逐个执行**，纪律如下：

- **顺序执行**：从第一个任务开始，运行它真正需要的工具（Read / Write / Edit / Bash / …），确认该任务的工作确实完成，再进入下一个任务。
- **禁止跳过**：绝不允许跳过任何一个 pending / in_progress 的任务，也不允许"跳着做"或只做其中几个。
- **禁止提前结束**：在所有任务都标记为 completed 之前，不得输出最终答案。若某个任务确实不再需要，必须显式将其标记为 cancelled，而不是悄悄跳过。
- **状态跟随（你负责）**：任务进行中用 in_progress 标记；当该任务对应的真实工具（Read/Write/Edit/Bash/…）**确实执行完成**后，你必须自己用 TodoWrite 把它标为 completed、并把下一个 pending 任务标为 in_progress。系统不会替你标 completed——只有你真正做完工作才能标，绝不可只创建/规划任务就标完成。可用 notes 字段记录验证结果。

这条纪律优先于"尽早给出结论"的倾向——计划未跑完就收尾属于未完成工作。

## 输出格式

使用 GitHub Flavored Markdown 格式：
- 并列项使用无序列表
- **强调**用粗体
- \`路径/命令/标识符\` 用行内代码
- 枚举型数据（文件/行号/状态、before/after、量化数据）用表格
- 代码块标注语言以启用语法高亮

你的回复应像优秀技术博客一样精确、结构化、高质量。避免行话堆砌，用简洁的语言解释做了什么和为什么。回复长度与任务复杂度匹配。

## 思考链格式（<think> 内的自我推理）

在 \`<think>\` 标签内输出推理过程时，必须**结构化、分层次**，禁止一大段纯文本堆砌。遵循以下约定：

- **分模块**：用 Markdown 标题把过程切成清晰阶段，推荐顺序：
  \`## 问题定位\` → \`## 根因分析\` → \`## 解决方案\`（定位类任务可用「现象 → 排查 → 结论」）。
- **步骤编号前缀**：多步推理统一用 \`**Step 1:**\` → \`**Step 2:**\` → \`**Step 3:**\` 前缀标注，\`Step N:\` 后紧跟内容说明，让用户能清晰追踪推理链条；若步骤内还有子推理，用有序列表 \`1. 2. 3.\` 或无序 bullet 点缩进。
- **逻辑阶段标注**：每步推理开头用 \`**思考：**\`、\`**分析：**\`、\`**结论：**\` 等标签明确标记当前所处的逻辑阶段，让阅读者一眼看出这一步是"在分析"还是"已得出结论"。
- **每步独立成段**：步骤之间用空行或分隔线（\`---\`）隔开，不要密集堆叠，确保视觉上可逐条扫读。
- **复杂步骤内的层次**：当一步涉及多个子推理时，用缩进 bullet points（\`- 子推理 1\` → \`- 子推理 2\`）展示子层级，不要平铺成连续段落。
- **突出核心结论**：最关键的根因 / 决策用 \`> 引用块\` 或 **加粗** 单独呈现，不要淹没在叙述中段。
- **标注关键信息**：文件路径、函数名、行号等一律用行内代码 \`\`\`path/to/file.py:123\`\`\` 或 \`\`\`function_name()\`\`\` 包裹；成组的关键信息（候选根因、受影响文件清单）用列表或表格罗列。
- **最终输出分离**：思考链结束后用 \`**最终答案：**\` 加粗标记或 \`---\` 分隔线明确隔离推理与最终结果，让用户知道"结论已出"。
- **整体简洁**：控制每步长度，优先使用短句和要点式表达；合理利用空格、对齐和分隔符提升可读性，避免冗长段落。
- 思考链是给用户看的「可追溯推理」，结构化程度直接决定可读性，请务必重视排版层次（缩进、序号、分隔线）。

## 工具调用注意事项

- 工具调用失败时，分析错误原因并修正参数后再试
- 如果同一工具连续失败多次，说明当前方法不可行，应改用其他方案或直接告知用户，不要反复重试
- 工具执行结果过长时会被自动截断（仅保留前 6000 字符），但完整内容你可以在预览面板中查看
- **读取文件后必须基于内容进行分析或给出下一步，严禁在未分析的情况下再次读取同一文件**。文件内容已保留在对话中，重复读取同一文件既浪费又无新信息；若确需回顾，直接引用上方已有的内容即可。
- Read 工具对同一文件的重复读取会被缓存并直接返回已有内容，此时请**直接分析已有内容**，不要继续发起新的 Read 调用。

请仔细阅读每个工具的具体使用说明：

	${toolPrompts}`
  const docs = await discoverProjectDocs(project.workspaceDir)
  const full = docs ? `${base}\n\n${docs}` : base
  const custom = project.systemPrompt?.trim()
  return custom ? `${custom}\n\n${full}` : full
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

const TOOL_RESULT_LIMIT = 6000
// 单条工具结果的硬上限（字符）：无论上下文多大都不超过此值。
// 关键护栏：32k 这类小上下文模型上，toolResultCharLimit 原随预算放大到 ~68k 字符，
// 一条 Read 大文件就能吃掉大半个 prompt 预算 → 几轮就把上下文填爆。
// 这里封顶，保证单条结果在任何模型上都不会超过 ~16k 字符（约 5k token）。
const TOOL_RESULT_HARD_CAP = 16000
// 单条工具结果最多可占 prompt 预算的比例：从预算分配层面兜底，
// 即使预算很大，单条也不会吃掉大部分可用上下文（小上下文模型受益最大）。
const TOOL_RESULT_BUDGET_RATIO = 0.4
// 工具结果截断：两种策略
//  - 'keep-ends'（默认，bash/read 等）：保留头尾，中间省略——内容对模型有价值，尽量保全
//  - 'drop-long-lines'（grep 等）：超长单行直接丢弃并标注，避免单条巨行挤占上下文
// 参考 grok-build 的「grep 类丢弃+标记 / bash 类软换行保全部」二分思路。
const TRUNC_LINE_CAP = 2000 // 单行超此长度则在 drop 模式下截断/标注
function truncateToolResult(s: string, limit: number = TOOL_RESULT_LIMIT, mode: 'keep-ends' | 'drop-long-lines' = 'keep-ends'): { text: string; truncated: boolean; total: number } {
  if (s.length <= limit) {
    if (mode === 'drop-long-lines') {
      // 未超总限，但仍可能含个别超长行：仅做行级收敛
      const lines = s.split('\n')
      let changed = false
      const out = lines.map(l => {
        if (l.length > TRUNC_LINE_CAP) { changed = true; return l.slice(0, TRUNC_LINE_CAP) + ` [... 单行过长已截断 ${l.length - TRUNC_LINE_CAP} 字符]` }
        return l
      })
      if (changed) return { text: out.join('\n'), truncated: false, total: s.length }
    }
    return { text: s, truncated: false, total: s.length }
  }
  if (mode === 'drop-long-lines') {
    const lines = s.split('\n')
    const kept: string[] = []
    let total = 0
    let dropped = 0
    for (const l of lines) {
      if (l.length > TRUNC_LINE_CAP) { dropped++; kept.push(l.slice(0, TRUNC_LINE_CAP) + ` [... 单行过长已截断 ${l.length - TRUNC_LINE_CAP} 字符]`); total += TRUNC_LINE_CAP; }
      else if (total + l.length + 1 <= limit) { kept.push(l); total += l.length + 1; }
      else { dropped++; }
    }
    const note = dropped > 0 ? `\n…（结果过长：已省略 ${dropped} 行超长/溢出内容，仅显示约 ${total} / 共 ${s.length} 字符）` : `\n…（结果过长已截断，仅显示约 ${total} / 共 ${s.length} 字符）`
    return { text: kept.join('\n') + note, truncated: true, total: s.length }
  }
  // keep-ends：头 + 省略标记 + 尾
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  const mid = s.length - head - tail
  const note = `\n…（结果过长已截断：显示前 ${head} + 后 ${tail} 字符，中间省略 ${mid} 字符，共 ${s.length} 字符）`
  return { text: s.slice(0, head) + note + s.slice(s.length - tail), truncated: true, total: s.length }
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

function isToolErrorResult(s: string): boolean {
  if (!s) return false
  const trimmed = s.trimStart()
  if (/^error:/i.test(trimmed)) return true
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
  const root = getWorkspaceRootForSession()
  if (!root) return p
  return root.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '')
}

const AGENT_CTX_DEFAULT = 4096    // 取不到真实 n_ctx 时的兜底上下文大小
const AGENT_MAX_OUTPUT = 4096     // 与 chatStream 实际 max_tokens 一致
const AGENT_CTX_SAFETY = 256      // 预留安全余量（token）

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
// 避免大上下文模型也被无意义截断；同时受「硬上限 + 预算占比上限」双重封顶，
// 防止小上下文模型（如 32k）因单条结果过大而几轮内就把 prompt 预算吃爆。
function toolResultCharLimit(budgetTokens: number): number {
  const n = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : AGENT_CTX_DEFAULT
  const scaled = Math.floor(n * 3)
  const byBudget = Math.floor(n * TOOL_RESULT_BUDGET_RATIO)
  return Math.max(TOOL_RESULT_LIMIT, Math.min(scaled, TOOL_RESULT_HARD_CAP, byBudget))
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
  // 安全阀：最新一轮仍超预算时，从最旧起截断 tool 结果内容。
  // 仅截断、绝不丢弃 tool 消息——丢弃会破坏「tool_calls ↔ tool 结果」配对导致 API 400。
  // 单条压到 120 字符后若仍超预算（极端小上下文 + 极长结果的罕见情况），保留轻微超限：
  // 本地模型通常对少量 token 溢出有容忍度，且继续裁剪会损害可读性，故在此止步。
  used = result.reduce((s, m) => s + estimateApiMsgTokens(m), 0)
  // 安全阀：最新一轮仍超预算时，从最早的 tool 结果起压缩内容。
  // 两阶段策略，避免「读 → 被裁没 → 再读」死循环：
  //   1) 先压缩所有「非 Read」工具结果（Bash/Grep 等），Read 结果暂时保全；
  //   2) 仅当非 Read 结果已无可压、仍超限时，才最后压缩 Read 结果（保头尾、留底限），
  //      保证小上下文模型（如 32k）的上下文最终能被压回预算内，而非单调撑爆。
  const READ_FLOOR = 2000 // Read 结果压缩后的最小保留字符（头尾各半，足以让模型「看见」关键片段）
  const isReadContent = (c: string) => /"File: /.test(c) || c.startsWith('File: ')
  const compressTo = (m: ApiMessage, floor: number) => {
    if (m.role !== 'tool' || typeof m.content !== 'string') return
    let text = m.content
    while (used > budget && text.length > floor) {
      text = text.slice(0, Math.floor(text.length * 0.6))
      result[result.indexOf(m)] = { ...m, content: text }
      used = result.reduce((s, mm) => s + estimateApiMsgTokens(mm), 0)
    }
  }
  // 阶段一：非 Read 结果
  for (let i = 0; i < result.length && used > budget; i++) {
    const m = result[i]
    if (m.role === 'tool' && typeof m.content === 'string' && !isReadContent(m.content)) {
      compressTo(m, 120)
    }
  }
  // 阶段二：Read 结果（最后手段，保留头尾足够内容让模型仍可定位）
  for (let i = 0; i < result.length && used > budget; i++) {
    const m = result[i]
    if (m.role === 'tool' && typeof m.content === 'string' && isReadContent(m.content)) {
      compressTo(m, READ_FLOOR)
    }
  }
  // ── 配对兜底（参考 grok-build 的 repair_dangling_tool_calls）──
  // 若某条 assistant 的 tool_calls 中，有 id 找不到对应的 tool 结果消息（例如熔断/中止时
  // 提前 break 导致后续调用未产生结果、或裁剪时丢掉了结果轮次），会破坏
  // 「tool_calls ↔ tool 结果」配对，发送给模型即触发 API 400。此处补一条合成结果，保证配对完整。
  result = repairDanglingToolCalls(result)
  return { messages: result, dropped }
}

// 纯函数：扫描所有 assistant 的 tool_calls，对缺少对应 tool 结果的 id 补一条合成结果。
// 合成结果标注来源，避免模型误以为是真实执行产出。幂等、不改原数组。
function repairDanglingToolCalls(msgs: ApiMessage[]): ApiMessage[] {
  const presentIds = new Set<string>()
  for (const m of msgs) {
    if (m.role === 'tool') presentIds.add(m.tool_call_id)
  }
  const synthetic: ApiMessage[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant' || !('tool_calls' in m) || !m.tool_calls || m.tool_calls.length === 0) continue
    for (const tc of m.tool_calls) {
      if (!presentIds.has(tc.id)) {
        presentIds.add(tc.id)
        synthetic.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: '该工具调用未产生结果（可能因达到熔断/轮次上限被提前中止）。请换用其他方案或向用户说明。' })
        })
      }
    }
  }
  if (synthetic.length === 0) return msgs
  return [...msgs, ...synthetic]
}

// ═══════════════════════════════════════════════════════════════════════════
// 上下文摘要/压缩：当会话历史逼近预算高水位时，把最早若干轮压缩为摘要，替代直接丢弃。
// ═══════════════════════════════════════════════════════════════════════════
const CONDENSE_TRIGGER_RATIO = 0.8   // 送入 token 超过 ctxBudget*RATIO 时触发压缩
const KEEP_RECENT_TURNS = 3          // 最近若干轮永远逐字保留（不参与压缩）
const SUMMARY_MAX_TOKENS = 1024      // 摘要生成的 max_tokens
const SUMMARY_TEMPERATURE = 0.2
const SUMMARY_TURN_RESULT_CAP = 600  // 序列化待压缩内容时，单条工具结果的最大保留字符

const SUMMARY_PROMPT = `你是对话历史压缩助手。请把下面的早期对话（可能含既有摘要）压缩成一段简明的中文摘要，供后续对话继续参考。
必须保留：
1) 任务目标与用户的关键需求；
2) 已发现的关键事实（文件路径、配置值、接口/函数名等具体信息）；
3) 已做出的决策与结论；
4) 已尝试并排除的方向（避免重复走弯路）。
要求：只输出摘要正文本身，不要客套或解释；用简洁要点式；总长度控制在约 600 tokens 以内。`

// 按「user 消息为界」把消息切分为轮次（与 trimApiMessages 一致），保证工具配对不被拆散
function splitAgentTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = []
  let cur: AgentMessage[] | null = null
  for (const m of messages) {
    if (m.role === 'user' || cur === null) { cur = [m]; turns.push(cur) }
    else { cur.push(m) }
  }
  return turns
}

// 把待压缩的消息序列化成可读文本（工具结果按上限截断，避免摘要输入本身超长）
function serializeMessagesForSummary(messages: AgentMessage[]): string {
  const cap = (s: string) => (s.length > SUMMARY_TURN_RESULT_CAP ? s.slice(0, SUMMARY_TURN_RESULT_CAP) + ' …(已截断)' : s)
  const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const attach = m.attachments?.length ? `（附件 ${m.attachments.length} 个）` : ''
      parts.push(`用户${attach}: ${m.content || ''}`.trim())
    } else if (m.toolCalls && m.toolCalls.length > 0) {
      if (m.content && stripThink(m.content)) parts.push(`助手: ${stripThink(m.content)}`)
      for (const tc of m.toolCalls) {
        parts.push(`助手调用工具 ${tc.name}(${cap(tc.args || '')})`)
        if (tc.result) parts.push(`工具结果: ${cap(tc.result)}`)
      }
    } else {
      const t = stripThink(m.content || '')
      if (t) parts.push(`助手: ${t}`)
    }
  }
  return parts.join('\n')
}

// 复杂任务启发式：文本较长或含枚举/多步信号即视为复杂（保守，宁可少判）。
// 用于“任务分解提示强化”：命中时且会话无任务，提醒模型先用 TodoWrite 拆解再执行。
function isComplexRequest(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (t.length >= 120) return true
  if (/(^|\n)\s*\d+[.)、]/.test(t)) return true                                   // 1. / 2) / 3、
  if (/(步骤|然后|接着|之后|并且|同时|分别|依次|首先|其次|最后)/.test(t)) return true
  const bulletLines = t.split('\n').filter(l => /^\s*[-*·]\s+/.test(l)).length
  if (bulletLines >= 2) return true
  return false
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

// 把累积的「自上一工具批以来的文本」切分为已闭合的 think/text 片段，
// 返回这些片段与「尚未闭合、需下次继续累积」的尾部。用于按流式时间线把
// 思考段与工具批交错成 segments（工具栏 → 思考链 → 工具栏 → 思考链 …）。
// 仅吐出完全闭合的 <think>…</think>；遇到未闭合的尾部（模型还在思考中）
// 则留作 rest 缓冲，避免把"想一半"的思考块当 finalized 渲染。
function segmentClosedThink(raw: string): { segments: ContentSegment[]; rest: string } {
  const out: ContentSegment[] = []
  let rest = raw
  while (rest.length > 0) {
    const openIdx = rest.indexOf('<think>')
    if (openIdx === -1) {
      if (rest.trim()) out.push({ type: 'text', value: rest })
      return { segments: out, rest: '' }
    }
    if (openIdx > 0 && rest.slice(0, openIdx).trim()) {
      out.push({ type: 'text', value: rest.slice(0, openIdx) })
    }
    const inner = rest.slice(openIdx + '<think>'.length)
    const closeIdx = inner.indexOf('</think>')
    if (closeIdx === -1) {
      // 未闭合：保留后续所有内容待下次
      return { segments: out, rest: rest.slice(openIdx) }
    }
    out.push({ type: 'think', value: inner.slice(0, closeIdx), closed: true })
    rest = inner.slice(closeIdx + '</think>'.length)
  }
  return { segments: out, rest: '' }
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

// ── 历史摘要气泡：会话顶部展示「发送给模型的早期对话压缩摘要」──
// 默认折叠，展开后用 AgentMarkdown 渲染摘要。原始历史消息在界面上仍全部保留，
// 本气泡仅额外展示被压缩、发送时省略的内容，参照 ThinkBlock 的折叠交互与样式。
const HistorySummaryBubble = React.memo(function HistorySummaryBubble({ summary, count }: { summary: string; count: number }) {
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)
  const handleToggle = () => {
    if (expanded) { setExpanded(false); setVisible(false) }
    else { setVisible(true); requestAnimationFrame(() => setExpanded(true)) }
  }
  return (
    <div className={`chat-think agent-history-summary ${expanded ? 'expanded' : ''}`}>
      <button className="chat-think-toggle" onClick={handleToggle}>
        <span className="chat-think-status"><Brain size={12} /> 历史摘要（已压缩 {count} 条早期消息）</span>
        <ChevronDown size={13} className={`chat-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {visible && (
        <div className={`chat-think-body ${expanded ? 'open' : ''}`}>
          {summary ? <AgentMarkdown content={summary} /> : '（空）'}
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

// ── 流式正文（非思考段）Markdown 节流渲染 ──
// 模型主输出（正文）在流式期间每 ~30ms 落盘一次（STREAM_FLUSH_MS），若不优化，每次都触发 react-markdown
// + remark-gfm/math + rehype-katex + rehype-raw + rehype-sanitize 对「完整且持续变长」的
// 文本做一次全量解析 → 内容越长单帧开销越大，表现为文字跳动/卡顿。
// 三管齐下：
//   1) 节流：用 setInterval（~150ms）同步渲染值，把重解析频率与落盘频率解耦；
//   2) 轻量插件栈：流式期间只用 remarkGfm + remarkLinkifyUrls，跳过 katex/raw/sanitize
//      （这些最耗时的插件在「完成时」才用完整栈精确渲染）；
//   3) content-visibility：视口外消息跳过渲染（CSS 侧），进一步降低整页重绘成本。
// 流式 Markdown 重解析节流间隔。流式期间已改用轻量插件栈，单帧解析成本很低，
// 故可把间隔压到 60ms：既让文字显示跟手（~16 次/秒重解析），又避免逐 commit 重解析。
// 注：落盘节流 STREAM_FLUSH_MS 取更小值（见流式循环），二者配合使画面接近模型真实吐字节奏。
const STREAM_MD_THROTTLE_MS = 60
// 流式专用轻量 Markdown：插件栈大幅精简（去掉 rehypeKatex / rehypeRaw / rehypeSanitize），
// 仅保 gfm + 链接识别，单帧解析开销显著下降；完成时由 AgentMarkdown 完整栈接管。
const StreamingMarkdown = React.memo(function StreamingMarkdown({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [display, setDisplay] = useState(content)
  useEffect(() => {
    if (!isStreaming) { setDisplay(content); return }
    setDisplay(content)
    const timer = setInterval(() => setDisplay(content), STREAM_MD_THROTTLE_MS)
    return () => clearInterval(timer)
  }, [content, isStreaming])
  if (!display) return null
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkLinkifyUrls]}
      components={{ code: MarkdownCode as any, pre: MarkdownPre as any, a: MarkdownLink as any }}
    >
      {display}
    </ReactMarkdown>
  )
})

const StreamingContent = React.memo(function StreamingContent({ content, streaming }: { content: string; streaming?: boolean }) {
  const segs = useMemo(() => parseThinkSegments(content || ''), [content])
  return (
    <>
      {segs.map((seg, j) =>
        seg.type === 'think'
          ? <ThinkBlock key={`t-${j}`} value={seg.value} closed={seg.closed} isStreaming={!!streaming && !seg.closed} />
          : <div key={`m-${j}`} className={`chat-msg-bubble chat-msg-markdown${streaming ? ' chat-msg-bubble--streaming' : ''}`}><StreamingMarkdown content={seg.value} isStreaming={streaming} /></div>
      )}
    </>
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
  // 所有工具结果默认收起，点击「展开」才显示完整内容
  const [expanded, setExpanded] = useState(false)
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
        {preview && <span className="agent-tool-call-preview">{preview}</span>}
        {total > 1 && <span className="agent-tool-call-step">步骤 {index + 1}/{total}</span>}
        <span className="agent-tool-call-meta">
          {editDiffStat && (
            <span className="agent-tool-diffstat">
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
            <span className="agent-tool-call-dur">
              <Clock size={10} /> {formatDuration(tc.durationMs)}
            </span>
          )}
          {canRestore && (
            <button className="agent-tool-undo" onClick={(e) => { e.stopPropagation(); onUndo?.() }}>
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
  // 订阅模型运行指标，复用与「模型运行数据」面板完全相同的 prefill 进度数据源。
  const modelMetrics = useStore(s => s.modelMetrics)
  const prefillProgress = runningCard ? (modelMetrics[runningCard.template.id]?.prefillProgress ?? null) : null
  const prefillActive = prefillProgress !== null && prefillProgress < 1
  const prefillDone = prefillProgress !== null && prefillProgress >= 1
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

  const PREVIEW_MAX_BYTES = 128 * 1024
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
  const CODE_EXT = new Set([
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cc', 'hh',
    'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'html', 'htm',
    'css', 'scss', 'less', 'sass', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'cmd', 'sql',
    'r', 'R', 'lua', 'pl', 'pm', 'dart', 'vue', 'svelte', 'gradle', 'makefile',
    'lock', 'log', 'csv', 'tsv', 'diff', 'patch',
  ])
  const MD_EXT = new Set(['md', 'markdown', 'mdx', 'mkd', 'mdwn', 'mkdn', 'text', 'txt', 'rst', 'adoc', 'asciidoc', 'ronn'])
  const isPreviewMarkdown = (() => {
    const p = activeTabPath || ''
    const extMatch = /\.([a-z0-9]+)$/i.exec(p)
    const ext = extMatch ? extMatch[1].toLowerCase() : ''
    if (MD_EXT.has(ext)) return true
    if (CODE_EXT.has(ext)) return false
    const c = activeTab?.content
    if (c && /(^|\n)\s*(<[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?>|#{1,6}\s|>\s|[-*+]\s+\S|\d+\.\s+\S|```|!?\[|\[.+\]\(|\|[^\n]*\|)/.test(c.slice(0, 3000))) {
      return true
    }

    const base = dirName(p).toLowerCase()
    return /^(readme|changelog|license|licence|contributing|notice|authors|code_of_conduct|security|todo|notes?)$/.test(base)
  })()

  const inlineLocalImages = useCallback(async (markdown: string, baseFilePath: string): Promise<string> => {
    const dir = pathDir(baseFilePath)

    type Match = { type: 'md'; full: string; alt: string; url: string } | { type: 'html'; full: string; src: string; url: string }

    const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
    const htmlImgRe = /<img\b([^>]*)>/gi
    const matches: Match[] = []

    let m: RegExpExecArray | null
    while ((m = mdImgRe.exec(markdown)) !== null) {
      const url = m[2]!.trim()
      if (/^(https?:|data:|file:\/\/|\/)/.test(url)) continue
      matches.push({ type: 'md', full: m[0], alt: m[1]!, url })
    }
    while ((m = htmlImgRe.exec(markdown)) !== null) {
      const attrs = m[1]!
      const srcM = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      const url = srcM ? (srcM[2] ?? srcM[3] ?? srcM[4] ?? '') : ''
      if (!url || /^(https?:|data:|file:\/\/|\/)/.test(url)) continue
      matches.push({ type: 'html', full: m[0], src: url, url })
    }

    if (matches.length === 0) return markdown

    const replaced = await Promise.all(matches.map(async (match) => {
      const abs = (dir + '/' + match.url).replace(/\\/g, '/').replace(/\/+/g, '/')
      const r = await window.api.readFileBase64(abs)
      return { ...match, dataUrl: r.success ? r.dataUrl : null }
    }))

    let out = markdown
    for (const item of replaced) {
      if (!item.dataUrl) continue
      if (item.type === 'md') {
        out = out.split(item.full).join(`![${item.alt}](${item.dataUrl})`)
      } else {
        // 替换 HTML <img> 标签中的 src 属性（支持双引号和单引号）
        const newTag = item.full.replace(/\bsrc\s*=\s*(['"])([^'"]*)\1/i, `src=$1${item.dataUrl}$1`)
        out = out.split(item.full).join(newTag)
      }
    }
    return out
  }, [])

  const openPreview = useCallback(async (path: string) => {
    const name = dirName(path)
    // 已打开则仅切换到该标签，不重复读取
    setOpenTabs(prev => {
      if (prev.some(t => t.path === path)) return prev
      return [...prev, { path, name, content: null, lines: null, truncated: false, loading: true, error: null }]
    })
    setActiveTabPath(path)
    const res = await window.api.readFile(path, { maxBytes: PREVIEW_MAX_BYTES, raw: true })
    let content = res.success ? (res.content || '') : null
    // 仅对疑似 Markdown 的内容内联本地图片（避免代码文件被无意义扫描）。
    // 同时匹配 markdown 特征和 HTML 标签（以 < 开头），确保 <div>/<img>/<p> 等
    // HTML 内容中的相对路径图片也能被内联。
    // 注意：正则字面量不能跨行，且避免裸 ``` 反引号，故用单行形式。
    if (content && /(^|\n)\s*(<[a-zA-Z]|#{1,6}\s|>\s|!\[|\[.+\]|```|[-*+]\s+\S)/.test(content.slice(0, 3000))) {
      try { content = await inlineLocalImages(content, path) } catch { /* 内联失败不影响文本预览 */ }
    }
    setOpenTabs(prev => prev.map(t => t.path === path ? {
      ...t,
      loading: false,
      error: res.success ? null : (res.error || '读取失败'),
      content,
      lines: res.success ? (res.lines ?? 0) : null,
      truncated: !!res.truncated,
    } : t))
  }, [inlineLocalImages])

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

  // 会话侧边栏宽度：拖拽侧边栏右边框时调整
  const SIDEBAR_MIN = 160, SIDEBAR_MAX = 420
  const [sidebarWidth, setSidebarWidth] = useState(200)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null)
  const sidebarRafRef = useRef<number | null>(null)
  const applySidebarWidth = useCallback((w: number) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w))
    const root = document.querySelector('.agent-code-body') as HTMLElement | null
    if (root) root.style.setProperty('--agent-sidebar-width', `${clamped}px`)
  }, [])
  const onSidebarDragMove = useCallback((e: PointerEvent) => {
    const d = sidebarDragRef.current
    if (!d) return
    lastClientXRef.current = e.clientX
    const dx = e.clientX - d.startX
    const next = d.startW + dx
    if (sidebarRafRef.current !== null) cancelAnimationFrame(sidebarRafRef.current)
    sidebarRafRef.current = requestAnimationFrame(() => applySidebarWidth(next))
  }, [applySidebarWidth])
  const onSidebarDragEnd = useCallback(() => {
    const d = sidebarDragRef.current
    if (d) setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, d.startW + (lastClientXRef.current - d.startX))))
    sidebarDragRef.current = null
    setSidebarResizing(false)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onSidebarDragMove)
    window.removeEventListener('pointerup', onSidebarDragEnd)
  }, [onSidebarDragMove])
  useEffect(() => {
    applySidebarWidth(sidebarWidth)
  }, [sidebarWidth, applySidebarWidth])
  const startSidebarResize = (e: React.PointerEvent) => {
    e.preventDefault()
    lastClientXRef.current = e.clientX // 同步更新最后坐标，供 onSidebarDragEnd 使用（与预览拖拽共享 ref）
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth }
    setSidebarResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onSidebarDragMove)
    window.addEventListener('pointerup', onSidebarDragEnd)
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
  const [streaming, setStreaming] = useState(false)
  const [condensing, setCondensing] = useState(false)  // 正在压缩历史（顶部轻量提示）
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const pendingSendRef = useRef<Array<{ text: string; attachments: Attachment[] }>>([])
  const handleSendRef = useRef<(text?: string, attachments?: Attachment[]) => void>(() => { })
  const abortRef = useRef<{ aborted: boolean; resolve: (() => void) | null }>({ aborted: false, resolve: null })
  const currentStreamIdRef = useRef<string | null>(null)
  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ctxBtnRef = useRef<HTMLButtonElement>(null)
  const promptBtnRef = useRef<HTMLButtonElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; isImage: boolean; dataUrl?: string; content?: string }>>([])
  const [filePickerAttached, setFilePickerAttached] = useState<Array<{ id: string; path: string; name: string; isDir: boolean }>>([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const attachBtnRef = useRef<HTMLButtonElement>(null)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [contextModalOpen, setContextModalOpen] = useState(false)
  const treeOpenRef = useRef(treeOpen)
  treeOpenRef.current = treeOpen
  useEffect(() => {
    setSidebarOpen(openTabs.length === 0)
  }, [openTabs.length])

  const toggleBothSidebars = useCallback((e: React.MouseEvent) => {
    if (e.type === 'contextmenu') e.preventDefault()
    setSidebarOpen(v => !v)
    setTreeOpen(v => !v)
  }, [])

  const handleModelAction = useCallback(async (card: CardState) => {
    if (card.status === 'running') {
      const { setCardStatus, clearModelMetrics, activeChatPort, clearActiveChat } = useStore.getState()
      setCardStatus(card.template.id, 'idle')
      clearModelMetrics(card.template.id)
      if (activeChatPort === card.template.serverPort) clearActiveChat()
      const res = await safeCall(() => window.api.stopModel(card.template.id), '停止模型失败')
      if (res === null) { setCardStatus(card.template.id, 'running'); return }
      if (!res.success) notify(`停止失败：${res.error}`, 'error')
      return
    }
    const { backends, activeBackend, commandsSchema, clearModelLogs } = useStore.getState()
    let targetBackend = backends.find(b => b.name === card.template.backendVersion)
    if (!targetBackend && activeBackend) targetBackend = activeBackend
    if (!targetBackend || !targetBackend.exe) {
      notify('未找到后端或无可执行文件。', 'error')
      return
    }
    const args: string[] = []
    const tArgs = card.template.args || {}
    if (card.template.modelPath) args.push('-m', card.template.modelPath)
    if (commandsSchema) {
      for (const cat of commandsSchema.categories) {
        for (const cmd of cat.commands) {
          if (cmd.arg === '--port' || cmd.arg === '--model') continue
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true || val === 'true' || val === '1') args.push(cmd.arg) }
            else if (cmd.type === 'select' && cmd.options && !cmd.options.includes(String(val))) continue
            else args.push(cmd.arg, String(val))
          }
        }
      }
    } else {
      const fallbackAllowed = new Set(['--host', '--no-webui', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b', '--flash-attn', '-fa', '--mlock', '--mmap', '--verbose'])
      for (const [k, v] of Object.entries(tArgs)) {
        if (!fallbackAllowed.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    if (card.template.serverPort) args.push('--port', String(card.template.serverPort))
    const port = card.template.serverPort || 8080
    useStore.getState().setCardStatus(card.template.id, 'running')
    const res = await safeCall(() => window.api.runModel({
      id: card.template.id,
      backendPath: targetBackend.path,
      exe: targetBackend.exe!,
      args,
      openBrowser: false,
      port
    }), '启动模型失败')
    if (res === null) { useStore.getState().setCardStatus(card.template.id, 'error'); return }
    if (res.success) {
      clearModelLogs(card.template.id)
      useStore.getState().setCardStatus(card.template.id, 'running', res.pid)
    } else {
      notify(`运行失败：${res.error}`, 'error')
      useStore.getState().setCardStatus(card.template.id, 'error')
    }
  }, [])

  useEffect(() => {
    if (!modelPickerOpen) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      if (modelBtnRef.current?.contains(target)) return
      if (modelPickerRef.current && !modelPickerRef.current.contains(target)) {
        setModelPickerOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [modelPickerOpen])

  useEffect(() => {
    if (!contextModalOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        setContextModalOpen(false)
        return
      }
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
  // 卡片关闭过渡态：关闭时先播放收起/淡出动画，动画结束再真正卸载（taskModalOpen=false）。
  // 过渡期间卡片真实高度仍由 ResizeObserver 写入 --task-card-h，消息区平滑跟降，无突跳/留缝。
  const [taskCardClosing, setTaskCardClosing] = useState(false)
  // 上下文裁剪提示：当因窗口限制自动省略早期消息时写入（目前仅记录，未做独立渲染）
  const [, setCtxTrimInfo] = useState<{ dropped: number } | null>(null)
  // 当前 TodoWrite 计划项（每次新调用替换，不累加）
  const [currentPlanItems, setCurrentPlanItems] = useState<TodoUpdate[]>([])
  // 计划总标题（plan 级别，区别于每条待办 content）：仅用于内联卡片展示，不持久化
  const [planTitle, setPlanTitle] = useState('')

  const [taskPanelCollapsed, setTaskPanelCollapsed] = useState(false)

  // 点击任务卡片外部 / Escape 关闭：进入过渡态（播放收起动画），而非立即卸载
  useEffect(() => {
    if (!taskModalOpen || taskCardClosing) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTaskCardClosing(true)
      }
    }
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('keydown', close)
    }
  }, [taskModalOpen, taskCardClosing])

  const [reqCount, setReqCount] = useState(0)
  const [cumTokens, setCumTokens] = useState(0)
  const [approvalReq, setApprovalReq] = useState<{ id: string; name: string; args: string } | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const autoApproveRef = useRef(false)
  const rejectBtnRef = useRef<HTMLButtonElement>(null)
  const autoApproveBtnRef = useRef<HTMLButtonElement>(null)
  const allowBtnRef = useRef<HTMLButtonElement>(null)
  const backupsRef = useRef<Record<string, { path: string; content: string }>>({})
  const regenRollbackRef = useRef<{ sid: string; messages: AgentMessage[] } | null>(null)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [approveWriteEditDraft, setApproveWriteEditDraft] = useState(false)

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
  // 审批面板键盘导航：方向键切换按钮，Enter 确认允许，Escape 拒绝
  useEffect(() => {
    if (!approvalReq) return
    const btns = [rejectBtnRef.current, autoApproveBtnRef.current, allowBtnRef.current].filter(Boolean) as HTMLButtonElement[]
    let idx = 2 // 默认聚焦「允许」按钮
    const focusIdx = (i: number) => {
      idx = (i + btns.length) % btns.length
      btns[idx]?.focus()
    }
    focusIdx(idx)
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); focusIdx(idx + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusIdx(idx - 1) }
      else if (e.key === 'Escape') { e.preventDefault(); resolveApproval(false) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [approvalReq, resolveApproval])
  const refreshTasks = useCallback(async () => {
    if (!activeSessionId) { setTasks([]); setCurrentPlanItems([]); return }
    try {
      const res = await window.api.agentTaskList(activeSessionId)
      if (res.success) {
        setTasks(res.tasks)
        // 修复①：后端持久化状态为权威来源，回写 currentPlanItems，
        // 使卡片渲染真实状态，而非仅依赖流式解析的临时快照。
        setCurrentPlanItems(res.tasks
          .filter(t => t.status !== 'deleted')
          .map((t): TodoUpdate => ({
            id: t.id,
            content: t.subject,
            description: t.description,
            status: t.status as TodoUpdate['status'],
            priority: t.priority,
            activeForm: t.activeForm,
            notes: t.notes,
          })))
      }
    } catch { /* 忽略：面板刷新失败不影响对话 */ }
  }, [activeSessionId])

  // 计划推进（兜底，非主控）：状态归属已交还给模型——模型应自己用 TodoWrite 标 completed/in_progress。
  // 此函数仅在「边缘情况」下轻量辅助：当本轮模型执行了真实工具（非 TodoWrite）却完全没碰 TodoWrite
  // （即模型没有自己维护状态），才把第一个 in_progress 翻 completed、并把第一个 pending 推 in_progress，
  // 避免计划彻底卡死。若模型本轮已通过 TodoWrite 自行维护状态，则不干预，避免与模型自检打架。
  // 用后端 agentTaskList 返回的权威 id（与 String(i+1) 兜底一致），避免 merge 错位。
  const advancePlan = useCallback(async (sid: string, modelTouchedTodoThisRound: boolean) => {
    if (modelTouchedTodoThisRound) return // 模型已自行维护状态，内核不干预
    try {
      const list = await window.api.agentTaskList(sid)
      if (!list.success) return
      const tasks = list.tasks
      const idx = tasks.findIndex(t => t.status === 'in_progress')
      if (idx < 0) return // 没有进行中的步骤，不推进
      const next = tasks.findIndex(t => t.status === 'pending')
      const updates: Array<{ id: string; status: 'completed' | 'in_progress' }> = [
        { id: tasks[idx].id, status: 'completed' },
      ]
      if (next >= 0) updates.push({ id: tasks[next].id, status: 'in_progress' })
      await window.api.agentTodoWrite(sid, { merge: true, todos: updates })
      refreshTasksRef.current() // 回写 currentPlanItems，卡片刷新
    } catch { /* 推进失败不影响对话 */ }
  }, [])

  // 收尾清理孤儿 in_progress：模型只用 TodoWrite 把任务标成 in_progress 然后直接返回
  // 文本（未执行任何真实工具），advancePlan 永远不会被触发，导致该任务永久卡在 in_progress、
  // 后续 pending 也无法推进。此函数在「模型返回最终文本且无工具调用」时调用：若存在 in_progress
  // 任务，说明它没有被任何真实工具支撑，将孤儿 in_progress 回退为 pending，使计划可继续推进或提示模型。
  // 仅回退「孤立」的 in_progress（本轮无真实工具执行），若 in_progress 确实由 advancePlan 正常推进产生，
  // 则此处不会被调用（advancePlan 已在同一轮把它翻成 completed）。
  const cleanupOrphanInProgress = useCallback(async (sid: string) => {
    try {
      const list = await window.api.agentTaskList(sid)
      if (!list.success) return
      const orphan = list.tasks.filter(t => t.status === 'in_progress')
      if (orphan.length === 0) return
      const updates = orphan.map((t) => ({ id: t.id, status: 'pending' as const }))
      await window.api.agentTodoWrite(sid, { merge: true, todos: updates })
      refreshTasksRef.current() // 回写 currentPlanItems，卡片刷新
    } catch { /* 清理失败不影响对话 */ }
  }, [])
  // 始终持有最新的 refreshTasks，避免 send 闭包使用过期引用
  const refreshTasksRef = useRef(refreshTasks)
  refreshTasksRef.current = refreshTasks
  const [sessRenamingId, setSessRenamingId] = useState<string | null>(null)
  const [sessRenameText, setSessRenameText] = useState('')
  const sessRenameInputRef = useRef<HTMLInputElement>(null)
  const [projRenamingId, setProjRenamingId] = useState<string | null>(null)
  const [projRenameText, setProjRenameText] = useState('')
  const projRenameInputRef = useRef<HTMLInputElement>(null)
  const msgEndRef = useRef<HTMLDivElement>(null)
  const chatInputAreaRef = useRef<HTMLDivElement>(null)
  const taskCardRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0]!
  const activeSession = activeProject.sessions.find(s => s.id === activeSessionId) || activeProject.sessions[0] || null
  const toolCardExpandedDefault = useStore(s => s.agentToolCardsExpanded)
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

  // 测量计划卡片（agent-task-card-inline）高度，写入 CSS 变量 --task-card-h。
  // 卡片是 absolute 浮层、脱离文档流，展开时会向上遮挡消息区；
  // 把其高度作为 .chat-messages 的底部预留空间，消息区即可上移、不被遮挡。
  // 卡片关闭（taskModalOpen=false）或收起时高度记为 0。
  // 跟降策略：
  //  - 收缩方向（收起/关闭动画）scrollHeight 减小，此处用「实时」贴底判断跟降，避免误判；
  //  - 展开方向 scrollHeight 增大，实时判断会误判为离底，故不由这里滚，交由按钮 onClick 的双 rAF 兜底；
  //  - 非用户触发的高度变化（如模型刷新计划项）守 atBottom，避免打断用户向上翻看。
  useEffect(() => {
    const root = chatScrollRef.current?.closest('.agent-code-chat') as HTMLElement | null
    if (!root) return
    const apply = () => {
      const h = taskCardRef.current && taskModalOpen ? taskCardRef.current.offsetHeight : 0
      root.style.setProperty('--task-card-h', `${h}px`)
      const el = chatScrollRef.current
      // 实时计算贴底（不依赖缓存的 atBottomRef，避免 padding 变化引发的 scroll 误判）
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) scrollToBottom()
    }
    apply()
    const ro = new ResizeObserver(apply)
    if (taskCardRef.current) ro.observe(taskCardRef.current)
    return () => ro.disconnect()
  }, [taskModalOpen, scrollToBottom])

  useEffect(() => {
    setReqCount(0)
    setCumTokens(0)
    setPlanTitle('')
    // 修复②：切换会话时清空计划项，避免上一个会话的待办残留显示在新会话
    setCurrentPlanItems([])
    atBottomRef.current = true
    setAtBottom(true)
  }, [activeSessionId])

  useEffect(() => {
    setWorkspaceRootForSession(activeSessionId, activeProject.workspaceDir)
    window.api?.setBashCwd(activeProject.workspaceDir || '').catch(() => { })
    window.api?.setAgentWorkspace(activeProject.workspaceDir || '').catch(() => { })
  }, [activeProject.workspaceDir, activeSessionId])

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
    const proj: AgentProject = { id: uniqueId('proj'), title: name, workspaceDir: res.path, expanded: true, sessions: [{ id: uniqueId('sess'), title: '新会话', messages: [] }] }
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
    const sess: AgentSession = { id: uniqueId('sess'), title: '新会话', messages: [] }
    setProjects(prev => prev.map(p => p.id === projId ? { ...p, sessions: [...p.sessions, sess] } : p))
    setActiveSessionId(sess.id)
  }, [])

  const deleteSession = useCallback((projId: string, sessId: string) => {
    const fallbackId = uniqueId('sess')
    setProjects(prev => prev.map(p => p.id !== projId ? p : {
      ...p,
      sessions: (() => {
        const next = p.sessions.filter(s => s.id !== sessId)
        if (next.length === 0) next.push({ id: fallbackId, title: '新会话', messages: [] })
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

  const handleFilePickerAttach = useCallback(async (entry: { name: string; path: string; isDir: boolean }) => {
    if (entry.isDir) return
    setFilePickerAttached(prev => {
      if (prev.some(a => a.path === entry.path)) return prev
      return [...prev, { id: newId('fp-att'), path: entry.path, name: entry.name, isDir: false }]
    })
    try {
      const res = await window.api.readFile(entry.path, { maxBytes: 128 * 1024 })
      if (res.success && typeof res.content === 'string') {
        setAttachedFiles(prev => {
          if (prev.some(a => a.name === entry.name)) return prev
          return [...prev, { id: newId('fp-read'), name: entry.name, isImage: false, content: res.content! }]
        })
      }
    } catch { /* 读取失败，静默跳过 */ }
  }, [])

  const handleFilePickerRemove = useCallback((path: string) => {
    setFilePickerAttached(prev => prev.filter(a => a.path !== path))
    const name = path.replace(/\\/g, '/').split('/').pop() || path
    setAttachedFiles(prev => prev.filter(a => a.name !== name))
  }, [])

  const toggleFilePicker = useCallback(() => {
    setFilePickerOpen(v => !v)
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
    // 更改目录后，标题同步显示为该目录的主目录文件名，
    // 使左侧标题栏始终等于当前切换到的目录名
    const patch: Partial<AgentProject> = { workspaceDir: res.path, title: dirName(res.path) }
    updateProject(projId, patch)
  }, [updateProject])

  const confirmProjRename = () => {
    const text = projRenameText.trim()
    if (text && projRenamingId) updateProject(projRenamingId, { title: text })
    setProjRenamingId(null)
  }

  const startSessRename = (sessId: string, currentTitle: string) => {
    setSessRenamingId(sessId)
    setSessRenameText(currentTitle)
    setTimeout(() => sessRenameInputRef.current?.focus(), 0)
  }

  const confirmSessRename = (projId: string, sessId: string) => {
    const text = sessRenameText.trim()
    if (text) updateSessionInProject(projId, sessId, { title: text })
    setSessRenamingId(null)
  }

  // 构建发送给模型的消息序列，并把工具调用结果（toolCalls[].result）补成 role:'tool' 消息，
  // 用于「重新生成 / 重发」时基于已有历史（含工具执行记录）重建发送给模型的消息序列。
  // 传入 memory 时：先注入一条「早期对话摘要」系统消息，并省略被摘要覆盖的最早连续前缀消息
  // （按 coveredMsgIds 前缀匹配，前缀一旦断裂即停止跳过）。以整条 AgentMessage 为覆盖单位，
  // 其 assistant tool_calls 与 tool 结果由同一条消息生成，故 tool 配对不会被破坏。
  function buildApiMessagesFull(messages: AgentMessage[], memory?: AgentSession['memory']): ApiMessage[] {
    const out: ApiMessage[] = []
    // 计算被覆盖的最早连续前缀长度
    let coveredPrefix = 0
    if (memory?.summary && memory.coveredMsgIds?.length) {
      const coveredSet = new Set(memory.coveredMsgIds)
      while (coveredPrefix < messages.length && coveredSet.has(messages[coveredPrefix]!.id)) coveredPrefix++
      if (coveredPrefix > 0) {
        out.push({ role: 'system', content: `## 早期对话摘要\n以下是本会话较早轮次的压缩摘要（原始消息已省略以节省上下文）：\n\n${memory.summary}` })
      }
    }
    for (let mi = coveredPrefix; mi < messages.length; mi++) {
      const m = messages[mi]!
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

  // 上下文摘要压缩：在发送前自动触发，或由用户手动触发（force=true）。
  // 用与 trimApiMessages 一致的分轮规则估算总 token：自动模式下未超 budget*RATIO 直接返回原 memory；
  // force 模式跳过水位判断，只要存在「最近 KEEP_RECENT_TURNS 轮之前」的更早轮次就压缩。
  // 把该批轮次交给同一本地模型压缩成摘要，持久化到会话并返回新 memory。
  // 失败/超时/空返回一律吞掉异常、返回原 memory（引用不变，供调用方判断是否成功）。
  const condenseSessionMemory = useCallback(async (
    pid: string, sid: string, messages: AgentMessage[],
    memory: AgentSession['memory'], budget: number, port: number, force = false
  ): Promise<AgentSession['memory']> => {
    try {
      if (abortRef.current.aborted) return memory
      const apiMsgs = buildApiMessagesFull(messages, memory)
      const total = apiMsgs.reduce((s, m) => s + estimateApiMsgTokens(m), 0)
      if (!force && total <= budget * CONDENSE_TRIGGER_RATIO) return memory
      // 定位「已覆盖前缀之后」的消息，切分轮次，保留最近 KEEP_RECENT_TURNS 轮不压缩
      const coveredSet = new Set(memory?.coveredMsgIds || [])
      let coveredPrefix = 0
      while (coveredPrefix < messages.length && coveredSet.has(messages[coveredPrefix]!.id)) coveredPrefix++
      const uncovered = messages.slice(coveredPrefix)
      const turns = splitAgentTurns(uncovered)
      if (turns.length <= KEEP_RECENT_TURNS) return memory
      const batch = turns.slice(0, turns.length - KEEP_RECENT_TURNS).flat()
      if (batch.length === 0) return memory
      const priorSummary = memory?.summary ? `已有摘要：\n${memory.summary}\n\n新增对话：\n` : ''
      const userContent = priorSummary + serializeMessagesForSummary(batch)
      setCondensing(true)
      const res = await window.api.chatCompletion({ port, body: {
        messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: userContent }],
        temperature: SUMMARY_TEMPERATURE, max_tokens: SUMMARY_MAX_TOKENS, stream: false,
      } })
      const data: any = (res as any)?.ok ? (res as any).data : null
      const summary = data?.choices?.[0]?.message?.content
      if (!(res as any)?.ok || typeof summary !== 'string' || !summary.trim()) return memory
      const newMemory = {
        summary: summary.trim(),
        coveredMsgIds: [...(memory?.coveredMsgIds || []), ...batch.map(m => m.id)],
        updatedAt: Date.now(),
      }
      updateSessionInProject(pid, sid, { memory: newMemory })
      return newMemory
    } catch {
      return memory
    } finally {
      setCondensing(false)
    }
  }, [updateSessionInProject])

  // 手动压缩：用户从顶部按钮主动触发，不等高水位。force 方式调用 condenseSessionMemory，
  // 并根据返回值是否变化给出反馈（无可压缩 / 已压缩 N 条 / 未完成）。
  const handleManualCondense = useCallback(async () => {
    if (loading || condensing) return
    if (!runningCard || !apiBaseUrl) { notify('模型未启动，无法压缩历史', 'error'); return }
    if (!activeSession || activeSession.messages.length === 0) { notify('当前会话无可压缩的历史', 'info'); return }
    // 预检是否存在「最近保留轮之前」的更早轮次，避免无意义的模型调用
    const msgs = activeSession.messages
    const coveredSet = new Set(activeSession.memory?.coveredMsgIds || [])
    let coveredPrefix = 0
    while (coveredPrefix < msgs.length && coveredSet.has(msgs[coveredPrefix]!.id)) coveredPrefix++
    if (splitAgentTurns(msgs.slice(coveredPrefix)).length <= KEEP_RECENT_TURNS) {
      notify(`暂无可压缩的更早历史（最近 ${KEEP_RECENT_TURNS} 轮会保留）`, 'info')
      return
    }
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const prevCovered = activeSession.memory?.coveredMsgIds?.length || 0
    const next = await condenseSessionMemory(activeProjectId, activeSessionId, msgs, activeSession.memory, ctxBudget, runningCard.template.serverPort, true)
    const nextCovered = next?.coveredMsgIds?.length || 0
    if (nextCovered > prevCovered) notify(`已压缩 ${nextCovered - prevCovered} 条早期消息`, 'success')
    else notify('压缩未完成（模型无响应或返回为空）', 'error')
  }, [loading, condensing, runningCard, apiBaseUrl, activeSession, activeProjectId, activeSessionId, condenseSessionMemory])

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
    // 清空上一轮 agent 会话的提问记录，避免跨会话残留
    askUserQuestionRegistry.reset()

    // 局部工具状态更新（直接改写闭包内的 displayMsgs，并同步提交 React）
    const patchToolCall = (liveId: string, tcId: string, patch: Partial<NonNullable<AgentMessage['toolCalls']>[number]>) => {
      const patchedToolCalls = (m_toolCalls: NonNullable<AgentMessage['toolCalls']> | undefined) =>
        (m_toolCalls || []).map(t => t.id === tcId ? { ...t, ...patch } : t)
      displayMsgs = displayMsgs.map(m => m.id === liveId ? {
        ...m,
        toolCalls: patchedToolCalls(m.toolCalls),
        // 同步更新 segments 里的 tools 段：toolCalls 数组经 .map 变成新引用，
        // 若不回写，交错渲染拿到的仍是旧的 pending 数组（无结果）→ 结果丢失。
        segments: m.segments?.map(seg => seg.kind === 'tools' ? { ...seg, toolCalls: patchedToolCalls(seg.toolCalls) } : seg)
      } : m)
      // 同步更新本地 segments（最终落盘时直接用它，避免覆盖掉已写入的结果）
      segments = segments.map(seg => seg.kind === 'tools' ? { ...seg, toolCalls: patchedToolCalls(seg.toolCalls) } : seg)
    }
    const commitToolCall = (liveId: string, tcId: string, patch: Partial<NonNullable<AgentMessage['toolCalls']>[number]>) => {
      patchToolCall(liveId, tcId, patch)
      flushSync(() => { updateSessionInProject(pid, sid, { messages: displayMsgs }) })
    }

    // ── 交错渲染：按流式时间线把「思考/正文段」与「工具批段」切分为有序 segments ──
    // 声明在 while 循环之外（与 patchToolCall 同作用域），否则 patchToolCall 闭包
    // 引用不到内层声明的 segments，运行时会抛 "segments is not defined" 导致整个
    // agent 循环中断（表现为「发送失败」、Bash 审批弹窗永不出现）。
    // segments 跨轮累积（一条助手消息可能有多批工具）；pendingRaw 每轮重置。
    let segments: AgentSegment[] = []
    let pendingRaw = ''

    try {
      let turn = 0
      const MAX_AGENT_TURNS = 40
      // 硬性熔断：连续失败达到阈值时，强制中止工具循环，
      // 避免模型在错误命令上反复空转。模型应停止重试、改用其他方案或向用户说明。
      const MAX_TOOL_FAILS = 3            // 同一工具连续失败达此数 → 熔断
      const FAIL_WINDOW = 6               // 滚动窗口大小（最近 N 次工具执行）
      const FAIL_WINDOW_LIMIT = 4         // 窗口内失败数达此值 → 熔断（防“换写法反复失败”）
      // 提问工具防抖：本地小模型常陷入「问→答→又问」的死循环。累计 AskUserQuestion 调用次数，
      // 超过阈值即强制停止继续提问，要求模型基于已有答案推进，避免反复弹出提问面板。
      const MAX_ASK_QUESTION = 3
      let askQuestionCount = 0
      let askQuestionBlown = false
      let liveId = ''
      const toolFailCount = new Map<string, number>()
      const failedCalls = new Set<string>()
      const recentResults: boolean[] = [] // 最近若干次工具执行的成败（true=成功），用于滚动窗口判断
      let fuseBlown = false
      let fuseTool = ''
      let fuseSummary = ''
      // ── 复杂任务分解提示强化（一次性）──
      // 收到复杂指令且该会话当前无任务时，向本轮 apiMsgs 追加一条 system 提示，
      // 促使模型先用 TodoWrite 分步再执行。仅注入当轮（不写入 displayMsgs、不持久化），
      // 已有任务或简单任务不注入。图片模式（无工具）不适用。
      if (!userHasImages && tools.length > 0) {
        const lastUser = [...startDisplay].reverse().find(m => m.role === 'user')
        if (lastUser && isComplexRequest(lastUser.content || '')) {
          try {
            const list = await window.api.agentTaskList(sid)
            const noTasks = !list?.success || (list.tasks?.length ?? 0) === 0
            if (noTasks) {
              apiMsgs = [...apiMsgs, { role: 'system', content: '此任务较复杂：请先用 TodoWrite 制定 ≥3 步的分步计划，再逐步执行；每完成一步用 TodoWrite 更新任务状态。' }]
            }
          } catch { /* 查询失败不阻塞对话 */ }
        }
      }
      while (true) {
        if (abortRef.current.aborted) break
        if (turn >= MAX_AGENT_TURNS) {
          const note = `\n\n（已达到工具调用轮次上限 ${MAX_AGENT_TURNS}，自动停止探索并给出当前结论。）`
          displayMsgs = displayMsgs.map(m =>
            m.id === liveId
              ? { ...m, content: (m.content || '') + note }
              : m
          )
          updateSessionInProject(pid, sid, { messages: displayMsgs })
          break
        }
        const streamId = `agent-${sid}-${++turn}`
        currentStreamIdRef.current = streamId
        // 仅首轮（或上一轮已结束）新建助手消息；后续工具轮复用同一条，避免重复头像
        if (!liveId) liveId = newMsgId()
        // 若最后一条消息不是当前 liveId（说明本轮尚未建过），种一颗空的助手消息用于流式填充
        if (displayMsgs[displayMsgs.length - 1]?.id !== liveId) {
          displayMsgs = [...displayMsgs, { id: liveId, role: 'assistant', content: '' }]
          updateSessionInProject(pid, sid, { messages: displayMsgs })
        }

        let streamedText = ''
        let toolCalls: { id: string; function: { name: string; arguments: string } }[] | undefined
        let streamError: string | undefined
        let lastFlush = 0
        // 落盘节流：每 ~30ms 把累积文本写回 store 一次。模型真实吐字约 20ms/token，
        // 之前 100ms 的批量落盘会让文字「一顿一顿」地成批蹦出；压到 30ms 后显示节奏
        // 接近模型真实速度（~33 次/秒更新），更跟手。解析侧另有 STREAM_MD_THROTTLE_MS
        // 协调，二者配合避免逐 token 整页重渲染。
        const STREAM_FLUSH_MS = 30
        // ── 交错渲染：按流式时间线把「思考/正文段」与「工具批段」切分为有序 segments ──
        // segments 跨轮累积（一条助手消息可能有多批工具）；pendingRaw 每轮重置，
        // 只存「自上一工具批以来模型新产生的文本」，待工具批到达时切分为 think/text 段。
        // 注意：segments / pendingRaw 已在循环外声明，这里仅赋值（恢复已有会话的 segments、重置 pendingRaw），不要重新用 const/let 声明。
        segments = (displayMsgs.find(m => m.id === liveId)?.segments || []).slice()
        pendingRaw = ''

        await new Promise<void>((resolve) => {
          abortRef.current.resolve = resolve
          const onChunk = (data: any) => {
            if (data.streamId !== streamId) return
            if (typeof data.delta === 'string' && data.delta) {
              streamedText += data.delta
              pendingRaw += data.delta
              // 保留该助手消息已有的 toolCalls / segments（跨轮不被流式帧清空）
              const keepCalls = displayMsgs.find(m => m.id === liveId)?.toolCalls
              const liveMsg = displayMsgs.find(m => m.id === liveId)
              const keepSegments = liveMsg?.segments
              displayMsgs = displayMsgs.slice(0, -1).concat({ id: liveId, role: 'assistant', content: streamedText, ...(keepCalls ? { toolCalls: keepCalls } : {}), ...(keepSegments ? { segments: keepSegments } : {}) })
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
                // 把「自上一工具批以来」的文本切分为已闭合的 think/text 段，追加进 segments；
                // 未闭合的思考尾部留在 pendingRaw，等下一轮或最终答案时再收尾。
                const { segments: flushed, rest } = segmentClosedThink(pendingRaw)
                for (const s of flushed) segments.push({ kind: s.type, content: s.value })
                pendingRaw = rest
                // 修复④：同批次可能有多个 TodoWrite 调用（如初始化 + 后续 merge），逐个处理而非只取第一个
                const todoWriteCalls = data.toolCalls.filter((tc: any) => tc.function?.name === 'TodoWrite')
                for (const todoWriteCall of todoWriteCalls) {
                  setTaskModalOpen(true)
                  // 解析本次 TodoWrite 的计划项（支持 merge 合并）
                  try {
                    const args = JSON.parse(todoWriteCall.function.arguments)
                    if (args.todos?.length) {
                      // 计划总标题：plan 级别，model 可在调用时附带；替换模式无标题则清空
                      if (typeof args.title === 'string' && args.title.trim()) {
                        setPlanTitle(args.title.trim())
                      } else if (args.merge === false) {
                        setPlanTitle('')
                      }
                      const merge = args.merge !== false
                      if (merge) {
                        setCurrentPlanItems(prev => {
                          // 修复⑤/⑥：key 与存储的 id 都按下标兜底 String(idx+1)，与后端
                          // todoUpdateToAgentTask 的 `u.id || String(i+1)` 对齐，避免前后端失步、key 稳定。
                          const map = new Map<string, TodoUpdate>()
                          prev.forEach((t, idx) => { map.set(t.id || String(idx + 1), t) })
                          args.todos.forEach((t, idx) => {
                            const key = t.id || String(idx + 1)
                            map.set(key, { ...(map.get(key) || {}), ...t, id: t.id || key })
                          })
                          return Array.from(map.values())
                        })
                      } else {
                        // 替换模式：同样补齐兜底 id，保证 key 稳定
                        setCurrentPlanItems(args.todos.map((t, idx) => ({ ...t, id: t.id || String(idx + 1) })))
                      }
                    }
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

        // 最终答案轮（无工具调用）：把剩余文本（收尾思考 + 正文）切分进 segments。
        // 工具调用轮已在上面 push 过 tools 段，pendingRaw 也已 flush 过，这里仅处理最终轮。
        if (!toolCalls || toolCalls.length === 0) {
          const { segments: flushed, rest } = segmentClosedThink(pendingRaw)
          for (const s of flushed) segments.push({ kind: s.type, content: s.value })
          pendingRaw = rest
        }
        // 把已切分的 segments 落回当前助手消息（保证刷新/重开后仍是交错顺序）
        if (segments.length) {
          displayMsgs = displayMsgs.map(m => m.id === liveId ? { ...m, segments: segments.slice() } : m)
          updateSessionInProject(pid, sid, { messages: displayMsgs })
        }

        // 用户中止：标记当前助手消息为「已停止」并退出循环
        if (abortRef.current.aborted) {
          displayMsgs = displayMsgs.map(m => m.id === liveId ? { ...m, stopped: true } : m)
          updateSessionInProject(pid, sid, { messages: displayMsgs })
          break
        }

        if (toolCalls && toolCalls.length) {
          const prevCalls = displayMsgs.find(m => m.id === liveId)?.toolCalls || []
          const nextCalls = toolCalls.map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments, status: 'pending' as const }))
          // 把这批工具调用作为一个 tools 段追加进 segments（紧跟在刚切出的思考段之后）
          segments.push({ kind: 'tools', toolCalls: nextCalls })
          const assistMsg: AgentMessage = { id: liveId, role: 'assistant', content: streamedText, toolCalls: [...prevCalls, ...nextCalls], segments: segments.slice() }
          displayMsgs = displayMsgs.slice(0, -1).concat(assistMsg)
          // 强制同步提交 DOM，确保用户立即看到工具卡片列表（待执行状态）
          flushSync(() => {
            updateSessionInProject(pid, sid, { messages: displayMsgs })
          })
          // 立即滚动到底部，确保工具卡片在视口内可见
          scrollToBottom()
          apiMsgs.push({ role: 'assistant', content: streamedText || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments } })) } as ApiMessage)
          // 第二阶段：逐个执行工具（pi-web 风格：状态驱动）
          // 本轮去重：模型偶会在同一 tool_calls 数组里把同一条调用发两遍（如 Bash 重复两次），
          // 按「名称 + 归一化参数」去重，命中则跳过执行并复用本轮已得到的结果。
          const batchExecuted = new Map<string, string>()
          // 追踪本轮模型是否自己维护过计划状态（调过 TodoWrite），用于决定 advancePlan 是否兜底干预
          let todoTouchedThisRound = false
          const toolCallKey = (name: string, argsStr: string): string => {
            try {
              const o = JSON.parse(argsStr || '{}')
              const norm = JSON.stringify(Object.keys(o).sort().reduce((a: Record<string, unknown>, k) => (a[k] = o[k], a), {}))
              return `${name}::${norm}`
            } catch { return `${name}::${argsStr}` }
          }
          // ── 只读批并发预取 ──
          // 整批均为只读工具（Read/Glob/Grep/ListDir/AnalyzeDir）且 >1 个时，先并发执行（去重后
          // 仅执行唯一调用），结果存入 preRun 供下方顺序循环直接取用；顺序循环的去重/截断/
          // 失败跟踪/熔断/提交逻辑完全不变，保证顺序与因果与串行路径一致。只读工具无需审批/备份。
          const preRun = new Map<string, { result: string; failed: boolean }>()
          const parallelReadBatch = toolCalls.length > 1 && !userHasImages &&
            toolCalls.every(tc => TOOL_METAS[tc.function.name]?.readOnly === true)
          if (parallelReadBatch) {
            const batch = toolCalls
            for (const tc of batch) commitToolCall(liveId, tc.id, { status: 'executing' })
            const phaseTools = batch.map(tc => ({ name: tc.function.name, verb: toolRunVerb(tc.function.name) }))
            flushSync(() => { useStore.getState().setAgentPhase({ kind: 'running_tools', tools: phaseTools }) })
            scrollToBottom()
            const runOne = async (name: string, argsStr: string): Promise<{ result: string; failed: boolean }> => {
              try {
                const args = parseToolArgs(argsStr)
                const r = await executeToolCall(name, args)
                return { result: r, failed: isToolErrorResult(r) }
              } catch (e: any) {
                return { result: JSON.stringify({ error: e?.message || String(e) }), failed: true }
              }
            }
            // 去重：相同 key 仅执行一次，多个相同调用共享同一 Promise
            const keyPromise = new Map<string, Promise<{ result: string; failed: boolean }>>()
            const idKeys = batch.map(tc => {
              const key = toolCallKey(tc.function.name, tc.function.arguments)
              if (!keyPromise.has(key)) keyPromise.set(key, runOne(tc.function.name, tc.function.arguments))
              return { id: tc.id, key }
            })
            await Promise.allSettled([...keyPromise.values()])
            for (const { id, key } of idKeys) preRun.set(id, await keyPromise.get(key)!)
          }
          for (const tc of toolCalls) {
            const dupKey = toolCallKey(tc.function.name, tc.function.arguments)
            if (batchExecuted.has(dupKey)) {
              const reused = batchExecuted.get(dupKey)!
              commitToolCall(liveId, tc.id, { status: 'done', result: `${reused}\n\n（本轮已执行过相同调用，已跳过重复执行）`, resultTotal: reused.length, failed: false })
              apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: reused })
              continue
            }
            // ── 破坏性工具审批 ──
            // Delete 永远需要人工确认（本质破坏性）。
            // Bash：仅当命令被判定为「破坏性」（删除/格式化/终止进程/改系统状态）时才弹窗确认；
            //        普通命令（dir、python/node 运行脚本、构建、git status/log、cat/type 等）直接执行，不弹窗。
            // Write / Edit：可由项目开关追加确认（不变）。
            const toolArgs = parseToolArgs(tc.function.arguments)
            const bashCmd = tc.function.name === 'Bash' && typeof toolArgs.command === 'string' ? toolArgs.command : ''
            const bashNeedsApproval = tc.function.name === 'Bash' && isDestructiveBashCommand(bashCmd)
            const needsApproval = (APPROVAL_TOOLS.has(tc.function.name) && tc.function.name !== 'Bash') || bashNeedsApproval || (approveWriteEdit && WRITE_EDIT_TOOLS.has(tc.function.name))
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
            // ── 提问工具防冗余 ──
            // 命中任一条件即视为冗余提问，不再弹出面板：
            //   1) 模型已输出正文（看起来像最终回答）却又追问（askQuestionCount >= 1）
            //   2) 问题内容已在本次会话中问过（跨轮次内容去重）
            const isAskAgain = tc.function.name === 'AskUserQuestion'
            let redundantAsk = false
            if (isAskAgain) {
              const hasTextBefore = streamedText.trim().length > 0
              if (askQuestionCount >= 1 && hasTextBefore) {
                redundantAsk = true
              } else {
                // 内容级去重：解析参数中的问题文本，检查是否有已问过的
                try {
                  const parsed = JSON.parse(tc.function.arguments || '{}')
                  const questions: Array<{ question: string }> = parsed.questions || []
                  if (questions.some(q => askUserQuestionRegistry.wasAsked(q.question))) {
                    redundantAsk = true
                  }
                } catch { /* 参数解析失败，走正常执行流程 */ }
              }
            }
            if (redundantAsk) {
              toolResult = 'You have already provided a final answer (and the user has answered your earlier questions). Do NOT ask again — proceed with the task using the information you have.'
              failed = false
            } else if (preRun.has(tc.id)) {
              // 只读批已并发预取，直接取用（failed 已由 isToolErrorResult 判定）
              const pre = preRun.get(tc.id)!
              toolResult = pre.result
              failed = pre.failed
            } else {
              try { const args = parseToolArgs(tc.function.arguments); toolResult = await executeToolCall(tc.function.name, args) } catch (e: any) { toolResult = JSON.stringify({ error: e?.message || String(e) }); failed = true }
            }
            if (!failed && isToolErrorResult(toolResult)) failed = true

            // 工具执行完成：更新消息状态（flushSync 确保 DOM 即时提交后再滚动，防止布局偏移）
            // grep 类用「丢弃超长行」策略，其余（bash/read 等）用「保留头尾」策略
            const truncMode = tc.function.name === 'Grep' ? 'drop-long-lines' : 'keep-ends'
            const capped = truncateToolResult(toolResult, toolResultCharLimit(opts.ctxBudget), truncMode)

            // ── 工具失败跟踪：防止模型无限重试 ──
            if (failed) {
              const toolName = tc.function.name
              const curFail = (toolFailCount.get(toolName) || 0) + 1
              toolFailCount.set(toolName, curFail)
              const callKey = `${toolName}::${tc.function.arguments}`
              const isExactRetry = failedCalls.has(callKey)
              failedCalls.add(callKey)
              // 滚动窗口：记录本次成败，仅保留最近 FAIL_WINDOW 次
              recentResults.push(false)
              while (recentResults.length > FAIL_WINDOW) recentResults.shift()
              const windowFails = recentResults.filter(r => !r).length
              const warnings: string[] = []
              if (isExactRetry) warnings.push('该工具已使用完全相同参数尝试过并失败')
              warnings.push(`${toolName} 已连续失败 ${curFail} 次`)
              if (windowFails >= FAIL_WINDOW_LIMIT) warnings.push(`最近 ${recentResults.length} 次工具调用中有 ${windowFails} 次失败（换写法仍反复失败）`)
              toolResult += `\n\n【${warnings.join('；')}。请改用其他方法，或直接向用户说明情况。不要继续重试。】`
              // ★ 硬性熔断：满足任一条件即强制中止工具循环
              //   1) 同一工具连续失败达 MAX_TOOL_FAILS；2) 滚动窗口内失败过多（防“换写法反复失败”）
              if (curFail >= MAX_TOOL_FAILS || windowFails >= FAIL_WINDOW_LIMIT) {
                fuseBlown = true
                fuseTool = toolName
                fuseSummary = `工具 ${toolName} 执行失败并已熔断（连续失败 ${curFail} 次；最近 ${recentResults.length} 次调用中 ${windowFails} 次失败）。最近一次错误：\n${String(toolResult).slice(0, 800)}`
                // 强制中止本轮剩余工具，跳出 for 循环
                flushSync(() => { commitToolCall(liveId, tc.id, { status: 'done', result: capped.text, truncated: capped.truncated, resultTotal: capped.total, failed: true }) })
                apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: capped.text })
                batchExecuted.set(dupKey, capped.text)
                scrollToBottom()
                break
              }
            } else {
              toolFailCount.set(tc.function.name, 0)
              recentResults.push(true)
              while (recentResults.length > FAIL_WINDOW) recentResults.shift()
            }

            flushSync(() => { commitToolCall(liveId, tc.id, { status: 'done', result: capped.text, truncated: capped.truncated, resultTotal: capped.total, failed }) })
            apiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: capped.text })
            batchExecuted.set(dupKey, capped.text)
            scrollToBottom()
            // ── 提问工具防抖：累计 AskUserQuestion 调用，超过阈值即停止继续提问 ──
            if (tc.function.name === 'AskUserQuestion') {
              askQuestionCount++
              if (askQuestionCount >= MAX_ASK_QUESTION) {
                askQuestionBlown = true
                // 强制中止本轮剩余工具，跳出 for 循环
                break
              }
            }
            // TodoWrite 执行完毕后立即刷新任务数据，弹窗内容随之更新
            if (tc.function.name === 'TodoWrite') {
              todoTouchedThisRound = true
              refreshTasksRef.current()
            }
            // 计划推进（兜底）：仅当模型本轮完全没碰 TodoWrite（未自行维护状态）、且成功执行了
            // 一个真实工具时，内核才轻量辅助翻 completed / 推 in_progress。若模型已自行标状态则不干预。
            if (!failed && tc.function.name !== 'TodoWrite') {
              await advancePlan(activeSessionId, todoTouchedThisRound)
            }
          }
          if (abortRef.current.aborted) break
          // ★ 熔断：工具连续失败达阈值，强制中止整个工具循环，不再空转
          if (fuseBlown) {
            endedWithError = true
            useStore.getState().setAgentPhase(null)
            refreshTasksRef.current()
            const note = `\n\n（工具「${fuseTool}」执行失败过多，已自动熔断并停止继续尝试，避免无意义的反复重试。请检查命令/路径是否正确，或换用其他方案。汇总：\n${fuseSummary}）`
            displayMsgs = displayMsgs.map(m =>
              m.id === liveId ? { ...m, content: (m.content || '') + note } : m
            )
            updateSessionInProject(pid, sid, { messages: displayMsgs })
            break
          }
          // ★ 提问防抖：AskUserQuestion 累计调用达上限，停止继续提问，强制推进
          if (askQuestionBlown) {
            useStore.getState().setAgentPhase(null)
            refreshTasksRef.current()
            const note = `\n\n（已多次向你提问（${askQuestionCount} 次），为避免反复弹窗陷入死循环，已自动停止继续提问。请基于用户此前的回答推进任务，或换用其他方案获取所需信息。）`
            displayMsgs = displayMsgs.map(m =>
              m.id === liveId ? { ...m, content: (m.content || '') + note } : m
            )
            updateSessionInProject(pid, sid, { messages: displayMsgs })
            break
          }
          // ★ 工具执行完毕，清除 store 阶段状态
          useStore.getState().setAgentPhase(null)
          // 工具执行后刷新任务清单
          refreshTasksRef.current()
          continue
        }

        // 最终文本回复：本轮无工具调用。若计划里仍有孤儿 in_progress（模型只发 TodoWrite
        // 设 in_progress 却未执行真实工具），回退为 pending，避免永久卡死、后续 pending 无法推进。
        if (!streamError) {
          await cleanupOrphanInProgress(sid)
        }

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
      if (useStore.getState().soundEnabled) playNotificationSound(useStore.getState().notificationSound)
      // 本轮结束后，自动发送排队中的消息（按入队顺序依次发出；每条发送时会自行决定是否再次排队）
      const queue = pendingSendRef.current
      pendingSendRef.current = []
      for (const pending of queue) {
        if (pending.text.trim() || pending.attachments.length) {
          setTimeout(() => handleSendRef.current(pending.text || undefined, pending.attachments), 0)
        }
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
      // 生成 / 工具执行期间：把当前输入加入队列，待本轮结束后按序自动发送
      pendingSendRef.current.push({ text: overrideText ?? input, attachments: attachmentsForSend })
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

    const systemMsg: ApiMessage = { role: 'system', content: await buildSystemContent(activeProject) }
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    // 发送前先尝试压缩历史（超高水位时）；失败则回退原 memory
    const mem = await condenseSessionMemory(pid, sid, displayMsgs, activeSession?.memory, ctxBudget, runningCard.template.serverPort)
    const apiMsgs = [systemMsg, ...buildApiMessagesFull(displayMsgs, mem)]
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))

    await runAgentTurn(pid, sid, displayMsgs, apiMsgs, {
      port: runningCard.template.serverPort,
      tools,
      userHasImages,
      ctxBudget,
      approveWriteEdit: !!activeProject.approveWriteEdit,
    })
  }, [input, attachedFiles, loading, apiBaseUrl, runningCard, activeProjectId, activeSessionId, activeSession, activeProject, updateSessionInProject, runAgentTurn, condenseSessionMemory])

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
    const systemMsg: ApiMessage = { role: 'system', content: await buildSystemContent(activeProject) }
    const lastUser = [...base].reverse().find(m => m.role === 'user')
    const userHasImages = !!(lastUser?.attachments?.some(a => a.type === 'image' && a.dataUrl))
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const mem = await condenseSessionMemory(activeProjectId, activeSessionId, base, activeSession.memory, ctxBudget, runningCard.template.serverPort)
    const apiMsgs = [systemMsg, ...buildApiMessagesFull(base, mem)]
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))
    const r = await runAgentTurn(activeProjectId, activeSessionId, base, apiMsgs, {
      port: runningCard.template.serverPort, tools, userHasImages, ctxBudget, approveWriteEdit: !!activeProject.approveWriteEdit,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runAgentTurn, condenseSessionMemory])

  // 重发：截断保留到该 user 消息（含），重新生成其回复
  const resendAt = useCallback(async (msgId: string) => {
    if (loading || !runningCard || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0 || msgs[idx]!.role !== 'user') return
    const base = msgs.slice(0, idx + 1)
    regenRollbackRef.current = { sid: activeSessionId, messages: msgs.map(m => ({ ...m })) }
    updateSessionInProject(activeProjectId, activeSessionId, { messages: base })
    const systemMsg: ApiMessage = { role: 'system', content: await buildSystemContent(activeProject) }
    const userHasImages = !!(msgs[idx]!.attachments?.some(a => a.type === 'image' && a.dataUrl))
    const ctxN = useStore.getState().modelMetrics[runningCard.template.id]?.nCtx || 0
    const ctxBudget = computeContextBudget(ctxN)
    const mem = await condenseSessionMemory(activeProjectId, activeSessionId, base, activeSession.memory, ctxBudget, runningCard.template.serverPort)
    const apiMsgs = [systemMsg, ...buildApiMessagesFull(base, mem)]
    const tools = userHasImages ? [] : getToolDefinitions().filter(t => AGENT_FILE_TOOL_NAMES.includes(t.function.name))
    const r = await runAgentTurn(activeProjectId, activeSessionId, base, apiMsgs, {
      port: runningCard.template.serverPort, tools, userHasImages, ctxBudget, approveWriteEdit: !!activeProject.approveWriteEdit,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runAgentTurn, condenseSessionMemory])

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
    // 编辑历史消息会改动/截断历史，旧摘要可能失真：清除 memory，下次发送按需重新压缩
    updateSessionInProject(activeProjectId, activeSessionId, { messages: updated, memory: undefined })
    setEditingMsgId(null)
  }, [editingMsgId, editDraft, activeSession, activeProjectId, activeSessionId, updateSessionInProject])

  // 一键撤销：把工具执行前的原文件内容写回（仅当前会话内存备份有效）
  const handleUndo = useCallback(async (msgId: string, tcId: string) => {
    const b = backupsRef.current[tcId]
    if (!b) return
    let res: { success: boolean; error?: string }
    try {
      res = await window.api.writeFile(b.path, b.content)
    } catch (e: any) {
      notify('恢复失败：' + (e?.message || '未知错误'), 'error')
      return
    }
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

  // 稳定的「可撤销判断 / 撤销回调」引用：直接内联箭头函数会导致每次父组件重渲染都生成
  // 新函数身份，击穿 ToolCallGroup / ToolCallCard 的 React.memo，使工具卡片在流式每帧
  // （~100ms）都重新挂载 → 展开状态下 ToolArgsView / ToolResultView 反复重算 → 工具栏卡顿跳动。
  // 用 useCallback 固定身份后，memo 生效，非变化的卡片被跳过，抖动消除。
  const canUndoFor = useCallback((tc: NonNullable<AgentMessage['toolCalls']>[number]) => !!backupsRef.current[tc.id], [])
  const onUndoTool = useCallback((msgId: string, tc: NonNullable<AgentMessage['toolCalls']>[number]) => { void handleUndo(msgId, tc.id) }, [handleUndo])

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
  const AGENT_SUGGESTIONS: { text: string; icon: React.ReactNode }[] = [
    { text: '讲讲这个代码库的架构', icon: <Code2 size={13} /> },
    { text: '总结最近的 git 改动', icon: <GitBranch size={13} /> },
    { text: '智能体的运行主循环在哪，它做了什么？', icon: <Bot size={13} /> },
    { text: '找出并修复这个项目里的一个 bug', icon: <Bug size={13} /> },
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

  function parseToolArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw === 'string' && raw.trim()) {
      try { return JSON.parse(raw) } catch { throw new Error('工具参数 JSON 解析失败（模型输出残缺或非 JSON）：' + raw.slice(0, 200)) }
    }
    return {}
  }

  const renderToolCalls = (toolCalls: NonNullable<AgentMessage['toolCalls']>, msgId: string) => (
    <ToolCallGroup
      toolCalls={toolCalls}
      cardDefaultOpen={toolCardExpandedDefault}
      onPreviewFile={openPreview}
      canUndoFor={canUndoFor}
      onUndo={(tc) => onUndoTool(msgId, tc)}
    />
  )

  return (
    <div className={`agent-code-view ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <div className="agent-code-topbar">
        <div className="agent-code-topbar-left">
          <button className="chat-collapse-btn" onClick={() => setSidebarOpen(v => !v)} style={{ marginTop: 0, width: 28, height: 28 }}>
            {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <span className="agent-code-topbar-title">{activeSession?.title || '新会话'}</span>
        </div>
        <div className="agent-code-topbar-toggle" onDoubleClick={toggleBothSidebars} onContextMenu={toggleBothSidebars} />
        <div className="agent-code-topbar-right">
          {/* Prefill 进度条：直接复用「模型运行数据」面板的同一数据源（modelMetrics[].prefillProgress），
              作为顶部栏行内条目显示，样式照搬 metric-bar-wrap / metric-bar-fill。
              仅在 prefill 进行中（pp < 1）显示，完成后自动消失。 */}
          {prefillActive && (
            <div
              className="metric-bar-wrap agent-prompt-build-bar"
              title={prefillDone ? '提示词加载完成' : '正在加载提示词…'}
            >
              <div
                className="metric-bar-fill"
                style={{ width: `${Math.min(100, (prefillProgress ?? 0) * 100)}%`, background: '#7c3aed', opacity: 0.7 }}
              />
            </div>
          )}
          <button ref={ctxBtnRef} className={`agent-code-topbar-btn ${contextModalOpen ? 'active' : ''}`} onClick={() => setContextModalOpen(v => !v)}>上下文</button>
          <button
            className="agent-code-topbar-btn"
            onClick={handleManualCondense}
            disabled={loading || condensing || !runningCard}
          >
            {condensing ? <Loader2 size={12} className="spin" /> : <Brain size={12} />} 压缩历史
          </button>
          <button ref={promptBtnRef} className={`agent-code-topbar-btn ${promptModalOpen ? 'active' : ''}`} onClick={openPromptModal}><SlidersHorizontal size={12} /> 提示词</button>
          <button className="chat-collapse-btn" onClick={() => { setContextModalOpen(false); setTreeOpen(v => !v) }} style={{ marginTop: 0, width: 28, height: 28 }}>
            {treeOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
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
                  <div className={`agent-code-project-item ${p.id === activeProjectId ? 'active' : ''}`} onClick={() => { updateProject(p.id, { expanded: !p.expanded }); setActiveProjectId(p.id); }}>
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
                      <>
                        <Folder size={13} className="agent-code-project-icon" />
                        <span className="agent-code-session-title">{p.title}</span>
                      </>
                    )}
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); changeProjectDir(p.id) }}><FolderOpen size={11} /></button>
                    </span>
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteProject(p.id) }}><Trash2 size={11} /></button>
                    </span>
                    <span className="ac-icon-btn">
                      <button className="agent-code-session-add" onClick={e => { e.stopPropagation(); addSessionToProject(p.id) }}><Plus size={11} /></button>
                    </span>
                  </div>
                  <div className={`agent-code-child-wrap ${p.expanded ? 'open' : ''}`}>
                    <div className="agent-code-child-sessions">
                      {p.sessions.map(s => (
                        <div key={s.id} className={`agent-code-session-item ${s.id === activeSessionId && p.id === activeProjectId ? 'active' : ''}`} onClick={() => { setActiveProjectId(p.id); setActiveSessionId(s.id) }}>
                          {sessRenamingId === s.id ? (
                            <input
                              ref={sessRenameInputRef}
                              className="agent-code-rename-input"
                              value={sessRenameText}
                              onChange={e => setSessRenameText(e.target.value)}
                              onBlur={() => confirmSessRename(p.id, s.id)}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => { if (e.key === 'Enter') confirmSessRename(p.id, s.id); if (e.key === 'Escape') setSessRenamingId(null) }}
                            />
                          ) : (
                            <span className="agent-code-session-title">{s.title}</span>
                          )}
                          <span className="ac-icon-btn">
                            <button className="agent-code-session-rename" onClick={e => { e.stopPropagation(); startSessRename(s.id, s.title) }}><Pencil size={10} /></button>
                            <button className="agent-code-session-del" onClick={e => { e.stopPropagation(); deleteSession(p.id, s.id) }}><Trash2 size={10} /></button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className={`agent-code-sidebar-resize-handle${sidebarResizing ? ' agent-code-resize-handle--active' : ''}`} onPointerDown={startSidebarResize} />

        <div className="agent-code-chat">
          <div className="chat-messages" ref={chatScrollRef} onScroll={onChatScroll}>
            {condensing && (
              <div className="agent-condensing"><Loader2 size={13} className="spin" /> 正在压缩历史…</div>
            )}
            {activeSession?.memory?.summary && (
              <HistorySummaryBubble summary={activeSession.memory.summary} count={activeSession.memory.coveredMsgIds.length} />
            )}
            {!activeSession || activeSession.messages.length === 0 ? (
              <div className="agent-welcome">
                <div className="agent-welcome-title">
                  <Sparkles size={20} className="agent-welcome-icon" />
                  一个LLM本地智能体
                </div>
                <div className="agent-welcome-desc">描述任务，或随便问点什么。</div>
                <div className="agent-welcome-hint">
                  <span className="agent-welcome-chip"><span className="agent-welcome-key">⏎</span> 发送</span>
                  <span className="agent-welcome-chip"><span className="agent-welcome-key">@</span> 文件</span>
                </div>
                <div className="agent-welcome-suggestions">
                  {AGENT_SUGGESTIONS.map((s) => (
                    <button key={s.text} className="agent-suggestion" onClick={() => sendSuggestion(s.text)}>
                      <span className="agent-suggestion-icon">{s.icon}</span>
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : activeSession.messages.map((msg, i) => {
              const isLast = i === activeSession.messages.length - 1
              // 核心修复：一旦消息已携带 toolCalls，说明模型已经完成思考并决定调用工具，
              // 此时 ThinkBlock 绝不应再显示“思考中”转圈，无论 streaming 状态如何。
              const hasToolCalls = !!(msg.toolCalls?.length)
              const streamingThis = streaming && isLast && msg.role === 'assistant' && !hasToolCalls
              // 流式消息（不限是否已产生工具批）：用于「流式期间实时渲染 content」与
              // 「完成后切换为 segments 交错布局」的分流。流式时必须实时显示思考/工具状态，
              // 否则思考链要等工具批到达才出现（延迟）；done 后才用 segments 交错。
              const streamingMsg = streaming && isLast && msg.role === 'assistant'
              // 已切分进 segments 的工具调用 id（用于流式时把「当前轮尚未切分」的工具卡
              // 作为实时尾部追加，避免流式期所有工具卡堆在顶部、完成后才跳回交错）。
              const segmentedToolIds = new Set<string>()
              if (msg.segments) for (const seg of msg.segments) if (seg.kind === 'tools') for (const t of seg.toolCalls) segmentedToolIds.add(t.id)
              const liveToolCalls = (msg.toolCalls || []).filter(t => !segmentedToolIds.has(t.id))
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
                            <button className="chat-msg-action-btn" onClick={() => copyMessage(msg.content)}><Copy size={13} /></button>
                            <button className="chat-msg-action-btn" onClick={() => editAt(msg.id)} disabled={loading}><Pencil size={13} /></button>
                            <button className="chat-msg-action-btn" onClick={() => resendAt(msg.id)} disabled={loading}><Send size={13} /></button>
                            <button className="chat-msg-action-btn" onClick={() => branchAt(msg.id)} disabled={loading}><GitBranch size={13} /></button>
                          </div>
                        </>
                      ) : null
                    ) : (
                      <>
                        {/* 交错渲染：消息 finalized 后（非流式），若已按流式时间线切分为
                            segments，则严格按 工具栏 → 思考链 → 工具栏 → 思考链 → … → 正文气泡
                            的顺序排列。流式进行中一律走下面的实时 content 渲染（保证思考链/工具状态
                            实时显示，不延迟到工具批到达才出现）；旧消息（无 segments）也走传统布局。 */}
                        {streamingMsg && msg.segments && msg.segments.length > 0 ? (
                          // 流式进行中：先渲染已 finalized 的 segments（按时间线交错，逐轮累积，
                          // 不会把所有工具卡堆在顶部），再追加「当前轮实时尾部」（本轮尚未切分
                          // 的工具卡 + 实时思考），避免完成后才从「全堆顶部」跳回交错布局。
                          <>
                            {msg.segments.map((seg, si) =>
                              seg.kind === 'tools' ? (
                                <ToolCallGroup
                                  key={`seg-${si}`}
                                  toolCalls={seg.toolCalls}
                                  cardDefaultOpen={toolCardExpandedDefault}
                                  onPreviewFile={openPreview}
                                  canUndoFor={canUndoFor}
                                  onUndo={(tc) => onUndoTool(msg.id, tc)}
                                />
                              ) : seg.kind === 'think' ? (
                                <ThinkBlock key={`seg-${si}`} value={seg.content} closed={true} isStreaming={false} />
                              ) : (
                                <div key={`seg-${si}`} className="chat-msg-bubble chat-msg-markdown"><AgentMarkdown content={seg.content} /></div>
                              )
                            )}
                            {liveToolCalls.length > 0 && renderToolCalls(liveToolCalls, msg.id)}
                            {msg.stopped && (
                              <div className="chat-msg-stopped-badge">
                                <Square size={10} />
                                <span>已停止生成</span>
                              </div>
                            )}
                            {streamingThis && (
                              <StreamingBadge text={msg.content || ''} modelLabel={modelLabel} />
                            )}
                            {streamingThis && !msg.content ? (
                              <div className="chat-msg-bubble chat-msg-thinking-wait">
                                <Loader2 size={14} className="spin" />
                                <span className="chat-msg-thinking-text">模型思考中…</span>
                              </div>
                            ) : (
                              <StreamingContent content={msg.content} streaming={streamingMsg} />
                            )}
                          </>
                        ) : !streamingMsg && msg.segments && msg.segments.length > 0 ? (
                          // 已完成：完整交错布局
                          <>
                            {msg.segments.map((seg, si) =>
                              seg.kind === 'tools' ? (
                                <ToolCallGroup
                                  key={`seg-${si}`}
                                  toolCalls={seg.toolCalls}
                                  cardDefaultOpen={toolCardExpandedDefault}
                                  onPreviewFile={openPreview}
                                  canUndoFor={canUndoFor}
                                  onUndo={(tc) => onUndoTool(msg.id, tc)}
                                />
                              ) : seg.kind === 'think' ? (
                                <ThinkBlock key={`seg-${si}`} value={seg.content} closed={true} isStreaming={false} />
                              ) : (
                                <div key={`seg-${si}`} className="chat-msg-bubble chat-msg-markdown"><AgentMarkdown content={seg.content} /></div>
                              )
                            )}
                            {msg.stopped && (
                              <div className="chat-msg-stopped-badge">
                                <Square size={10} />
                                <span>已停止生成</span>
                              </div>
                            )}
                            {/* 交错消息完成后展示操作按钮 */}
                            {!streamingThis && (
                              <div className="chat-msg-actions">
                                <button className="chat-msg-action-btn" onClick={() => copyMessage(msg.content || '')}><Copy size={13} /></button>
                                {isLast && !loading && (
                                  <button className="chat-msg-action-btn" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                                )}
                                {isLast && (msg.stopped || (msg.content && (msg.content.startsWith('模型调用失败') || msg.content.startsWith('发送失败')))) && !loading && (
                                  <button className="chat-msg-action-btn" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          // 旧消息（无 segments）或兜底：传统布局（工具卡在顶部）
                          <>
                            {hasToolCalls ? renderToolCalls(msg.toolCalls!, msg.id) : null}
                            {msg.stopped && (
                              <div className="chat-msg-stopped-badge">
                                <Square size={10} />
                                <span>已停止生成</span>
                              </div>
                            )}
                            {streamingThis && (
                              <StreamingBadge text={msg.content || ''} modelLabel={modelLabel} />
                            )}
                            {streamingThis && !msg.content ? (
                              <div className="chat-msg-bubble chat-msg-thinking-wait">
                                <Loader2 size={14} className="spin" />
                                <span className="chat-msg-thinking-text">模型思考中…</span>
                              </div>
                            ) : (
                              <StreamingContent content={msg.content} streaming={streamingMsg} />
                            )}
                            {!streamingThis && !hasToolCalls && (
                              <div className="chat-msg-actions">
                                <button className="chat-msg-action-btn" onClick={() => copyMessage(msg.content || '')}><Copy size={13} /></button>
                                {isLast && !loading && (
                                  <button className="chat-msg-action-btn" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                                )}
                                {isLast && (msg.stopped || (msg.content && (msg.content.startsWith('模型调用失败') || msg.content.startsWith('发送失败')))) && !loading && (
                                  <button className="chat-msg-action-btn" onClick={() => regenerateAt(msg.id)}><RotateCcw size={13} /></button>
                                )}
                              </div>
                            )}
                          </>
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
                  <input type="checkbox" className="agent-prompt-checkbox" checked={approveWriteEditDraft} onChange={e => setApproveWriteEditDraft(e.target.checked)} />
                  对写入 / 编辑（Write / Edit）也要求人工确认
                </label>
              </div>
              <div className="agent-card-prompt-footer">
                <button className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => { setPromptDraft(''); setApproveWriteEditDraft(false) }}>重置默认</button>
                <button className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => setPromptModalOpen(false)}>取消</button>
                <button className="agent-prompt-btn agent-prompt-btn-primary" onClick={saveSystemPrompt}>保存</button>
              </div>
            </div>
          )}
          {/* 滚动到底部浮动按钮：仅当消息列表较长且用户已向上滚动（非贴底）时显示。
              置于 .agent-code-chat（非滚动容器）内，用 --chat-input-h 变量精确浮在输入框上方。 */}
          {!atBottom && (
            <button className="agent-code-scroll-bottom-btn" onClick={() => scrollToBottom(true)} >
              <ChevronDown size={18} />
            </button>
          )}
          <div className="chat-input-area" ref={chatInputAreaRef}>
            {/* 破坏性工具审批面板：内联显示在输入框内（与提问工具 AskUserQuestionInline 同款位置/风格），不弹窗 */}
            {approvalReq && (
              <div className="agent-approve-inline">
                <div className="agent-approve-inline-head">
                  <AlertCircle size={15} className="agent-ask-question-icon" />
                  <span className="agent-ask-question-title">需要确认：{TOOL_META[approvalReq.name]?.name || approvalReq.name}</span>
                </div>
                <div className="agent-approve-inline-body">
                  <div className="agent-approve-hint">该操作具有破坏性，执行前需你确认</div>
                  <div className="agent-approve-detail-row"><span>工具</span><code>{approvalReq.name}</code></div>
                  <div className="agent-approve-detail-row">
                    <span>参数</span>
                    <pre className="agent-approve-args">{formatToolArgs(approvalReq.args) || '(无)'}</pre>
                  </div>
                </div>
                <div className="agent-approve-inline-footer">
                  <button ref={rejectBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => resolveApproval(false)}>拒绝</button>
                  <button ref={autoApproveBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={() => { autoApproveRef.current = true; resolveApproval(true) }}>本次全部允许</button>
                  <button ref={allowBtnRef} className="agent-prompt-btn agent-prompt-btn-primary" onClick={() => resolveApproval(true)}>允许</button>
                </div>
              </div>
            )}
            {taskModalOpen && (
              <div
                ref={taskCardRef}
                className={`agent-task-card agent-task-card-inline${taskPanelCollapsed ? ' collapsed' : ''}${taskCardClosing ? ' closing' : ''}`}
                onTransitionEnd={(e) => {
                  // 仅当收起动画结束（max-height 过渡完成）且确实处于关闭过渡态时，才真正卸载卡片
                  if (e.propertyName === 'max-height' && taskCardClosing) {
                    setTaskModalOpen(false)
                    setTaskPanelCollapsed(false)
                    setTaskCardClosing(false)
                  }
                }}
              >
                <div className="agent-task-card-head">
                  <span className="agent-task-card-title">待办</span>
                  <span className="agent-task-card-count">{currentPlanItems.filter(i => i.status === 'completed').length}/{currentPlanItems.length}</span>
                  <div className="agent-task-card-head-actions">
                    <button className="agent-task-card-head-btn" onClick={() => {
                      setTaskPanelCollapsed(p => !p)
                      // 用户主动展开/收起：双 rAF 等布局稳定（含 --task-card-h 写入）后滚到底，
                      // 让消息区底部贴合卡片上边框。展开方向 scrollHeight 增大，必须无条件滚，
                      // 不能依赖 atBottom 判断（否则会被误判为离底而不顶上去）。
                      requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
                    }}>{taskPanelCollapsed ? '展开' : '收起'}</button>
                    <button className="agent-task-card-head-btn" onClick={() => {
                      setTaskCardClosing(true)
                      // 关闭动画期间高度持续收缩，双 rAF 触发一次滚到底，后续由 RO 实时跟降
                      requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
                    }}>关闭</button>
                  </div>
                </div>
                {!taskPanelCollapsed && (
                  planTitle && (
                    <div className="agent-task-card-plan-title">{planTitle}</div>
                  )
                )}
                {!taskPanelCollapsed && (
                  <div className="agent-task-card-body">
                    {currentPlanItems.length === 0 ? (
                      <div className="agent-task-card-empty">暂无计划</div>
                    ) : (
                      currentPlanItems.map((item, i) => {
                        // 修复③：显式覆盖全部状态枚举，避免 cancelled 被 fallback 成「待完成」
                        const raw = item.status || 'pending'
                        const statusLabel =
                          raw === 'completed' ? '已完成'
                            : raw === 'in_progress' ? '进行中'
                              : raw === 'cancelled' ? '已取消'
                                : '待完成'
                        const isDone = raw === 'completed'
                        // 仿 Reasonix：每条只显示一行。进行中且有备注(notes)时，备注作为 activeForm 显示；
                        // 否则显示 content。notes 不再作为独立第二行渲染。
                        const text = raw === 'in_progress' && item.notes
                          ? item.notes
                          : (item.content || item.description || '')
                        // 修复④：用稳定 id 作为 key（无 id 时回退下标），减少 merge 导致顺序变化时 DOM 复用错乱
                        return (
                          <div key={item.id ?? i} className={`agent-task-card-item${isDone ? ' done' : ''}`}>
                            <span className={`agent-task-card-status status-${raw}`}>{statusLabel}</span>
                            <div className="agent-task-card-content">
                              <div className="agent-task-card-text">{text}</div>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )}
            <AskUserQuestionInline />
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
            {filePickerOpen && activeProject.workspaceDir && (
              <AgentFilePicker
                workspaceDir={activeProject.workspaceDir}
                attached={filePickerAttached}
                onAttach={handleFilePickerAttach}
                onRemove={handleFilePickerRemove}
                onClose={() => setFilePickerOpen(false)}
                onOpenFile={openPreview}
                triggerRef={attachBtnRef}
              />
            )}
            {attachedFiles.length > 0 && (
              <div className="chat-attach-tray">
                {attachedFiles.map(att => (
                  <div className="chat-attach-chip" key={att.id}>
                    {att.isImage && att.dataUrl
                      ? <img src={att.dataUrl} className="chat-attach-thumb" alt={att.name} />
                      : <FileText size={14} className="chat-attach-fileicon" />}
                    <span className="chat-attach-name" title={att.name}>{att.name}</span>
                    <button className="chat-attach-remove" onClick={() => removeAttachment(att.id)} disabled={loading}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <div ref={modelPickerRef} className={`chat-model-picker${modelPickerOpen ? ' open' : ''}`}>
              {cards.map(card => (
                <div key={card.template.id} className={`chat-model-item ${card.status}`} onClick={() => handleModelAction(card)}>
                  <div className="chat-model-item-avatar">{card.template.name[0]?.toUpperCase() || '?'}</div>
                  <div className="chat-model-item-info">
                    <div className="chat-model-item-name">{card.template.name}</div>
                    <div className="chat-model-item-status">
                      <span className={`chat-model-item-dot ${card.status === 'running' && card.ready ? 'ready' : card.status === 'running' ? 'running' : card.status === 'error' ? 'error' : 'idle'}`} />
                      {card.ready ? '就绪' : card.status === 'running' ? '启动中' : card.status === 'error' ? '错误' : '未启动'}
                    </div>
                  </div>
                  <button className="chat-model-item-action" onClick={e => { e.stopPropagation(); handleModelAction(card) }}>
                    {card.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                  </button>
                </div>
              ))}
            </div>
            <div className="chat-input-row">
              <button ref={attachBtnRef} className={`chat-attach-btn${filePickerOpen ? ' active' : ''}`} onClick={toggleFilePicker} ><FolderOpen size={14} /></button>
              <button ref={modelBtnRef} className={`chat-model-btn${modelPickerOpen ? ' active' : ''}`} onClick={() => setModelPickerOpen(v => !v)} ><Cpu size={14} /></button>
              <textarea ref={textareaRef} className="chat-input" placeholder={apiBaseUrl ? '输入自然语言指令，或添加附件 / 图片…' : '请先启动模型，输入内容将在启动后可发送'} rows={1} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown} />
              {loading ? (
                <button className="btn btn-primary chat-send-btn" onClick={handleStop} ><Square size={16} /></button>
              ) : (
                <button className="btn btn-primary chat-send-btn" onClick={() => handleSend()} disabled={!input.trim() && attachedFiles.length === 0 || !apiBaseUrl} ><Send size={16} /></button>
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
            <div className={`agent-code-resize-handle${previewResizing ? ' agent-code-resize-handle--active' : ''}`} onPointerDown={startResize('preview')} />
            <div className={`agent-code-preview-group ${openTabs.length === 0 ? 'collapsed' : ''}`}>
              <div className="agent-code-preview">
                <div className="agent-code-preview-header">
                  <div className="agent-code-preview-tabs">
                    {openTabs.map(t => (
                      <div
                        key={t.path}
                        className={`agent-code-preview-tab ac-icon-btn ${t.path === activeTabPath ? 'active' : ''}`}
                        onClick={() => setActiveTabPath(t.path)}
                      >
                        <span className="agent-code-preview-tab-name">{t.name}</span>
                        <button
                          className="agent-code-preview-tab-close"
                          onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <span className="agent-code-preview-actions">
                    <button className="btn btn-xs agent-code-preview-close ac-icon-btn" onClick={() => activeTab && closeTab(activeTab.path)} disabled={!activeTab}>
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
                            <AgentMarkdown content={renderPreviewMarkdown(activeTab.content ?? '')} />
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

    </div>
  )
}
