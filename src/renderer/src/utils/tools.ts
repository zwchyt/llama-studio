// ── 工具注册中心（类似 textgen 的 tool_use.py + 各 tools/*.py）────

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
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
import { definition as FileDeleteDef, execute as FileDeleteExec } from '../tools/FileDeleteTool'
import { definition as TodoWriteDef, execute as TodoWriteExec } from '../tools/TodoWriteTool'
import { definition as TaskCreateDef, execute as TaskCreateExec } from '../tools/TaskCreateTool'
import { definition as TaskGetDef, execute as TaskGetExec } from '../tools/TaskGetTool'
import { definition as TaskListDef, execute as TaskListExec } from '../tools/TaskListTool'
import { definition as TaskUpdateDef, execute as TaskUpdateExec } from '../tools/TaskUpdateTool'
import { definition as TaskStopDef, execute as TaskStopExec } from '../tools/TaskStopTool'
import { definition as TaskOutputDef, execute as TaskOutputExec } from '../tools/TaskOutputTool'
register(FileReadDef, FileReadExec)
register(FileWriteDef, FileWriteExec)
register(FileEditDef, FileEditExec)
register(GlobDef, GlobExec)
register(GrepDef, GrepExec)
register(BashDef, BashExec)
register(FileDeleteDef, FileDeleteExec)
register(TodoWriteDef, TodoWriteExec)
register(TaskCreateDef, TaskCreateExec)
register(TaskGetDef, TaskGetExec)
register(TaskListDef, TaskListExec)
register(TaskUpdateDef, TaskUpdateExec)
register(TaskStopDef, TaskStopExec)
register(TaskOutputDef, TaskOutputExec)

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
