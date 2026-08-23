/** 知识库检索入参 */
export interface KnowledgeSearchInput {
  query: string
  limit?: number
  /** 目标知识库名（enum 注入本机全部库名；缺省=绑定库或唯一库） */
  kb?: string
}

/** 本机知识库清单项（注入工具参数 enum 用） */
export interface KnowledgeBaseRef {
  id: string
  name: string
}

/** 一个知识块引用（docName + 0 起始块号） */
export interface KnowledgeChunkRef {
  docName: string
  ordinal: number
}

/** 检索命中的一条块（含标题与相关度） */
export interface KnowledgeSearchHit {
  docName: string
  ordinal: number
  title?: string
  text: string
  score: number
}

/** knowledge_query IPC 返回 */
export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[]
  lowConfidence?: boolean
  error?: string
}

/** 知识库元信息（用于注入工具描述） */
export interface KnowledgeBaseInfo {
  name: string
  docs: string[]
}
