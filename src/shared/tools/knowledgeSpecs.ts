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
  'Search ONLY the knowledge bases already selected by knowledge_overview — the code layer injects their stable library ids, ' +
  'so you never pass a library name or id to this tool. Retrieval is BM25 lexical keyword matching (no embeddings, so paraphrases may miss). ' +
  'Results from the selected libraries are merged by cross-library rank fusion and ordered by that rank. ' +
  'Each entry carries a chunk id (C1, C2 ...), library id, library type, library name, document name, chunk index, ' +
  'the library-internal relevance score and a short content excerpt. ' +
  'The 相关度 value is comparable only within one library and NOT across libraries. ' +
  'The full text of the top-ranked chunk is auto-attached — do NOT call knowledge_read for that one. ' +
  'For the other entries, pass their chunk ids to knowledge_read. ' +
  'You MUST call knowledge_list first and then knowledge_overview to select libraries; otherwise this call is rejected ' +
  'with a hint to restart from knowledge_list.'

export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  '四个工具必须按 knowledge_list → knowledge_overview → knowledge_search → knowledge_read 顺序走；跳过选库直接检索会被拒绝，拒绝信息会提示重新调用 knowledge_list。',
  '检索范围由代码层按会话注入（工具一给出固定库编号、工具二选中库后由代码层记录），不要自己传库名或库编号，也不要逐库试错。',
  'knowledge_search 会在返回命中目录的同时，自动把排名最高那一块的完整正文附在末尾——所以一次检索通常就够用，不必再为它调用 knowledge_read。',
  '目录每条都有块编号、库编号、库类型、库名、文档名、块号、相关度与内容摘要；需要其它块的正文时，用 knowledge_read 传对应的块编号。',
  '构造查询词时只从用户问题里抽内容词：章节名、领域术语、代码标识符等文档正文里真会出现的词；库名、文档名、文件名不是检索词，不要写进 query（检索只匹配块正文与块标题）。检索是字面词法匹配（没有向量/语义通道），同义改述可能漏检——中文文档换中文词、代码术语换英文标识符再试一次。',
  '查询内容本身是命令、API 调用、报错或配置项时，把它整条原样传入，保留词序与 --flag / -m 这类参数，不要拆成零散关键词。检索对「相邻词对」加权：整条命令原样出现会显著加分，打乱词序或删掉参数恰好丢掉这部分信号（实测「git commit --amend -m」拆成关键词后，讲 Mermaid gitGraph 语法的块会靠 commit 词频排到正确的块前面）。',
  'query 一般只传 2–6 个关键词，不要原样转述用户的整句提问。长查询会掺进「如何/应该/什么」这类低信息量词，把所有块的分数一起抬高，真正相关的块反而拉不开差距；中文长句还会被切成大量跨词假词（「如何配置」→「何配」）造成误匹配。正确做法是自己从问题里抽出最有区分度的名词 / 标识符再检索，必要时换关键词多搜一次，而不是把问题原样丢进来。（例外：问题本身就是一条命令 / API / 报错原文时，按上一条整条传入。）',
  '目录按跨库融合排名降序，每行还标了「词序吻合 X%」与命中词——判断该读哪条请优先看排名、词序吻合度、命中词与内容摘要。行尾的相关度是各库内部的 BM25 分，跨库不可比、列表里不一定递减，不要拿两个不同库的条目去比这个数字。',
  '查询词全是常见词（在库里几乎每个块都出现）时，检索会返回一批分数很低的命中并标记低置信，且不给建议关键词——这种情况直接换更有区分度的词，不要反复用同一批词重搜。',
  '构造 query 之前，先用 knowledge_list 看有哪些知识库，再用 knowledge_overview 选中相关库并取概括，从概括里挑出文档里可能实际出现的名词或术语；概括只是选词参考，不是检索结果。',
]

export const KNOWLEDGE_LIST_DESCRIPTION =
  'List every local knowledge base with its STABLE library id, name and whether a user-written summary exists. ' +
  'Call this FIRST whenever a question may need the user documents. ' +
  'Then call knowledge_overview to select the libraries; the code layer records their ids and injects them into the later tools. ' +
  'Calling this tool again clears the selection.'

export const KNOWLEDGE_LIST_GUIDELINES: string[] = [
  '要用知识库时先调 knowledge_list 拿到全部库名与固定库编号，据此判断哪些库可能相关；库名和编号都不是检索词，不要写进 query。',
  '再用 knowledge_overview 选中相关库取概括，最后才用 knowledge_search 检索；选库结果由代码层记住，后续检索只在已选库内进行。再次调用本工具会清空已选库。',
]

