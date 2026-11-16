// 知识库工具：参数 schema + 输出格式化（纯数据/纯函数，主进程与渲染层双侧共享，禁止引用 window）。
// 从 src/renderer/src/tools/KnowledgeSearchTool 与 KnowledgeReadTool 抽离，
// 消除 main → renderer 跨构建图 import（分析文档 R4）。两边统一引用本文件，避免 spec/prompt/format 被两份构建各编一次。
import type { KnowledgeHit } from '../types'

export const KNOWLEDGE_LIST_TOOL_NAME = 'knowledge_list'
export const KNOWLEDGE_OVERVIEW_TOOL_NAME = 'knowledge_overview'
export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge_search'
export const KNOWLEDGE_READ_TOOL_NAME = 'knowledge_read'

/** 工具三目录条数：默认 3 条、上限 5 条；工具四一次能读的块编号也由上限决定。
    提示词、参数规格与服务端截断共用这一份，避免数字各写一遍后漂移。 */
export const KNOWLEDGE_TOOL_TOP_K_DEFAULT = 3
export const KNOWLEDGE_TOOL_TOP_K_MAX = 5

export const KNOWLEDGE_SEARCH_DESCRIPTION_BASE =
  'Search ONLY the knowledge base selected by knowledge_overview — the code layer injects the library, so never pass a library name or id. ' +
  'Optionally pass docId (a D-number from the overview document list) to search INSIDE that one document first; ' +
  'if it has no hit, the code layer automatically falls back to the whole library. ' +
  'Retrieval is BM25 lexical keyword matching (no embeddings, so paraphrases may miss). ' +
  'The catalog lists only chunk ids (C1, C2 ...), the chunk title and matched terms — no library names, scores or excerpts. ' +
  'The full text of the top-ranked chunk is auto-attached at the end: if it answers the question, STOP here and do NOT call knowledge_read. ' +
  'knowledge_read is on-demand ONLY — use it solely when you need the full text of a lower-ranked chunk. ' +
  'You MUST call knowledge_list then knowledge_overview first; otherwise this call is rejected.'

export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  '四个工具不要求走完：必走的是 knowledge_list → knowledge_overview → knowledge_search。knowledge_read 是按需的，不是第四步必做。',
  '检索范围由代码层按会话注入，不要自己传库名，也不要逐库试错。',
  '若 knowledge_overview 里锁定了某文档，把它的 D 编号传给 docId 可先在该文档内检索；该文档无命中时代码层自动回退整库，不必换参数重试。',
  '排名最高那一块的完整正文会自动附在目录末尾。若它已能回答问题，直接回答即可，不要再调 knowledge_read——绝不要为相关度低的其余块重复读取。',
  '只有当你判断第一块正文不足、且需要某个较低排名块的完整正文时，才用 knowledge_read 传它的 C 编号；一次只读需要的那一块。',
  '目录每条只有块编号 C、块标题与命中词，用于判断该不该读；排序按融合排名降序，排在前面的优先。',
  '构造查询词时只从用户问题里抽内容词：章节名、领域术语、代码标识符等正文里真会出现的词；库名、文档名、文件名不是检索词（检索只匹配块正文与块标题）。字面词法匹配，同义改述可能漏检——中文文档换中文词、代码术语换英文标识符再试一次。',
  '查询内容本身是命令、API 调用、报错或配置项时，整条原样传入，保留词序与 --flag / -m 这类参数，不要拆成零散关键词；检索对相邻词对加权，打乱词序或删参数会丢信号。',
  'query 一般只传 2–6 个关键词，不要原样转述整句提问；长查询掺进低信息量词会把所有块分数一起抬高，中文长句还会切出跨词假词。例外的整条命令按上一条处理。',
  '查询词全是常见词时会返回低置信结果并标记，此时直接换更有区分度的词，不要反复用同一批词重搜。',
  '构造 query 前先 knowledge_list 选库，再 knowledge_overview 取文档名列表；只有需要选词参考时才传 D 编号展开单个文档的关键词与概括。',
]

export const KNOWLEDGE_LIST_DESCRIPTION =
  'List every local knowledge base by name. Call this FIRST whenever a question may need the user documents. ' +
  'The library number is handled by the code layer — you only need the name. ' +
  'Then call knowledge_overview with the chosen name. Calling this tool again clears the selection.'

