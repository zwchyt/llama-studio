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
  Wrench, TerminalSquare, XCircle, CheckCircle2, Undo2, FileDiff,
} from 'lucide-react'
import {
  LoaderIcon, ClockIcon, CheckIcon, ChevronRightIcon, GitBranchIcon,
} from '@animateicons/react/lucide'
import { useCollapseAnimation } from '../../../utils/useCollapseAnimation'
import { fileMeta } from '../../../utils/fileIcon'
import { TOOL_METAS, WRITE_EDIT_TOOLS, BACKUP_TOOLS } from '../../../utils/tools'
import WebSearchResults from '../../WebSearchResults'
import BrowserScreenshotResult from '../../BrowserScreenshotResult'
import { getEditDiffStat, ToolEditDiff } from '../agent-diff'
import { LinedPre, LINED_PRE_WINDOW_CHARS } from './LinedPre'
import { WindowedText } from '../WindowedText'
import { dirName, resolveWorkspacePath } from '../utils/paths'
import { formatDuration } from '../utils/format'
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

// 带行号的等宽文本块（工具写入内容 / Read 结果）已抽至 ./LinedPre.tsx：
// 阈值以下逐行 DOM（原行为），以上走行窗口只挂载视口附近行。

export const ToolArgsView = React.memo(function ToolArgsView({ name, args, onPreviewFile, headFilePath }: { name: string; args: string; onPreviewFile: (p: string, line?: number) => void; headFilePath?: string }) {
  const parsed = (() => { try { return JSON.parse(args) } catch { return null } })()
  const filePath = name === 'Read' ? '' : (headFilePath || (parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : ''))
  const isFileEdit = !!parsed && (name === 'Write' || name === 'Edit')
  // browser_show 的卡片只说明「这一次调用要打开什么」：文件路径 / 网址 / 内联 HTML 的体量。
  // 参数里的 html 是模型生成的整份文档，不再打印出来——源码看文件，效果看右侧预览区。
  if (name === 'browser_show' && parsed) {
    const p = parsed as Record<string, unknown>
    const html = typeof p.html === 'string' ? p.html : ''
    const label = p.type === 'file' ? '打开项目文件' : p.type === 'url' ? '打开网址' : '显示 HTML 页面'
    return (
      <div className="agent-tool-args">
        <div className="agent-tool-shot-head">
          <span>{label}</span>
          {typeof p.path === 'string' && p.path && <span className="agent-tool-shot-dims" title={p.path}>{p.path}</span>}
          {typeof p.url === 'string' && p.url && <span className="agent-tool-shot-dims" title={p.url}>{p.url}</span>}
          {typeof p.title === 'string' && p.title && <span className="agent-tool-shot-dims">{p.title}</span>}
          {html && <span className="agent-tool-shot-dims">HTML {html.length} 字符</span>}
        </div>
      </div>
    )
  }
  if (isFileEdit) {
    return (
      <div className="agent-tool-args">
        {name === 'Write' && typeof parsed!.content === 'string' && (
          <div className="agent-tool-content">
            <div className="agent-tool-content-head"><span>写入内容</span></div>
            <LinedPre text={parsed!.content} maxHeight={360} />
          </div>
        )}
        {name === 'Edit' && (() => {
          // 兼容两代参数：自研旧式 old_string/new_string，pi 原生 path + edits[]（一次多处）
          if (typeof parsed!.old_string === 'string' && typeof parsed!.new_string === 'string') {
            return <ToolEditDiff oldText={parsed!.old_string} newText={parsed!.new_string} />
          }
          const edits = Array.isArray(parsed!.edits) ? parsed!.edits : []
          if (edits.length === 0) return null
          return (
            <div className="agent-tool-edits">
              {edits.map((e, i) => {
                if (!e || typeof e.oldText !== 'string' || typeof e.newText !== 'string') return null
                return (
                  <div className="agent-tool-edit" key={i}>
                    <div className="agent-tool-content-head"><span>编辑 {i + 1}</span></div>
                    <ToolEditDiff oldText={e.oldText} newText={e.newText} />
                  </div>
                )
              })}
            </div>
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
      {formatted && <pre className="agent-tool-args-pre">{formatted}</pre>}
      {filePath && (
        <div className="agent-tool-filebar">
          <button className="agent-tool-call-path" title={filePath} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(filePath)) }}>
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

export const ToolResultView = React.memo(function ToolResultView({ result, truncated, total, lined }: { result: string; truncated?: boolean; total?: number; lined?: boolean }) {
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
  const canRestore = done && canUndo && !tc.restored && BACKUP_TOOLS.has(tc.name)
  // 展开/收起动画：与 ThinkBlock 同方案——由 useCollapseAnimation 提供
  // handleToggle / onBodyTransitionEnd。裁剪层 max-height 像素过渡，首次展开后保持挂载
  // （visible），收起只收到 0 不卸载，避免 diff/高亮重解析卡顿。
  // 工具卡始终默认收起：是否展开由用户逐卡手动决定，无全局批量开关。
  const bodyRef = useRef<HTMLDivElement>(null)
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
  const bashCmd = (() => {
    if (tc.name !== 'Bash') return null
    const c = parsed && typeof parsed.command === 'string' ? parsed.command : null
    return c && c.length > 400 ? c.slice(0, 400) + '\n…' : c
  })()
  // Read/Write/Edit 统一：文件名内联到头部（文件树同款图标 + 可点跳预览），替代纯文字参数预览。
  let readFilePath = tc.name === 'Read' && parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : ''
  if (tc.name === 'Read' && typeof tc.result === 'string') {
    const firstLine = tc.result.split('\n')[0] || ''
    const m = /^File:\s*(.+)$/i.exec(firstLine)
    if (m) readFilePath = m[1].trim()
  }
  const headFilePath = readFilePath || (WRITE_EDIT_TOOLS.has(tc.name) && parsed && typeof (parsed.file_path ?? parsed.path) === 'string' ? (parsed.file_path ?? parsed.path) as string : '')
  // Read 实际读取的行段（结果头 Lines: x-y 解析）：头部展示「文件名:x-y」、点击文件名跳转到起始行。
  // 行段取自执行结果而非参数，是钳制后的真实范围；同一文件多次分片读取时借此区分各卡片。
  const readRange = (() => {
    if (tc.name !== 'Read' || !done || typeof tc.result !== 'string') return null
    const m = tc.result.match(/^Lines: (\d+)-(\d+)/m)
    return m ? { start: Number(m[1]), end: Number(m[2]) } : null
  })()
  // Write/Edit 成功结果只是一句确认文案，与头部绿勾「完成」重复，隐藏结果块；
  // 写入内容预览 / diff（来自参数）照常展示，失败时仍显示错误结果块。
  // Read 成功结果保留展示（ToolResultView 默认折叠为 12 行预览，可展开），供审计模型实际读到的内容。
  const hideResult = done && !failed && WRITE_EDIT_TOOLS.has(tc.name)

  // ── 卡片渲染门控 ──
  // 工具声明（pending）即渲染卡片（与参考项目 Reasonix 的 ToolCard 一致：dispatch 即显示），
  // 状态全程可见：待执行 → 写入中/修改中（verb）→ 完成，执行中的状态不会一闪而过。
  const showCard = done || awaiting || executing || pending
  if (!showCard) return null

  return (
    <>
      {/* 每个工具卡的独立时间标签：基于该工具执行时长（elapsed），卡片上方醒目展示 */}
      {done && tc.durationMs != null && (
        <div className="agent-tool-time">Tool: {formatDuration(tc.durationMs)}</div>
      )}
      <div className={`agent-tool-call tool-${tc.name.toLowerCase()}${failed ? ' failed' : ''}${executing ? ' executing' : ''}${pending ? ' pending' : ''}`}>
        <div className="agent-tool-call-head" onClick={handleToggle}>
          <span className="agent-tool-call-icon">
            <Icon size={13} />
          </span>
          <span className="agent-tool-call-name">{tc.name}</span>
          {/* Read/Write/Edit：文件名直接内联到头部（文件树同款图标 + 可点跳预览）。
              Read 完成后附行段「文件名:x-y」，点击跳转到读取起始行——与模型实际读到的片段对上 */}
          {headFilePath ? (
            <button className="agent-tool-call-path" title={headFilePath} onClick={(e) => { e.stopPropagation(); onPreviewFile(resolveWorkspacePath(headFilePath), readRange?.start) }}>
              <span className="agent-tool-file-icon" style={{ color: fileMeta(dirName(headFilePath)).color }}>{(() => { const { Icon: FIcon } = fileMeta(dirName(headFilePath)); return <FIcon size={12} /> })()}</span>{headFilePath}
              {readRange && <span className="agent-tool-call-linerange">:{readRange.start}-{readRange.end}</span>}
            </button>
          ) : (
            preview && <span className="agent-tool-call-preview">{preview}</span>
          )}
          {total > 1 && <span className="agent-tool-call-step">步骤 {index + 1}/{total}</span>}
          <span className="agent-tool-call-meta">
            {editDiffStat && (
              <span className="agent-tool-diffstat">
                <span className="diff-add">+{editDiffStat.added}</span>
                <span className="diff-del">-{editDiffStat.removed}</span>
              </span>
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
              <span className="agent-tool-call-status err"><XCircle size={12} /> 失败</span>
            ) : (
              <span className="agent-tool-call-status ok"><CheckCircle2 size={12} /> 完成</span>
            )}
            {canRestore && (
              <button className="agent-tool-undo" title="撤销仅本次运行内有效，重启应用后不可用" onClick={(e) => { e.stopPropagation(); onUndo?.() }}>
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
              {tc.name === 'Bash' && bashCmd && (
                <div className="agent-tool-bash">
                  <div className="agent-tool-bash-bar"><TerminalSquare size={11} /> 命令</div>
                  <pre className="agent-tool-bash-cmd">{bashCmd}</pre>
                </div>
              )}
              {tc.name !== 'Bash' && tc.name !== 'web_search' && tc.name !== 'web_search_bing' && <ToolArgsView name={tc.name} args={tc.args} onPreviewFile={onPreviewFile} headFilePath={headFilePath} />}
              {(tc.name === 'web_search' || tc.name === 'web_search_bing') && (executing || done) && (
                <WebSearchResults
                  result={done ? tc.result ?? undefined : undefined}
                  query={parsed && typeof parsed.query === 'string' ? parsed.query : undefined}
                  loading={executing}
                />
              )}
              {tc.name === 'browser_screenshot' && done && <BrowserScreenshotResult result={tc.result} />}
              {done && !hideResult && tc.name !== 'web_search' && tc.name !== 'web_search_bing' && (
                <ToolResultView result={tc.result!} truncated={tc.truncated} total={tc.resultTotal} lined={tc.name === 'Read'} />
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
  if (files.length === 0) return null
  const totalAdded = files.reduce((s, f) => s + f.added, 0)
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0)
  return (
    <div className={`agent-file-changes${expanded ? ' expanded' : ''}`}>
      <div className="agent-file-changes-head" onClick={() => setExpanded(v => !v)} role="button" tabIndex={0} title={expanded ? '收起文件变更' : '展开文件变更'} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}>
        <ChevronRightIcon size={12} className={`agent-file-changes-chev${expanded ? ' open' : ''}`} />
        {/* 文件差异图标：与「变更」语义对应，强化卡片身份 */}
        <FileDiff size={13} className="agent-file-changes-head-icon" />
        <span>{files.length} 个文件已变更</span>
        <span className="agent-tool-diffstat">
          {totalAdded > 0 && <span className="diff-add">+{totalAdded}</span>}
          {totalRemoved > 0 && <span className="diff-del">-{totalRemoved}</span>}
        </span>
        {/* 头部右侧「撤销」：折叠/展开态均可用，一键写回本次修改前的原文件内容（仅当前会话内存备份有效） */}
        <button className="agent-file-changes-undo" title="撤销本次全部修改（仅当前会话内存备份有效）" disabled={!canUndoAll} onClick={e => { e.stopPropagation(); onUndoAll?.() }}>
          <Undo2 size={11} /> 撤销
        </button>
      </div>
      <div className="agent-file-changes-collapse">
        <div className="agent-file-changes-clip">
          <div className="agent-file-changes-body">
            {files.map((f, i) => {
              // 文件名 + 淡化目录前缀（与 Git 变更面板同构），同名文件可区分归属
              const norm = f.path.replace(/\\/g, '/')
              const cut = norm.lastIndexOf('/')
              const parent = cut > 0 ? norm.slice(0, cut) : ''
              return (
                <div className="agent-file-changes-line" key={f.path}>
                  <button className="agent-file-changes-row" title={f.path} style={{ animationDelay: `${Math.min(i, 8) * 70}ms` }} onClick={() => onOpenChange(resolveWorkspacePath(f.path))}>
                    {(() => { const { Icon: FIcon, color } = fileMeta(dirName(f.path)); return <FIcon size={12} style={{ color }} /> })()}
                    <span className="agent-file-changes-name">{dirName(f.path)}</span>
                    {/* 增删行数与 A/M 徽标紧跟文件名，扫视时名称、数字、状态一眼对应 */}
                    <span className="agent-tool-diffstat">
                      {f.added > 0 && <span className="diff-add">+{f.added}</span>}
                      {f.removed > 0 && <span className="diff-del">-{f.removed}</span>}
                    </span>
                    {/* 状态徽标：复用 Git 变更面板同款配色（A 新增 / M 修改） */}
                    <span className={`agent-git-badge s-${f.status}`} title={f.status === 'A' ? '新增文件' : '修改文件'}>{f.status}</span>
                    {parent && <span className="agent-file-changes-dir">{parent}</span>}
                  </button>
                  {/* 每行右侧「审查」：审查该文件的改动（跳变更面板定位该文件 diff） */}
                  <button className="agent-file-changes-review" title="在变更面板中审查该文件的改动" onClick={() => onOpenChange(resolveWorkspacePath(f.path))}>
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
