import type { ToolDefinition } from '../../utils/tools'
import { FILE_WRITE_TOOL_NAME } from './constants'
import type { FileWriteInput } from './types'
import { invalidateReadCache } from '../FileReadTool/FileReadTool'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: FILE_WRITE_TOOL_NAME,
  description: 'Write content to a file (overwrites existing!). Creates parent directories automatically. For partial edits use Edit, not Write. For file/directory deletion use Delete, not Write. Path is resolved relative to the project directory, so relative paths like "subdir/file.py" work (absolute paths also work).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file, relative to the project directory (e.g. "subdir/file.py") or absolute.' },
      content: { type: 'string', description: 'The content to write to the file.' }
    },
    required: ['file_path', 'content']
  }
}

/** 格式化写入/编辑返回的错误（参考 grok-build 的结构化错误分类） */
function classifyFileError(err: string): string {
  if (/ENOENT|no such|does not exist/.test(err)) return `❌ 路径不存在：${err}`
  if (/EACCES|EPERM|permission|denied/.test(err)) return `🔒 权限不足：${err}`
  if (/EISDIR/i.test(err)) return `📁 路径是目录，无法写入`
  if (/EEXIST|already exists/.test(err)) return `⚠️ 文件已存在：${err}`
  if (/IsADirectory/i.test(err)) return `📁 路径是目录，无法写入`
  return `❌ 写入失败：${err}`
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { file_path, content } = args as unknown as FileWriteInput
  const res = await window.api.writeFile(file_path, content)
  if (!res.success) return classifyFileError(res.error || '')
  invalidateReadCache(file_path)
  // 轻量回读校验：写入成功后回读确认内容已落盘（统一换行后比对）。
  // 仅追加提示供模型参考，不改变成功语义（避免编码/换行差异造成误熔断）。
  let note = ''
  try {
    const rb = await window.api.readFile(file_path, { raw: true })
    if (rb.success && typeof rb.content === 'string') {
      if (rb.truncated) {
        note = '（回读校验跳过：文件较大已截断）'
      } else {
        const norm = (s: string) => s.replace(/\r\n/g, '\n')
        note = norm(rb.content) === norm(content)
          ? '（已回读校验：内容一致）'
          : '（提醒：回读内容与写入不一致，可能存在编码/换行差异，请 Read 复核）'
      }
    } else {
      note = `（回读校验跳过：${rb.error || '读取失败'}）`
    }
  } catch (e: any) {
    note = `（回读校验跳过：${e?.message || String(e)}）`
  }
  return `✅ 文件写入成功。${note}`
}
