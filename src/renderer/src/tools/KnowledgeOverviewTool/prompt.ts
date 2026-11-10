import { KNOWLEDGE_OVERVIEW_DESCRIPTION, KNOWLEDGE_OVERVIEW_GUIDELINES } from '../../../../shared/tools/knowledgeSpecs'

export function getKnowledgeOverviewPrompt(): string {
  return `# knowledge_overview 工具
${KNOWLEDGE_OVERVIEW_DESCRIPTION}
${KNOWLEDGE_OVERVIEW_GUIDELINES.map(g => `- ${g}`).join('\n')}`
}
