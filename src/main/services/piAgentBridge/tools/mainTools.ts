// llama-studio 主要工具在 main 进程的实现（供 pi bridge 注册）。
// 执行器通过依赖注入（MainToolExecutors），生产环境由 ipc.ts 提取的 handler 提供，
// 测试环境可注入真实实现，与 ipc.ts 解耦。
import { isAbsolute, resolve, sep } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { makePiTool, getTypebox, type PlainToolSpec } from './toolAdapter'

export interface MainToolExecutors {
  readFile(
    filePath: string,
    opts?: { offset?: number; limit?: number; raw?: boolean; maxBytes?: number }
  ): Promise<{
    success: boolean
    content?: string
    startLine?: number
    totalLines?: number
    truncated?: boolean
    error?: string
    errorType?: string
    suggestedCommand?: string
  }>
  writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }>
  glob(opts: { pattern: string; path: string; limit?: number }): Promise<{
    success: boolean
    filenames?: string[]
    numFiles?: number
    truncated?: boolean
    error?: string
  }>
  listDir(dirPath: string): Promise<{
    success: boolean
    entries?: { name: string; isDir: boolean; fileCount: number; size?: number }[]
    truncated?: boolean
    total?: number
    error?: string
  }>
  grep(opts: {
    pattern: string
    path: string
    glob?: string
    output_mode?: string
    head_limit?: number
    '-i'?: boolean
    context?: number
    '-n'?: boolean
    type?: string
    timeout_seconds?: number
  }): Promise<{ success: boolean; content?: string; numFiles?: number; truncated?: boolean; error?: string }>
  deletePath(path: string, recursive: boolean): Promise<{ success: boolean; message?: string; error?: string }>
  // ── 会话/任务类（sessionId 由 createMainTools 的 ctx 注入）──
  todoWrite(sessionId: string, input: { merge: boolean; todos: TodoUpdateInput[] }): Promise<{ success: boolean; tasks?: AgentTaskLike[]; error?: string }>
  taskGet(sessionId: string, taskId: string): Promise<{ success: boolean; task?: AgentTaskLike; error?: string }>
  taskList(sessionId: string): Promise<{ success: boolean; tasks: AgentTaskLike[] }>
  codesearchQuery(dir: string, query: string, limit?: number): Promise<{
    status: string
    results: Array<{ relPath: string; startLine: number; endLine: number; symbol: string; kind: string; score: number; snippet: string }>
    lowConfidence: boolean
    indexedChunks: number
  }>
  webSearch: (query: string) => Promise<string>
  fetchWebpage: (url: string) => Promise<string>
  /** 询问用户（跨进程弹窗；由 IPC 层提供实现） */
  askUser(questions: AskUserQuestionInput[]): Promise<string>
  /** 破坏性操作审批（由 IPC 层提供实现；未提供则放行） */
  approve?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  /** 记录撤销备份（content=null 表示原文件不存在，撤销时删除文件） */
  recordUndo: (toolCallId: string, filePath: string, content: string | null) => void
  /** 移除撤销备份（工具执行失败时清掉孤儿条目；未提供则忽略） */
  removeUndo?: (toolCallId: string) => void
  /** 撤销（写回备份内容或删除新建文件） */
  undo: (toolCallId: string) => Promise<{ success: boolean; path?: string; error?: string }>
}

export interface TodoUpdateInput {
  id?: string
  content?: string
  description?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: 'low' | 'medium' | 'high'
  activeForm?: string
  notes?: string
}

export interface AgentTaskLike {
  id: string
  subject: string
  description?: string
  status?: string
  priority?: string
  notes?: string
  activeForm?: string
}

export interface AskUserQuestionInput {
  question: string
  options?: string[]
  allowFreeform?: boolean
}

/** 破坏性 Bash 命令判定（Bash 工具执行前的人工审批依据） */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(?:del|erase)\b/i,
  /\brm\b/i,
  /\b(?:rmdir|rd)\b/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\b(?:taskkill|tskill)\b/i,
  /\breg\s+delete\b/i,
  /\bbcdedit\b/i,
  /\bschtasks\s+\/delete\b/i,
  /\bnet\s+(?:stop|pause)\b/i,
  /\bsc\s+(?:stop|delete|config)\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /\bwmic\b/i,
  /\bmv\b/i,
  /\bmove\b/i,
  /\bremove-item\b/i,                                   // PowerShell 删除（模型常发 PS 命令）
  /\brimraf\b/i,                                        // node 生态递归删除工具
  /\bgit\s+reset\s+--hard\b/i,                          // 丢弃工作区改动（不可逆）
  /\bgit\s+clean\b/i,                                   // 删除未跟踪文件（不可逆）
  /\bgit\s+push\b/i,                                    // 推送远端（外发操作，一律人工确认）
]

export function isDestructiveBashCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false
  const cmd = command.trim()
  if (!cmd) return false
  const stripped = cmd
    .replace(/^(?:rem\s|::).*$/gim, ' ')
    .replace(/(?:^|\s)#.*$/gm, ' ')
  for (const re of DESTRUCTIVE_PATTERNS) {
    if (re.test(stripped)) return true
  }
  return false
}

