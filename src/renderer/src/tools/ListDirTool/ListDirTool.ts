import type { ToolDefinition } from '../../utils/tools'
import { LIST_DIR_TOOL_NAME } from './constants'
import type { ListDirInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: LIST_DIR_TOOL_NAME,
  description: 'List files and directories of a SINGLE directory level (non-recursive) at the given path. Use it only to confirm/inspect one directory\'s immediate contents (e.g. check whether a file exists, verify a path before Read/Write). For a full project overview / analyzing what a directory does, use the AnalyzeDir tool instead — do NOT enumerate subdirs one-by-one with ListDir. Prefer this over Bash `dir`/`ls`. To see only directories, set dirsOnly.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative or absolute directory path to list. Omit to list the project root.' },
      dirsOnly: { type: 'boolean', description: 'If true, list only directories (equivalent to `dir /ad`), hiding plain files. Use this when you only need the folder structure.' },
      recursive: { type: 'boolean', description: 'If true, list subdirectories recursively (one entry per directory, indented by depth) so you can see the full tree in a single call. Off by default (non-recursive, single level).' }
    },
    required: []
  }
}

function formatFileCount(count: number): string {
  if (count === 0) return 'empty'
  return `${count} item${count === 1 ? '' : 's'}`
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { path, dirsOnly, recursive } = args as unknown as ListDirInput & { dirsOnly?: boolean; recursive?: boolean }
  const targetPath = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRootForSession()
  if (!targetPath) return 'Error: 未设置路径（请先在项目中创建或选择目录）'

  const res = await window.api.listDir(targetPath)
  if (!res.success) return `Error: ${res.error}`
  let entries = res.entries ?? []
  if (entries.length === 0) return '(empty directory)'
  if (dirsOnly) entries = entries.filter(e => e.isDir)

  if (recursive) {
    // 递归收集子目录，按深度缩进，整棵树一次返回
    const lines: string[] = [`- ${targetPath}/`]
    const childPath = (parent: string, name: string) => `${parent}\\${name}`
    const walk = async (dir: string, depth: number): Promise<void> => {
      const r = await window.api.listDir(dir)
      if (!r.success) return
      const subs = (r.entries ?? []).filter(e => e.isDir)
      for (const s of subs) {
        const indent = '  '.repeat(depth + 1)
        const summary = s.fileCount > 0 ? `  [${formatFileCount(s.fileCount)}]` : ''
        lines.push(`${indent}- ${s.name}/${summary}`)
        await walk(childPath(dir, s.name), depth + 1)
      }
    }
    for (const e of entries) {
      if (!e.isDir) continue
      const summary = e.fileCount > 0 ? `  [${formatFileCount(e.fileCount)}]` : ''
      lines.push(`  - ${e.name}/${summary}`)
      await walk(childPath(targetPath, e.name), 1)
    }
    return lines.join('\n')
  }

  // ── 预算折叠（参考 grok-build 的 list_dir 折叠摘要）──
  // 目录条目（少而关键）始终列出；文件条目过多时，不逐个罗列，而是折叠成
  // 「按扩展名分桶的数量统计」，用极少字符给模型一个结构概览，避免一次性吐出上万字符。
  const LISTDIR_CHAR_BUDGET = 6000
  const dirs = entries.filter(e => e.isDir)
  const files = entries.filter(e => !e.isDir)
  const renderDirs = () => dirs.map(e => `  - ${e.name}/`).join('\n')
  const renderFiles = () => files.map(e => `  - ${e.name}`).join('\n')

  let output = ''
  if (path) output += `- ${targetPath}/\n`
  const headerLen = output.length
  const dirsText = renderDirs()
  const filesText = renderFiles()
  const fullLen = headerLen + (dirsText ? dirsText.length + 1 : 0) + (filesText ? filesText.length + 1 : 0)

  if (files.length > 0 && fullLen > LISTDIR_CHAR_BUDGET) {
    // 文件过多 → 折叠为扩展名计数摘要
    if (dirsText) output += dirsText + '\n'
    const buckets = new Map<string, number>()
    for (const f of files) {
      const ext = f.name.includes('.') ? '*' + f.name.slice(f.name.lastIndexOf('.')) : '(无扩展名)'
      buckets.set(ext, (buckets.get(ext) ?? 0) + 1)
    }
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    const summary = top.map(([ext, n]) => `${n} ${ext}`).join('，')
    const more = buckets.size > top.length ? `，及其他 ${buckets.size - top.length} 类` : ''
    output += `  - [${files.length} 个文件，已折叠为类型统计：${summary}${more}]\n`
    output += `\n(目录较大，已折叠为类型统计以节省上下文；如需查看某类文件，请用 Grep 检索内容，或对具体子目录再次调用 ListDir)`
  } else {
    if (dirsText) output += dirsText + '\n'
    if (filesText) output += filesText + '\n'
    if (res.truncated) {
      output += `\n(仅显示前 1000 项，共 ${res.total} 项)`
    }
  }
  return output.trimEnd()
}