export const KNOWLEDGE_LIST_GUIDELINES: string[] = [
  '要用知识库时先调 knowledge_list 拿到全部库名，据此判断哪些库可能相关；库名不是检索词，不要写进 query。',
  '再用 knowledge_overview 选中相关库、取文档名列表，最后用 knowledge_search 检索；选库结果由代码层记住，后续检索只在已选库内进行。再次调用本工具会清空已选库。',
]

export const KNOWLEDGE_OVERVIEW_DESCRIPTION =
  'Select one knowledge base by exact name from knowledge_list and return its DOCUMENT NAME list, ' +
  'each with a short D-number (D1, D2 ...). By default no keywords or summaries are included. ' +
  'The D-number maps to the real document id in the code layer — pass it as docId to knowledge_search ' +
  'to search inside that document, or back to this tool to expand that ONE document\'s keywords and summary. ' +
  'Use cursor to page. Repeated calls with a different kb switch libraries.'

export const KNOWLEDGE_OVERVIEW_GUIDELINES: string[] = [
  'knowledge_overview 的 kb 用 knowledge_list 返回的库名原样传入，一次只选一个库；默认只返回文档名 + D 编号，不含关键词与概括。',
  '用文档名判断哪个文档可能相关；需要它的关键词/概括来构造查询词时，才传该文档的 D 编号再次调用本工具单独展开，默认不要展开任何文档。',
  '把 D 编号传给 knowledge_search 的 docId 可只在选中文档内检索，无命中会自动回退整库。',
  '文档多时按 cursor 翻页，别一次读完；换库后旧 D 编号与块编号立即失效，需要重新取列表与检索。',
]

/** 用户为知识库手写的概括（由知识库界面维护，随知识库文件保存）。
    id 是库文件的固定编号：改名不变、删库才失效，后续工具只认它。 */
export interface KnowledgeBaseSummary {
  id: string
  name: string
  summary: string
  docCount?: number
}

/** 文档导航数据：默认只输出文档名 + D 编号，关键词/概括按需展开。 */
export interface KnowledgeDocCard {
  docId: string
  docName: string
  /** 一句定位，缺省时由代码层回退为文档名或首块摘要 */
  summaryOneLine?: string
  /** 3–8 个查询词，缺省时由代码层回退抽取 */
  keywords?: string[]
  chunkCount?: number
}

/** 工具二的返回预算：单页最多 20 个文档、正文总长 ≤1500 字，超出用 cursor 翻页。 */
export const KNOWLEDGE_CARD_PAGE_SIZE = 20
export const KNOWLEDGE_CARD_TEXT_BUDGET = 1500
/** 文档级一句定位的展示上限 */
export const KNOWLEDGE_ONELINE_MAX = 60

/** 知识库工具的执行器：主进程传 RPC，渲染层传进程通道；本文件因此不必依赖 window。 */
export type KnowledgeToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>

/** 与渲染层注册中心的工具定义结构一致，但不引用它，避免主进程工程被拉进渲染层依赖。 */
export interface KnowledgeToolDefinition {
  name: string
  label?: string
  description: string
  promptGuidelines?: string[]
  parameters: Record<string, unknown>
}

/** 规格工厂的返回类型：四个工厂都给出中文标签，注册时不必再判空。 */
export interface KnowledgeToolSpec extends KnowledgeToolDefinition {
  label: string
}

/** 工具一输出：只有库名。库编号由代码层记录，概括与文档数不进上下文。 */
export function formatKnowledgeBaseList(libs: readonly KnowledgeBaseSummary[]): string {
  if (libs.length === 0) return '本机尚未创建任何知识库。'
  // 只给库名：编号由代码层记住，概括与文档数不进上下文，选库靠库名即可。
  return libs.map((l, i) => `[${i + 1}] ${l.name.replace(/\s+/g, ' ').trim()}`).join('\n')
}

/** 工具二默认输出：只给文档名 + D 编号，一句话定位与关键词都不进上下文。
    D 编号是本页全局序号（D1、D2…），由执行层映射回真实 docId；文档多时用 cursor 翻页。 */
