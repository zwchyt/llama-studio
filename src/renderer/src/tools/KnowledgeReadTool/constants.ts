// 工具名、描述与提示词的唯一来源在共享规格文件，这里按五文件规范转导出。
export {
  KNOWLEDGE_READ_TOOL_NAME,
  KNOWLEDGE_READ_DESCRIPTION_BASE,
  KNOWLEDGE_READ_GUIDELINES,
  createKnowledgeReadSpec,
  parseChunkRefs,
  formatKnowledgeChunks,
} from '../../../../shared/tools/knowledgeSpecs'
