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
  'query 只传 2–6 个关键词，不要原样转述用户的整句提问。长查询会掺进「如何/应该/什么」这类低信息量词，把所有块的分数一起抬高，真正相关的块反而拉不开差距；中文长句还会被切成大量跨词假词（「如何配置」→「何配」）造成误匹配。正确做法是自己从问题里抽出最有区分度的名词 / 标识符再检索，必要时换关键词多搜一次，而不是把问题原样丢进来。',
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
  /** 本条实际命中的查询词（tokenize 后，按 idf 降序）：供目录行说明命中依据 */
  matched?: string[]
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
        query: {
          type: 'string',
          description:
            'Search keywords, NOT the question. Pass 2-6 distinctive terms extracted from the user question ' +
            '(document titles, section names, domain terms, code identifiers). Drop filler words such as how / should / what / please. ' +
            'BM25 is literal keyword matching: a full sentence adds low-information words that flatten the ranking and returns weaker hits.'
        },
        limit: { type: 'number', description: 'Max number of merged title entries to return. Default 8, max 12.' },
        kb: kbProp
      },
      required: ['query']
    }
  }
}

// ── 检索结果排序与剪枝策略 ──
// 放在共享模块里，让「主进程检索」与「工具侧跨库合并」用同一份实现，
// 避免两处各写一遍后漂移（曾经就出现过：界面加了全局剪枝、工具侧没加）。

/** 相对阈值：低于「最高分 × 此比例」的结果视为噪音。
    注意它只在「同一批结果内」成立——整批都弱时最高分自身很低，阈值随之形同虚设，
    所以必须配下面的绝对下限。 */
export const RELATIVE_NOISE_RATIO = 0.15
/** 绝对下限：低于此分一律丢弃，无论相对阈值多宽松。
    效果：某库对本次查询其实没有实质命中时，返回的是「未命中」而不是硬凑出来的弱结果。 */
export const MIN_HIT_SCORE = 1.0
/** 目录行里展示的命中词个数（已按 idf 降序）：太多会让目录行变长、白耗 token */
export const CATALOG_MATCHED_SHOW = 4

/** 合并多库检索结果：按分降序 → 全局相对剪枝 + 绝对下限 → 截断。
    工具侧与知识库界面共用，保证「跨库搜索」在两处行为一致。 */
export function mergeKbHits<T extends { score: number }>(per: readonly { hits: T[] }[], limit: number): T[] {
  const merged = per.flatMap(r => r.hits).sort((a, b) => b.score - a.score)
  // 全局剪枝：各库内部那次是以「本库最高分」为基准的——A 库 30 分、B 库 1.9 分时，
  // B 库以 1.9 为基准（阈值仅 0.285），只沾到一个常见词的块全被留下，
  // 合并进目录就成了「跟关键词毫无关系」的结果。以全局最高分为基准再砍一刀。
  const globalBest = merged[0]?.score ?? 0
  const cutoff = Math.max(globalBest * RELATIVE_NOISE_RATIO, MIN_HIT_SCORE)
  return merged.filter(h => h.score >= cutoff).slice(0, limit)
}

export function formatKnowledgeCatalog(r: KnowledgeSearchResult): string {
  if (r.error && !r.hits.length) return `检索失败：${r.error}`
  if (!r.hits.length) return '知识库未命中任何内容。'
  const catalog = r.hits
    .map((h, i) => {
      // 命中词：让模型看到「这条是靠什么命中的」——只看分数没法判断该不该继续读下一条。
      // 已按 idf 降序，只列前几个，避免目录行变长白耗 token。
      const m = (h.matched ?? []).slice(0, CATALOG_MATCHED_SHOW)
      const hitLabel = m.length > 0 ? ` · 命中 ${m.join('/')}` : ''
      return `[${i + 1}] ${h.title || '（无标题）'} · ${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}${hitLabel}`
    })
    .join('\n')
  // 低置信标记放在目录「头部」而不是末尾：末尾的尾注很容易被模型跳过，
  // 头部则先于条目被读到，模型在读条目前就已经知道该对这批命中保持怀疑。
  const head = r.lowConfidence
    ? '⚠️ 低置信检索：以下条目可能只沾到部分查询词，引用前请先核对原文或换关键词重搜。\n'
    : ''
  return `${head}${catalog}\n（以上为标题目录，跨全部知识库按相关度降序。第 [1] 条的完整正文已自动附在下方；如需其他条的正文，再用 knowledge_read 传对应 kb、docName 与 ordinal。）`
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
