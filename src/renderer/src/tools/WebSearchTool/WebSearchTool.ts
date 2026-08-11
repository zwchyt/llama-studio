import type { ToolDefinition } from '../../utils/tools'
import { WEB_SEARCH_TOOL_NAME } from './constants'
import type { WebSearchInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: WEB_SEARCH_TOOL_NAME,
  description: 'Search the web. Returns a list of results with title, URL, and snippet.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' }
    },
    required: ['query']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { query } = args as unknown as WebSearchInput
  return window.api.webSearch(String(query ?? ''))
}
