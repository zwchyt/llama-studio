// ── 工具注册中心（类似 textgen 的 tool_use.py + 各 tools/*.py）────
import type { ComponentType } from 'react'
import { Eye, FilePlus2, Pencil, Search, FileSearch, TerminalSquare, Clock, HelpCircle, FileText, Trash2, List, ListChecks, TerminalSquare as BgTaskIcon, FolderOpen, Layers, Lightbulb } from 'lucide-react'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// 工具分类（参考 grok-build 的 ToolKind / ToolMetadata：把「是什么类型、要不要审批、
// 能不能撤销、显示什么」做成工具自身属性，而非外部散落的字符串 Set）
export type ToolKind = 'read' | 'write' | 'edit' | 'delete' | 'execute' | 'search' | 'list' | 'plan' | 'ask' | 'task' | 'other'

export interface ToolMeta {
  kind: ToolKind
  label: string                                   // 中文名
  verb: string                                    // 执行中状态文案
  icon: ComponentType<{ size?: number; className?: string }>
  readOnly: boolean                               // 是否为只读/非破坏性
  needsApproval: boolean                          // 默认需人工确认（破坏性）
  canUndo: boolean                                // 执行前备份原文件、支持一键撤销
}

// 单一事实来源：所有工具的分类/展示/权限元数据集中于此
export const TOOL_METAS: Record<string, ToolMeta> = {
  Read:            { kind: 'read',   label: '读取文件', verb: '读取中', icon: Eye,            readOnly: true,  needsApproval: false, canUndo: false },
  Write:           { kind: 'write',  label: '写入文件', verb: '写入中', icon: FilePlus2,       readOnly: false, needsApproval: false, canUndo: true },
  Edit:            { kind: 'edit',   label: '编辑文件', verb: '编辑中', icon: Pencil,          readOnly: false, needsApproval: false, canUndo: true },
  Glob:            { kind: 'search', label: '查找文件', verb: '查找中', icon: Search,          readOnly: true,  needsApproval: false, canUndo: false },
  Grep:            { kind: 'search', label: '搜索内容', verb: '搜索中', icon: FileSearch,      readOnly: true,  needsApproval: false, canUndo: false },
  ListDir:         { kind: 'list',   label: '列出目录', verb: '列目录中', icon: FolderOpen,    readOnly: true,  needsApproval: false, canUndo: false },
  AnalyzeDir:      { kind: 'list',   label: '分析目录', verb: '分析中', icon: Layers,          readOnly: true,  needsApproval: false, canUndo: false },
  Bash:            { kind: 'execute', label: '执行命令', verb: '执行中', icon: TerminalSquare,  readOnly: false, needsApproval: true,  canUndo: false },
  Delete:          { kind: 'delete', label: '删除文件', verb: '删除中', icon: Trash2,          readOnly: false, needsApproval: true,  canUndo: true },
  get_datetime:    { kind: 'other',  label: '获取时间', verb: '获取时间中', icon: Clock,        readOnly: true,  needsApproval: false, canUndo: false },
  web_search:      { kind: 'other',  label: '网络搜索', verb: '搜索中', icon: Search,          readOnly: true,  needsApproval: false, canUndo: false },
  fetch_webpage:   { kind: 'other',  label: '抓取网页', verb: '抓取中', icon: FileText,        readOnly: true,  needsApproval: false, canUndo: false },
  AskUserQuestion: { kind: 'ask',    label: '提问用户', verb: '提问中', icon: HelpCircle,      readOnly: true,  needsApproval: false, canUndo: false },
  Reflect:         { kind: 'other',  label: '自我反思', verb: '反思中', icon: Lightbulb,       readOnly: true,  needsApproval: false, canUndo: false },
  view_tool:       { kind: 'other',  label: '查看工具', verb: '查看工具中', icon: HelpCircle,   readOnly: true,  needsApproval: false, canUndo: false },
  TodoWrite:       { kind: 'plan',   label: '计划任务', verb: '计划中', icon: ListChecks,      readOnly: false, needsApproval: false, canUndo: false },
  TaskGet:         { kind: 'task',   label: '查询任务', verb: '查询任务中', icon: List,        readOnly: true,  needsApproval: false, canUndo: false },
  TaskList:        { kind: 'task',   label: '列出任务', verb: '列出任务中', icon: ListChecks,   readOnly: true,  needsApproval: false, canUndo: false },
  GetBackgroundTaskOutput: { kind: 'task', label: '读取后台输出', verb: '读取输出中', icon: BgTaskIcon, readOnly: true, needsApproval: false, canUndo: false },
  ListBackgroundTasks:     { kind: 'task', label: '列出后台任务', verb: '列出任务中', icon: ListChecks, readOnly: true, needsApproval: false, canUndo: false },
}