/** 破坏性工具审批检查（与 renderer runAgentTurn 语义一致）；返回 true = 放行 */
async function checkApproval(
  exec: MainToolExecutors,
  ctx: CreateMainToolsContext | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; reason?: string }> {
  if (!exec.approve) return { ok: true } // 未接审批通道（如测试环境）直接放行
  const bashCmd = toolName === 'Bash' && typeof args.command === 'string' ? args.command : ''
  const bashNeedsApproval = toolName === 'Bash' && isDestructiveBashCommand(bashCmd)
  const needsApproval =
    (toolName === 'Delete') ||
    bashNeedsApproval ||
    (ctx?.approveWriteEdit && (toolName === 'Write' || toolName === 'Edit'))
  if (!needsApproval) return { ok: true }
  const approved = await exec.approve(toolName, args)
  if (!approved) return { ok: false, reason: '用户已拒绝该工具调用（需要人工确认的操作）' }
  return { ok: true }
}

/** 执行前记录撤销备份（content=null = 原文件不存在，撤销时删除） */
async function recordBackup(exec: MainToolExecutors, toolCallId: string, filePath: string): Promise<void> {
  try {
    const probe = await exec.readFile(filePath, { raw: true })
    if (probe.success && typeof probe.content === 'string') {
      exec.recordUndo(toolCallId, filePath, probe.content)
    } else {
      exec.recordUndo(toolCallId, filePath, null)
    }
  } catch {
    /* 备份失败不阻塞工具执行 */
  }
}

/** 编辑目标是否落在工作区范围内（Windows 大小写不敏感；与 ipc.ts isAgentPathInScope 的工作区基准一致） */
function isPathInWorkspace(absPath: string, baseDir: string): boolean {
  const base = resolve(baseDir).toLowerCase()
  const target = resolve(absPath).toLowerCase()
  return target === base || target.startsWith(base + sep.toLowerCase())
}

// ── pi 原生 Edit 工具（替换自研 edit；wrapper 补回沙箱/审批/撤销）──
// pi 的 createEditToolDefinition 提供自研缺失的能力：edits[] 一次调用多处编辑、
// 模糊匹配（NFKC/智能引号/Unicode 破折号/特殊空白归一）、BOM/行尾还原、unified patch
// 输出（details.diff/patch/firstChangedLine）、同文件变更互斥队列。
// 但默认直接操作本地 fs，绕过 llama-studio 的路径沙箱 / approveWriteEdit 审批 / 撤销备份，
// 这里用 wrapper 补回。注意：跨批冲突检测（ipc.ts fileSnapshots hash 比对）pi 原生无此
// 机制，替换后不再生效——换取 pi 更稳的匹配与多编辑能力，属预期取舍。
async function createPiEditTool(exec: MainToolExecutors, ctx?: CreateMainToolsContext): Promise<ToolDefinition> {
  // main 构建是 CJS，而 pi 系包为 ESM-only（exports 仅 import 条件），静态 import 会
  // require 失败，必须动态 import（与 toolAdapter.ts 对 typebox 的处理一致）。
  const { createEditToolDefinition } = await import('@earendil-works/pi-coding-agent')
  const baseDir = ctx?.workspaceDir ?? '.'
  const piEdit = createEditToolDefinition(baseDir)
  const origPrepare = piEdit.prepareArguments
  // 剥离 pi 的 TUI 渲染字段（renderCall/renderResult 面向 pi 终端 UI，llama-studio 用
  // AgentCodeView 自绘，且其具体泛型参数与通用 ToolDefinition 不兼容）。
  const { renderCall: _renderCall, renderResult: _renderResult, ...piCore } = piEdit
  return {
    ...piCore,
    name: 'Edit', // 保持大写：toolNames 白名单 / TOOL_METAS 元数据 / AgentCodeView 判断均以此为键
    label: '编辑文件',
    // 兼容模型沿用自研参数（file_path + old_string/new_string + replace_all / hashline）：
    // 先转成 pi 的 path + edits[] 格式，再走 pi 原生垫片（edits 字符串化、顶层 oldText/newText）。
    prepareArguments: (args: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>
      if (typeof a.file_path === 'string' && typeof a.path !== 'string') a.path = a.file_path
      if (typeof a.old_string === 'string' && typeof a.new_string === 'string' && !Array.isArray(a.edits)) {
        a.edits = [{ oldText: a.old_string, newText: a.new_string }]
        delete a.old_string
        delete a.new_string
        // replace_all 无法直接映射（pi 要求 oldText 唯一、无"全部替换"），保留标记供
        // execute 在文件存在多处匹配时给出明确提示，避免模型误以为已全部替换
        if (a.replace_all === true) a.__replaceAll = true
        delete a.replace_all
        delete a.hashline
      }
      return origPrepare ? (origPrepare(a) as Record<string, unknown>) : a
    },
    execute: async (toolCallId, params, signal, onUpdate, pctx) => {
      const input = (params ?? {}) as Record<string, unknown>
      const rawPath = String(input.path ?? input.file_path ?? '')
      // 1) 审批：approveWriteEdit 开启时要求人工确认
      const approval = await checkApproval(exec, ctx, 'Edit', { path: rawPath })
      if (!approval.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: approval.reason }) }], details: {} }
      }
      // 2) 路径沙箱：解析到绝对路径并校验在工作区内（pi 原生不检查，防止越界写盘）
      if (!rawPath) {
        return { content: [{ type: 'text', text: '❌ 编辑失败：缺少路径参数 path' }], details: {} }
      }
      const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseDir, rawPath)
      if (!isPathInWorkspace(abs, baseDir)) {
        return { content: [{ type: 'text', text: `❌ 编辑被拒绝：目标路径不在工作区/应用范围内：${rawPath}` }], details: {} }
      }
      // 2.5) replace_all 兼容提示：pi 原生要求每个 oldText 唯一，无法表达"全部替换"；
      // 若原请求 replace_all=true 且文件中存在多处匹配，直接给出明确错误（而非让 pi 报
      // 一句令人困惑的"必须唯一"，或让模型误以为替换已全部生效）
      if (
        input.__replaceAll === true &&
        Array.isArray(input.edits) &&
        input.edits.length === 1 &&
        typeof (input.edits[0] as Record<string, unknown> | undefined)?.oldText === 'string'
      ) {
        const oldText = (input.edits[0] as Record<string, unknown>).oldText as string
        const probe = await exec.readFile(abs, { raw: true }).catch(() => null)
        if (probe?.success && typeof probe.content === 'string') {
          const matches = probe.content.split(oldText).length - 1
          if (matches > 1) {
            return {
              content: [{
                type: 'text',
                text: `❌ 编辑失败：old_string 在文件中有 ${matches} 处匹配。pi 原生 edit 要求 oldText 唯一（不再支持 replace_all 全部替换），请改用更精确的 old_string 分次编辑，或使用 Bash 工具批量替换。`
              }],
              details: {}
            }
          }
        }
      }
      // 3) 撤销备份（recordUndo → UI 一键撤销；pi 无此能力）
      await recordBackup(exec, toolCallId, abs)
      // 4) 执行 pi 原生编辑（path 传绝对路径，绕过 pi 自身的 cwd 解析；去掉内部标记）
      delete input.__replaceAll
      try {
        const res = await piCore.execute(
          toolCallId,
          { ...input, path: abs } as never,
          signal,
          onUpdate,
          pctx
        )
        // 5) 追加 backupId 供 renderer 撤销（与自研 Write/Edit 的 details 契约一致）
        return { ...res, details: { ...((res.details ?? {}) as unknown as Record<string, unknown>), backupId: toolCallId } }
      } catch (err) {
        // 执行失败：编辑未生效，清掉刚记录的撤销备份，避免撤销列表残留无效条目
        exec.removeUndo?.(toolCallId)
        throw err
      }
    }
  }
}

