import { KNOWLEDGE_READ_DESCRIPTION_BASE, KNOWLEDGE_READ_GUIDELINES } from '../../../../shared/tools/knowledgeSpecs'

export function getKnowledgeReadPrompt(): string {
  return `# knowledge_read 工具
${KNOWLEDGE_READ_DESCRIPTION_BASE}
${KNOWLEDGE_READ_GUIDELINES.map(g => `- ${g}`).join('\n')}`
}
