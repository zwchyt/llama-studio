// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-diff —— Diff 计算与分栏展示                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx「区域：Diff 计算与展示组件（分栏对比、行号渲染）」，
// 逻辑与注释均未改动。原文件仅保留 import。
//
// 对外导出：
//   - countDiffStats / computeSplitDiff：纯 LCS 计算（无 React 依赖，可单测）
//   - getEditDiffStat：Edit 工具增删行数统计（按 tc.id 缓存）
//   - ToolEditDiff：分栏 diff 视图组件

import React, { useMemo } from 'react'
import type { AgentMessage } from '../../../../../shared/types'
import { WindowedRows } from '../WindowedText'

export type DiffRow = { type: 'equal' | 'del' | 'ins' | 'replace'; left: string | null; right: string | null; leftNum: number | null; rightNum: number | null }

// 轻量级 diff 统计：仅计算增删行数，不生成完整 DiffRow。
// 将 LCS DP 压到一维数组，只追踪长度，大幅降低内存和 CPU。
export function countDiffStats(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length, m = b.length

  const MAX_DIFF_CELLS = 500_000
  if (n === 0) return { added: m, removed: 0 }
  if (m === 0) return { added: 0, removed: n }

  // 超大文件退化为 worst-case：旧的全部删除，新的全部新增
  if (n * m > MAX_DIFF_CELLS) {
    return { added: m, removed: n }
  }

  // 用较短数组做外层循环，减少内存和比较次数
  const [shorter, longer] = n <= m ? [a, b] : [b, a]
  const sn = shorter.length, lm = longer.length
  const prev = new Array(lm + 1).fill(0)
  const curr = new Array(lm + 1).fill(0)

  for (let i = sn - 1; i >= 0; i--) {
    for (let j = lm - 1; j >= 0; j--) {
      curr[j] = shorter[i] === longer[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1])
    }
    for (let j = 0; j <= lm; j++) prev[j] = curr[j]
  }

  const lcs = prev[0]
  return {
    added: m - lcs,
    removed: n - lcs,
  }
}

// Edit 工具增删行数统计（+N -M 徽标）：工具卡片（ToolCallCard，单卡）与文件变更汇总
// （FileChangeSummary，按文件聚合）需要的是同一份结果，各自实现会让同一 args 的 LCS
// 跑两遍。此处收敛为唯一实现（顺带消除两处参数解析逻辑漂移的风险），并以 tc.id 缓存。
//
// ⚠️ 缓存键必须用 tc.id，不能用 tc 对象：工具状态流转
// （pending → executing → done）每一步都是 `toolCalls[i] = { ...toolCalls[i], ... }`，
// 即每次换新对象。若以对象为键，「卡片算完时缓存的那个对象」与「汇总阶段拿到的对象」
// 必然不是同一个 → 缓存永不命中；反过来若把 memo 依赖改成对象，则流式期间每次状态
// 流转都会重算一次，总次数反而比现在更多。
//
// 命中时校验 args：同一 id 的 args 理论上只写一次，但留此护栏可在未来某处改为原地
// 改写 tc.args 时自动失效重算，而不是永久展示陈旧的 +N -M。
// 容量有界：按插入顺序 FIFO 淘汰，避免长会话里 args 字符串被缓存无限持有。
export type EditDiffStat = { added: number; removed: number }
const EDIT_STAT_CACHE_MAX = 256
const editStatCache = new Map<string, { args: string; stat: EditDiffStat | null }>()

// 兼容两代参数：自研旧式 old_string/new_string；pi 原生 path + edits[]（逐条累加）。
export function getEditDiffStat(tc: NonNullable<AgentMessage['toolCalls']>[number]): EditDiffStat | null {
  if (tc.name !== 'Edit') return null
  const args = tc.args || ''
  const cached = tc.id ? editStatCache.get(tc.id) : undefined
  if (cached && cached.args === args) return cached.stat

  let stat: EditDiffStat | null = null
  let parsed: { old_string?: unknown; new_string?: unknown; edits?: unknown } | null = null
  try { parsed = JSON.parse(args || '{}') } catch { parsed = null }
  if (parsed && typeof parsed === 'object') {
    let added = 0
    let removed = 0
    const acc = (o: string, n: string): void => {
      const s = countDiffStats(o, n)
      added += s.added
      removed += s.removed
    }
    if (typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string') {
      acc(parsed.old_string, parsed.new_string)
    } else if (Array.isArray(parsed.edits)) {
      for (const e of parsed.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
        if (e && typeof e.oldText === 'string' && typeof e.newText === 'string') acc(e.oldText, e.newText)
      }
    }
    if (added !== 0 || removed !== 0) stat = { added, removed }
  }

  if (tc.id) {
    if (editStatCache.size >= EDIT_STAT_CACHE_MAX) {
      const oldest = editStatCache.keys().next().value
      if (oldest !== undefined) editStatCache.delete(oldest)
    }
    editStatCache.set(tc.id, { args, stat })
  }
  return stat
}

