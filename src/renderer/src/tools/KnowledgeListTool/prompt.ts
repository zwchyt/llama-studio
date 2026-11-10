import { KNOWLEDGE_LIST_DESCRIPTION, KNOWLEDGE_LIST_GUIDELINES } from '../../../../shared/tools/knowledgeSpecs'

export function getKnowledgeListPrompt(): string {
  return `# knowledge_list 工具
${KNOWLEDGE_LIST_DESCRIPTION}
${KNOWLEDGE_LIST_GUIDELINES.map(g => `- ${g}`).join('\n')}`
}
