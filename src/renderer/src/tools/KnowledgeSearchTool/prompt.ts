import { KNOWLEDGE_SEARCH_DESCRIPTION_BASE, KNOWLEDGE_SEARCH_GUIDELINES } from '../../../../shared/tools/knowledgeSpecs'

export function getKnowledgeSearchPrompt(): string {
  return `# knowledge_search 工具
${KNOWLEDGE_SEARCH_DESCRIPTION_BASE}
${KNOWLEDGE_SEARCH_GUIDELINES.map(g => `- ${g}`).join('\n')}`
}
