import { createKnowledgeListSpec, KNOWLEDGE_LIST_TOOL_NAME } from '../../../../shared/tools/knowledgeSpecs'
import type { KnowledgeToolDefinition, KnowledgeToolExecutor } from '../../../../shared/tools/knowledgeSpecs'

// 规格只有共享文件那一份，这里只转成工具定义；执行器由调用方注入。
// 本文件不依赖 window、也不依赖渲染层注册中心，所以主进程工程可以直接引用。
const spec = createKnowledgeListSpec()
export const definition: KnowledgeToolDefinition = {
  name: spec.name,
  label: spec.label,
  description: spec.description,
  parameters: spec.parameters,
  ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {})
}

export function createExecute(call: KnowledgeToolExecutor) {
  return (args: Record<string, unknown>): Promise<string> => call(KNOWLEDGE_LIST_TOOL_NAME, args)
}
