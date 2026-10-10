// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-tools —— 工具元数据、参数/结果渲染、工具卡片、文件变更汇总        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「工具元数据与工具调用解析」「工具结果截断与格式化」
// 两区域，以及模块级子组件区中的 LinedPre / ToolArgsView / ToolResultView /
// ToolCallCard / ToolCallGroup / FileChangeSummary。逻辑与注释均未改动。
//
// 对外导出：TOOL_META、formatToolArgs、getToolPreview、LinedPre、
//           ToolArgsView、ToolResultView、ToolCallCard、ToolCallGroup、FileChangeSummary

import React, { useMemo, useRef, useState } from 'react'
import {
  Wrench, XIcon, Undo2, FileDiff,
} from 'lucide-react'
import {
  LoaderIcon, ClockIcon, CheckIcon, ChevronRightIcon, ChevronDownIcon, GitBranchIcon,
} from '@animateicons/react/lucide'
import { useCollapseAnimation } from '../../../utils/useCollapseAnimation'
import { fileMeta } from '../../../utils/fileIcon'
import { TOOL_METAS, WRITE_EDIT_TOOLS, BACKUP_TOOLS } from '../../../utils/tools'
import WebSearchResults from '../../WebSearchResults'
import FetchWebpageResult from '../../FetchWebpageResult'
import BrowserScreenshotResult from '../../BrowserScreenshotResult'
import BrowserShowResult from '../../BrowserShowResult'
import ViewImageResult from '../../ViewImageResult'
import { JsonResultCard } from '../../ToolResultRows'
import { getEditDiffStat, ToolEditDiff } from '../agent-diff'
import { LinedPre, LINED_PRE_WINDOW_CHARS } from './LinedPre'
import { WindowedText } from '../WindowedText'
import { HighlightedCode } from '../HighlightedCode'
import { langFromPath } from '../utils/highlightLines'
import { dirName, pathDir, resolveWorkspacePath, toWorkspaceRelative } from '../utils/paths'
import { formatDuration } from '../utils/format'
import { useBubbleTip } from '../../useBubbleTip'
import type { AgentMessage } from '../../../../../shared/types'

// LinedPre 已抽至 ./LinedPre（长内容行窗口），此处 re-export 保持原导入路径可用
export { LinedPre } from './LinedPre'

// 工具头部预览摘要（参考 pi-web：显示文件名 / 命令 / 模式等主要参数；文件路径只取文件名）
export function getToolPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  if (pick('command')) return pick('command').slice(0, 120)
  if (pick('file_path')) return dirName(pick('file_path'))
  if (pick('path')) return dirName(pick('path'))
  if (pick('pattern')) return pick('pattern')
  if (pick('query')) return pick('query')
  const keys = Object.keys(o)
  if (!keys.length) return ''
  const first = o[keys[0]!]
  return typeof first === 'string' ? first.slice(0, 120) : ''
}

// ── 工具元信息：中文名 / 描述 / 图标（用于工具调用块展示）────
// 工具分类/展示/权限元数据已集中到 utils/tools.ts 的 TOOL_METAS（单一事实来源）。
// 以下 helper 从元数据派生，替代原先散落的字符串 Set 与手写 Map。
export const TOOL_META: Record<string, { name: string; desc: string; icon: React.ComponentType<{ size?: number; className?: string }> }> =
  Object.fromEntries(
    Object.entries(TOOL_METAS).map(([name, m]) => [name, { name: m.label, desc: '', icon: m.icon }])
  )

// 将工具参数格式化为可读 JSON（参数可能为压缩单行字符串或已解析对象）
export function formatToolArgs(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw)
    return JSON.stringify(obj, null, 2)
  } catch {
    return raw
  }
}

// ── 专属渲染的门控集合 ──
// ToolCallCard 展开体里，参数区与结果区各有「通用实现」与「专属实现」两条路。
// 原先写成两串内联的 `&& tc.name !== '...'`，每加一个专属卡要改两处、各加一个 !==，
// 且两串的成员还高度重叠 —— 收成集合后只维护这里一处。
/** 参数已由卡头预览或专属结果卡呈现，不再走通用 ToolArgsView */
const CUSTOM_ARGS_TOOLS = new Set(['Bash', 'web_search', 'web_search_bing', 'fetch_webpage'])
/** 结果由专属结果卡渲染，不再走通用 ToolResultView（否则同一份结果会渲染两遍） */
const CUSTOM_RESULT_TOOLS = new Set([
  ...CUSTOM_ARGS_TOOLS,
  'browser_show', 'browser_screenshot', 'view_image', 'get_datetime'
])

// 带行号的等宽文本块（工具写入内容 / Read 结果）已抽至 ./LinedPre.tsx：
// 阈值以下逐行 DOM（原行为），以上走行窗口只挂载视口附近行。

// ── Grep 结果的结构化形态 ──
// files_with_matches：一行一个绝对路径。
// content：每行 `路径:行号:内容`（项目 GrepTool 的原生格式）。路径可能含盘符冒号
//   （E:\...），所以用「非贪婪路径 + 行号锚点」切分，而不是 split(':')。
//   尾部还可能跟一段以 `(` 开头的提示（超时说明 / Read 开窗引导），单独提取为注脚。
// 之所以要拆开渲染：content 模式每行都带完整绝对路径，直接堆原文会把真正的内容淹掉。
type GrepHit = { line: number; text: string }
export type GrepResult =
  | { kind: 'files'; paths: string[] }
  | { kind: 'content'; groups: { path: string; hits: GrepHit[] }[]; note?: string }

const GREP_CONTENT_LINE = /^(.+?):(\d+):([\s\S]*)$/

function parseGrepResult(result: string, mode: string): GrepResult | null {
  const lines = result.split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean)
  if (lines.length === 0) return null
  // 失败信息不是结果内容（tc.failed 通常会拦住，这里再兜一层）
  if (/^Error:/i.test(lines[0])) return null

  if (mode === 'files_with_matches') {
    // 空结果有两套写法，都不是文件路径，必须排除，否则会被当成一个叫
    // 「(0 files matched)」的文件：
    //   · mainTools.ts（主进程）→ `(0 files matched)`
    //   · GrepTool.ts（渲染进程）→ `No matches found.`
    const isNote = (l: string) =>
      l.startsWith('(') || l.startsWith('（') || /^No matches found\.?$/i.test(l)
    return { kind: 'files', paths: lines.filter((l) => !isNote(l)) }
  }
  if (mode !== 'content') return null
  const groups = new Map<string, GrepHit[]>()
  const notes: string[] = []
  for (const line of lines) {
    const m = GREP_CONTENT_LINE.exec(line)
    if (m) {
      const hit = { line: Number(m[2]), text: m[3] }
      const list = groups.get(m[1])
      if (list) list.push(hit)
      else groups.set(m[1], [hit])
    } else if (line.startsWith('(') || line.startsWith('（')) {
      notes.push(line)
    }
  }
  return {
    kind: 'content',
    groups: Array.from(groups, ([path, hits]) => ({ path, hits })),
    note: notes.join('\n') || undefined,
  }
}

// ── Read 结果的结构化形态 ──
// 原生格式：首两行是 `File: <路径>` / `Lines: <起>-<止> of <总>`，空行之后是正文。
// 正文每行有两种可能（项目里 Read 有两套实现，输出格式不同）：
//   · mainTools.ts（主进程，pi 桥接）→ `行号 内容`（无哈希，行内容可直接作 Edit 的 oldText）
//   · FileReadTool.ts（渲染进程）   → `行号 7位哈希|内容`（哈希供 Edit 定位）
// 直接渲染会把协议头、空行和每行的前缀全摊出来，且行号列是结果内序号而非文件真实行号 ——
// 这里统一拆成「真实行号 | 行锚点(有才显示) | 内容」，协议头不再进正文。
type ReadLine = { num: number; hash: string; text: string }
type ReadResult = { lines: ReadLine[]; hasHash: boolean }

