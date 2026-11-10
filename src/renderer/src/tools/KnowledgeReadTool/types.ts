// 块引用类型沿用共享规格文件，不另写一份。
export type { KnowledgeChunkRef } from '../../../../shared/tools/knowledgeSpecs'

export interface KnowledgeReadInput {
  kb?: string
  refs: { kb?: string; docName: string; ordinal: number }[]
}
