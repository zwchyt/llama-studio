// 工具适配器：把 llama-studio 的 OpenAI 格式工具定义（JSON Schema 参数）
// 包装成 pi 的 ToolDefinition（TypeBox 参数 + {content, details} 返回）。
//
// 注意：typebox / pi 系包均为 ESM-only（exports 仅 import 条件），main 构建是 CJS，
// 静态 import 会在运行时 require 失败（ERR_PACKAGE_PATH_NOT_EXPORTED），
// 因此运行时依赖全部走动态 import（import() 匹配 import 条件）。
import type { TSchema } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

let typeboxPromise: Promise<typeof import('typebox')> | null = null
export function getTypebox(): Promise<typeof import('typebox')> {
  if (!typeboxPromise) typeboxPromise = import('typebox')
  return typeboxPromise
}

/** JSON Schema（OpenAI 工具参数）→ TypeBox TSchema（pi 参数验证用 typebox Compile） */
export function jsonSchemaToTypeBox(
  schema: Record<string, unknown> | undefined,
  Type: typeof import('typebox')['Type']
): TSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return Type.Object({})
  const s = schema as {
    type?: string
    description?: string
    enum?: unknown[]
    items?: Record<string, unknown>
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
    additionalProperties?: boolean | Record<string, unknown>
  }
  const descOpt = s.description ? { description: s.description } : undefined

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return Type.Union(s.enum.map((v) => Type.Literal(v as string | number | boolean)))
  }
  switch (s.type) {
    case 'string':
      return Type.String(descOpt)
    case 'number':
      return Type.Number(descOpt)
    case 'integer':
      return Type.Integer(descOpt)
    case 'boolean':
      return Type.Boolean(descOpt)
    case 'null':
      return Type.Null()
    case 'array':
      return Type.Array(s.items ? jsonSchemaToTypeBox(s.items, Type) : Type.Unknown(), descOpt)
    case 'object': {
      const props: Record<string, TSchema> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) props[k] = jsonSchemaToTypeBox(v, Type)
      return Type.Object(props, {
        ...descOpt,
        required: s.required ?? []
      })
    }
    default:
      return Type.Unknown()
  }
}

/** 工具规格（与 renderer 工具一致的契约：入参对象 → 返回文本） */
export interface PlainToolSpec {
  name: string
  label?: string
  description: string
  /** OpenAI 格式 JSON Schema 参数定义 */
  parameters: Record<string, unknown>
  /** 返回文本；或 {text, details} 以便携带附加信息（如撤销备份 id） */
  execute: (args: Record<string, unknown>, meta: { toolCallId: string }) => Promise<string | { text: string; details?: Record<string, unknown> }>
}

/** 包装成 pi ToolDefinition（Type 由调用方注入，避免模块级动态依赖） */
export function makePiTool(
  spec: PlainToolSpec,
  Type: typeof import('typebox')['Type']
): ToolDefinition {
  return {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: jsonSchemaToTypeBox(spec.parameters, Type),
    execute: async (toolCallId, params, _signal, _onUpdate) => {
      const res = await spec.execute(params as Record<string, unknown>, { toolCallId })
      if (typeof res === 'string') {
        return { content: [{ type: 'text', text: res }], details: {} }
      }
      return {
        content: [{ type: 'text', text: res.text }],
        details: res.details ?? {}
      }
    }
  }
}
