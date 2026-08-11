// llama-studio 主要工具在 main 进程的实现（供 pi bridge 注册）。
// 执行器通过依赖注入（MainToolExecutors），生产环境由 ipc.ts 提取的 handler 提供，
// 测试环境可注入真实实现，与 ipc.ts 解耦。
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
  executeCommand(opts: {
    command: string
    timeout?: number
    isBackground?: boolean
    maxOutputChars?: number
    autoBackground?: boolean
  }): Promise<{
    stdout: string
    stderr: string
    code: number
    truncated?: boolean
    outputFile?: string
    autoBackgrounded?: boolean
    taskId?: string
  }>
  writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }>
  editFile(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean
  ): Promise<{ success: boolean; content?: string; error?: string }>
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
  getBackgroundTask(taskId: string): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    code?: number | null
    status?: string
    truncated?: boolean
    totalBytes?: number
    error?: string
  }>
  listBackgroundTasks(): Promise<Array<{ id: string; command: string; status: string; pid: number; startTime: number; autoBackgrounded: boolean }>>
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

/** 与 renderer BashTool 一致的破坏性命令判定 */
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
  /\bmove\b/i
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

export interface CreateMainToolsContext {
  /** llama-studio 会话 id（Todo/Task 工具定位任务清单用） */
  sessionId?: string
  /** 项目开关：Write/Edit 额外要求人工确认 */
  approveWriteEdit?: boolean
  /** 工作区目录（CodeSearch/AnalyzeDir 的相对路径基准） */
  workspaceDir?: string
}