export const KNOWLEDGE_OVERVIEW_DESCRIPTION =
  'Select the knowledge bases to search and read their user-written summaries. ' +
  'Pass kb with an exact name or stable id from knowledge_list, or kbs as an array to select several at once. ' +
  'The code layer records the library ids; repeated calls accumulate the selection, and replace:true switches libraries. ' +
  'Use the nouns, document names, section names and identifiers in the summary to build a distinctive knowledge_search query. ' +
  'A summary is a keyword hint, NOT the content of the library.'

export const KNOWLEDGE_OVERVIEW_GUIDELINES: string[] = [
  'knowledge_overview 的 kb 用 knowledge_list 返回的库名或库编号原样传入；kbs 可一次传多个；库多时优先挑一到两个相关库，别一次读全部概括。',
  '多次调用会攒出多库列表；换库时传 replace:true 清空上次选择，换库后旧目录的块编号立即失效，需要重新检索。',
  '概括只是选词参考，不代表库里只有这些内容，也不要把概括当检索结果引用；选中库之后再用 knowledge_search 检索，库编号由代码层注入，不要自己填。',
]

/** 用户为知识库手写的概括（由知识库界面维护，随知识库文件保存）。
    id 是库文件的固定编号：改名不变、删库才失效，后续工具只认它。 */
export interface KnowledgeBaseSummary {
  id: string
  name: string
  summary: string
}

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

/** 库列表输出：给固定库编号、库名与概括状态，库再多也只是每库一行短文本。 */
export function formatKnowledgeBaseList(libs: readonly KnowledgeBaseSummary[]): string {
  if (libs.length === 0) return '本机尚未创建任何知识库。'
  const lines = libs.map((l, i) => `[${i + 1}] 库编号 ${l.id} · ${l.name.replace(/\s+/g, ' ').trim()} · ${l.summary ? '已写概括' : '未写概括'}`)
  return `本机共 ${libs.length} 个知识库：\n${lines.join('\n')}\n（库编号固定不变，只由代码层记录，不用写进检索参数。下一步用 knowledge_overview 选中要查的库，可传库名或库编号；选中的库编号会由代码层注入后续检索，检索只在已选库内进行。再次调用本工具会清空已选库。）`
}

/** 概括输出：按库返回全文，随时读取磁盘最新值；支持一次选多个库以省上下文。
    不做长度截断——写多长由用户在界面里自己控制，代码不替他砍内容。
    selected 是代码层记录的已选库编号，随输出回给模型确认范围。 */
export function formatKnowledgeOverview(
  libs: readonly KnowledgeBaseSummary[],
  kb?: string | readonly string[],
  selected: readonly { id: string; name: string }[] = []
): string {
  const wants = (typeof kb === 'string' ? [kb] : kb ? [...kb] : []).map(w => String(w).trim()).filter(Boolean)
  const picked = wants.length ? libs.filter(l => wants.some(w => l.name === w || l.id === w)) : libs
  if (wants.length && picked.length === 0) {
    return `未找到知识库「${wants.join('、')}」。可用库名与编号：${libs.map(l => `${l.name}（${l.id}）`).join('、') || '（无）'}`
  }
  const lines = picked.map(s => {
    const name = s.name.replace(/\s+/g, ' ').trim()
    const text = (s.summary ?? '').replace(/\s+/g, ' ').trim()
    return `【${name} · 库编号 ${s.id}】${text || '（未写概括）'}`
  })
  if (lines.length === 0) return '本机尚未创建任何知识库。'
  const range = selected.length
    ? `\n（当前已选 ${selected.length} 个库：${selected.map(s => `${s.name}（${s.id}）`).join('、')}；库编号由代码层注入后续检索，不要自己写进参数。）`
    : ''
  return `知识库概括（由用户维护，仅供挑选检索词，不代表库内全部内容）：\n${lines.join('\n')}${range}\n（据此挑出文档里可能实际出现的名词、术语或章节名，再用 knowledge_search 检索；检索只在已选库内进行。）`
}

export const KNOWLEDGE_READ_DESCRIPTION_BASE =
  'Read the FULL text of chunks selected from the MOST RECENT knowledge_search catalog. ' +
  'Pass their chunk ids (C1, C2 ...) as chunkIds; the code layer resolves each id to its library and chunk. ' +
  'Chunks outside the selected libraries or outside the latest catalog are rejected, ' +
  'and you cannot skip the list / overview / search steps.'

