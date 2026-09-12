// 知识库工具：参数 schema + 输出格式化（纯数据/纯函数，主进程与渲染层双侧共享，禁止引用 window）。
// 从 src/renderer/src/tools/KnowledgeSearchTool 与 KnowledgeReadTool 抽离，
// 消除 main → renderer 跨构建图 import（分析文档 R4）。两边统一引用本文件，避免 spec/prompt/format 被两份构建各编一次。

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge_search'
export const KNOWLEDGE_READ_TOOL_NAME = 'knowledge_read'

export const KNOWLEDGE_SEARCH_DESCRIPTION_BASE =
  'Search the user-attached local knowledge base (BM25 keyword retrieval). ' +
  'Returns a catalog of matching chunk titles (document name, chunk index, relevance score) PLUS the full text of the single most relevant chunk, auto-attached at the end. ' +
  'Use it whenever the user question may be answered by their documents. ' +
  'The auto-attached top chunk is already the best hit — do NOT call knowledge_read for it. ' +
  'Only call knowledge_read with docName+ordinal pairs when you need the body of the OTHER catalog entries. ' +
  'Target library is selected via the optional kb parameter — its enum lists every existing knowledge base (single source of truth).'

export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  'knowledge_search 会在返回「标题目录」的同时，自动把相关度最高的那一块的完整正文附在末尾——所以一次检索通常就够用，不必再为它调用 knowledge_read。',
  '只有当你要读的正文不在目录末尾附带的那一块里时，才用 knowledge_read 传对应的 docName 与 ordinal 去取。',
  '构造查询词时优先使用文档标题、章节名或领域关键词；BM25 是字面关键词匹配，同义改述可能漏检，必要时换词重搜。',
  '若目录里第一条的相关度明显高于其余（且它不是你需要的块），说明换词重搜往往比顺着目录读更省事。',
]

export const KNOWLEDGE_READ_DESCRIPTION_BASE =
  'Read the FULL text of specific knowledge-base chunks selected from a previous knowledge_search catalog. ' +
  'Pass the docName and ordinal (chunk index, 0-based as shown as "第N块" minus 1) for each chunk you want. ' +
  'Returns the complete text of each matched chunk.'

export const KNOWLEDGE_READ_GUIDELINES: string[] = [
  'knowledge_read 的入参来自 knowledge_search 目录：docName 必须与目录显示完全一致，「第N块」换算成 ordinal = N-1（0 起始）。',
  '单次最多读取 8 块；只读取与当前问题真正相关的块，不要为保险起见整批拉取。',
]

export interface KnowledgeSearchInput {
  query: string
  limit?: number
  kb?: string
}

export interface KnowledgeBaseRef {
  id: string
  name: string
}

export interface KnowledgeChunkRef {
  docName: string
  ordinal: number
}

export interface KnowledgeSearchHit {
  docName: string
  ordinal: number
  title?: string
  text: string
  score: number
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[]
  lowConfidence?: boolean
  error?: string
}

export interface KnowledgeBaseInfo {
  name: string
  docs: string[]
}

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

export function formatKnowledgeCatalog(r: KnowledgeSearchResult): string {
  if (r.error && !r.hits.length) return `检索失败：${r.error}`
  if (!r.hits.length) return '知识库未命中任何内容。'
  const catalog = r.hits
    .map((h, i) => `[${i + 1}] ${h.title || '（无标题）'} · ${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}`)
    .join('\n')
  return `${catalog}\n（以上为标题目录，按相关度降序。第 [1] 条的完整正文已自动附在下方；如需其他条的正文，再用 knowledge_read 传对应 docName 与 ordinal。）`
}

interface KnowledgeReadResult {
  hits: Array<{ docName: string; ordinal: number; title?: string; text: string }>
  error?: string
}

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

export function parseChunkRefs(raw: unknown): KnowledgeChunkRef[] {
  const arr = Array.isArray(raw) ? raw : []
  return arr
    .map((r) => ({ docName: String((r as Record<string, unknown>)?.docName ?? ''), ordinal: Number((r as Record<string, unknown>)?.ordinal) }))
    .filter(r => r.docName && Number.isInteger(r.ordinal))
}

export function formatKnowledgeChunks(r: KnowledgeReadResult): string {
  if (r.error && !r.hits.length) return `读取失败：${r.error}`
  if (!r.hits.length) return '没有匹配到任何块（文档名或块号不存在，请对照目录重试）。'
  return r.hits
    .map(h => `【${h.title || '（无标题）'}】(${h.docName} · 第${h.ordinal + 1}块)\n${h.text}`)
    .join('\n--------------------\n')
}