export function formatKnowledgeDocCards(
  _lib: { name: string; id: string },
  cards: readonly KnowledgeDocCard[],
  cursor: number,
  pageSize: number = KNOWLEDGE_CARD_PAGE_SIZE,
  _budget: number = KNOWLEDGE_CARD_TEXT_BUDGET
): string {
  const start = Number.isInteger(cursor) && cursor > 0 ? cursor : 0
  const page = cards.slice(start, start + pageSize)
  if (page.length === 0) return '（该库没有可用文档）'
  const lines = page.map((c, k) => `D${start + k + 1} · ${c.docName.replace(/\s+/g, ' ').trim()}`)
  const shown = start + page.length
  const more = shown < cards.length ? `\n（还有 ${cards.length - shown} 个文档，用 cursor=${shown} 继续。）` : ''
  return lines.join('\n') + more
}

/** 单文档展开：传 docId（D 编号）时按需返回该文档的关键词与完整概括，常路径不触发。 */
export function formatKnowledgeDocSummary(libName: string, doc: KnowledgeDocCard, full: string): string {
  const name = doc.docName.replace(/\s+/g, ' ').trim()
  const kw = (doc.keywords ?? []).map(w => String(w).trim()).filter(Boolean)
  const body = (full ?? '').replace(/\s+/g, ' ').trim()
  const head = `${name}（库「${libName}」）`
  const kwLine = kw.length ? `\n关键词：${kw.join('、')}` : ''
  // 概括与关键词重复时不重复打印：很多库 fullSummary 就是关键词的另一种拼法。
  const bodyLine = body && body !== kw.join('、') ? `\n概括：${body}` : ''
  return head + kwLine + bodyLine
}

export const KNOWLEDGE_READ_DESCRIPTION_BASE =
  'On-demand ONLY. Read the FULL text of a chunk from the MOST RECENT knowledge_search catalog, by its chunk id (C1, C2 ...). ' +
  'The top-ranked chunk is ALREADY attached in full to the search result — do NOT read it again. ' +
  'Only call this when the attached chunk is insufficient and you specifically need a lower-ranked chunk; ' +
  'do NOT re-read low-relevance chunks just because they appear in the catalog. ' +
  'If the attached chunk answers the question, finish without calling this tool.'

export const KNOWLEDGE_READ_GUIDELINES: string[] = [
  'knowledge_read 是按需工具，不是必走的第四步：排名最高那块正文已随 knowledge_search 返回，够用就直接用它回答，不要调本工具。',
  '只有第一块正文不足、且明确需要某个较低排名块的完整正文时才调用，传它的 C 编号；不要为了"看全"去读相关度低的其他块，那是重复且浪费上下文。',
  '块编号只接受最近一次 knowledge_search 目录里的 C 编号，不要自己拼；跳过 list / overview / search、拿旧目录编号、读已选范围之外的库都会被拒绝。',
  `单次最多可传 ${KNOWLEDGE_TOOL_TOP_K_MAX} 个块编号，但按需建议一次只读真正需要的那一块。`,
]

export interface KnowledgeSearchInput {
  query: string
  limit?: number
}

/** 目录命中的字段与主进程检索结果完全共用，不在这里再抄一份。 */
export type KnowledgeSearchHit = KnowledgeHit

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[]
  lowConfidence?: boolean
  error?: string
}

/** 工具三：检索范围由代码层按会话注入，模型不传库名。 */
export function createKnowledgeSearchSpec(): KnowledgeToolSpec {
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
            '(section names, domain terms, code identifiers, or any words that actually appear in the chunk text); ' +
            'drop filler words such as how / should / what / please. ' +
            'Never include library names, document names or file names: retrieval matches only chunk text and chunk titles, ' +
            'and those names are used for choosing a library and for knowledge_read refs instead. ' +
            'Exception: when the question is about an exact command, API call, error message or config key, pass that string verbatim — ' +
            'keep its word order and flags such as --amend / -m. Retrieval is lexical and gives a word-order bonus when adjacent query words ' +
            'appear adjacently in a chunk, so shuffling terms or stripping flags loses signal, and paraphrases may miss.'
        },
        docId: {
          type: 'string',
          description: 'Optional document id from the knowledge_overview card catalog. When set, search inside that document first; the code layer falls back to the whole library if it has no hit.'
        },
        limit: { type: 'number', description: `Max number of merged entries to return. Default ${KNOWLEDGE_TOOL_TOP_K_DEFAULT}, max ${KNOWLEDGE_TOOL_TOP_K_MAX}.` }
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
/** 目录每行的内容摘要长度：全文由 knowledge_read 取，目录只给够判断的片段，避免一次灌进几千字。 */
export const CATALOG_EXCERPT_SHOW = 120

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
  // 极简目录：块编号 + 块标题 + 命中词。库编号/库名/文档名/相关度/摘要都不进上下文——
  // 来源在自动附的第一块正文标题里给出，其余块要读全文才带文档名（工具四）。
  // 相关度等字段仍保留在对象里供内部排序，只是不打印。
  const lines = r.hits.map((h, i) => {
    const cid = h.chunkId ?? `C${i + 1}`
    const title = (h.title ?? '').replace(/\s+/g, ' ').trim() || '（无标题）'
    const m = (h.matched ?? []).slice(0, CATALOG_MATCHED_SHOW)
    const hitLabel = m.length > 0 ? ` · 命中 ${m.join('/')}` : ''
    const attached = i === 0 ? '（正文见下）' : ''
    return `[${i + 1}] ${cid} ${title}${hitLabel}${attached}`
  })
  const rest = r.hits.slice(1).map((h, i) => h.chunkId ?? `C${i + 2}`)
  const tail = rest.length > 0
    ? `\n（按融合排名降序；其余用 knowledge_read 传块编号读全文。）`
    : ''
  const head = r.lowConfidence ? '⚠️ 低置信检索，引用前请核对原文或换关键词重搜。\n' : ''
  return head + lines.join('\n') + tail
}

