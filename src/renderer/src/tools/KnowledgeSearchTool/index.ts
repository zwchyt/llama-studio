// 兼容层：知识库检索工具原实现已抽到 src/shared/tools/knowledgeSpecs（main 与 renderer 双侧共享）。
// 保留本 barrel 以兼容任何按原路径导入的模块。
export {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_SEARCH_DESCRIPTION_BASE,
  KNOWLEDGE_SEARCH_GUIDELINES,
  createKnowledgeSearchSpec,
  formatKnowledgeCatalog,
} from '../../../../shared/tools/knowledgeSpecs'
export type {
  KnowledgeSearchInput,
  KnowledgeBaseRef,
  KnowledgeChunkRef,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  KnowledgeBaseInfo,
} from '../../../../shared/tools/knowledgeSpecs'