const READ_HASHLINE = /^(\d+) ([0-9a-f]{7})\|([\s\S]*)$/
const READ_NUMBERED = /^(\d+) ([\s\S]*)$/

function parseReadResult(result: string): ReadResult | null {
  const lines: ReadLine[] = []
  let hasHash = false
  for (const raw of result.split('\n')) {
    // 项目源码是 CRLF：按 \n 拆行后行尾会残留 \r，剥掉再匹配
    const line = raw.replace(/\r$/, '')
    const h = READ_HASHLINE.exec(line)
    if (h) {
      hasHash = true
      lines.push({ num: Number(h[1]), hash: h[2], text: h[3] })
      continue
    }
    // 无哈希格式：`行号 内容`。协议头（File: / Lines:）与尾部提示都不以数字开头，不会被误收。
    const n = READ_NUMBERED.exec(line)
    if (n) lines.push({ num: Number(n[1]), hash: '', text: n[2] })
  }
  return lines.length > 0 ? { lines, hasHash } : null
}

// ── Glob 结果的结构化形态 ──
// 项目里 Glob 有两套实现，输出格式不同（与 Read 同理）：
//   · mainTools.ts（主进程，pi 桥接）→ 裸列表：一行一个绝对路径，无表头；
//     空结果 `No files found.`；截断时尾部追加 `(结果已截断，仅显示前 N 项)`。
//   · GlobTool.ts（渲染进程）      → 首行 `找到 N 个文件：` + 路径 + `(...)` 注脚；
//     空结果 `未找到匹配的文件。` + 注脚。
// 两种都要认，否则会漏到原始渲染，把绝对路径整串摊出来。
type GlobResult = { paths: string[]; note?: string }

const GLOB_HEAD = /^找到 \d+ 个文件/
const GLOB_EMPTY = /^未找到匹配的文件/
const GLOB_NO_FILES = /^No files found\.?$/i
// 绝对路径必然含分隔符，用它区分「裸路径列表」与普通文本
const LOOKS_LIKE_PATH = /[\\/]/

function parseGlobResult(result: string): GlobResult | null {
  const lines = result.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean)
  if (lines.length === 0) return null

  const isHead = lines.some((l) => GLOB_HEAD.test(l))
  const isEmpty = lines.some((l) => GLOB_EMPTY.test(l))

  // 渲染进程格式：有表头
  if (isHead || isEmpty) {
    const paths: string[] = []
    const notes: string[] = []
    for (const l of lines) {
      if (GLOB_HEAD.test(l)) continue
      if (l.startsWith('(') || l.startsWith('（')) { notes.push(l); continue }
      if (isEmpty) { notes.push(l); continue }
      paths.push(l)
    }
    return { paths, note: notes.join('\n') || undefined }
  }

  // 主进程格式：裸列表（无表头）。至少一行像路径才认，避免把普通文本误当文件列表。
  const notes = lines.filter((l) => l.startsWith('(') || l.startsWith('（'))
  const paths = lines.filter((l) => !notes.includes(l) && !GLOB_NO_FILES.test(l))
  if (paths.length > 0 && paths.some((l) => LOOKS_LIKE_PATH.test(l))) {
    return { paths, note: notes.join('\n') || undefined }
  }
  if (lines.some((l) => GLOB_NO_FILES.test(l))) {
    return { paths: [], note: ['未找到匹配的文件。', ...notes].join('\n') }
  }
  return null
}

/** Write 流式预览的尾部窗口行数。用户要看的是「正在写到哪里」，不是从头读一份还在生成的文件。
 *  与主进程的 STREAM_WRITE_TAIL_LINES 是两层独立窗口：那层管过 IPC 的体积，这层管上屏的行数。 */
const STREAM_WRITE_PREVIEW_LINES = 60