export const KNOWLEDGE_READ_GUIDELINES: string[] = [
  'knowledge_read 只接受最近一次 knowledge_search 目录里的块编号（C1、C2…），不要自己拼库名、文档名或块号。',
  '必须先按顺序调用 knowledge_list → knowledge_overview → knowledge_search；跳步、拿旧目录的块编号、或读已选范围之外的库都会被拒绝，拒绝信息会告诉你下一步该调哪个工具。',
  `单次最多读取 ${KNOWLEDGE_TOOL_TOP_K_MAX} 块（就是目录里的全部条目）；排名第一块的正文已由 knowledge_search 自动附带，不必再读它。多个已选库里的块可以在同一次调用里一起读，回答不受影响。`,
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

/** 工具三：检索范围由代码层按会话注入，模型不再传库名/库编号。 */
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
  const catalog = r.hits
    .map((h, i) => {
      // 命中词：让模型看到「这条是靠什么命中的」——只看分数没法判断该不该继续读下一条。
      const m = (h.matched ?? []).slice(0, CATALOG_MATCHED_SHOW)
      const hitLabel = m.length > 0 ? ` · 命中 ${m.join('/')}` : ''
      // 词序吻合标记：BM25 只看词不看词序，「整条命令原样出现」和「碰巧重复了同一个词」
      // 分数可能相近。这个词序比例是模型区分两者最直接的信号，比分数可靠。
      const seqLabel = (h.adjacent ?? 0) > 0 ? ` · 词序吻合 ${Math.round((h.adjacent ?? 0) * 100)}%` : ''
      const plain = (h.text ?? '').replace(/\s+/g, ' ').trim()
      const excerpt = plain.slice(0, CATALOG_EXCERPT_SHOW) + (plain.length > CATALOG_EXCERPT_SHOW ? '…' : '')
      return `[${i + 1}] 块 ${h.chunkId ?? `C${i + 1}`} · 库编号 ${h.kbId ?? '未知'}（${h.kbType ?? '本机'}）· ${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块 · 相关度 ${h.score}${seqLabel}${hitLabel}\n    内容：${excerpt}`
    })
    .join('\n')
  // 低置信标记放在目录「头部」而不是末尾：末尾的尾注很容易被模型跳过。
  const head = r.lowConfidence
    ? '⚠️ 低置信检索：以下条目可能只沾到部分查询词，引用前请先核对原文或换关键词重搜。\n'
    : ''
  // 排序口径必须写清楚：条目按「跨库融合分」排序，显示的相关度是各库内部 BM25 分，
  // 两者量纲不同，所以列表里的相关度不一定单调递减。
  return `${head}${catalog}\n（以上为已选知识库内的命中目录，按跨库融合排名降序。相关度是各库内部 BM25 分，只在同一个库内可比、跨库不可比，故不一定单调递减；判断该读哪条请优先看排名、词序吻合度、命中词与内容摘要。第 [1] 条的完整正文已自动附在下方；如需其他条的正文，用 knowledge_read 传对应的块编号。）`
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

/** 工具四：只按最近一次目录里的块编号读全文，库编号由代码层注入，模型不再写库名。 */
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
    .map(h => `【块 ${h.chunkId ?? '?'} · 库编号 ${h.kbId ?? '未知'}（${h.kbType ?? '本机'}）· ${h.title || '（无标题）'}】(${h.kbName ? `${h.kbName} · ` : ''}${h.docName} · 第${h.ordinal + 1}块)\n${h.text}`)
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

/** 工具二：选中要检索的库并取用户手写的概括；库编号由代码层记录，后续工具不再传库名。 */
export function createKnowledgeOverviewSpec(kbNames?: string[], kbIds?: string[]): KnowledgeToolSpec {
  // 同名库会让枚举出现重复值，去重后再交给参数校验。
  const choices = [...new Set([...(kbNames ?? []), ...(kbIds ?? [])])]
  const kbProp: Record<string, unknown> = {
    type: 'string',
    description: 'Library name or stable library id exactly as returned by knowledge_list.',
    ...(choices.length > 0 ? { enum: choices } : {})
  }
  return {
    name: KNOWLEDGE_OVERVIEW_TOOL_NAME,
    label: '知识库概括',
    description: KNOWLEDGE_OVERVIEW_DESCRIPTION,
    promptGuidelines: KNOWLEDGE_OVERVIEW_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        kb: kbProp,
        kbs: {
          type: 'array',
          description: 'Select several libraries at once; names or ids from knowledge_list.',
          items: choices.length > 0 ? { type: 'string', enum: choices } : { type: 'string' }
        },
        replace: { type: 'boolean', description: 'Set true to switch libraries: clear the accumulated selection before adding these.' }
      }
    }
  }
}
