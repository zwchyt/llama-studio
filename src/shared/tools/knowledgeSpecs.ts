// 知识库工具：参数 schema + 输出格式化（纯数据/纯函数，主进程与渲染层双侧共享，禁止引用 window）。
// 从 src/renderer/src/tools/KnowledgeSearchTool 与 KnowledgeReadTool 抽离，
// 消除 main → renderer 跨构建图 import（分析文档 R4）。两边统一引用本文件，避免 spec/prompt/format 被两份构建各编一次。

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge_search'
export const KNOWLEDGE_READ_TOOL_NAME = 'knowledge_read'

export const KNOWLEDGE_SEARCH_DESCRIPTION_BASE =
  'Search ALL local knowledge bases at once (BM25 lexical keyword retrieval — no embeddings, so paraphrases may miss) ' +
  'and return a catalog merged by cross-library rank fusion. ' +
  'Each catalog entry is labeled with its source library (kb), document name and chunk index. ' +
  'Entries are ordered by fusion rank. The 相关度 value on each line is that library\'s own BM25 score: ' +
  'it is comparable only within one library and NOT across libraries, so it does not necessarily decrease down the list — ' +
  'judge by rank order, the word-order match marker (词序吻合) and the matched terms, never by comparing two numbers from different libraries. ' +
  'The full text of the single most relevant chunk is auto-attached at the end. ' +
  'Use it whenever the user question may be answered by their documents. ' +
  'The auto-attached top chunk is already the best hit — do NOT call knowledge_read for it. ' +
  'Only call knowledge_read with docName+ordinal pairs when you need the body of the OTHER catalog entries. ' +
  'Pass the optional kb parameter ONLY to narrow the search to one specific library; omit it to search every library (recommended).'

export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  'knowledge_search 一次调用即检索全部知识库并合并排序，目录每条都标注来源库名——不要为「选库」单独发起多次调用，也不要逐库排除。',
  'knowledge_search 会在返回「标题目录」的同时，自动把相关度最高的那一块的完整正文附在末尾——所以一次检索通常就够用，不必再为它调用 knowledge_read。',
  '只有当你要读的正文不在目录末尾附带的那一块里时，才用 knowledge_read 传对应条目的 kb（库名）、docName 与 ordinal 去取。',
  '构造查询词时优先使用文档标题、章节名或领域关键词；检索是字面词法匹配（没有向量/语义通道），同义改述可能漏检——中文文档换中文词、代码术语换英文标识符再试一次。',
  '查询内容本身是命令、API 调用、报错或配置项时，把它整条原样传入，保留词序与 --flag / -m 这类参数，不要拆成零散关键词。检索对「相邻词对」加权：整条命令原样出现会显著加分，打乱词序或删掉参数恰好丢掉这部分信号（实测「git commit --amend -m」拆成关键词后，讲 Mermaid gitGraph 语法的块会靠 commit 词频排到正确的块前面）。',
  'query 一般只传 2–6 个关键词，不要原样转述用户的整句提问。长查询会掺进「如何/应该/什么」这类低信息量词，把所有块的分数一起抬高，真正相关的块反而拉不开差距；中文长句还会被切成大量跨词假词（「如何配置」→「何配」）造成误匹配。正确做法是自己从问题里抽出最有区分度的名词 / 标识符再检索，必要时换关键词多搜一次，而不是把问题原样丢进来。（例外：问题本身就是一条命令 / API / 报错原文时，按上一条整条传入。）',
  '目录按跨库融合排名降序，每行还标了「词序吻合 X%」与命中词——判断该读哪条请优先看排名、词序吻合度和命中词。行尾的相关度是各库内部的 BM25 分，跨库不可比、列表里不一定递减，不要拿两个不同库的条目去比这个数字。',
  '查询词全是常见词（在库里几乎每个块都出现）时，检索会返回一批分数很低的命中并标记低置信，且不给建议关键词——这种情况直接换更有区分度的词，不要反复用同一批词重搜。',
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
  /** 词序吻合度（0-1）：查询里相邻的词在块里也相邻出现的比例。
      BM25 是词袋模型不认词序，这个值是「整条命令原样出现」与「碰巧重复同一个词」的区分依据。 */
  adjacent?: number
  /** 跨库融合权重（0-1），由各库 search() 计算，mergeKbHits 用它给排名分加权 */
  fusionWeight?: number
  /** 跨库融合后的最终得分（RRF × fusionWeight），由 mergeKbHits 写入 */
  fusionScore?: number
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
            'Search query, NOT the user\'s whole question. Usually pass 2-6 distinctive terms extracted from the question ' +
            '(document titles, section names, domain terms, code identifiers); drop filler words such as how / should / what / please. ' +
            'Exception: when the question is about an exact command, API call, error message or config key, pass that string verbatim — ' +
            'keep its word order and flags such as --amend / -m. Retrieval is lexical and gives a word-order bonus when adjacent query words ' +
            'appear adjacently in a chunk, so shuffling terms or stripping flags loses signal, and paraphrases may miss.'
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
    效果：某库对本次查询其实没有实质命中时，返回的是「未命中」而不是硬凑出来的弱结果。
    例外：查询词平均 idf 过低（词本身没有区分度）时全库得分都会低于此值，
    这一刀会把唯一相关的库也清空（实测：拿文档名当查询）。此时 search() 会降级为纯相对阈值，
    详见 knowledgeService 里 LOW_IDF_AVG / noDiscrimination 处注释。 */
