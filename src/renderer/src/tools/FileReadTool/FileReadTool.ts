import type { ToolDefinition } from '../../utils/tools'
import { FILE_READ_TOOL_NAME } from './constants'
import type { FileReadInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_READ_TOOL_NAME,
  description: 'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns each line as "行号 哈希|内容" (Hashline format with content fingerprint for precise Edit targeting). Supports offset/limit. Token budget ~25000; larger content suggests using Grep. Prefer over Bash type/cat.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      offset: { type: 'number', description: 'Starting line number (1-indexed). Negative counts from end (e.g. -20 = last 20 lines). Default: 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000.' }
    },
    required: ['file_path']
  }
}

// ── 短期读取缓存 ──
// Agent 探索项目时模型常对同一文件重复 Read（尤其上下文被裁剪后）。
// 按 file_path|offset|limit 缓存格式化结果，命中则直接返回，避免反复读盘与重复轮次。
const readCache = new Map<string, string>()
const READ_CACHE_MAX = 200

// 缓存 key 使用归一化绝对路径（相对路径按当前会话工作区解析、统一分隔符、小写）：
// 1) 避免「Read 用相对路径、Edit 用绝对路径（或 \\ vs / 、大小写差异）」导致
//    invalidateReadCache 前缀不命中、后续 Read 返回陈旧内容与陈旧 hashline；
// 2) 避免不同项目的相同相对路径（如都有 src/index.ts）互相串缓存。
function normalizeCachePath(p: string): string {
  let abs = p || ''
  const isAbs = /^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith('/') || abs.startsWith('\\')
  if (!isAbs) {
    const root = getWorkspaceRootForSession()
    if (root) abs = root.replace(/[\\/]+$/, '') + '/' + abs.replace(/^[\\/]+/, '')
  }
  return abs.replace(/\\/g, '/').toLowerCase()
}

function readCacheKey(file_path: string, offset?: number, limit?: number): string {
  return `${normalizeCachePath(file_path)}|${offset ?? ''}|${limit ?? ''}`
}

/** 文件被写入/编辑/删除后调用，使该路径的缓存失效；不传路径则清空全部缓存 */
export function invalidateReadCache(file_path?: string): void {
  if (!file_path) { readCache.clear(); return }
  const prefix = `${normalizeCachePath(file_path)}|`
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key)
  }
}

// ── Hashline：行内容指纹锚点 ──
// 每行的内容指纹（FNV-1a 哈希前 7 位），用于 Edit 时精确定位。
// 模型不可自行编造或修改锚点字符串；锚点由 Read 工具生成，Edit 工具校验。
export function lineHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, offset, limit } = args as unknown as FileReadInput
  const cacheKey = readCacheKey(file_path, offset, limit)
  const cached = readCache.get(cacheKey)
  if (cached !== undefined) return `${cached}\n\n(命中读取缓存，未重复读盘；该文件内容已在上方，请直接基于已有内容分析，不要再次读取同一文件)`
  // raw=true 获取纯净原文（无行号前缀），用于 hashline 锚点格式化
  const res = await window.api.readFile(file_path, { offset, limit, raw: true })
  if (!res.success) {
    let msg = `Error: ${res.error}`
    if (res.errorType === 'FileTooLarge' && res.suggestedCommand) {
      msg += `\n\n建议使用 Grep 搜索：${res.suggestedCommand}`
    }
    return msg
  }
  const allLines = res.content!.split('\n')
  const startLine = res.startLine ?? 1
  const totalLines = res.totalLines ?? allLines.length
  const endLine = startLine + allLines.length - 1
  // 对每一行：行号 + 内容指纹 + 原始内容
  const hashlineContent = allLines.map((line, i) => {
    const lineNum = startLine + i
    const hash = lineHash(line)
    return `${lineNum} ${hash}|${line}`
  }).join('\n')
  // 未显式指定 limit 且文件还有剩余行：尾部附加显式截断提示（与 pi 主进程版 Read 一致），
  // 引导模型继续读用 offset、定位用 Grep 开窗，避免一页页顺序通读大文件
  const truncHint = limit === undefined && endLine < totalLines
    ? `\n\n(已截断：第 ${startLine}-${endLine} 行 / 共 ${totalLines} 行。继续读用 offset=${endLine + 1}；定位目标代码更推荐 Grep（output_mode: content 带行号）后按行号以 offset/limit 开窗读取，避免逐页通读)`
    : ''
  const displayPath = (() => {
    const root = getWorkspaceRootForSession()
    if (!root) return file_path
    if (/^[a-zA-Z]:[\\/]/.test(file_path) || file_path.startsWith('/') || file_path.startsWith('\\')) return file_path
    return root.replace(/[\\/]+$/, '') + '/' + file_path.replace(/^[\\/]+/, '')
  })()
  const result = `File: ${displayPath}\nLines: ${startLine}-${endLine} of ${totalLines}\n\n${hashlineContent}${truncHint}`
  if (readCache.size >= READ_CACHE_MAX) readCache.clear()
  readCache.set(cacheKey, result)
  return result
}
