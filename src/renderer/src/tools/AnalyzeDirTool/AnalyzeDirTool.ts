import type { ToolDefinition } from '../../utils/tools'
import { ANALYZE_DIR_TOOL_NAME } from './constants'
import type { AnalyzeDirInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: ANALYZE_DIR_TOOL_NAME,
  description: '分析目录结构与功能，一次性返回「目录树 + 入口文件 + 文件类型统计」，用于快速了解项目全貌。这是分析目录的首选工具：只需调用一次即可得到完整概览，严禁改用 Bash `dir`/`ls` 逐子目录罗列，也严禁用 ListDir 的 recursive 模式一次性 dump 整棵树。分析完即可直接回答用户，无需再逐个查看子目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要分析的目录，相对或绝对路径。省略则分析项目根目录。' },
      maxDepth: { type: 'number', description: '递归分析的最大深度（默认 3，避免极深目录撑爆上下文）。' }
    },
    required: []
  }
}

// 常见「入口/约定」文件：命中即视为项目关键文件，单独列出供模型快速定位
const ENTRY_FILES = [
  'README.md', 'README', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md',
  'main.py', 'app.py', 'index.py', 'server.py', 'manage.py', 'wsgi.py',
  'main.js', 'index.js', 'app.js', 'server.js', 'main.ts', 'index.ts',
  'main.go', 'main.rs', 'main.c', 'main.cpp', 'Program.cs', 'main.java',
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'compose.yml', 'config.py', 'config.json',
  'config.yaml', 'config.yml', 'settings.py', 'settings.json', '.env',
]
const ENTRY_SET = new Set(ENTRY_FILES)

// 一次性分析目录：单条调用给出完整概览，杜绝「逐子目录 dir」式枚举。
export async function execute(args: Record<string, unknown>): Promise<string> {
  const { path, maxDepth } = args as unknown as AnalyzeDirInput
  const root = (typeof path === 'string' && path.trim()) ? path : getWorkspaceRootForSession()
  if (!root) return 'Error: 未设置路径（请先在项目中创建或选择目录）'

  const MAX_DEPTH = Number.isFinite(maxDepth) && (maxDepth as number) > 0 ? Math.min(Math.floor(maxDepth as number), 6) : 3
  const MAX_DIRS = 400            // 最多走访的目录数，防止超巨型项目撑爆上下文
  const MAX_TREE_LINES = 400      // 树状输出行数上限
  const TYPE_TOP_N = 12

  const treeLines: string[] = []
  const typeBuckets = new Map<string, number>()
  const entryHits: string[] = []
  let dirsVisited = 0
  let dirsCapped = false

  const extOf = (name: string): string => {
    if (!name.includes('.')) return '(无扩展名)'
    const ext = name.slice(name.lastIndexOf('.'))
    return ext.toLowerCase()
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    if (dirsVisited >= MAX_DIRS) { dirsCapped = true; return }
    dirsVisited++
    const res = await window.api.listDir(dir)
    if (!res.success || !res.entries) return
    const dirs = res.entries.filter(e => e.isDir)
    const files = res.entries.filter(e => !e.isDir)
    for (const f of files) {
      const ext = extOf(f.name)
      typeBuckets.set(ext, (typeBuckets.get(ext) ?? 0) + 1)
      if (ENTRY_SET.has(f.name)) entryHits.push(`${'  '.repeat(depth)}${f.name}`)
    }
    // 文件过多时折叠为数量，避免单目录刷屏
    const fileLines = files.length > 30
      ? [`${'  '.repeat(depth)}（${files.length} 个文件，已折叠）`]
      : files.map(f => `${'  '.repeat(depth)}- ${f.name}`)
    if (treeLines.length < MAX_TREE_LINES) {
      const dirLabel = res.truncated ? ` [前 ${res.entries.length}/${res.total} 项]` : ''
      treeLines.push(`${'  '.repeat(depth)}- ${dir.split(/[\\/]/).pop() || dir}/${dirLabel}`)
      for (const l of fileLines) { if (treeLines.length < MAX_TREE_LINES) treeLines.push(l) }
    }
    for (const d of dirs) {
      if (dirsVisited >= MAX_DIRS) { dirsCapped = true; break }
      const child = `${dir.replace(/[\\/]+$/, '')}/${d.name}`
      await walk(child, depth + 1)
    }
  }

  try {
    await walk(root, 0)
  } catch (e: any) {
    return `Error: 分析目录失败：${e?.message || String(e)}`
  }

  const topTypes = [...typeBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, TYPE_TOP_N)
  const typeSummary = topTypes.map(([ext, n]) => `${n} ${ext}`).join('，')
  const moreTypes = typeBuckets.size > TYPE_TOP_N ? `，及其他 ${typeBuckets.size - TYPE_TOP_N} 类` : ''

  const parts: string[] = []
  parts.push(`已分析目录：${root}（最大深度 ${MAX_DEPTH}，走访 ${dirsVisited} 个子目录${dirsCapped ? '，已达上限' : ''}）`)
  if (entryHits.length) {
    parts.push('\n## 关键入口/约定文件')
    parts.push(entryHits.join('\n'))
  }
  parts.push('\n## 目录结构')
  parts.push(treeLines.join('\n') + (treeLines.length >= MAX_TREE_LINES ? '\n…（树过大已截断，请针对性 Grep/Glob 深入）' : ''))
  parts.push('\n## 文件类型统计')
  parts.push(typeSummary + moreTypes)
  parts.push('\n---\n以上为完整概览。请勿再逐子目录执行 dir/ListDir；如需某部分细节，直接用 Grep/Glob 按关键词定位，或对具体文件 Read。')

  return parts.join('\n')
}
