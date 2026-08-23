// 知识库读块工具：参数 schema + 输出格式化（纯数据/纯函数，双侧可导入，禁止引用 window）
import { KNOWLEDGE_READ_TOOL_NAME } from './constants'
import { KNOWLEDGE_READ_DESCRIPTION_BASE, KNOWLEDGE_READ_GUIDELINES } from './prompt'
import type { KnowledgeChunkRef } from '../KnowledgeSearchTool'

/** 读块结果的最小结构（主进程 exec.knowledgeRead 返回不含 score） */
interface KnowledgeReadResult {
  hits: Array<{ docName: string; ordinal: number; title?: string; text: string }>
  error?: string
}

/** 工具定义的纯数据部分（结构兼容 pi PlainToolSpec 与 OpenAI function schema） */
export function createKnowledgeReadSpec(kbNames?: string[]): {
  name: string
  label: string
  description: string
  promptGuidelines?: string[]
  parameters: Record<string, unknown>
} {
  const kbProp: Record<string, unknown> = kbNames && kbNames.length > 0
    ? { type: 'string', description: 'Target knowledge base name. Omit to use the bound library (or the only existing one).', enum: kbNames }
    : { type: 'string', description: 'Target knowledge base name.' }
  return {
    name: KNOWLEDGE_READ_TOOL_NAME,
    label: '知识库读取块',
    description: KNOWLEDGE_READ_DESCRIPTION_BASE,
    promptGuidelines: KNOWLEDGE_READ_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        kb: kbProp,
        refs: {
          type: 'array',
          description: 'Chunks to read, e.g. [{"docName":"部署手册","ordinal":3}]. Max 8 per call.',
          items: {
            type: 'object',
            properties: {
              docName: { type: 'string', description: 'Document name exactly as shown in the catalog.' },
              ordinal: { type: 'number', description: 'Chunk index (第N块 → ordinal = N-1).' }
            },
            required: ['docName', 'ordinal']
          }
        }
      },
      required: ['refs']
    }
  }
}

/** 解析模型传入的 refs（容错：过滤缺 docName / 非整数 ordinal 的项） */
export function parseChunkRefs(raw: unknown): KnowledgeChunkRef[] {
  const arr = Array.isArray(raw) ? raw : []
  return arr
    .map((r) => ({ docName: String((r as Record<string, unknown>)?.docName ?? ''), ordinal: Number((r as Record<string, unknown>)?.ordinal) }))
    .filter(r => r.docName && Number.isInteger(r.ordinal))
}

/** 块正文输出格式化（两阶段第二段的全部可见输出） */
export function formatKnowledgeChunks(r: KnowledgeReadResult): string {
  if (r.error && !r.hits.length) return `读取失败：${r.error}`
  if (!r.hits.length) return '没有匹配到任何块（文档名或块号不存在，请对照目录重试）。'
  return r.hits
    .map(h => `【${h.title || '（无标题）'}】(${h.docName} · 第${h.ordinal + 1}块)\n${h.text}`)
    .join('\n--------------------\n')
}