export const ToolArgsView = React.memo(function ToolArgsView({ name, args, onPreviewFile, headFilePath, readRange, streaming = false }: { name: string; args: string; onPreviewFile: (p: string, line?: number) => void; headFilePath?: string; readRange?: { start: number; end: number; total?: number } | null; streaming?: boolean }) {
  const parsed = (() => { try { return JSON.parse(args) } catch { return null } })()
  // Write 的「写入内容」折叠状态（超过 12 行时才出现展开按钮）
  const [writeExpanded, setWriteExpanded] = useState(false)
  const filePath = name === 'Read' ? '' : (headFilePath || (parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : ''))
  const isFileEdit = !!parsed && (name === 'Write' || name === 'Edit')
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；用到的 return 分支里放 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  // get_datetime 没有任何参数（parameters 是空对象）：通用兜底会把 `{}` 原样打印成一个代码块，
  // 这里直接不渲染参数区，卡片只保留结果区。
  if (name === 'get_datetime') return null
  // view_image 的参数只有一个 file_path，已内联到卡片头部（图片图标 + 文件名，可点跳预览）：
  // 参数区不再重复。图片本体由结果区的 ViewImageResult 展示。
  if (name === 'view_image') return null
  // browser_show 的卡片只说明「这一次调用要打开什么」：文件路径 / 网址 / 内联 HTML 的体量。
  // 参数里的 html 是模型生成的整份文档，不再打印出来——源码看文件，效果看右侧预览区。
  if (name === 'browser_show' && parsed) {
    const p = parsed as Record<string, unknown>
    const html = typeof p.html === 'string' ? p.html : ''
    const rawPath = typeof p.path === 'string' ? p.path : ''
    const rawUrl = typeof p.url === 'string' ? p.url : ''
    const rawTitle = typeof p.title === 'string' ? p.title.trim() : ''
    const label = p.type === 'file' ? '打开项目文件' : p.type === 'url' ? '打开网址' : '显示 HTML 页面'
    // 文件路径按项目既有约定展示：目录段弱化 + 文件名加强（绝对路径会把真正要看的文件名挤掉）
    const rel = rawPath ? toWorkspaceRelative(rawPath).replace(/\\/g, '/') : ''
    const cut = rel.lastIndexOf('/')
    const dir = cut > 0 ? rel.slice(0, cut) : ''
    const base = cut > 0 ? rel.slice(cut + 1) : rel
    // 标题去重：模型常把 title 填成与文件名 / 网址一模一样的内容，那样会把同一个名字打印两遍；
    // 只有 title 真的提供了额外信息（例如给页面起的名字）时才单独显示。
    const titleRedundant = !rawTitle || rawTitle === rel || rawTitle === rawPath || rawTitle === base || rawTitle === rawUrl
    // 参数区沿用项目统一的「标签 | 值 | 注」三列参数框（与 Read / Grep / Glob / Write 同款容器），
    // 结构上与其他工具卡一致：一个描边参数框，逐行说明这次调用要打开什么。
    return (
      <div className="agent-tool-args">
        {tipNode}
        <div className="agent-tool-io-group">
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">操作</span>
            <span className="agent-tool-io-value">{label}</span>
            <span className="agent-tool-io-note">type={typeof p.type === 'string' ? p.type : '—'}</span>
          </div>
          {rel && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">文件</span>
              <span className="agent-tool-io-value" {...tip(rawPath)}>{rel}</span>
              <span className="agent-tool-io-note">{dir ? `位于 ${dir}/` : '项目根目录'}</span>
            </div>
          )}
          {rawUrl && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">网址</span>
              <span className="agent-tool-io-value" {...tip(rawUrl)}>{rawUrl}</span>
            </div>
          )}
          {!titleRedundant && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">标题</span>
              <span className="agent-tool-io-value">{rawTitle}</span>
              <span className="agent-tool-io-note">预览页显示名</span>
            </div>
          )}
          {html && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">内容</span>
              <span className="agent-tool-io-value">内联 HTML 文档</span>
              <span className="agent-tool-io-note">{html.length} 字符</span>
            </div>
          )}
        </div>
      </div>
    )
  }
  // browser_screenshot 的参数只有一个 fullPage 开关：摊成参数框一行，和其他工具同款容器。
  // 以前落到通用兜底，会把 {"fullPage":true} 原样打印出来。
  if (name === 'browser_screenshot' && parsed) {
    const fullPage = (parsed as Record<string, unknown>).fullPage === true
    return (
      <div className="agent-tool-args">
        <div className="agent-tool-io-group">
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">范围</span>
            <span className="agent-tool-io-value">{fullPage ? '完整可滚动页面' : '当前可视区域'}</span>
            <span className="agent-tool-io-note">{fullPage ? 'fullPage=true' : '默认（仅可视区域）'}</span>
          </div>
        </div>
      </div>
    )
  }
  // Read：把 offset / limit 摊成参数行，并把结果首部 `Lines: X-Y of N` 里的真实行段作为「范围」行。
  // 文件名不在这里重复 —— 它已经在卡片头部（沿用项目既有约定）。
  if (name === 'Read' && parsed) {
    const r = parsed as Record<string, unknown>
    const offset = typeof r.offset === 'number' ? r.offset : undefined
    const limit = typeof r.limit === 'number' ? r.limit : undefined
    const bare = offset === undefined && limit === undefined
    // 与 demo 一致：Read 的参数区是**裸**描边框，不加分区标题
    //（「⚙️ 执行参数」那层分区标题是 Grep 卡的形态）
    return (
      <div className="agent-tool-io-group">
        <div className="agent-tool-io">
          <span className="agent-tool-io-label">参数</span>
          <span className="agent-tool-io-value">
            {bare ? (
              '未指定'
            ) : (
              <>
                <span className="agent-tool-io-kv">
                  <i>offset</i>=<b>{offset ?? 1}</b>
                </span>
                <span className="agent-tool-io-kv">
                  <i>limit</i>=<b>{limit ?? 2000}</b>
                </span>
              </>
            )}
          </span>
          <span className="agent-tool-io-note">
            {bare ? '按默认读取（最多 2000 行）' : `从第 ${offset ?? 1} 行开始，往后读取 ${limit ?? 2000} 行`}
          </span>
        </div>
        {readRange && (
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">范围</span>
            <span className="agent-tool-io-value">
              第 {readRange.start}–{readRange.end} 行
            </span>
            <span className="agent-tool-io-note">{readRange.total ? `文件共 ${readRange.total} 行` : ''}</span>
          </div>
        )}
      </div>
    )
  }
  // Grep：把 pattern / path / output_mode 摊成四行「参数区」。
  // 用中文标签 + 双语术语，避免把 API 枚举值（files_with_matches）直接丢给用户；
  // 数据全部来自已解析的 args，不新增任何解析。
  if (name === 'Grep' && parsed) {
    const g = parsed as Record<string, unknown>
    const mode = typeof g.output_mode === 'string' ? g.output_mode : 'files_with_matches'
    const MODE_LABEL: Record<string, string> = {
      files_with_matches: '仅显示文件路径',
      content: '匹配行 + 行号',
      count: '只报数量',
    }
    const hasPath = typeof g.path === 'string' && g.path.length > 0
    const pathValue = hasPath ? (g.path as string) : '项目根目录'
    return (
      <div className="agent-tool-section">
        <div className="agent-tool-section-head">
          <span className="agent-tool-section-title">⚙️ 执行参数</span>
        </div>
        <div className="agent-tool-io-group">
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">搜索词</span>
            <span className="agent-tool-io-value">{String(g.pattern ?? '')}</span>
            <span className="agent-tool-io-note">
              <span className="agent-tool-flag">Aa</span>
              {g['-i'] === true ? '忽略大小写' : '区分大小写'}
            </span>
          </div>
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">范围</span>
            <span className="agent-tool-io-value">{pathValue}</span>
            <span className="agent-tool-io-note">{hasPath ? '仅限此目录' : '默认范围'}</span>
          </div>
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">模式</span>
            <span className="agent-tool-io-value">正则表达式</span>
            <span className="agent-tool-io-note">Regex</span>
          </div>
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">返回</span>
            <span className="agent-tool-io-value">{MODE_LABEL[mode] ?? mode}</span>
            <span className="agent-tool-io-note">{mode}</span>
          </div>
        </div>
      </div>
    )
  }
  // Glob：按文件名模式找文件（不匹配目录），参数只有 pattern / path 两个。
  // 与 Grep 同族，沿用「⚙️ 执行参数」分区形态。
  if (name === 'Glob' && parsed) {
    const g = parsed as Record<string, unknown>
    const hasPath = typeof g.path === 'string' && (g.path as string).length > 0
    return (
      <div className="agent-tool-section">
        <div className="agent-tool-section-head">
          <span className="agent-tool-section-title">⚙️ 执行参数</span>
        </div>
        <div className="agent-tool-io-group">
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">模式</span>
            <span className="agent-tool-io-value">{String(g.pattern ?? '')}</span>
            <span className="agent-tool-io-note">按 glob 匹配文件名，不匹配目录</span>
          </div>
          <div className="agent-tool-io">
            <span className="agent-tool-io-label">范围</span>
            <span className="agent-tool-io-value">
              {hasPath ? toWorkspaceRelative(g.path as string) : '项目根目录'}
            </span>
            <span className="agent-tool-io-note">{hasPath ? '仅在此目录内查找' : '未指定 path，默认搜项目根'}</span>
          </div>
        </div>
      </div>
    )
  }
  if (isFileEdit) {
    const writeContent = name === 'Write' && typeof parsed!.content === 'string' ? (parsed!.content as string) : null
    // 内容过大时不拆行：保留 LinedPre 的行窗口路径，避免一次性挂载上万个行节点
    const writeRows =
      writeContent !== null && writeContent.length <= LINED_PRE_WINDOW_CHARS ? writeContent.split('\n') : null
    const writeBytes = writeContent !== null ? new TextEncoder().encode(writeContent).length : 0
    const writeSize = writeBytes >= 1024 ? `${(writeBytes / 1024).toFixed(1)} KB` : `${writeBytes} B`
    const writeClipped = !!writeRows && writeRows.length > 12
    // Write 流式预览的语法：按目标文件扩展名推断（见 utils/highlightLines）。
    // 用参数里的路径而不是 headFilePath —— 后者已转成相对路径用于展示，直接读参数少一层耦合。
    const writeLang = langFromPath(
      typeof (parsed!.file_path ?? parsed!.path) === 'string' ? ((parsed!.file_path ?? parsed!.path) as string) : ''
    )
    // 流式尾部窗口：行号偏移 = 主进程注入的 __tailStart + 本层窗口裁剪偏移，相加才是真实行号。
    const streamTailStart = typeof parsed!.__tailStart === 'number' ? (parsed!.__tailStart as number) : 0
    const streamRows = writeContent !== null ? writeContent.split('\n') : []
    const streamTotalLines = streamTailStart + streamRows.length
    const streamWinStart = Math.max(0, streamRows.length - STREAM_WRITE_PREVIEW_LINES)
    return (
      <div className="agent-tool-args">
        {name === 'Write' && (
          <>
            {/* 模式行：Write 只能新建文件，这是它最容易踩的行为约束，单独占一行 */}
            <div className="agent-tool-io-group">
              <div className="agent-tool-io">
                <span className="agent-tool-io-label">模式</span>
                <span className="agent-tool-io-value">新建文件 · UTF-8</span>
                <span className="agent-tool-io-note">仅能新建（已存在会被拒绝），自动创建父目录</span>
              </div>
            </div>
            {streaming ? (
              // 流式态：尾部窗口 + 真实总行数 + 语法高亮。
              // 刻意与完成态分走两个分支 —— 完成态保留既有的「12 行折叠 + 展开」与 LinedPre 路径，
              // 不把流式改造扩大成一次 UI 重做。
              <div className="agent-tool-result">
                <div className="agent-tool-result-head">
                  <span className="agent-tool-result-label">写入内容</span>
                  <span className="agent-tool-result-actions">
                    <span className="agent-tool-result-meta">
                      {streamTotalLines} 行{streamWinStart > 0 ? ` · 显示末 ${STREAM_WRITE_PREVIEW_LINES} 行` : ''}
                    </span>
                  </span>
                </div>
                {writeContent === null ? (
                  <div className="agent-tool-content-empty">等待内容生成…</div>
                ) : (
                  <HighlightedCode
                    code={streamRows.slice(streamWinStart).join('\n')}
                    language={writeLang}
                    startLine={streamTailStart + streamWinStart + 1}
                    className="no-hash"
                    streaming
                  />
                )}
              </div>
            ) : writeRows ? (
              <div className="agent-tool-result">
                <div className="agent-tool-result-head">
                  <span className="agent-tool-result-label">写入内容</span>
                  <span className="agent-tool-result-actions">
                    <span className="agent-tool-result-meta">{writeSize}</span>
                    {writeClipped && (
                      <button type="button" className="agent-tool-btn" onClick={() => setWriteExpanded((v) => !v)}>
                        <ChevronDownIcon size={11} className={`agent-tool-subchev ${writeExpanded ? 'open' : ''}`} />
                        {writeExpanded ? '收起' : `展开（12 / ${writeRows.length} 行）`}
                      </button>
                    )}
                  </span>
                </div>
                {/* 新建文件的写入内容从第 1 行起连续编号，走默认的 CSS 计数器 */}
                <div className={`agent-tool-code no-hash is-clipped${writeExpanded ? ' expanded' : ''}`}>
                  {writeRows.map((text, i) => (
                    <div className="agent-tool-code-row" key={i}>
                      <span className="agent-tool-code-num" />
                      <span className="agent-tool-code-text">{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              writeContent !== null && (
                <div className="agent-tool-content">
                  <div className="agent-tool-content-head"><span>写入内容</span></div>
                  <LinedPre text={writeContent} maxHeight={360} />
                </div>
              )
            )}
          </>
        )}
        {name === 'Edit' && (() => {
          // 兼容两代参数：自研旧式 old_string/new_string，pi 原生 path + edits[]（一次多处）。
          // 流式期间参数是半截的（old_string 已写完而 new_string 还没开始，或反之），所以刻意
          // 不再要求「两侧同时是 string」—— 旧守卫会让整个 diff 在参数生成的前半程消失。
          // 缺失的一侧视作空串，渲染「渐进 diff」，等另一侧开始生成再补上。
          const oldStr = typeof parsed!.old_string === 'string' ? (parsed!.old_string as string) : null
          const newStr = typeof parsed!.new_string === 'string' ? (parsed!.new_string as string) : null
          const single = oldStr !== null || newStr !== null
          const edits = Array.isArray(parsed!.edits)
            ? (parsed!.edits as Array<{ oldText?: unknown; newText?: unknown }>).filter(
              (e) => e && (typeof e.oldText === 'string' || typeof e.newText === 'string')
            )
            : []
          const count = single ? 1 : edits.length
          if (count === 0) return null
          // 恰好一处时不套「编辑 1」子标题。单元素 edits[] 才是常态（pi 的 Edit 提示词已改成
          // 「一次调用只改一处」），真正的多 edit 只剩历史消息或模型未遵守时才会出现。
          const oneShot = count === 1
          const onlyOld = oldStr ?? (typeof edits[0]?.oldText === 'string' ? (edits[0]!.oldText as string) : '')
          const onlyNew = newStr ?? (typeof edits[0]?.newText === 'string' ? (edits[0]!.newText as string) : '')
          return (
            <>
              {/* 编辑处数：处数决定下面会出现几个 diff */}
              <div className="agent-tool-io-group">
                <div className="agent-tool-io">
                  <span className="agent-tool-io-label">编辑</span>
                  <span className="agent-tool-io-value">{count} 处</span>
                  <span className="agent-tool-io-note">
                    {streaming
                      ? '参数生成中 · 内容实时预览'
                      : oneShot ? '单处替换' : 'edits[] 逐条替换'}
                  </span>
                </div>
              </div>
              {oneShot ? (
                <ToolEditDiff oldText={onlyOld} newText={onlyNew} streaming={streaming} />
              ) : (
                <div className="agent-tool-edits">
                  {edits.map((e, i) => (
                    <div className="agent-tool-edit" key={i}>
                      <div className="agent-tool-content-head"><span>编辑 {i + 1}</span></div>
                      <ToolEditDiff
                        oldText={typeof e.oldText === 'string' ? e.oldText : ''}
                        newText={typeof e.newText === 'string' ? e.newText : ''}
                        streaming={streaming}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        })()}
        {/* Write/Edit 的文件名已内联到卡片头部（可点跳预览），展开体不再重复渲染文件名行 */}
      </div>
    )
  }
  const formatted = formatToolArgs(args)
  if (!formatted && !filePath) return null
  return (
    <div className="agent-tool-args">
      {tipNode}
      {formatted && <pre className="agent-tool-args-pre">{formatted}</pre>}
      {filePath && (
        <div className="agent-tool-filebar">
          <button className="agent-tool-call-path" {...tip(filePath)} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(filePath)) }}>
            <span className="agent-tool-file-icon" style={{ color: fileMeta(dirName(filePath)).color }}>{(() => { const { Icon: FIcon } = fileMeta(dirName(filePath)); return <FIcon size={12} /> })()}</span>{filePath}
          </button>
        </div>
      )}
    </div>
  )
})

// 非行号结果的窗口参数：行高与 .agent-tool-result-window 的 11px × line-height 1.5 对齐
// （见 styles/agent-code.css 末尾「长内容行窗口：固定行高契约」），视口高度对齐原 max-height。
const TOOL_RESULT_WINDOW_ROW_HEIGHT = 17
const TOOL_RESULT_WINDOW_VIEW_HEIGHT = 360

// 取前 n 行的有界前缀：不 split 全文——超大文本 split('\n') 会生成与行数同量的字符串对象，
// 正是这一步要避免的开销。
function boundedHead(text: string, n: number): string {
  let pos = 0
  for (let i = 0; i < n; i += 1) {
    const next = text.indexOf('\n', pos)
    if (next === -1) return text
    pos = next + 1
  }
  return text.slice(0, pos) + '…'
}

export const ToolResultView = React.memo(function ToolResultView({ result, truncated, total, lined, grep, glob, readLines, readRange, onPreviewFile }: { result: string; truncated?: boolean; total?: number; lined?: boolean; grep?: GrepResult | null; glob?: GlobResult | null; readLines?: ReadResult | null; readRange?: { start: number; end: number; total?: number } | null; onPreviewFile?: (p: string, line?: number) => void }) {
  // 所有工具结果默认收起，点击「展开」才显示完整内容
  const [expanded, setExpanded] = useState(false)
  // 超长结果不 split：阈值判断只看字符数，这样不必先 split 全文就能决定走不走窗口。
  const oversized = result.length > LINED_PRE_WINDOW_CHARS
  const lines = useMemo(() => (oversized ? null : result.split('\n')), [result, oversized])
  const lineCount = lines ? lines.length : 0
  // 收起预览：>12 行显示前 12 行；2~12 行多行结果折叠为首行预览；单行无需收起。
  // 注意 collapsed 不能只按 >12 行判定，否则 ≤12 行的短结果点「收起」内容不变、按钮看似无效。
  const isLong = lines ? lineCount > 12 : true
  const isMulti = lines ? lineCount > 1 : true
  const shownText = expanded
    ? result
    : lines
      ? (isLong ? lines.slice(0, 12).join('\n') + '\n…' : (isMulti ? lines.slice(0, 1).join('\n') + '\n…' : result))
      : boundedHead(result, 12)
  // 超长结果的「行数」无法廉价获得（那要先 split 全文），改报字符数。
  const meta = truncated ? `已截断，共 ${total} 字符` : (lines ? `共 ${lineCount} 行` : `共 ${result.length} 字符`)
  // 展开 + 超长 + 非行号：走行窗口，只挂载视口附近的行（行号类由 LinedPre 自己处理）。
  const windowed = expanded && oversized && !lined
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；用到的 return 分支里放 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  // Read 结果：三列（文件真实行号 | 行锚点 | 内容），协议头（File: / Lines:）不再进正文。
  // 超过 12 行折叠为前 12 行，与结果区共用同一个展开状态。
  if (readLines) {
    const readRows = readLines.lines
    const hasHash = readLines.hasHash
    const clipped = readRows.length > 12
    const unread = readRange?.total ? readRange.total - readRows.length : 0
    return (
      <div className="agent-tool-result">
        {tipNode}
        <div className="agent-tool-result-head">
          <span className="agent-tool-result-label">结果</span>
          <span className="agent-tool-result-actions">
            <span
              className="agent-tool-result-legend"
              {...tip(
                hasHash
                  ? '左列为文件真实行号；中列为行内容指纹（FNV-1a 取 7 位十六进制），Edit 用它定位该行'
                  : '左列为文件真实行号'
              )}
            >
              {hasHash ? '行号 + 行锚点' : '行号'}
            </span>
            {clipped && (
              <button type="button" className="agent-tool-btn" onClick={() => setExpanded((v) => !v)}>
                <ChevronDownIcon size={11} className={`agent-tool-subchev ${expanded ? 'open' : ''}`} />
                {expanded ? '收起' : `展开（12 / ${readRows.length} 行）`}
              </button>
            )}
          </span>
        </div>
        {/* 无哈希格式（主进程 Read）不渲染锚点列，走 no-hash 变体：行号列自带发丝线 */}
        <div className={`agent-tool-code no-counter${hasHash ? '' : ' no-hash'} is-clipped${expanded ? ' expanded' : ''}`}>
          {readRows.map((l) => (
            <div className="agent-tool-code-row" key={l.num}>
              <span className="agent-tool-code-num">{l.num}</span>
              {hasHash && <span className="agent-tool-code-hash">{l.hash}</span>}
              <span className="agent-tool-code-text">{l.text}</span>
            </div>
          ))}
        </div>
        {unread > 0 && readRange && (
          <div className="agent-tool-code-more">
            文件其余 {unread} 行未读取 · 继续读用 offset={readRange.end + 1}，定位目标代码更推荐先用 Grep
          </div>
        )}
      </div>
    )
  }
  // Glob 结果：文件列表，与 Grep 的 files_with_matches 同形（路径只出现一次 + 尾部注脚）
  if (glob) {
    return (
      <div className="agent-tool-section">
        {tipNode}
        <div className="agent-tool-section-head">
          <span className="agent-tool-section-title">📂 匹配结果（{glob.paths.length} 个文件）</span>
        </div>
        {glob.paths.length > 0 ? (
          <div className="agent-tool-paths">
            {glob.paths.map((p) => (
              <button
                key={p}
                type="button"
                className="agent-tool-paths-row"
                {...tip(p)}
                onClick={() => onPreviewFile?.(resolveWorkspacePath(p))}
              >
                <span className="agent-tool-paths-name">{dirName(p)}</span>
                {/* 展示用工作区相对路径；title 与点击跳转仍用原绝对路径 */}
                <span className="agent-tool-paths-full">{toWorkspaceRelative(p)}</span>
                <span className="agent-tool-paths-hint">（点击文件名可在编辑器中打开）</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="agent-tool-note">{glob.note || '未找到匹配的文件。'}</div>
        )}
        {glob.paths.length > 0 && glob.note && <div className="agent-tool-code-more">{glob.note}</div>}
      </div>
    )
  }
  // Grep 结果的结构化渲染：文件路径只出现一次，命中行按真实行号列出。
  // 注意：必须放在所有 hook 之后，否则两条 return 路径的 hook 顺序不一致。
  if (grep) {
    const hitCount =
      grep.kind === 'files' ? grep.paths.length : grep.groups.reduce((n, g) => n + g.hits.length, 0)
    const fileCount = grep.kind === 'files' ? grep.paths.length : grep.groups.length
    const summary = grep.kind === 'files' ? `${fileCount} 个文件` : `${hitCount} 处 · ${fileCount} 个文件`
    return (
      <div className="agent-tool-section">
        {tipNode}
        <div className="agent-tool-section-head">
          <span className="agent-tool-section-title">📂 匹配结果（{summary}）</span>
        </div>
        {hitCount === 0 ? (
          <div className="agent-tool-note">
            没有命中任何文件。可放宽 path 范围、换更短的关键词，或确认该符号确实存在。
          </div>
        ) : grep.kind === 'files' ? (
          <div className="agent-tool-paths">
            {grep.paths.map((p) => (
              <button
                key={p}
                type="button"
                className="agent-tool-paths-row"
                {...tip(p)}
                onClick={() => onPreviewFile?.(resolveWorkspacePath(p))}
              >
                <span className="agent-tool-paths-name">{dirName(p)}</span>
                <span className="agent-tool-paths-full">{toWorkspaceRelative(p)}</span>
                <span className="agent-tool-paths-hint">（点击文件名可在编辑器中打开）</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {grep.groups.map((g) => (
              <div className="agent-tool-paths" key={g.path}>
                {/* 文件路径在这里只出现一次 —— 原生格式是每行都重复一遍绝对路径，
                    真正的内容会被路径前缀淹掉 */}
                <button
                  type="button"
                  className="agent-tool-paths-row"
                  {...tip(g.path)}
                  onClick={() => onPreviewFile?.(resolveWorkspacePath(g.path))}
                >
                  <span className="agent-tool-paths-name">{dirName(g.path)}</span>
                  <span className="agent-tool-paths-full">{toWorkspaceRelative(g.path)}</span>
                </button>
                <div className="agent-tool-code no-hash no-counter">
                  {g.hits.map((h) => (
                    <div className="agent-tool-code-row" key={h.line}>
                      <span className="agent-tool-code-num">{h.line}</span>
                      <span className="agent-tool-code-text">{h.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {grep.note && <div className="agent-tool-code-more">{grep.note}</div>}
          </>
        )}
      </div>
    )
  }
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">结果（{meta}）</span>
        <button className="agent-tool-subtoggle" onClick={() => setExpanded(v => !v)}>
          <ChevronRightIcon size={11} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
          {expanded ? '收起' : (isLong ? `展开（显示前 12 / ${meta}）` : (isMulti ? `展开（显示首行 / ${meta}）` : '展开'))}
        </button>
      </div>
      {lined ? (
        <LinedPre text={shownText} />
      ) : windowed ? (
        <WindowedText
          text={result}
          rowHeight={TOOL_RESULT_WINDOW_ROW_HEIGHT}
          viewHeight={TOOL_RESULT_WINDOW_VIEW_HEIGHT}
          className="agent-window agent-tool-result-window"
          rowAttr="data-tool-row"
          ariaLabel={`工具结果（窗口渲染，共 ${result.length} 字符）`}
        />
      ) : (
        <pre className="agent-tool-result-pre">{shownText}</pre>
      )}
    </div>
  )
})

// 流式生成阶段的工具状态（写入/修改/调用参数生成中）统一改由输入框上方的常驻状态栏展示，
// 会话区不再内联渲染生成状态行；此处仅保留 genToolVerb 供状态栏取用。

export const ToolCallCard = React.memo(function ToolCallCard({ tc, index, total, onPreviewFile, canUndo, onUndo }: { tc: NonNullable<AgentMessage['toolCalls']>[number]; index: number; total: number; onPreviewFile: (p: string, line?: number) => void; canUndo?: boolean; onUndo?: () => void }) {
  const meta = TOOL_META[tc.name]
  const Icon = meta?.icon || Wrench
  // 状态：await_approval(待人工确认) / executing(执行中) / done(已完成)。
  // 「待执行/参数生成中」阶段卡片不渲染（由输入框上方常驻状态栏展示，见下方渲染门控）；
  // 执行中显示状态徽标（verb，如「写入中」），完成后显示结果卡片。
  const status = tc.status || (tc.result != null ? 'done' : 'pending')
  const awaiting = status === 'await_approval'
  const executing = status === 'executing'
  const pending = status === 'pending'
  const done = status === 'done'
  const failed = done && !!tc.failed
  // 参数是否仍在逐 token 生成。由 useAgentLoop 在 onToolCallArgs 里显式置 false、
  // 在 toolcall_end 置 true；历史消息（无该字段）为 undefined → 一律视为非流式，
  // 否则旧会话每次打开都会被判成「生成中」，白白走一遍流式态渲染与节流。
  const argsStreaming = tc.argsComplete === false
  const canRestore = done && canUndo && !tc.restored && BACKUP_TOOLS.has(tc.name)
  // 展开/收起动画：与 ThinkBlock 同方案——由 useCollapseAnimation 提供
  // handleToggle / onBodyTransitionEnd。裁剪层 max-height 像素过渡，首次展开后保持挂载
  // （visible），收起只收到 0 不卸载，避免 diff/高亮重解析卡顿。
  // 工具卡始终默认收起：是否展开由用户逐卡手动决定，无全局批量开关。
  const bodyRef = useRef<HTMLDivElement>(null)
  // 注意：Write/Edit 流式期间**不自动展开**。曾试过按 useCollapseAnimation 注释里的
  // 「自动展开」约定接上，但实时预览每帧长高、卡片会持续把界面顶开，打断阅读；且与
  // 上面「工具卡始终默认收起」的既有约定冲突。改动仍在卡片里照常渲染（含实时 diff /
  // 尾部窗口高亮），用户点一下就能看到，展开后是实时跟进的。
  const { expanded, visible, onBodyTransitionEnd, toggle: handleToggle } =
    useCollapseAnimation(bodyRef)

  const parsed = useMemo(() => { try { return JSON.parse(tc.args || '{}') } catch { return null } }, [tc.args])
  const preview = getToolPreview(parsed)
  // 编辑工具的增删行数统计（显示在工具卡片上方，类似 git diff 的 +N -M）。
  // 实现收敛在模块级 getEditDiffStat（内部跑 LCS diff + 按 tc.id 缓存），与
  // FileChangeSummary 的汇总共用同一份结果，避免同一 args 被算两遍。
  // 依赖仍按 [tc.name, parsed] 而非 [tc]：parsed 由 tc.args 派生，仅在参数真正变化时
  // 变化；以 tc 为依赖会因状态流转换对象而每次重算（缓存能挡住，但白付一次查表）。
  const editDiffStat = useMemo(() => getEditDiffStat(tc), [tc.name, parsed])
  // 参数还在逐 token 生成时（parsed 出不来）用主进程数出来的行数兜一下，头部不至于空着
  const shownDiffStat = editDiffStat ?? tc.streamStat
  // Bash 命令：独立成「执行命令」区块，上限从 400 放宽到 1200 字符（原上限会把多行命令截掉）；
  // 超出仍截断兜底，高度由 CSS 的 max-height 控制，长命令在框内滚动。
  const bashCmd = (() => {
    if (tc.name !== 'Bash') return null
    const c = parsed && typeof parsed.command === 'string' ? parsed.command : null
    return c && c.length > 1200 ? c.slice(0, 1200) + '\n…' : c
  })()
  // Bash 输出：超长结果按 LINED_PRE_WINDOW_CHARS 截断（避免一次性挂满 DOM），
  // 高度由 CSS 的 max-height 控制（框内滚动），不再把整张卡片拉长。
  const bashOut = (() => {
    if (tc.name !== 'Bash' || !done || typeof tc.result !== 'string' || !tc.result) return null
    return tc.result.length > LINED_PRE_WINDOW_CHARS
      ? tc.result.slice(0, LINED_PRE_WINDOW_CHARS) + '\n…（输出过长，已截断显示）'
      : tc.result
  })()
  // 输出区右上角量化指标：小结果给行数；超长结果不 split（那正是要避免的一次性开销），改报字符数
  const bashOutMeta = (() => {
    if (tc.name !== 'Bash' || !done || typeof tc.result !== 'string' || !tc.result) return null
    const r = tc.result
    return r.length > LINED_PRE_WINDOW_CHARS ? `共 ${r.length} 字符` : `${r.split('\n').length} 行`
  })()
  // Read/Write/Edit 统一：文件名内联到头部（文件树同款图标 + 可点跳预览），替代纯文字参数预览。
  let readFilePath = tc.name === 'Read' && parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : ''
  if (tc.name === 'Read' && typeof tc.result === 'string') {
    const firstLine = tc.result.split('\n')[0] || ''
    const m = /^File:\s*(.+)$/i.exec(firstLine)
    if (m) readFilePath = m[1].trim()
  }
  // 头部展示统一用工作区相对路径：Read 结果的 `File:` 头是绝对路径（absForDisplay），
  // Write/Edit 的参数也可能是绝对路径 —— 绝对路径会把真正要看的文件名挤掉。
  // 点击预览时再由 resolveWorkspacePath 还原成绝对路径，所以这里只影响显示。
  const headFilePath = toWorkspaceRelative(
    readFilePath ||
    // Write/Edit 的参数、以及 view_image 的 file_path：都内联到卡片头部
    ((WRITE_EDIT_TOOLS.has(tc.name) || tc.name === 'view_image') && parsed && typeof (parsed.file_path ?? parsed.path) === 'string'
      ? (parsed.file_path ?? parsed.path) as string
      : '')
  )
  // 目录段：pathDir 在「无分隔符」时会把整个路径原样返回（根目录下的文件），
  // 直接用会渲染成 `style.css/style.css`，所以只在真的存在目录段时才取
  const headFileDir = headFilePath && pathDir(headFilePath) !== headFilePath ? pathDir(headFilePath) : ''
  // Read 实际读取的行段（结果头 Lines: x-y 解析）：头部展示「文件名:x-y」、点击文件名跳转到起始行。
  // 行段取自执行结果而非参数，是钳制后的真实范围；同一文件多次分片读取时借此区分各卡片。
  const readRange = (() => {
    if (tc.name !== 'Read' || !done || typeof tc.result !== 'string') return null
    const m = tc.result.match(/^Lines: (\d+)-(\d+)(?: of (\d+))?/m)
    return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] ? Number(m[3]) : undefined } : null
  })()
  // Read 结果拆成「真实行号 | 行锚点 | 内容」三列渲染。超大结果不拆 ——
  // 保留 LinedPre 的行窗口路径，避免一次性挂载上万个行节点。
  const readLines = (() => {
    if (tc.name !== 'Read' || !done || tc.failed || typeof tc.result !== 'string') return null
    if (tc.result.length > LINED_PRE_WINDOW_CHARS) return null
    return parseReadResult(tc.result)
  })()
  // Write/Edit 成功结果只是一句确认文案，与头部绿勾「完成」重复，隐藏结果块；
  // 写入内容预览 / diff（来自参数）照常展示，失败时仍显示错误结果块。
  // Read 成功结果保留展示（ToolResultView 默认折叠为 12 行预览，可展开），供审计模型实际读到的内容。
  const hideResult = done && !failed && WRITE_EDIT_TOOLS.has(tc.name)
  // Grep 结果按 output_mode 结构化：files_with_matches → 文件列表；content → 按文件分组的命中行。
  // output_mode 缺省即 files_with_matches（与 GrepTool 默认值一致）；count 仍走原文渲染。
  const grepResult = (() => {
    if (tc.name !== 'Grep' || !done || tc.failed || typeof tc.result !== 'string') return null
    const mode = parsed && typeof parsed.output_mode === 'string' ? parsed.output_mode : 'files_with_matches'
    return parseGrepResult(tc.result, mode)
  })()
  // Glob 结果按「文件列表」结构化（与 Grep 的 files_with_matches 同形）
  const globResult = (() => {
    if (tc.name !== 'Glob' || !done || tc.failed || typeof tc.result !== 'string') return null
    return parseGlobResult(tc.result)
  })()

  // ── 卡片渲染门控 ──
  // 工具声明（pending）即渲染卡片（与参考项目 Reasonix 的 ToolCard 一致：dispatch 即显示），
  // 状态全程可见：待执行 → 写入中/修改中（verb）→ 完成，执行中的状态不会一闪而过。
  const showCard = done || awaiting || executing || pending
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  if (!showCard) return null

  return (
    <>
      {tipNode}
      {/* 执行时长已并入卡头 meta 区（.agent-tool-call-dur），不再在卡片上方单独占一行——
          使工具卡折叠态严格是一行，与思考段「Thought: 515ms」、批头「执行工具 N 次 · 1.8s」
          的「一行 + 可展开」形态对齐 */}
      <div className={`agent-tool-call tool-${tc.name.toLowerCase()}${failed ? ' failed' : ''}${executing ? ' executing' : ''}${pending ? ' pending' : ''}`}>
        <div className="agent-tool-call-head" onClick={handleToggle}>
          <span className="agent-tool-call-icon">
            <Icon size={13} />
          </span>
          <span className="agent-tool-call-name">{tc.name}</span>
          {/* Read/Write/Edit：文件名直接内联到头部（文件树同款图标 + 可点跳预览）。
              Read 完成后附行段「文件名:x-y」，点击跳转到读取起始行——与模型实际读到的片段对上 */}
          {headFilePath ? (
            <button className="agent-tool-call-path" {...tip(headFilePath)} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(headFilePath), readRange?.start) }}>
              <span className="agent-tool-file-icon" style={{ color: fileMeta(dirName(headFilePath)).color }}>{(() => { const { Icon: FIcon } = fileMeta(dirName(headFilePath)); return <FIcon size={12} /> })()}</span>
              {/* 路径三段式：目录弱化、文件名加强。路径过长被截断时截的是目录而不是文件名，
                  行段做成中性 chip（此前是 `:7-19` 这种带冒号的纯文本，看不出是独立参数） */}
              <span className="agent-tool-call-pathlabel">
                {headFileDir && <span className="agent-tool-call-pathdir">{headFileDir}/</span>}
                <span className="agent-tool-call-pathname">{dirName(headFilePath)}</span>
              </span>
              {readRange && <span className="agent-tool-call-linerange">{readRange.start}-{readRange.end}</span>}
            </button>
          ) : (
            preview && <span className="agent-tool-call-preview">{preview}</span>
          )}
          {total > 1 && <span className="agent-tool-call-step">步骤 {index + 1}/{total}</span>}
          <span className="agent-tool-call-meta">
            {shownDiffStat && (
              <span className="agent-tool-diffstat">
                {/* 分项条件渲染：Write 只能新增，只出 +N；Edit 有删有增才出 -M */}
                {shownDiffStat.added > 0 && <span className="diff-add">+{shownDiffStat.added}</span>}
                {shownDiffStat.removed > 0 && <span className="diff-del">-{shownDiffStat.removed}</span>}
              </span>
            )}
            {/* 该工具的执行时长（elapsed）：并入卡头、紧邻状态徽标——与思考段折叠头的
                「Thought: 515ms」、批头的「执行工具 N 次 · 1.8s」同一套橙色等宽标签风格 */}
            {done && tc.durationMs != null && (
              <span className="agent-tool-call-dur">{formatDuration(tc.durationMs)}</span>
            )}
            {executing ? (
              <span className="agent-tool-call-status run"><LoaderIcon size={12} className="spin" /> {TOOL_METAS[tc.name]?.verb || '执行中'}</span>
            ) : awaiting ? (
              <span className="agent-tool-call-status confirm"><ClockIcon size={12} /> 待确认</span>
            ) : pending ? (
              // 参数流式生成中（toolcall_start 后 args 为空）显示「参数生成中」；
              // 参数完整待执行时显示「待执行」——卡片从参数生成起就可见（参考项目同款）
              <span className="agent-tool-call-status pending">
                {tc.args ? <ClockIcon size={12} /> : <LoaderIcon size={12} className="spin" />}
                {tc.args ? '待执行' : '参数生成中'}
              </span>
            ) : failed ? (
              <span className="agent-tool-call-status err"><XIcon size={12} /> 失败</span>
            ) : (
              <span className="agent-tool-call-status ok"><CheckIcon size={12} /> 完成</span>
            )}
            {canRestore && (
              <button className="agent-tool-undo" {...tip('撤销仅本次运行内有效，重启应用后不可用')} onClick={(e) => { e.stopPropagation(); onUndo?.() }}>
                <Undo2 size={12} /> 恢复
              </button>
            )}
            {tc.restored && (
              <span className="agent-tool-restored"><CheckIcon size={12} /> 已恢复</span>
            )}
            <ChevronRightIcon size={12} className={`agent-tool-chev ${expanded ? 'open' : ''}`} />
          </span>
        </div>
        {visible && (
          <div className="agent-tool-call-anim" ref={bodyRef} onTransitionEnd={onBodyTransitionEnd}>
            <div className="agent-tool-call-body">
              {/* Bash：拆成「执行命令」与「输出结果」两个独立区块，各带标签头。
                  命令是工具的参数（command 字段），走描边面（与 Read / Grep / Write 的参数框同一套）；
                  输出是内容，走填充面（--code-bg）。不再共用一个深色终端框——
                  深色底原本是为了在同一个框里把命令条与输出区分开，拆成两块后不再需要。
                  输出区限高 + 内部滚动，长输出不再把整张卡片拉长。 */}
              {tc.name === 'Bash' && bashCmd && (
                <>
                  <div className="agent-tool-result">
                    <div className="agent-tool-result-head">
                      <span className="agent-tool-result-label">执行命令</span>
                    </div>
                    <div className="agent-tool-term-cmd"><span className="ps">$</span> {bashCmd}</div>
                  </div>
                  <div className="agent-tool-result">
                    <div className="agent-tool-result-head">
                      <span className="agent-tool-result-label">输出结果</span>
                      <span className="agent-tool-result-actions">
                        {executing
                          ? <span className="agent-tool-result-running">● 流式接收中</span>
                          : bashOutMeta && <span className="agent-tool-result-meta">{bashOutMeta}</span>}
                      </span>
                    </div>
                    {bashOut != null
                      ? <pre className="agent-tool-term-out">{bashOut}</pre>
                      : <div className="agent-tool-note">{executing ? '等待输出…' : '（无输出）'}</div>}
                  </div>
                </>
              )}
              {/* fetch_webpage 的唯一参数就是 url：它已经在卡头预览里，结果卡的来源行还会再
                  给一次（带站点图标、可点外开），所以不再渲染 JSON 参数块 —— 那只是一份重复 */}
              {!CUSTOM_ARGS_TOOLS.has(tc.name) && <ToolArgsView name={tc.name} args={tc.args} onPreviewFile={onPreviewFile} headFilePath={headFilePath} readRange={readRange} streaming={argsStreaming} />}
              {(tc.name === 'web_search' || tc.name === 'web_search_bing') && (executing || done) && (
                <WebSearchResults
                  result={done ? tc.result ?? undefined : undefined}
                  query={parsed && typeof parsed.query === 'string' ? parsed.query : undefined}
                  loading={executing}
                />
              )}
              {/* 抓取网页：结构化结果卡（来源行 + 分段正文 + 字符数），不再把
                  {url, content} 那一整行 JSON 原样铺开。执行中也渲染，好让来源行先出现 */}
              {tc.name === 'fetch_webpage' && (executing || done) && (
                <FetchWebpageResult
                  url={parsed && typeof parsed.url === 'string' ? parsed.url : undefined}
                  result={done ? tc.result ?? undefined : undefined}
                  loading={executing}
                />
              )}
              {tc.name === 'browser_screenshot' && done && <BrowserScreenshotResult result={tc.result} />}
              {tc.name === 'browser_show' && done && <BrowserShowResult result={tc.result} />}
              {/* view_image：图片直接内联在卡里（右侧预览面板同时也会展开，两边都展示） */}
              {tc.name === 'view_image' && done && <ViewImageResult result={tc.result} />}
              {/* get_datetime 结果就是 {date, time}：摊成横向键值行（日期 / 时间），不再打印原始 JSON */}
              {tc.name === 'get_datetime' && done && <JsonResultCard result={tc.result} />}
              {/* Bash 的结果已并入终端块；其余专属结果卡见模块顶部的 CUSTOM_RESULT_TOOLS，
                  这里一并排除，避免同一份结果渲染两遍 */}
              {done && !hideResult && !CUSTOM_RESULT_TOOLS.has(tc.name) && (
                <ToolResultView result={tc.result!} truncated={tc.truncated} total={tc.resultTotal} lined={tc.name === 'Read'} grep={grepResult} glob={globResult} readLines={readLines} readRange={readRange} onPreviewFile={onPreviewFile} />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
})

export const ToolCallGroup = React.memo(function ToolCallGroup({ toolCalls, onPreviewFile, canUndoFor, onUndo }: { toolCalls: NonNullable<AgentMessage['toolCalls']>; onPreviewFile: (p: string, line?: number) => void; canUndoFor?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => boolean; onUndo?: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => void }) {
  return (
    <div className="agent-tool-list">
      {toolCalls.map((tc, i) => <ToolCallCard key={tc.id || i} tc={tc} index={i} total={toolCalls.length} onPreviewFile={onPreviewFile} canUndo={canUndoFor ? canUndoFor(tc) : false} onUndo={onUndo ? () => onUndo(tc) : undefined} />)}
    </div>
  )
})

// ── 消息底部「文件变更汇总」──
// 一条助手消息内所有成功且未被撤销的 Write/Edit 按文件聚合增删行数，
// 在消息底部统一展示：头部「N 个文件已变更 +X -Y」，每文件一行
// （文件树同款图标 + 文件名 + 该文件增删，点击跳「变更」面板定位到该文件的 diff）。
// 默认折叠：折叠态头部右侧仅「撤销」（一键写回本次修改前的原文件内容）；
// 展开后文件竖排列表，每行右侧「审查」该文件的改动。
export const FileChangeSummary = React.memo(function FileChangeSummary({ toolCalls, onOpenChange, canUndoAll, onUndoAll }: { toolCalls?: AgentMessage['toolCalls']; onOpenChange: (p: string) => void; canUndoAll?: boolean; onUndoAll?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const files = useMemo(() => {
    if (!toolCalls?.length) return []
    // status：Write 仅能新建文件（已存在会被拒）→ A；只有 Edit → M；先 Write 后 Edit 仍算新增 A
    const map = new Map<string, { path: string; added: number; removed: number; status: 'A' | 'M' }>()
    for (const tc of toolCalls) {
      const status = tc.status || (tc.result != null ? 'done' : 'pending')
      if (status !== 'done' || tc.failed || tc.restored || !WRITE_EDIT_TOOLS.has(tc.name)) continue
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(tc.args || '{}') } catch { continue }
      if (!parsed || typeof parsed !== 'object') continue
      const fp = typeof parsed.file_path === 'string' ? parsed.file_path : typeof parsed.path === 'string' ? parsed.path : ''
      if (!fp) continue
      let added = 0
      let removed = 0
      if (tc.name === 'Edit') {
        // 与工具卡片共用同一份统计（getEditDiffStat 按 tc.id 缓存）：
        // 卡片在上方已经算过，这里直接命中，不再跑第二遍 LCS。
        const stat = getEditDiffStat(tc)
        if (stat) {
          added = stat.added
          removed = stat.removed
        }
      } else if (tc.name === 'Write' && typeof parsed.content === 'string') {
        // Write 无旧内容可比，按写入行数计为新增
        added = parsed.content.split('\n').length
      }
      if (added === 0 && removed === 0) continue
      const prev = map.get(fp)
      if (prev) {
        prev.added += added
        prev.removed += removed
        if (tc.name === 'Write') prev.status = 'A'
      } else {
        map.set(fp, { path: fp, added, removed, status: tc.name === 'Write' ? 'A' : 'M' })
      }
    }
    return [...map.values()]
  }, [toolCalls])
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  if (files.length === 0) return null
  const totalAdded = files.reduce((s, f) => s + f.added, 0)
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0)
  return (
    <div className={`agent-file-changes${expanded ? ' expanded' : ''}`}>
      {tipNode}
      <div className="agent-file-changes-head" onClick={() => setExpanded(v => !v)} role="button" tabIndex={0} {...tip(expanded ? '收起文件变更' : '展开文件变更')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}>
        <ChevronRightIcon size={12} className={`agent-file-changes-chev${expanded ? ' open' : ''}`} />
        {/* 文件差异图标：与「变更」语义对应，强化卡片身份 */}
        <FileDiff size={13} className="agent-file-changes-head-icon" />
        <span>{files.length} 个文件已变更</span>
        <span className="agent-tool-diffstat">
          {totalAdded > 0 && <span className="diff-add">+{totalAdded}</span>}
          {totalRemoved > 0 && <span className="diff-del">-{totalRemoved}</span>}
        </span>
        {/* 头部右侧「撤销」：折叠/展开态均可用，一键写回本次修改前的原文件内容（仅当前会话内存备份有效）。
            disabled 的按钮收不到鼠标事件，事件挂外层 span 保住提示（常驻包裹，disabled 翻转不重挂） */}
        <span style={{ display: 'inline-flex' }} {...tip('撤销本次全部修改（仅当前会话内存备份有效）')}>
          <button className="agent-file-changes-undo" aria-label="撤销本次全部修改" disabled={!canUndoAll} onClick={e => { e.stopPropagation(); onUndoAll?.() }}>
            <Undo2 size={11} /> 撤销
          </button>
        </span>
      </div>
      <div className="agent-file-changes-collapse">
        <div className="agent-file-changes-clip">
          <div className="agent-file-changes-body">
            {files.map((f, i) => {
              // 文件名 + 淡化目录前缀（与 Git 变更面板同构），同名文件可区分归属。
              // 展示用工作区相对路径：绝对路径会把目录段撑得很长，真正要看的文件名被挤掉；
              // 点击跳转仍用原路径（resolveWorkspacePath 会还原），只影响显示。
              const rel = toWorkspaceRelative(f.path)
              const norm = rel.replace(/\\/g, '/')
              const cut = norm.lastIndexOf('/')
              const parent = cut > 0 ? norm.slice(0, cut) : ''
              return (
                <div className="agent-file-changes-line" key={f.path}>
                  <button className="agent-file-changes-row" {...tip(f.path)} style={{ animationDelay: `${Math.min(i, 8) * 70}ms` }} onClick={() => onOpenChange(resolveWorkspacePath(f.path))}>
                    {(() => { const { Icon: FIcon, color } = fileMeta(dirName(rel)); return <FIcon size={12} style={{ color }} /> })()}
                    <span className="agent-file-changes-name">{dirName(rel)}</span>
                    {/* 增删行数与 A/M 徽标紧跟文件名，扫视时名称、数字、状态一眼对应 */}
                    <span className="agent-tool-diffstat">
                      {f.added > 0 && <span className="diff-add">+{f.added}</span>}
                      {f.removed > 0 && <span className="diff-del">-{f.removed}</span>}
                    </span>
                    {/* 状态徽标：复用 Git 变更面板同款配色（A 新增 / M 修改） */}
                    <span className={`agent-git-badge s-${f.status}`} {...tip(f.status === 'A' ? '新增文件' : '修改文件')}>{f.status}</span>
                    {parent && <span className="agent-file-changes-dir">{parent}</span>}
                  </button>
                  {/* 每行右侧「审查」：审查该文件的改动（跳变更面板定位该文件 diff） */}
                  <button className="agent-file-changes-review" {...tip('在变更面板中审查该文件的改动')} onClick={() => onOpenChange(resolveWorkspacePath(f.path))}>
                    <GitBranchIcon size={11} /> 审查
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
})