// 派生集合（替代原先散落在 AgentCodeView 里的字符串 Set）
export const APPROVAL_TOOLS = new Set(
  Object.entries(TOOL_METAS).filter(([, m]) => m.needsApproval).map(([n]) => n)
)
export const BACKUP_TOOLS = new Set(
  Object.entries(TOOL_METAS).filter(([, m]) => m.canUndo).map(([n]) => n)
)
export const WRITE_EDIT_TOOLS = new Set(
  Object.entries(TOOL_METAS).filter(([, m]) => m.kind === 'write' || m.kind === 'edit').map(([n]) => n)
)

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_METAS[name]
}

// ── 渐进工具暴露（frequent / rare 分级）─────────────────────
// 本地小模型上下文紧张：低频工具默认只注入「精简 schema」（一行摘要 + 参数名/类型，
// 去掉冗长描述），需要完整参数说明时由模型调用 view_tool 展开。可显著降低 system
// prompt 的 token 占用，减少弱模型的注意力干扰。
export const AGENT_RARE_TOOLS = new Set<string>([
  'Reflect', 'TaskGet', 'TaskList', 'GetBackgroundTaskOutput', 'ListBackgroundTasks',
])

interface ToolEntry {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>) => Promise<string>
}

const registry: ToolEntry[] = []

function register(
  fnDef: Omit<ToolDefinition['function'], 'type'>,
  execute: (args: Record<string, unknown>) => Promise<string>
): void {
  registry.push({
    definition: { type: 'function', function: fnDef },
    execute
  })
}

// ── 内置工具注册 ─────────────────────────────────────────

register(
  {
    name: 'get_datetime',
    description: 'Get the current date and time.',
    parameters: { type: 'object', properties: {} }
  },
  async (_args) => {
    const now = new Date()
    return JSON.stringify({
      date: now.toLocaleDateString('zh-CN'),
      time: now.toLocaleTimeString('zh-CN')
    })
  }
)

register(
  {
    name: 'web_search',
    description: 'Search the web. Returns a list of results with title, URL, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' }
      },
      required: ['query']
    }
  },
  async (args) => window.api.webSearch(String(args.query || ''))
)

register(
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the contents of a web page given its URL. Returns the page content as plain text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the web page to fetch.' }
      },
      required: ['url']
    }
  },
  async (args) => window.api.fetchWebpage(String(args.url || ''))
)

// view_tool：渐进工具暴露的配套——返回某个工具的完整参数定义。
// 当某个低频（rare）工具在提示词中仅显示精简摘要时，模型可先调用本工具获取完整 schema。
register(
  {
    name: 'view_tool',
    description: '查看某个精简（rare）工具的完整参数定义。若某工具仅显示一行摘要而你不确定其参数，请先调用本工具获取完整 schema，再正确调用该工具。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要查看的工具名称（如 Reflect、TaskList）。' }
      },
      required: ['name']
    }
  },
  async (args) => {
    const name = String(args.name || '')
    const entry = registry.find(e => e.definition.function.name === name)
    if (!entry) return JSON.stringify({ error: `未找到工具：${name}` })
    return JSON.stringify(entry.definition.function, null, 2)
  }
)

