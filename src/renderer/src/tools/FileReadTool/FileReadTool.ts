import type { ToolDefinition } from '../../utils/tools'
import { FILE_READ_TOOL_NAME } from './constants'
import type { FileReadInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_READ_TOOL_NAME,
  description: 'Read file content with automatic encoding detection (UTF-8/UTF-16). Returns each line as "行号 哈希|内容" (Hashline format with content fingerprint for precise Edit targeting). Supports offset/limit. Token budget ~25000; larger content suggests using Grep. Prefer over Bash type/cat.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      offset: { type: 'number', description: 'Starting line number (1-indexed). Negative counts from end (e.g. -20 = last 20 lines). Default: 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default: all lines.' }
    },
    required: ['file_path']
  }
}

// ── Hashline：行内容指纹锚点 ──
// 每行的内容指纹（FNV-1a 哈希前 7 位），用于 Edit 时精确定位。
// 模型不可自行编造或修改锚点字符串；锚点由 Read 工具生成，Edit 工具校验。
function lineHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, offset, limit } = args as unknown as FileReadInput
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
  // 对每一行：行号 + 内容指纹 + 原始内容
  const hashlineContent = allLines.map((line, i) => {
    const lineNum = startLine + i
    const hash = lineHash(line)
    return `${lineNum} ${hash}|${line}`
  }).join('\n')
  return `File: ${file_path}\nLines: ${startLine}-${startLine + allLines.length - 1} of ${totalLines}\n\n${hashlineContent}`
}
