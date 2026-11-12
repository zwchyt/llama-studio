// 概括工具入参：kb 为库名或固定库编号，kbs 可一次选多个；replace 为换库开关。
export type { KnowledgeBaseSummary } from '../../../../shared/tools/knowledgeSpecs'

export interface KnowledgeOverviewInput {
  kb?: string
  kbs?: string[]
  replace?: boolean
}