// ── Agent Code 文件操作工具（从独立模块导入）──────────────
import { definition as FileReadDef, execute as FileReadExec } from '../tools/FileReadTool'
import { definition as FileWriteDef, execute as FileWriteExec } from '../tools/FileWriteTool'
import { definition as FileEditDef, execute as FileEditExec } from '../tools/FileEditTool'
import { definition as GlobDef, execute as GlobExec } from '../tools/GlobTool'
import { definition as GrepDef, execute as GrepExec } from '../tools/GrepTool'
import { definition as BashDef, execute as BashExec } from '../tools/BashTool'
import { definition as ListDirDef, execute as ListDirExec } from '../tools/ListDirTool'
import { definition as AnalyzeDirDef, execute as AnalyzeDirExec } from '../tools/AnalyzeDirTool'
import { definition as FileDeleteDef, execute as FileDeleteExec } from '../tools/FileDeleteTool'
import { definition as TodoWriteDef, execute as TodoWriteExec } from '../tools/TodoWriteTool'
import { definition as TaskGetDef, execute as TaskGetExec } from '../tools/TaskGetTool'
import { definition as TaskListDef, execute as TaskListExec } from '../tools/TaskListTool'
import { definition as GetBackgroundTaskOutputDef, execute as GetBackgroundTaskOutputExec } from '../tools/GetBackgroundTaskOutputTool'
import { definition as ListBackgroundTasksDef, execute as ListBackgroundTasksExec } from '../tools/ListBackgroundTasksTool'
import { definition as AskUserQuestionDef, execute as AskUserQuestionExec } from '../tools/AskUserQuestionTool'
import { definition as ReflectDef, execute as ReflectExec } from '../tools/ReflectTool'
register(FileReadDef, FileReadExec)
register(FileWriteDef, FileWriteExec)
register(FileEditDef, FileEditExec)
register(GlobDef, GlobExec)
register(GrepDef, GrepExec)
register(BashDef, BashExec)
register(ListDirDef, ListDirExec)
register(AnalyzeDirDef, AnalyzeDirExec)
register(FileDeleteDef, FileDeleteExec)
register(TodoWriteDef, TodoWriteExec)
register(TaskGetDef, TaskGetExec)
register(TaskListDef, TaskListExec)
register(GetBackgroundTaskOutputDef, GetBackgroundTaskOutputExec)
register(ListBackgroundTasksDef, ListBackgroundTasksExec)
register(AskUserQuestionDef, AskUserQuestionExec)
register(ReflectDef, ReflectExec)

// ── 导出 API（类似 textgen 的 load_tools / execute_tool）──

// 工具统一执行超时（毫秒）与适用白名单（仅本地 IO 类，详见 executeToolCall）。
const TOOL_EXEC_TIMEOUT_MS = 30000
const TIMEOUT_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'ListDir', 'AnalyzeDir', 'Delete'])

// 可自动重试的工具（本地 IO + 网络类）：仅对「瞬时性」错误重试一次，避免让模型为偶发抖动放弃。
const RETRY_TOOLS = new Set([...TIMEOUT_TOOLS, 'web_search', 'fetch_webpage'])
const TOOL_RETRY_DELAY_MS = 300
// 瞬时错误特征（文件被占用 / 资源忙 / 网络抖动等）；确定性错误（不存在/无权限/未匹配）不重试。
const RETRYABLE_ERROR_RE = /(EBUSY|EAGAIN|EMFILE|ENFILE|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|network|socket hang up|temporarily unavailable|resource busy|being used by another process|正由另一(?:个)?进程使用|resource temporarily)/i
// 我方超时哨兵：超时后再重试大概率仍超时，故不重试。
const TIMEOUT_SENTINEL = '执行超时'

function extractErrorText(result: string): string | null {
  let msg = result
  try { const o = JSON.parse(result); if (o && typeof o.error === 'string') msg = o.error } catch { /* 非 JSON，直接用原文匹配 */ }
  return /"error"|error|失败|超时|Error/i.test(msg) ? msg : null
}

function isRetryableResult(result: string): boolean {
  const err = extractErrorText(result)
  if (!err) return false
  if (err.includes(TIMEOUT_SENTINEL)) return false
  return RETRYABLE_ERROR_RE.test(err)
}

