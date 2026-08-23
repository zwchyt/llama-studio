// 知识库检索工具的描述与使用规范（纯数据，渲染层/主进程双侧可导入）

export const KNOWLEDGE_SEARCH_DESCRIPTION_BASE =
  'Search the user-attached local knowledge base (BM25 keyword retrieval). ' +
  'Returns ONLY a catalog of matching chunk titles with document name, chunk index and relevance score — NOT the full text. ' +
  'Use it whenever the user question may be answered by their documents. ' +
  'After scanning the titles, call knowledge_read with the docName+ordinal pairs of the chunks you want to actually read. ' +
  'Target library is selected via the optional kb parameter — its enum lists every existing knowledge base (single source of truth).'

/** 激活本工具时附加到系统提示词的使用规范（中文，pi promptGuidelines 通道） */
export const KNOWLEDGE_SEARCH_GUIDELINES: string[] = [
  '知识库检索是两阶段流程：先用 knowledge_search 拿「标题目录」（每条仅几十字，极省 token），看目录挑中目标块后，再用 knowledge_read 只读选中块的正文。不要试图用 knowledge_search 直接获取正文。',
  '构造查询词时优先使用文档标题、章节名或领域关键词；BM25 是字面关键词匹配，同义改述可能漏检，必要时换词重搜。',
]
