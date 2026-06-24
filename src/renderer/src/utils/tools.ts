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