export const MIN_HIT_SCORE = 1.0
/** 目录行里展示的命中词个数（已按 idf 降序）：太多会让目录行变长、白耗 token */
export const CATALOG_MATCHED_SHOW = 4

/** RRF（倒数排名融合）的平滑常数：第 r 名贡献 1/(RRF_K + r)。
    取 20 是常用值——排名靠前的名次差异被放大，靠后的名次差异迅速抹平。 */
export const RRF_K = 20

/** 合并多库检索结果：按「跨库融合分」降序 → 全局相对剪枝 → 截断。
    工具侧与知识库界面共用，保证「跨库搜索」在两处行为一致。

    为什么不再直接比 BM25 分：每个库的 idf 是各自算的，只依赖本库的块数 N 与文档频率 df，
    所以同一个词在不同库里的 idf 可能相差几十倍。实测本机数据：词 `git` 在「Mermaid渲染格式规范」
    库里 idf=3.03（30 块、只有 1 块提到），在「Github相关知识」库里 idf=0.09（5 块、5 块全提到），
    相差 35 倍；再叠加 BM25 的长度归一化（两库平均块长 47.5 vs 99.8 词），
    直接把两库的裸分排序等于拿摄氏度和华氏度比大小——正确命中会被系统性压下去。

    RRF 只用名次、不用分数量纲，天然规避这个问题：每个库各自出排名，第 r 名贡献 1/(RRF_K+r)。
    再乘上库内算好的 fusionWeight（命中查询词的比例 × 库级质量软衰减），
    让「只命中一两个词」和「整库都只有弱命中」的条目自然沉底。 */
export function mergeKbHits<T extends { score: number; fusionWeight?: number; fusionScore?: number }>(
  per: readonly { hits: T[] }[], limit: number
): T[] {
  const fused = per.flatMap(r => r.hits.map((h, rank) => ({ h, fusion: (h.fusionWeight ?? 1) / (RRF_K + rank) })))
  fused.sort((a, b) => b.fusion - a.fusion)
  // 全局剪枝：各库内部那次是以「本库最高分」为基准的，弱库的弱条目会被漏下来。
  // 这里以融合分的最高值为基准再砍一刀——注意不再掺 MIN_HIT_SCORE：
  // 它是绝对分尺度上的门槛，而融合分是无量纲的，混用会把阈值算成另一回事。
  // 绝对下限并没有丢：每个库内部的 search() 已经逐条卡过 MIN_HIT_SCORE。
  const globalBest = fused[0]?.fusion ?? 0
  const cutoff = globalBest * RELATIVE_NOISE_RATIO
  return fused
    .filter(f => f.fusion >= cutoff)
    .slice(0, limit)
    .map(f => {
      f.h.fusionScore = Math.round(f.fusion * 10000) / 10000
      return f.h
    })
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
      // 词序吻合标记：BM25 只看词不看词序，「整条命令原样出现」和「碰巧重复了同一个词」
      // 分数可能相近。这个词序比例是模型区分两者最直接的信号，比分数可靠。
      const seqLabel = (h.adjacent ?? 0) > 0 ? ` · 词序吻合 ${Math.round((h.adjacent ?? 0) * 100)}%` : ''
      return `[${i + 1}] ${h.title || '（无标题）'} · ${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}${seqLabel}${hitLabel}`
    })
    .join('\n')
  // 低置信标记放在目录「头部」而不是末尾：末尾的尾注很容易被模型跳过，
  // 头部则先于条目被读到，模型在读条目前就已经知道该对这批命中保持怀疑。
  const head = r.lowConfidence
    ? '⚠️ 低置信检索：以下条目可能只沾到部分查询词，引用前请先核对原文或换关键词重搜。\n'
    : ''
  // 排序口径必须写清楚：条目按「跨库融合分」排序，而显示的相关度是各库内部的 BM25 分，
  // 两者量纲不同，所以列表里的相关度不一定单调递减。不说清楚会让模型以为结果乱了。
  return `${head}${catalog}\n（以上为标题目录，按跨知识库融合排名降序。相关度是各库内部 BM25 分，只在同一个库内可比、跨库不可比，故不一定单调递减；判断该读哪条请优先看排名、词序吻合度与命中词。第 [1] 条的完整正文已自动附在下方；如需其他条的正文，再用 knowledge_read 传对应 kb、docName 与 ordinal。）`
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