/** 将一个工具定义压缩为「精简 schema」：仅保留一行摘要 + 参数名/类型，去掉冗长描述。 */
function compactToolDefinition(def: ToolDefinition): ToolDefinition {
  const fn = def.function
  const desc = fn.description || ''
  const firstSentence = desc.split(/(?<=[.。！!?？])\s/)[0] || desc
  const shortDesc = (firstSentence.length > 120 ? firstSentence.slice(0, 120) : firstSentence)
    + '（精简模式；调用前如不确定参数，请先用 view_tool 获取完整说明）'
  const params = fn.parameters as { properties?: Record<string, { type?: string }>; required?: unknown } | undefined
  const props: Record<string, { type?: string }> = {}
  if (params?.properties) {
    for (const [k, spec] of Object.entries(params.properties)) props[k] = { type: (spec as { type?: string })?.type }
  }
  const required = Array.isArray(params?.required) ? params!.required : []
  return { type: 'function', function: { name: fn.name, description: shortDesc, parameters: { type: 'object', properties: props, required } } }
}

/** 获取所有已注册工具的定义列表（OpenAI 格式）。compactRare=true 时低频工具仅返回精简 schema。 */
export function getToolDefinitions(opts?: { compactRare?: boolean }): ToolDefinition[] {
  return registry.map(e =>
    opts?.compactRare && AGENT_RARE_TOOLS.has(e.definition.function.name)
      ? compactToolDefinition(e.definition)
      : e.definition
  )
}

// ── 工具参数 Schema 浅校验 + 自动修复 ──
// 参数键名别名 → 规范键（仅当规范键在 schema 中存在且当前缺失时才重映射）
const ARG_ALIASES: Record<string, string[]> = {
  file_path: ['path', 'filepath', 'filename', 'file', 'fileName', 'filePath', 'file_name'],
  path: ['dir', 'directory', 'folder'],
  pattern: ['glob', 'regex', 'search'],
  command: ['cmd', 'bash', 'shell', 'script'],
  content: ['text', 'data', 'body', 'file_content'],
  old_string: ['old', 'oldText', 'old_str', 'from'],
  new_string: ['new', 'newText', 'new_str', 'replacement', 'to'],
}
// 模型偶尔把真实参数多包一层（如 {"arguments": {...}}）
const WRAPPER_KEYS = new Set(['input', 'arguments', 'args', 'parameters', 'params', 'tool_input'])

interface ParamSpec { type?: string }
function getParamsSchema(name: string): { properties: Record<string, ParamSpec>; required: string[] } | null {
  const entry = registry.find(e => e.definition.function.name === name)
  const params = entry?.definition.function.parameters as { properties?: Record<string, ParamSpec>; required?: unknown } | undefined
  if (!params || typeof params !== 'object') return null
  const properties = params.properties && typeof params.properties === 'object' ? params.properties : null
  if (!properties || Object.keys(properties).length === 0) return null
  const required = Array.isArray(params.required) ? params.required.filter((x): x is string => typeof x === 'string') : []
  return { properties, required }
}

/**
 * 按工具已注册的 JSON Schema 对参数做浅校验与自动修复：
 * 解多余嵌套 → 键名别名重映射 → 标量类型强制 → 必填浅校验。
 * 返回修复后的 args 与 repairs 说明；缺必填项时返回 error（不执行）。
 * 不做数组/对象的深度校验，避免误伤 TodoWrite.todos / AskUserQuestion.questions 等结构。
 */
