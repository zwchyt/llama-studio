import type { ToolDefinition } from '../../utils/tools'
import { FETCH_WEBPAGE_TOOL_NAME } from './constants'
import type { FetchWebpageInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FETCH_WEBPAGE_TOOL_NAME,
  description: 'Fetch and read the contents of a web page given its URL. Returns the page content as plain text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL of the web page to fetch.' }
    },
    required: ['url']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { url } = args as unknown as FetchWebpageInput
  return window.api.fetchWebpage(String(url ?? ''))
}
