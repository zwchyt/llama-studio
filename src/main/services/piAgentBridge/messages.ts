// pi-agent SDK 消息/工具 ↔ llama.cpp OpenAI 兼容格式 转换
// pi 侧类型：UserMessage | AssistantMessage | ToolResultMessage（见 @earendil-works/pi-ai 的 Message）
// llama.cpp 侧：/v1/chat/completions 的 messages / tools 格式
import type { Context, Tool } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'

export interface LlamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface LlamaToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** pi 的 content 数组（Text/Image/ToolCall）→ OpenAI 文本/图片内容数组 */
function convertPiContent(
  content: string | Array<{ type: string; [k: string]: unknown }>
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  const out: Array<Record<string, unknown>> = []
  for (const c of content) {
    if (c.type === 'text') {
      out.push({ type: 'text', text: String((c as { text?: unknown }).text ?? '') })
    } else if (c.type === 'image') {
      // pi ImageContent: { type:'image', data: base64, mimeType }
      const img = c as { data?: string; mimeType?: string }
      if (img.data) {
        out.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType ?? 'image/png'};base64,${img.data}` }
        })
      }
    }
    // thinking 内容不传给 llama（无原生 thinking 通道；如需可拼接为文本）
  }
  return out
}

/** pi 工具参数 schema（TypeBox TSchema）→ 普通 JSON Schema 对象 */
export function schemaToJson(schema: TSchema): Record<string, unknown> {
  // TypeBox schema 本身就是 JSON-schema 兼容的普通对象，深拷贝避免共享引用
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
}

/** pi Tool[] → OpenAI tools 数组 */
export function convertTools(tools: Tool[] | undefined): LlamaToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ? schemaToJson(t.parameters) : { type: 'object', properties: {} }
    }
  }))
}

/** pi Context → llama.cpp messages 数组（含 systemPrompt 与工具调用历史） */
export function convertMessages(context: Context): LlamaChatMessage[] {
  const out: LlamaChatMessage[] = []
  if (context.systemPrompt) {
    out.push({ role: 'system', content: context.systemPrompt })
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: convertPiContent(msg.content as unknown as string | Array<{ type: string; [k: string]: unknown }>) })
    } else if (msg.role === 'assistant') {
      const m = msg as unknown as { content: Array<{ type: string; [k: string]: unknown }> }
      const texts: string[] = []
      const toolCalls: NonNullable<LlamaChatMessage['tool_calls']> = []
      for (const c of m.content ?? []) {
        if (c.type === 'text') texts.push(String((c as { text?: unknown }).text ?? ''))
        else if (c.type === 'toolCall') {
          const tc = c as { id?: string; name?: string; arguments?: Record<string, unknown> }
          toolCalls.push({
            id: tc.id ?? `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: tc.name ?? '',
              arguments: JSON.stringify(tc.arguments ?? {})
            }
          })
        }
      }
      const outMsg: LlamaChatMessage = {
        role: 'assistant',
        content: texts.length > 0 ? texts.join('') : null
      }
      if (toolCalls.length > 0) outMsg.tool_calls = toolCalls
      out.push(outMsg)
    } else if (msg.role === 'toolResult') {
      const m = msg as unknown as { toolCallId?: string; content?: string | Array<{ type: string; [k: string]: unknown }>; isError?: boolean }
      const content = m.content ?? ''
      const text = typeof content === 'string' ? content : convertPiContent(content)
      const finalText = typeof text === 'string' ? text : text.map((c) => (c.type === 'text' ? String(c.text ?? '') : '')).join('')
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.isError ? `[ERROR] ${finalText}` : finalText
      })
    }
  }
  return out
}
