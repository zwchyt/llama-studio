import type { ToolDefinition } from '../../utils/tools'
import { BING_SEARCH_TOOL_NAME } from './constants'
import type { BingSearchInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BING_SEARCH_TOOL_NAME,
  description: 'Search the web via Bing (cn.bing.com). Returns a list of results with title, URL, and snippet. Use this for Chinese/domestic web content and when DuckDuckGo is unreachable.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' }
    },
    required: ['query']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { query } = args as unknown as BingSearchInput
  return window.api.webSearchBing(String(query ?? ''))
}
