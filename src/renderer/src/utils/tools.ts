// ── 工具注册中心（类似 textgen 的 tool_use.py + 各 tools/*.py）────
import type { ComponentType } from 'react'
import { Eye, FilePlus2, Pencil, Search, FileSearch, TerminalSquare, Clock, HelpCircle, FileText, Trash2, List, CheckSquare, ListChecks, TerminalSquare as TaskOutputIcon, FolderOpen, Layers } from 'lucide-react'

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
  TodoWrite:       { kind: 'plan',   label: '计划任务', verb: '计划中', icon: ListChecks,      readOnly: false, needsApproval: false, canUndo: false },
  TaskGet:         { kind: 'task',   label: '查询任务', verb: '查询任务中', icon: List,        readOnly: true,  needsApproval: false, canUndo: false },
  TaskList:        { kind: 'task',   label: '列出任务', verb: '列出任务中', icon: ListChecks,   readOnly: true,  needsApproval: false, canUndo: false },
  TaskOutput:      { kind: 'task',   label: '读取任务输出', verb: '读取输出中', icon: TaskOutputIcon, readOnly: true, needsApproval: false, canUndo: false },
  GetBackgroundTaskOutput: { kind: 'task', label: '读取后台输出', verb: '读取输出中', icon: TaskOutputIcon, readOnly: true, needsApproval: false, canUndo: false },
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
import { definition as TaskOutputDef, execute as TaskOutputExec } from '../tools/TaskOutputTool'
import { definition as GetBackgroundTaskOutputDef, execute as GetBackgroundTaskOutputExec } from '../tools/GetBackgroundTaskOutputTool'
import { definition as ListBackgroundTasksDef, execute as ListBackgroundTasksExec } from '../tools/ListBackgroundTasksTool'
import { definition as AskUserQuestionDef, execute as AskUserQuestionExec } from '../tools/AskUserQuestionTool'
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
register(TaskOutputDef, TaskOutputExec)
register(GetBackgroundTaskOutputDef, GetBackgroundTaskOutputExec)
register(ListBackgroundTasksDef, ListBackgroundTasksExec)
register(AskUserQuestionDef, AskUserQuestionExec)

// ── 导出 API（类似 textgen 的 load_tools / execute_tool）──

/** 获取所有已注册工具的定义列表（OpenAI 格式） */
export function getToolDefinitions(): ToolDefinition[] {
  return registry.map(e => e.definition)
}

/** 按函数名执行工具，返回 JSON 字符串 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const entry = registry.find(e => e.definition.function.name === name)
  if (!entry) return JSON.stringify({ error: `Unknown tool: ${name}` })
  return entry.execute(args)
}