// ── pi 原生 Bash 工具（替换自研 bash；wrapper 补回审批 + env 过滤）──
// pi 的 createBashToolDefinition 在 Windows 上用 Git Bash 执行（自研版是 cmd.exe），
// 带流式输出（onUpdate）、尾部截断 + 完整输出落盘（pi-bash 前缀临时文件）、超时杀进程树。
// 但默认直接透传全部环境变量（含 SECRET/TOKEN 等敏感项）、无破坏性审批、工具名为小写
// `bash` 且带 TUI 渲染字段——这里用 wrapper 补回 llama-studio 的契约：
// 名字改回大写 Bash（toolNames 白名单 / TOOL_METAS / AgentCodeView 均以此键）、
// 剥 renderCall/renderResult、spawnHook 剔除敏感 env、execute 前走破坏性命令审批。
// cd 追踪 / 后台任务 / 自动转后台等自研能力不再保留（pi 原生无此机制，属预期取舍）。
const SENSITIVE_ENV_PATTERN = /(^|[-_])(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|\.ENV|ENV_?FILE)($|[-_])/i
function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(k)) continue // 剔除敏感变量
    out[k] = v
  }
  return out
}

async function createPiBashTool(exec: MainToolExecutors, ctx?: CreateMainToolsContext): Promise<ToolDefinition> {
  // main 构建是 CJS，而 pi 系包为 ESM-only（exports 仅 import 条件），静态 import 会
  // require 失败，必须动态 import（与 toolAdapter.ts / createPiEditTool 的处理一致）。
  const { createBashToolDefinition } = await import('@earendil-works/pi-coding-agent')
  const baseDir = ctx?.workspaceDir ?? '.'
  const piBash = createBashToolDefinition(baseDir, {
    // llama-studio 不用 pi 的 PI_* 会话环境变量，不注入（避免污染模型可见的环境）
    exposeSessionEnvironment: false,
    // 剔除敏感环境变量（模型 echo $TOKEN 会泄密；与 ipc.ts sanitizeCommandEnv 语义一致）
    spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: filterSensitiveEnv(env) })
  })
  // 剥离 pi 的 TUI 渲染字段（renderCall/renderResult 面向 pi 终端 UI，llama-studio 用
  // AgentCodeView 自绘，且其具体泛型参数与通用 ToolDefinition 不兼容）。
  const { renderCall: _renderCall, renderResult: _renderResult, ...piCore } = piBash
  return {
    ...piCore,
    name: 'Bash', // 保持大写：toolNames 白名单 / TOOL_METAS 元数据 / AgentCodeView 判断均以此为键
    label: '执行命令',
    // 兼容模型沿用自研参数（is_background/max_output_chars/auto_background/description）：
    // pi 原生 schema 只有 command + timeout(秒)，多余参数会被 TypeBox 严格校验拒绝。
    // 静默忽略旧参数；timeout 若按旧习惯传毫秒（>300）自动转秒，防 120000 被当成 33 小时。
    prepareArguments: (args: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>
      delete a.is_background
      delete a.auto_background
      delete a.max_output_chars
      delete a.description
      if (typeof a.timeout === 'number' && a.timeout > 300) a.timeout = Math.round(a.timeout / 1000)
      return a
    },
    execute: async (toolCallId, params, signal, onUpdate, pctx) => {
      const args = (params ?? {}) as Record<string, unknown>
      // 1) 审批：破坏性命令（del/rm/rmdir/git push 等）要求人工确认
      const approval = await checkApproval(exec, ctx, 'Bash', args)
      if (!approval.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: approval.reason }) }], details: {} }
      }
      // 2) 执行 pi 原生 bash（Git Bash；自带截断/落盘/超时/流式）。
      // params 已过 prepareArguments（剥旧参数 + timeout 毫秒转秒），用 as never 绕过
      // 泛型差异（与 createPiEditTool 的 `{ ...input, path: abs } as never` 同一模式）。
      try {
        return await piCore.execute(toolCallId, params as never, signal, onUpdate, pctx)
      } catch (err) {
        // 未装 Git Bash 时 pi 抛英文错误，转成可操作的中文提示
        const msg = err instanceof Error ? err.message : String(err)
        if (/No bash shell found/i.test(msg)) {
          return {
            content: [{
              type: 'text',
              text: '❌ 需要 Git Bash：Bash 工具基于 pi-agent 原生实现，在 Windows 上依赖 Git Bash 执行命令。请安装 Git for Windows（https://git-scm.com/download/win），或把 bash 加入 PATH（Cygwin/MSYS2/WSL 亦可）。'
            }],
            details: {}
          }
        }
        throw err
      }
    }
  }
}