export function validateAndRepairArgs(
  name: string,
  args: Record<string, unknown>
): { args: Record<string, unknown>; repairs: string[]; error?: string } {
  const schema = getParamsSchema(name)
  if (!schema) return { args, repairs: [] }
  const { properties, required } = schema
  const propNames = Object.keys(properties)
  const repairs: string[] = []
  let out: Record<string, unknown> = { ...(args || {}) }

  // 1) 解多余嵌套：顶层无任何 schema 属性命中，且唯一键为包装键且值为对象 → 解包
  const topKeys = Object.keys(out)
  const anyHit = topKeys.some(k => propNames.includes(k))
  if (!anyHit && topKeys.length === 1 && WRAPPER_KEYS.has(topKeys[0]!)) {
    const inner = out[topKeys[0]!]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      out = { ...(inner as Record<string, unknown>) }
      repairs.push(`解包外层「${topKeys[0]}」`)
    }
  }

  // 2) 键名别名重映射（仅规范键在 schema 且当前缺失时）
  for (const canon of propNames) {
    if (canon in out && out[canon] !== undefined) continue
    const aliases = ARG_ALIASES[canon]
    if (!aliases) continue
    for (const a of aliases) {
      if (a in out && out[a] !== undefined) {
        out[canon] = out[a]
        delete out[a]
        repairs.push(`${a}→${canon}`)
        break
      }
    }
  }

  // 3) 标量类型强制（按 property.type）
  for (const [k, spec] of Object.entries(properties)) {
    if (!(k in out) || out[k] == null) continue
    const t = spec?.type
    const v = out[k]
    if (t === 'number' || t === 'integer') {
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) { out[k] = Number(v); repairs.push(`${k} 转为数字`) }
    } else if (t === 'boolean') {
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1') { out[k] = true; repairs.push(`${k} 转为布尔`) }
        else if (s === 'false' || s === '0') { out[k] = false; repairs.push(`${k} 转为布尔`) }
      } else if (v === 1) { out[k] = true; repairs.push(`${k} 转为布尔`) }
      else if (v === 0) { out[k] = false; repairs.push(`${k} 转为布尔`) }
    } else if (t === 'string') {
      if (typeof v === 'number' || typeof v === 'boolean') { out[k] = String(v); repairs.push(`${k} 转为字符串`) }
    }
    // array / object 不做深度校验
  }

  // 4) 必填浅校验
  const missing = required.filter(k => {
    const v = out[k]
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
  })
  if (missing.length > 0) {
    return {
      args: out,
      repairs,
      error: `缺少必填参数：${missing.join('、')}。工具 ${name} 期望参数：${propNames.join(', ')}（必填：${required.join('、') || '无'}）。请补齐后重试。`,
    }
  }
  return { args: out, repairs }
}

// 单次执行（对本地 IO 类工具套用统一超时；其余直接执行）
async function runToolOnce(name: string, entry: ToolEntry, args: Record<string, unknown>): Promise<string> {
  if (!TIMEOUT_TOOLS.has(name)) return entry.execute(args)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(JSON.stringify({ error: `工具 ${name} ${TIMEOUT_SENTINEL}（${TOOL_EXEC_TIMEOUT_MS / 1000}s），已中止。如确需更久，请拆分任务或改用后台方式。` })),
      TOOL_EXEC_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([entry.execute(args), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 按函数名执行工具，返回 JSON 字符串 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const entry = registry.find(e => e.definition.function.name === name)
  if (!entry) return JSON.stringify({ error: `Unknown tool: ${name}` })
  // 参数 Schema 浅校验 + 自动修复（单次，位于重试之前）。
  const v = validateAndRepairArgs(name, args)
  if (v.error) return JSON.stringify({ error: `参数校验失败：${v.error}` })
  args = v.args
  const repairNote = v.repairs.length ? `\n\n（已自动修复参数：${v.repairs.join('；')}）` : ''
  // 仅在成功（非错误）结果末尾附上修复提示，避免破坏错误 JSON
  const withNote = (res: string) => (repairNote && !extractErrorText(res)) ? res + repairNote : res
  // 本地 IO 类工具统一超时：防止个别调用（超大文件、锁文件、异常 IPC）无限期挂起整个工具循环。
  // 不覆盖 Bash（主进程已有 timeout + 自动转后台）、AskUserQuestion（等待人工）、后台/任务查询类。
  const first = await runToolOnce(name, entry, args)
  // 重试/降级：网络/IO 类工具遇「瞬时性」错误时自动重试一次（确定性错误与超时不重试）。
  if (!RETRY_TOOLS.has(name) || !isRetryableResult(first)) return withNote(first)
  await new Promise(r => setTimeout(r, TOOL_RETRY_DELAY_MS))
  const second = await runToolOnce(name, entry, args)
  const finalRes = isRetryableResult(second)
    ? `${second}\n\n【${name} 已自动重试 1 次仍失败（瞬时性错误）。请改用其他方法或稍后再试。】`
    : second
  return withNote(finalRes)
}