interface KnowledgeReadResult {
  hits: Array<{
    docName: string
    ordinal: number
    title?: string
    text: string
    kbName?: string
    chunkId?: string
    kbId?: string
    kbType?: string
  }>
  error?: string
}

/** 工具四：按需读最近一次目录里某块的正文，库由代码层按块编号注入。 */
export function createKnowledgeReadSpec(): KnowledgeToolSpec {
  return {
    name: KNOWLEDGE_READ_TOOL_NAME,
    label: '知识库读取块',
    description: KNOWLEDGE_READ_DESCRIPTION_BASE,
    promptGuidelines: KNOWLEDGE_READ_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        chunkIds: {
          type: 'array',
          description: `Chunk ids exactly as shown in the latest knowledge_search catalog (C1, C2 ...). Max ${KNOWLEDGE_TOOL_TOP_K_MAX} per call.`,
          items: { type: 'string' }
        }
      },
      required: ['chunkIds']
    }
  }
}

export function formatKnowledgeChunks(r: KnowledgeReadResult): string {
  if (r.error && !r.hits.length) return `读取失败：${r.error}`
  if (!r.hits.length) return '没有匹配到任何块（块编号不存在，请对照最近一次检索目录重试）。'
  return r.hits
    .map(h => `【${h.chunkId ?? '?'}】${h.docName} · 第${h.ordinal}块\n${h.text}`)
    .join('\n--------------------\n')
}

/** 工具一：列出本机全部知识库，只给名字与概括状态，库再多也不占上下文。 */
export function createKnowledgeListSpec(): KnowledgeToolSpec {
  return {
    name: KNOWLEDGE_LIST_TOOL_NAME,
    label: '知识库列表',
    description: KNOWLEDGE_LIST_DESCRIPTION,
    promptGuidelines: KNOWLEDGE_LIST_GUIDELINES,
    parameters: { type: 'object', properties: {} }
  }
}

/** 工具二：选中一个库并返回文档名 + D 编号；传 D 编号按需展开单个文档。 */
export function createKnowledgeOverviewSpec(kbNames?: string[], kbIds?: string[]): KnowledgeToolSpec {
  // 同名库会让枚举出现重复值，去重后再交给参数校验。
  const choices = [...new Set([...(kbNames ?? []), ...(kbIds ?? [])])]
  const kbProp: Record<string, unknown> = {
    type: 'string',
    description: 'Library name exactly as returned by knowledge_list.',
    ...(choices.length > 0 ? { enum: choices } : {})
  }
  return {
    name: KNOWLEDGE_OVERVIEW_TOOL_NAME,
    label: '知识库文档列表',
    description: KNOWLEDGE_OVERVIEW_DESCRIPTION,
    promptGuidelines: KNOWLEDGE_OVERVIEW_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        kb: kbProp,
        docId: { type: 'string', description: 'Optional D-number (D1, D2 ...) from the document list: expand that ONE document\'s keywords and summary. Default OFF — do not pass it in the normal path.' },
        cursor: { type: 'number', description: 'Pagination offset for the document name list. Use the cursor hint from the previous page. Default 0.' }
      },
      required: ['kb']
    }
  }
}