export interface CreateMainToolsContext {
  /** llama-studio 会话 id（Todo/Task 工具定位任务清单用） */
  sessionId?: string
  /** 项目开关：Write/Edit 额外要求人工确认 */
  approveWriteEdit?: boolean
  /** 工作区目录（CodeSearch/AnalyzeDir 的相对路径基准） */
  workspaceDir?: string
}

function formatSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`
}

/** 注册 pi 版主要工具（名称/描述/参数与 renderer 版本一致，执行在 main） */
export async function createMainTools(exec: MainToolExecutors, ctx?: CreateMainToolsContext): Promise<ToolDefinition[]> {
  const { Type } = await getTypebox()
  const make = (spec: PlainToolSpec): ToolDefinition => makePiTool(spec, Type)
  const getDatetime: ToolDefinition = make({
    name: 'get_datetime',
    label: '获取时间',
    description: 'Get the current date and time.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const now = new Date()
      return JSON.stringify({
        date: now.toLocaleDateString('zh-CN'),
        time: now.toLocaleTimeString('zh-CN')
      })
    }
  })

  const webSearch: ToolDefinition = make({
    name: 'web_search',
    label: '网络搜索',
    description: 'Search the web. Returns a list of results with title, URL, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' }
      },
      required: ['query']
    },
    execute: async (args) => exec.webSearch(String(args.query ?? ''))
  })

  const fetchWebpage: ToolDefinition = make({
    name: 'fetch_webpage',
    label: '抓取网页',
    description: 'Fetch and read the contents of a web page given its URL. Returns the page content as plain text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the web page to fetch.' }
      },
      required: ['url']
    },
    execute: async (args) => exec.fetchWebpage(String(args.url ?? ''))
  })

  const read: ToolDefinition = make({
    name: 'Read',
    label: '读取文件',
    description:
      'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns each line prefixed with its line number; the line content after the number can be used directly as Edit edits[].oldText. Supports offset/limit. Token budget ~25000; larger content suggests using Grep. Prefer over Bash type/cat.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.'
        },
        offset: {
          type: 'number',
          description: 'Starting line number (1-indexed). Negative counts from end (e.g. -20 = last 20 lines). Default: 1.'
        },
        limit: { type: 'number', description: 'Maximum number of lines to read. Default: all lines.' }
      },
      required: ['file_path']
    },
    execute: async (args) => {
      const file_path = String(args.file_path ?? '')
      const offset = typeof args.offset === 'number' ? args.offset : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      const res = await exec.readFile(file_path, { offset, limit, raw: true })
      if (!res.success) {
        let msg = `Error: ${res.error}`
        if (res.errorType === 'FileTooLarge' && res.suggestedCommand) {
          msg += `\n\n建议使用 Grep 搜索：${res.suggestedCommand}`
        }
        return msg
      }
      const allLines = (res.content ?? '').split('\n')
      const startLine = res.startLine ?? 1
      const totalLines = res.totalLines ?? allLines.length
      // 每行带行号前缀（行内容可直接用作 Edit 的 edits[].oldText）
      const numberedContent = allLines
        .map((line, i) => `${startLine + i} ${line}`)
        .join('\n')
      return `File: ${file_path}\nLines: ${startLine}-${startLine + allLines.length - 1} of ${totalLines}\n\n${numberedContent}`
    }
  })

  const bash: ToolDefinition = await createPiBashTool(exec, ctx)

  const write: ToolDefinition = make({
    name: 'Write',
    label: '写入文件',
    description:
      'Create a NEW file only. If the target file already exists (non-empty), Write is rejected — use Edit for precise modifications instead (Read first, then Edit). Creates parent directories automatically. For file/directory deletion use Delete, not Write. Path is resolved relative to the project directory, so relative paths like "subdir/file.py" work (absolute paths also work).',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.'
        },
        content: { type: 'string', description: 'The content to write to the file.' }
      },
      required: ['file_path', 'content']
    },
    execute: async (args, meta) => {
      const approval = await checkApproval(exec, ctx, 'Write', args as Record<string, unknown>)
      if (!approval.ok) return JSON.stringify({ error: approval.reason })
      const file_path = String(args.file_path ?? '')
      const content = String(args.content ?? '')
      // 系统级强制：Write 仅用于新建文件（与 renderer 版本一致）
      try {
        const probe = await exec.readFile(file_path, { raw: true, maxBytes: 64 })
        const existsNonEmpty = probe.success && typeof probe.content === 'string' && probe.content.length > 0
        if (existsNonEmpty) {
          return [
            '❌ 目标文件已存在，禁止用 Write 整体重写。',
            '请改用 Edit 工具精准修改：先用 Read 查看当前内容，再用 Edit 只替换需要改动的片段。',
            '（若确需整体替换此文件，请先用 Delete 删除再用 Write 新建；但通常应优先 Edit。）'
          ].join('\n')
        }
      } catch { /* 探测失败则按新文件处理 */ }
      // 撤销备份：原文件不存在（撤销 = 删除新建文件）
      await recordBackup(exec, meta.toolCallId, file_path)
      const res = await exec.writeFile(file_path, content)
      if (!res.success) return `❌ 写入失败：${res.error}`
      // 轻量回读校验
      let note = ''
      try {
        const rb = await exec.readFile(file_path, { raw: true })
        if (rb.success && typeof rb.content === 'string') {
          const norm = (s: string) => s.replace(/\r\n/g, '\n')
          note = norm(rb.content) === norm(content)
            ? '（已回读校验：内容一致）'
            : '（提醒：回读内容与写入不一致，可能存在编码/换行差异，请 Read 复核）'
        }
      } catch { /* 校验失败不影响成功语义 */ }
      return { text: `✅ 文件写入成功。${note}`, details: { backupId: meta.toolCallId } }
    }
  })

  const edit: ToolDefinition = await createPiEditTool(exec, ctx)

  const glob: ToolDefinition = make({
    name: 'Glob',
    label: '查找文件',
    description:
      'Find files (not directories) by name using glob patterns (e.g. "*.ts", "src/**/*.tsx"). Returns absolute paths. Does NOT match directories. Avoid bare "*" or "**" patterns. For directory listing / project structure overview, use the ListDir tool, NOT Bash.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "*.ts", "src/**/*.tsx").' },
        path: { type: 'string', description: 'Directory to search in. Omit to use the project directory.' }
      },
      required: ['pattern']
    },
    execute: async (args) => {
      const pattern = String(args.pattern ?? '')
      const path = String(args.path ?? '.')
      const res = await exec.glob({ pattern, path })
      if (!res.success) return `Error: ${res.error}`
      if (!res.filenames || res.filenames.length === 0) return 'No files found.'
      const list = res.filenames.join('\n')
      return res.truncated ? `${list}\n(结果已截断，仅显示前 ${res.filenames.length} 项)` : list
    }
  })

  const grep: ToolDefinition = make({
    name: 'Grep',
    label: '搜索内容',
    description:
      'Search file contents by regex. Supports content/files_with_matches/count output modes, glob filter, type filter (py/js/ts/rs/go/java/…), context lines, case-insensitive mode. Long lines are truncated at 1000 chars. 20s timeout returns partial results. Default search root = project directory. Returns absolute paths. Prefer over Bash findstr.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for in file contents.' },
        path: { type: 'string', description: 'File or directory to search in. Omit to use the project directory.' },
        glob: { type: 'string', description: 'Glob filter for files (e.g. "*.ts", "*.{ts,tsx}").' },
        type: { type: 'string', description: 'File type shortcut — sets glob automatically. Common types: py, js, ts, rs, rust, go, java, c, cpp, md, json, yaml, sh, html, css, sql.' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
        head_limit: { type: 'number', description: 'Max lines/entries to return (default 250, 0 = unlimited).' },
        '-i': { type: 'boolean', description: 'Case insensitive search.' },
        context: { type: 'number', description: 'Lines of context before/after each match (content mode).' },
        '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' },
        timeout_seconds: { type: 'number', description: 'Abort and return partial matches after this many seconds (default 20, max 300).' }
      },
      required: ['pattern']
    },
    execute: async (args) => {
      const pattern = String(args.pattern ?? '')
      const path = String(args.path ?? '.')
      const opts: Parameters<MainToolExecutors['grep']>[0] = { pattern, path }
      if (typeof args.glob === 'string') opts.glob = args.glob
      if (typeof args.type === 'string') opts.type = args.type
      if (typeof args.output_mode === 'string') opts.output_mode = args.output_mode
      if (typeof args.head_limit === 'number') opts.head_limit = args.head_limit
      if (args['-i'] === true) opts['-i'] = true
      if (typeof args.context === 'number') opts.context = args.context
      if (args['-n'] === true) opts['-n'] = true
      if (typeof args.timeout_seconds === 'number') opts.timeout_seconds = args.timeout_seconds
      const res = await exec.grep(opts)
      if (!res.success) return `Error: ${res.error}`
      return res.content ?? `(${res.numFiles ?? 0} files matched)`
    }
  })

  const listDir: ToolDefinition = make({
    name: 'ListDir',
    label: '列出目录',
    description:
      'List files and directories of a SINGLE directory level (non-recursive) at the given path. Use it only to confirm/inspect one directory\'s immediate contents (e.g. check whether a file exists, verify a path before Read/Write). For a full project overview / analyzing what a directory does, use the AnalyzeDir tool instead — do NOT enumerate subdirs one-by-one with ListDir. Prefer this over Bash `dir`/`ls`. To see only directories, set dirsOnly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative or absolute directory path to list. Omit to list the project root.' },
        dirsOnly: { type: 'boolean', description: 'If true, list only directories (equivalent to `dir /ad`), hiding plain files.' },
        recursive: { type: 'boolean', description: 'If true, list subdirectories recursively (one entry per directory, indented by depth) so you can see the full tree in a single call. Off by default (non-recursive, single level).' }
      },
      required: []
    },
    execute: async (args) => {
      const path = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const dirsOnly = args.dirsOnly === true
      const recursive = args.recursive === true
      const res = await exec.listDir(path)
      if (!res.success) return `Error: ${res.error}`
      let entries = res.entries ?? []
      if (entries.length === 0) return '(empty directory)'
      if (dirsOnly) entries = entries.filter((e) => e.isDir)

      if (recursive) {
        const lines: string[] = [`- ${path}/`]
        const childPath = (parent: string, name: string): string => `${parent}\\${name}`
        const walk = async (dir: string, depth: number): Promise<void> => {
          const r = await exec.listDir(dir)
          if (!r.success) return
          for (const s of (r.entries ?? []).filter((e) => e.isDir)) {
            lines.push(`${'  '.repeat(depth + 1)}- ${s.name}/`)
            await walk(childPath(dir, s.name), depth + 1)
          }
        }
        for (const e of entries) {
          if (!e.isDir) continue
          lines.push(`  - ${e.name}/`)
          await walk(childPath(path, e.name), 1)
        }
        return lines.join('\n')
      }

      // 预算折叠：目录条目始终列出；文件过多时折叠为扩展名统计
      const dirs = entries.filter((e) => e.isDir)
      const files = entries.filter((e) => !e.isDir)
      const renderDirs = () => dirs.map((e) => `  - ${e.name}/`).join('\n')
      const renderFiles = () => files.map((e) => {
        const sz = formatSize(e.size)
        return sz ? `  - ${e.name}  (${sz})` : `  - ${e.name}`
      }).join('\n')
      let output = path && path !== '.' ? `- ${path}/\n` : ''
      const headerLen = output.length
      const dirsText = renderDirs()
      const filesText = renderFiles()
      const fullLen = headerLen + (dirsText ? dirsText.length + 1 : 0) + (filesText ? filesText.length + 1 : 0)
      if (fullLen > 6000 && files.length > 100) {
        const buckets = new Map<string, number>()
        for (const f of files) {
          const ext = (f.name.includes('.') ? f.name.split('.').pop()! : '(no ext)').toLowerCase()
          buckets.set(ext, (buckets.get(ext) ?? 0) + 1)
        }
        const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        const summary = top.map(([ext, n]) => `${ext}:${n}`).join(' ')
        const more = buckets.size > top.length ? `，及其他 ${buckets.size - top.length} 类` : ''
        output += `  - [${files.length} 个文件，已折叠为类型统计：${summary}${more}]\n`
        output += `\n(目录较大，已折叠为类型统计以节省上下文；如需查看某类文件，请用 Grep 检索内容，或对具体子目录再次调用 ListDir)`
      } else {
        if (dirsText) output += dirsText + '\n'
        if (filesText) output += filesText + '\n'
        if (res.truncated) output += `\n(仅显示前 1000 项，共 ${res.total} 项)`
      }
      return output.trimEnd()
    }
  })

  const deleteTool: ToolDefinition = make({
    name: 'Delete',
    label: '删除文件',
    description:
      'Delete a file or directory. This is the ONLY tool for deletion — do NOT use Write/Bash for deletion. For files just supply the path; for directories set recursive: true if non-empty. The path is resolved relative to the project directory and validated against it for safety.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
        recursive: { type: 'boolean', description: 'Set to true when deleting a non-empty directory (default false, only empty dirs allowed without this).' }
      },
      required: ['path']
    },
    execute: async (args, meta) => {
      const approval = await checkApproval(exec, ctx, 'Delete', args as Record<string, unknown>)
      if (!approval.ok) return JSON.stringify({ error: approval.reason })
      const path = String(args.path ?? '')
      const recursive = args.recursive === true
      if (!path) return '❌ 删除失败：缺少路径参数 path'
      await recordBackup(exec, meta.toolCallId, path)
      const res = await exec.deletePath(path, recursive)
      if (res.success) return { text: res.message || '✅ 删除成功。', details: { backupId: meta.toolCallId } }
      const err = res.error || ''
      if (/ENOENT|no such|does not exist/.test(err)) return `❌ 删除失败：路径不存在\n${err}`
      if (/EACCES|EPERM|permission/.test(err)) return `🔒 删除失败：权限不足\n${err}`
      if (/not empty|directory not empty/i.test(err)) return `📁 删除失败：目录非空，请设置 recursive: true 后再试\n${err}`
      return `❌ 删除失败：${err}`
    }
  })

  const todoWrite: ToolDefinition = make({
    name: 'TodoWrite',
    label: '任务清单',
    description:
      'Update the task list (todos) for the current session. Use merge:true to add/update individual tasks by id (existing tasks keep their state), or merge:false to replace the whole list. Tasks track progress across turns — keep it up to date as work proceeds. Get the current list with TaskList.',
    parameters: {
      type: 'object',
      properties: {
        merge: { type: 'boolean', description: 'Merge updates into existing tasks (true) or replace the whole list (false). Default false.' },
        todos: {
          type: 'array',
          description: 'Task updates. In merge mode, provide id (keep stable) + fields to change. In replace mode, provide the full new list.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable unique id (keep the same id across updates for the same task).' },
              content: { type: 'string', description: 'Task subject/content.' },
              description: { type: 'string', description: 'Optional longer description.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Task status.' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' },
              notes: { type: 'string', description: 'Progress notes.' },
              activeForm: { type: 'string', description: 'Current active form of the task (e.g. a filename being worked on).' }
            },
            required: ['id', 'content']
          }
        }
      },
      required: ['merge', 'todos']
    },
    execute: async (args) => {
      const sessionId = ctx?.sessionId ?? ''
      if (!sessionId) return '❌ TodoWrite 不可用：缺少会话上下文'
      const merge = args.merge === true
      const todos = Array.isArray(args.todos) ? (args.todos as TodoUpdateInput[]) : []
      if (todos.length === 0) return '❌ 请提供至少一个 todo 更新项'
      const res = await exec.todoWrite(sessionId, { merge, todos })
      if (!res.success) return `❌ 更新任务清单失败：${res.error}`
      const tasks = res.tasks ?? []
      if (tasks.length === 0) return '✅ 任务清单已清空'
      const lines = tasks.map((t) => {
        const mark = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
        return `- [${t.id}] ${mark} ${t.subject}${t.status && t.status !== 'pending' ? ` (${t.status})` : ''}`
      })
      return `✅ 任务清单已更新（共 ${tasks.length} 项）：\n${lines.join('\n')}`
    }
  })

  const taskGet: ToolDefinition = make({
    name: 'TaskGet',
    label: '查看任务',
    description: 'Get a single task from the current session task list by its id. Use TaskList to see all ids.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The id of the task to fetch.' } },
      required: ['task_id']
    },
    execute: async (args) => {
      const sessionId = ctx?.sessionId ?? ''
      const taskId = String(args.task_id ?? '')
      if (!sessionId || !taskId) return '❌ TaskGet 参数不完整'
      const res = await exec.taskGet(sessionId, taskId)
      if (!res.success || !res.task) return `Task ${taskId} not found`
      const t = res.task
      return [
        `Task ${t.id}: ${t.subject}`,
        `  status: ${t.status ?? 'pending'}`,
        t.description ? `  description: ${t.description}` : '',
        t.notes ? `  notes: ${t.notes}` : '',
        t.activeForm ? `  active_form: ${t.activeForm}` : ''
      ].filter(Boolean).join('\n')
    }
  })

  const taskList: ToolDefinition = make({
    name: 'TaskList',
    label: '任务列表',
    description: 'Get the current task list (todos) of this session. Shows all tasks with status. Use it before updating with TodoWrite.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const sessionId = ctx?.sessionId ?? ''
      if (!sessionId) return '❌ TaskList 不可用：缺少会话上下文'
      const res = await exec.taskList(sessionId)
      const tasks = res.tasks ?? []
      if (tasks.length === 0) return '当前会话没有任务。可以用 TodoWrite 建立任务清单。'
      const lines = tasks.map((t) => {
        const mark = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
        return `- [${t.id}] ${mark} ${t.subject}${t.status && t.status !== 'pending' ? ` (${t.status})` : ''}`
      })
      return `任务清单（${tasks.length} 项）：\n${lines.join('\n')}`
    }
  })

  const askUserQuestion: ToolDefinition = make({
    name: 'AskUserQuestion',
    label: '询问用户',
    description:
      'Ask the user one or more questions when you genuinely need their input (ambiguous requirements, permission for an action not covered by approval, or preference decisions). The user sees a panel with the questions; you get back structured answers as JSON. Do not overuse — decide autonomously when you have enough information.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text.' },
              options: { type: 'array', items: { type: 'string' }, description: 'Optional predefined choices.' },
              allowFreeform: { type: 'boolean', description: 'Allow free-text answer (default true).' }
            },
            required: ['question']
          }
        }
      },
      required: ['questions']
    },
    execute: async (args) => {
      const questions = Array.isArray(args.questions) ? (args.questions as AskUserQuestionInput[]) : []
      if (questions.length === 0) return 'No questions provided. Continue with the task.'
      return exec.askUser(questions)
    }
  })

  const reflect: ToolDefinition = make({
    name: 'Reflect',
    label: '反思',
    description: 'Pause and reflect on the current task: assess progress, note blockers, and state next steps. Useful when stuck or after a milestone. The reflection is recorded in the conversation so you can refer back to it.',
    parameters: {
      type: 'object',
      properties: {
        assessment: { type: 'string', description: 'What is the current state of the task?' },
        blockers: { type: 'string', description: 'Anything blocking progress?' },
        next_steps: { type: 'string', description: 'What to do next?' }
      },
      required: ['assessment']
    },
    execute: async (args) => {
      const assessment = String(args.assessment ?? '')
      const blockers = String(args.blockers ?? '').trim()
      const next_steps = String(args.next_steps ?? '').trim()
      return [
        '已记录你的反思：',
        `- 现状：${assessment || '（未填写）'}`,
        `- 阻碍：${blockers || '无'}`,
        `- 下一步：${next_steps || '（未填写）'}`,
        '请据此继续执行；若发现偏离目标，及时调整计划（可用 TodoWrite 更新任务）。'
      ].join('\n')
    }
  })

  const codeSearch: ToolDefinition = make({
    name: 'CodeSearch',
    label: '代码搜索',
    description:
      'Semantic code search over the project symbol index (natural language query → relevant symbols/files with scores). Use when you need to LOCATE code by concept/behavior without knowing exact identifiers (e.g. "where is the login validation handled"). For exact text/regex matches use Grep instead. Returns file paths and matching symbols.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the code you are looking for.' },
        path: { type: 'string', description: 'Directory to search in. Omit to use the project directory.' }
      },
      required: ['query']
    },
    execute: async (args) => {
      const query = String(args.query ?? '')
      const dir = typeof args.path === 'string' && args.path.trim() ? args.path : (ctx?.workspaceDir ?? '.')
      if (!query) return '❌ 缺少 query'
      const res = await exec.codesearchQuery(dir, query, 10)
      if (res.status === 'no-map') return '代码索引不可用（未生成 code map），请改用 Grep 精确搜索。'
      if (res.status === 'building') return `代码索引构建中（已索引 ${res.indexedChunks} 块），本次无法搜索，请改用 Grep 或稍后重试。`
      if (res.results.length === 0) return '没有找到匹配结果。可以换一种描述方式，或改用 Grep 精确搜索。'
      const lines = res.results.map((r) => `${r.relPath}  (${r.kind} ${r.symbol}, 相关度 ${r.score})\n    ${r.snippet.replace(/\n/g, ' ').slice(0, 120)}`)
      return `找到 ${res.results.length} 个相关结果：\n${lines.join('\n')}`
    }
  })

  const analyzeDir: ToolDefinition = make({
    name: 'AnalyzeDir',
    label: '分析目录',
    description:
      'Analyze a directory to understand what it is/does: lists the structure (recursively, with budget folding for large dirs), reads key files (README, package.json, pyproject.toml, etc.) to infer purpose. Use for "what does this directory do / where should X go" questions. For a quick single-level listing use ListDir instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to analyze, relative to the project directory. Omit to analyze the project root.' }
      },
      required: []
    },
    execute: async (args) => {
      const dir = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const base = ctx?.workspaceDir ?? '.'
      const resolveDir = (d: string): string => (d === '.' ? base : d)
      const out: string[] = [`分析目录: ${dir}`]
      // 1) 递归结构（预算折叠）
      const walk = async (d: string, depth: number): Promise<void> => {
        const r = await exec.listDir(resolveDir(d))
        if (!r.success) return
        const entries = r.entries ?? []
        const dirs = entries.filter((e) => e.isDir)
        const files = entries.filter((e) => !e.isDir)
        if (dirs.length === 0 && files.length === 0) {
          out.push(`${'  '.repeat(depth)}- (空目录)`)
          return
        }
        for (const e of dirs) {
          out.push(`${'  '.repeat(depth)}- ${e.name}/`)
          if (depth < 2) await walk(`${d}/${e.name}`, depth + 1)
          else out.push(`${'  '.repeat(depth + 1)}- …(${e.fileCount} 项)`)
        }
        for (const f of files) out.push(`${'  '.repeat(depth)}- ${f.name}`)
      }
      await walk(dir, 0)
      // 2) 读取关键文件推断用途
      const KEY_FILES = ['README.md', 'README', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'index.ts', 'index.js', 'main.py', 'main.ts']
      for (const kf of KEY_FILES) {
        const r = await exec.readFile(`${dir}/${kf}`, { raw: true, maxBytes: 2000 })
        if (r.success && r.content && r.content.trim()) {
          out.push(`\n── ${kf}（前 ${Math.min(r.content.length, 600)} 字符）──\n${r.content.slice(0, 600)}`)
          break
        }
      }
      return out.join('\n')
    }
  })

  return [getDatetime, webSearch, fetchWebpage, read, bash, write, edit, glob, grep, listDir, deleteTool, todoWrite, taskGet, taskList, askUserQuestion, reflect, codeSearch, analyzeDir]
}