export function computeSplitDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length, m = b.length
  // 大文件保护：LCS DP 表为 O(n×m)，超过阈值时直接退化为「全删+全增」展示，
  // 避免内存溢出或长时间卡顿渲染线程。阈值 500k ≈ 700×700 行。
  const MAX_DIFF_CELLS = 500_000
  if (n * m > MAX_DIFF_CELLS) {
    const rows: DiffRow[] = []
    let lnum = 1, rnum = 1
    for (let i = 0; i < n; i++) rows.push({ type: 'del', left: a[i]!, right: null, leftNum: lnum++, rightNum: null })
    for (let j = 0; j < m; j++) rows.push({ type: 'ins', left: null, right: b[j]!, leftNum: null, rightNum: rnum++ })
    return rows
  }
  // LCS 动态规划
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  // 先生成「编辑脚本」（equal / del / ins 序列，del/ins 各自独立），便于后续配对成一行
  const script: { type: 'equal' | 'del' | 'ins'; ai: number; bj: number }[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { script.push({ type: 'equal', ai: i, bj: j }); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { script.push({ type: 'del', ai: i, bj: -1 }); i++ }
    else { script.push({ type: 'ins', ai: -1, bj: j }); j++ }
  }
  while (i < n) { script.push({ type: 'del', ai: i, bj: -1 }); i++ }
  while (j < m) { script.push({ type: 'ins', ai: -1, bj: j }); j++ }

  const rows: DiffRow[] = []
  let lnum = 1, rnum = 1, k = 0
  while (k < script.length) {
    const s = script[k]!
    if (s.type === 'equal') {
      rows.push({ type: 'equal', left: a[s.ai]!, right: b[s.bj]!, leftNum: lnum, rightNum: rnum })
      k++; lnum++; rnum++
      continue
    }
    const dels: number[] = []
    const inss: number[] = []
    while (k < script.length && script[k]!.type !== 'equal') {
      if (script[k]!.type === 'del') dels.push(script[k]!.ai)
      else inss.push(script[k]!.bj)
      k++
    }
    const pairs = Math.min(dels.length, inss.length)
    for (let p = 0; p < pairs; p++) {
      rows.push({ type: 'replace', left: a[dels[p]!]!, right: b[inss[p]!]!, leftNum: lnum, rightNum: rnum })
      lnum++; rnum++
    }
    for (let p = pairs; p < dels.length; p++) {
      rows.push({ type: 'del', left: a[dels[p]!]!, right: null, leftNum: lnum, rightNum: null }); lnum++
    }
    for (let p = pairs; p < inss.length; p++) {
      rows.push({ type: 'ins', left: null, right: b[inss[p]!]!, leftNum: null, rightNum: rnum }); rnum++
    }
  }
  return rows
}

// Edit 工具的分栏 diff 视图（左原内容 / 右新内容，带行号与 +/- 标记）。
// React.memo + useMemo：LCS 为 O(n×m) 动态规划，流式期间父组件高频重渲染，
// 不缓存时大编辑每帧反复重算（单次可达数十毫秒），是流式卡顿的确定来源。
//
// 行数超阈值时改走行窗口（只挂载视口附近的行）。阈值以下保持逐行 DOM：短 diff 的成本可接受，
// 且能保留原有折行视觉——窗口态为了固定行高必须 nowrap，超长行只能省略号截断。
export const DIFF_WINDOW_ROWS = 400
// 与 .agent-tool-diff-window 的 11px × line-height 1.5 对齐（见 styles/agent-code.css
// 末尾「长内容行窗口：固定行高契约」），视口高度对齐原 .agent-tool-diff-body 的 max-height。
const DIFF_WINDOW_ROW_HEIGHT = 17
const DIFF_WINDOW_VIEW_HEIGHT = 420

export const ToolEditDiff = React.memo(function ToolEditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => computeSplitDiff(oldText, newText), [oldText, newText])
  // 行内容两个分支共用：窗口态由 WindowedRows 提供行外层，非窗口态自己包一层。
  const renderRow = (idx: number) => {
    const r = rows[idx]!
    return (
      <>
        <span className="agent-tool-diff-num left">{r.leftNum ?? ''}</span>
        <pre className="agent-tool-diff-code left">
          {(r.type === 'del' || r.type === 'replace') && <span className="agent-tool-diff-mark">-</span>}
          {r.left ?? ''}
        </pre>
        <span className="agent-tool-diff-num right">{r.rightNum ?? ''}</span>
        <pre className="agent-tool-diff-code right">
          {(r.type === 'ins' || r.type === 'replace') && <span className="agent-tool-diff-mark">+</span>}
          {r.right ?? ''}
        </pre>
      </>
    )
  }
  return (
    <div className="agent-tool-diff">
      <div className="agent-tool-diff-head">
        <span>原内容</span>
        <span>新内容</span>
      </div>
      {rows.length > DIFF_WINDOW_ROWS ? (
        <WindowedRows
          count={rows.length}
          viewHeight={DIFF_WINDOW_VIEW_HEIGHT}
          rowHeight={DIFF_WINDOW_ROW_HEIGHT}
          className="agent-window agent-tool-diff-window"
          rowAttr="data-diff-row"
          rowClassName={i => `agent-tool-diff-row ${rows[i]!.type}`}
          contentWidth="100%"
          ariaLabel={`Diff（窗口渲染，共 ${rows.length} 行）`}
          renderRow={renderRow}
        />
      ) : (
        <div className="agent-tool-diff-body">
          {rows.map((r, idx) => (
            <div className={`agent-tool-diff-row ${r.type}`} key={idx}>
              {renderRow(idx)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
