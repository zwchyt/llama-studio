// 知识库检索工具：参数 schema + 输出格式化（纯数据/纯函数，渲染层与主进程双侧可导入，禁止引用 window）
import { KNOWLEDGE_SEARCH_TOOL_NAME } from './constants'
import { KNOWLEDGE_SEARCH_DESCRIPTION_BASE, KNOWLEDGE_SEARCH_GUIDELINES } from './prompt'
import type { KnowledgeSearchResult } from './types'

/** 工具定义的纯数据部分（结构兼容 pi PlainToolSpec 与 OpenAI function schema）
 *  kbNames：本机全部知识库名列表 → 以 JSON Schema enum 注入 kb 参数（代码级库清单，唯一来源） */
export function createKnowledgeSearchSpec(kbNames?: string[]): {
  name: string
  label: string
  description: string
  promptGuidelines?: string[]
  parameters: Record<string, unknown>
} {
  const kbProp: Record<string, unknown> = kbNames && kbNames.length > 0
    ? { type: 'string', description: 'Target knowledge base name. Omit to search the bound library (or the only existing one).', enum: kbNames }
    : { type: 'string', description: 'Target knowledge base name.' }
  return {
    name: KNOWLEDGE_SEARCH_TOOL_NAME,
    label: '知识库检索',
    description: KNOWLEDGE_SEARCH_DESCRIPTION_BASE,
    promptGuidelines: KNOWLEDGE_SEARCH_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Keywords from the documents work best.' },
        limit: { type: 'number', description: 'Max number of title entries to return. Default 8, max 12.' },
        kb: kbProp
      },
      required: ['query']
    }
  }
}

/** 目录输出格式化（两阶段第一段的全部可见输出） */
export function formatKnowledgeCatalog(r: KnowledgeSearchResult): string {
  if (r.error && !r.hits.length) return `检索失败：${r.error}`
  if (!r.hits.length) return '知识库未命中任何内容。'
  const catalog = r.hits
    .map((h, i) => `[${i + 1}] ${h.title || '（无标题）'} · ${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}`)
    .join('\n')
  return `${catalog}\n（以上为标题目录。需要某块完整内容时，调用 knowledge_read 并传对应的 docName 与 ordinal。）`
}
