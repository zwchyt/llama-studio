// 知识库工具：参数 schema + 输出格式化（纯数据/纯函数，主进程与渲染层双侧共享，禁止引用 window）。
// 从 src/renderer/src/tools/KnowledgeSearchTool 与 KnowledgeReadTool 抽离，
// 消除 main → renderer 跨构建图 import（分析文档 R4）。两边统一引用本文件，避免 spec/prompt/format 被两份构建各编一次。

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge_search'
export const KNOWLEDGE_READ_TOOL_NAME = 'knowledge_read'

export const KNOWLEDGE_SEARCH_DESCRIPTION_BASE =
  'Search ALL local knowledge bases at once (BM25 keyword retrieval) and return a merged, score-ranked catalog. ' +
  'Each catalog entry is labeled with its source library (kb), document name and chunk index. ' +
  'The full text of the single most relevant chunk is auto-attached at the end. ' +
  'Use it whenever the user question may be answered by their documents. ' +
  'The auto-attached top chunk is already the best hit — do NOT call knowledge_read for it. ' +
  'Only call knowledge_read with docName+ordinal pairs when you need the body of the OTHER catalog entries. ' +
  'Pass the optional kb parameter ONLY to narrow the search to one specific library; omit it to search every library (recommended).'

export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  'knowledge_search 一次调用即检索全部知识库并合并排序，目录每条都标注来源库名——不要为「选库」单独发起多次调用，也不要逐库排除。',
  'knowledge_search 会在返回「标题目录」的同时，自动把相关度最高的那一块的完整正文附在末尾——所以一次检索通常就够用，不必再为它调用 knowledge_read。',
  '只有当你要读的正文不在目录末尾附带的那一块里时，才用 knowledge_read 传对应条目的 kb（库名）、docName 与 ordinal 去取。',
  '构造查询词时优先使用文档标题、章节名或领域关键词；BM25 是字面关键词匹配，同义改述可能漏检——中文文档换中文词、代码术语换英文标识符再试一次。',
  '若目录里第一条的相关度明显高于其余（且它不是你需要的块），说明换词重搜往往比顺着目录读更省事。',
]

export const KNOWLEDGE_READ_DESCRIPTION_BASE =
  'Read the FULL text of specific knowledge-base chunks selected from a previous knowledge_search catalog. ' +
  'Entries may come from different libraries; each ref accepts an optional kb (library name as shown in the catalog). ' +
  'Pass docName and ordinal (chunk index, 0-based as shown as "第N块" minus 1) for each chunk you want. ' +
  'Returns the complete text of each matched chunk.'

export const KNOWLEDGE_READ_GUIDELINES: string[] = [
  'knowledge_read 的入参来自 knowledge_search 目录：docName 必须与目录显示完全一致，「第N块」换算成 ordinal = N-1（0 起始）。',
  '目录条目标注了来源库名时，refs 里带上对应的 kb 可以精确跨库读取；省略 kb 时若文档名在多个库中重名会被拒绝。',
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
  /** 来源库名（目录条目有标注时带上；省略则按 docName 在全部库中唯一定位） */
  kb?: string
}

export interface KnowledgeSearchHit {
  docName: string
  ordinal: number
  title?: string
  text: string
  score: number
  /** 来源知识库名（跨库合并检索时由服务端填充） */
  kbName?: string
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
    ? { type: 'string', description: 'Narrow the search to one library. Omit to search ALL libraries (recommended).', enum: kbNames }
    : { type: 'string', description: 'Target knowledge base name. Omit to search all libraries.' }
  return {
    name: KNOWLEDGE_SEARCH_TOOL_NAME,
    label: '知识库检索',
    description: KNOWLEDGE_SEARCH_DESCRIPTION_BASE,
    promptGuidelines: KNOWLEDGE_SEARCH_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Keywords from the documents work best.' },
        limit: { type: 'number', description: 'Max number of merged title entries to return. Default 8, max 12.' },
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
    .map((h, i) => `[${i + 1}] ${h.title || '（无标题）'} · ${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}`)
    .join('\n')
  return `${catalog}\n（以上为标题目录，跨全部知识库按相关度降序。第 [1] 条的完整正文已自动附在下方；如需其他条的正文，再用 knowledge_read 传对应 kb、docName 与 ordinal。）`
}

interface KnowledgeReadResult {
  hits: Array<{ docName: string; ordinal: number; title?: string; text: string; kbName?: string }>
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
    ? { type: 'string', description: 'Default library for refs that omit kb. Omit when every ref carries its own kb or docName is unique across libraries.', enum: kbNames }
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
          description: 'Chunks to read, e.g. [{"kb":"部署手册","docName":"回滚流程","ordinal":3}]. Max 8 per call.',
          items: {
            type: 'object',
            properties: {
              kb: { type: 'string', description: 'Source library name exactly as labeled in the catalog. Optional when unambiguous.' },
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
    .map((r) => {
      const o = r as Record<string, unknown>
      return {
        docName: String(o?.docName ?? ''),
        ordinal: Number(o?.ordinal),
        kb: typeof o?.kb === 'string' && o.kb.trim() ? o.kb.trim() : undefined
      }
    })
    .filter(r => r.docName && Number.isInteger(r.ordinal))
}

export function formatKnowledgeChunks(r: KnowledgeReadResult): string {
  if (r.error && !r.hits.length) return `读取失败：${r.error}`
  if (!r.hits.length) return '没有匹配到任何块（文档名或块号不存在，请对照目录重试）。'
  return r.hits
    .map(h => `【${h.title || '（无标题）'}】(${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块)\n${h.text}`)
    .join('\n--------------------\n')
}