// ── FNV-1a 行内容指纹（与 renderer FileReadTool 一致的 hashline 锚点）──
export function lineHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 7)
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
      'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns each line as "行号 哈希|内容" (Hashline format with content fingerprint for precise Edit targeting). Supports offset/limit. Token budget ~25000; larger content suggests using Grep. Prefer over Bash type/cat.',
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
      const hashlineContent = allLines
        .map((line, i) => `${startLine + i} ${lineHash(line)}|${line}`)
        .join('\n')
      return `File: ${file_path}\nLines: ${startLine}-${startLine + allLines.length - 1} of ${totalLines}\n\n${hashlineContent}`
    }
  })

  const bash: ToolDefinition = make({
    name: 'Bash',
    label: '执行命令',
    description:
      '在 Windows cmd.exe 执行 shell 命令，返回 stdout/stderr。支持前台/后台模式与输出截断。仅用于真正需要 shell 的场景（运行程序、脚本、构建等）。注意：不支持 Unix 命令（pwd/ls/cat/grep/cp/mv/rm 等），改用 dir/cd/copy/move/del/rmdir/where/set；列目录或探索项目结构请用 ListDir 工具，不要用 Bash；避免输出重定向（> >>）。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令（如 git log、node、python、npm run build）。列目录请用 ListDir 工具。'
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice.'
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds (max 300000). Default: 120000.'
        },
        is_background: {
          type: 'boolean',
          description: 'Run in background (long-running commands: dev servers, builds). Returns taskId immediately.'
        },
        max_output_chars: {
          type: 'number',
          description: 'Max output characters before truncation (default 100000).'
        },
        auto_background: { type: 'boolean', description: 'If command times out, move to background instead of killing.' }
      },
      required: ['command']
    },
    execute: async (args) => {
      const approval = await checkApproval(exec, ctx, 'Bash', args as Record<string, unknown>)
      if (!approval.ok) return JSON.stringify({ error: approval.reason })
      const { command, description, timeout, is_background, max_output_chars, auto_background } = args as {
        command?: unknown
        description?: unknown
        timeout?: unknown
        is_background?: unknown
        max_output_chars?: unknown
        auto_background?: unknown
      }
      const res = await exec.executeCommand({
        command: String(command ?? ''),
        timeout: typeof timeout === 'number' ? Math.min(timeout, 300000) : 120000,
        isBackground: is_background === true,
        maxOutputChars: typeof max_output_chars === 'number' ? max_output_chars : undefined,
        autoBackground: auto_background === true
      })

      if (res.taskId && !res.autoBackgrounded) {
        return [
          `[${description ?? command}]`,
          `Background task started: ${res.taskId}`,
          'Command is running in the background.',
          `Use GetBackgroundTaskOutput with task_id="${res.taskId}" to retrieve the output later.`,
          'Use ListBackgroundTasks to see all running/completed tasks.'
        ].join('\n')
      }

      if (res.autoBackgrounded && res.taskId) {
        let output = `[${description ?? command}]`
        output += `\n⏱ 命令执行超时（已自动转入后台运行）\n`
        if (res.stdout) output += res.stdout
        if (res.stderr) {
          if (res.stdout) output += '\n'
          output += `stderr:\n${res.stderr}`
        }
        output += `\n\nTask ID: ${res.taskId}（仍在后台运行）`
        output += `\n可使用 GetBackgroundTaskOutput 获取完整输出。`
        return output
      }

      let output = ''
      if (description) output += `[${description}]\n`
      if (res.stdout) output += res.stdout
      if (res.stderr) {
        if (res.stdout) output += '\n'
        output += `stderr:\n${res.stderr}`
      }
      if (res.code !== 0) {
        if (res.code === 124 || res.code === -1) {
          output += `\n\n⏱ 命令执行超时（${(typeof timeout === 'number' ? timeout : 120000) / 1000}s），已自动终止。如需更长等待可调大 timeout 参数。`
        } else {
          output += `\n\n❌ 命令失败，退出码: ${res.code}`
        }
        if (!output.trim()) output = `命令失败，退出码 ${res.code}（无输出）`
      }
      if (res.truncated && res.outputFile) {
        output += `\n\n（输出过长已截断，完整输出已保存至：${res.outputFile}，可用 Read 工具查看全部内容）`
      }
      return output || '(no output)'
    }
  })

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
            '请改用 Edit 工具精准修改：先用 Read 获取最新 hashline 锚点，再用 Edit 只替换需要改动的片段。',
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

  const edit: ToolDefinition = make({
    name: 'Edit',
    label: '编辑文件',
    description:
      'Edit a file by replacing text. Requires exact old_string match (quote-normalized). Use replace_all for bulk. Always Read the file first to get fresh hashline anchors, then use old_string matching the line content. Returns error if no match found. Path is resolved relative to the project directory.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.'
        },
        old_string: { type: 'string', description: 'The exact content to replace (来自 Read 的 hashline 中 | 后面的部分，不含行号和哈希前缀)。' },
        new_string: { type: 'string', description: 'The replacement string.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string when true (default false).' },
        hashline: { type: 'string', description: '可选的 hashline 锚点（如 "42 abc1234"），用于交叉验证 old_string 定位的行是否正确。' }
      },
      required: ['file_path', 'old_string', 'new_string']
    },
    execute: async (args, meta) => {
      const approval = await checkApproval(exec, ctx, 'Edit', args as Record<string, unknown>)
      if (!approval.ok) return JSON.stringify({ error: approval.reason })
      const file_path = String(args.file_path ?? '')
      const old_string = String(args.old_string ?? '')
      const new_string = String(args.new_string ?? '')
      const replace_all = args.replace_all === true
      if (!old_string) return '❌ 编辑失败：缺少 old_string'
      await recordBackup(exec, meta.toolCallId, file_path)
      const res = await exec.editFile(file_path, old_string, new_string, replace_all)
      if (!res.success) return `❌ 编辑失败：${res.error}`
      return { text: `✅ 编辑成功。请用 Read 复核修改结果。`, details: { backupId: meta.toolCallId } }
    }
  })

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

  const getBackgroundTaskOutput: ToolDefinition = make({
    name: 'GetBackgroundTaskOutput',
    label: '后台任务输出',
    description: 'Get the current output of a background task by its task_id (returned when a command was started with is_background or auto-backgrounded after timeout). For running tasks returns the latest buffered output; for finished tasks returns the saved output. Also tells you the task status.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The id of the background task.' } },
      required: ['task_id']
    },
    execute: async (args) => {
      const taskId = String(args.task_id ?? '')
      if (!taskId) return '❌ 缺少 task_id'
      const res = await exec.getBackgroundTask(taskId)
      if (!res.success) return `❌ ${res.error}`
      const out: string[] = [`后台任务 ${taskId} 状态: ${res.status ?? 'unknown'}`]
      if (res.stdout) out.push(res.stdout)
      if (res.stderr) out.push(`stderr:\n${res.stderr}`)
      if (res.status === 'completed' && res.code === 0 && !res.stdout && !res.stderr) out.push('（已完成，无输出）')
      return out.join('\n')
    }
  })

  const listBackgroundTasks: ToolDefinition = make({
    name: 'ListBackgroundTasks',
    label: '后台任务列表',
    description: 'List all background tasks (running and completed) with their ids, status and commands. Use GetBackgroundTaskOutput with a task_id to see output. Completed tasks are kept for a while.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const tasks = await exec.listBackgroundTasks()
      if (tasks.length === 0) return '当前没有后台任务。'
      const lines = tasks.map((t) => {
        const mark = t.status === 'running' ? '🔄' : t.status === 'completed' ? '✅' : t.status === 'killed' ? '⛔' : '❔'
        return `- [${t.id}] ${mark} ${t.status} | ${t.command.slice(0, 80)}${t.autoBackgrounded ? ' (auto-backgrounded)' : ''}`
      })
      return `后台任务（${tasks.length} 个）：\n${lines.join('\n')}`
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

  return [getDatetime, webSearch, fetchWebpage, read, bash, write, edit, glob, grep, listDir, deleteTool, todoWrite, taskGet, taskList, getBackgroundTaskOutput, listBackgroundTasks, askUserQuestion, reflect, codeSearch, analyzeDir]
}
