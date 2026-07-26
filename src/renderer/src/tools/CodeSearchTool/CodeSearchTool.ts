import type { ToolDefinition } from '../../utils/tools'
import { CODE_SEARCH_TOOL_NAME } from './constants'
import type { CodeSearchInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: CODE_SEARCH_TOOL_NAME,
  description: '按自然语言或关键词在代码库内做混合检索（BM25 词法 + 符号精确加权，按函数/类等逻辑单元分块），返回相关代码块的位置与摘要。适用于「不知道代码在哪」的概念性提问（如"哪里处理工具结果截断"）；已知确切标识符/字符串用 Grep，已知文件路径直接 Read。支持中文查询（可匹配中文注释）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索语句：自然语言描述或关键词组合（中英文均可）。' },
      limit: { type: 'number', description: '返回结果数上限（默认 8，最大 20）。' }
    },
    required: ['query']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { query, limit } = args as unknown as CodeSearchInput
  const root = getWorkspaceRootForSession()
  if (!root) return 'Error: 未设置工作目录（请先在项目中创建或选择目录）'
  if (!query || !String(query).trim()) return 'Error: 检索语句不能为空'
  const res = await window.api.codesearchQuery(root, String(query), typeof limit === 'number' ? limit : undefined)
  // ── 降级瀑布：索引不可用 → 明确告知备选路径，不让模型空转 ──
  if (res.status === 'building') {
    return '检索索引正在后台构建中，本次不可用。请先改用 Grep（确切标识符/字符串）或 AnalyzeDir + Glob（结构导航）继续任务；稍后（约十几秒后）可再试 CodeSearch。'
  }
  if (res.status === 'no-map') {
    return '认知地图未就绪，CodeSearch 暂不可用。请改用 Grep / Glob / AnalyzeDir 完成本次检索，不要重试本工具。'
  }
  if (res.results.length === 0) {
    return `未检索到相关代码块（已索引 ${res.indexedChunks} 个块）。降级建议：\n- 换用更具体的代码词（函数名/变量名片段）重试一次；\n- 或用 Grep 按确切字符串精确搜索；\n- 或用 AnalyzeDir 看结构后针对性 Read。`
  }
  const lines: string[] = []
  lines.push(`共 ${res.results.length} 个相关代码块（已索引 ${res.indexedChunks} 块）：`)
  for (const h of res.results) {
    lines.push(`\n## ${h.relPath}:${h.startLine}-${h.endLine}  ${h.symbol}（${h.kind}，score ${h.score}）`)
    lines.push('```')
    lines.push(h.snippet)
    lines.push('```')
  }
  if (res.lowConfidence) {
    lines.push('\n⚠️ 本次检索置信度较低，以上结果可能不相关。请勿据此直接下结论：建议用 Grep 按确切标识符验证，或换更具体的查询词重试一次；仍无果则改走 AnalyzeDir 结构导航。')
  } else {
    lines.push('\n需要细节时，对命中文件用 Read 读取对应行段（offset/limit），不要整文件读取。')
  }
  return lines.join('\n')
}
