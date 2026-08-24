// 兼容层：知识库读块工具原实现已抽到 src/shared/tools/knowledgeSpecs（main 与 renderer 双侧共享）。
// 保留本 barrel 以兼容任何按原路径导入的模块。
export {
  KNOWLEDGE_READ_TOOL_NAME,
  KNOWLEDGE_READ_DESCRIPTION_BASE,
  KNOWLEDGE_READ_GUIDELINES,
  createKnowledgeReadSpec,
  parseChunkRefs,
  formatKnowledgeChunks,
} from '../../../../shared/tools/knowledgeSpecs'
