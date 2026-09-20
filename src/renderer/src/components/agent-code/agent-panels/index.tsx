// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-panels —— 审计 / 长期记忆 / 调试三个只读面板                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx「模块级 UI 子组件」区域中的三个面板组件。
// 三者都只订阅各自的模块级内存缓冲（auditLog / debugLog）或 props，不依赖主组件状态，
// 因此可以零 props 整体搬离。逻辑与注释均未改动，仅补齐 import。
//
// 对外导出：AuditPanel、MemoryPanel、DebugPanel、DebugTurnRow

import React, { useCallback, useEffect, useState } from 'react'
import {Trash2Icon, ChevronRightIcon, RotateCcwIcon} from 'lucide-react'
import {getAuditEntries, subscribeAudit, type AuditEntry} from '../../../utils/auditLog'
import { getDebugTurns, subscribeDebug, type DebugTurn } from '../../../utils/debugLog'
import { useMemoryPendingStore, type PendingMemory } from '../../../store/memoryPendingStore'
import { notify } from '../../../store/notificationStore'
import type { AgentMemoryEntry } from '../../../../../shared/types'

/** 取路径最后一段作工作区名（本地实现，避免为一个显示用的小函数引入 utils/paths 依赖） */
const dirLabel = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

// ── 操作审计面板：订阅内存环形缓冲，展示本会话工具调用记录（最新在前）──
// 默认只渲染最近 AUDIT_RENDER_LIMIT 条，避免 500 条记录（每条含 args/result 两个 pre）
// 一次性渲染阻塞界面（打开面板时「短暂冻结」的候选来源）；超出后提供「显示全部」。
const AUDIT_RENDER_LIMIT = 100
export const AuditPanel = React.memo(function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>(() => getAuditEntries())
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    setEntries(getAuditEntries())
    return subscribeAudit(() => setEntries(getAuditEntries()))
  }, [])
  if (entries.length === 0) return <div className="agent-audit-empty">暂无工具调用记录。</div>
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
  const shown = showAll ? entries : entries.slice(0, AUDIT_RENDER_LIMIT)
  const hasMore = entries.length > AUDIT_RENDER_LIMIT && !showAll
  return (
    <div className="agent-audit-list">
      {shown.map(e => (
        <div className={`agent-audit-row ${e.failed ? 'failed' : 'ok'}`} key={e.id}>
          <div className="agent-audit-line">
            <span className="agent-audit-tool">{e.tool}</span>
            {e.approved && <span className="agent-audit-tag approved">审批</span>}
            <span className={`agent-audit-tag ${e.failed ? 'fail' : 'done'}`}>{e.failed ? '失败' : '成功'}</span>
            <span className="agent-audit-dur">{e.durationMs}ms</span>
            <span className="agent-audit-time">{fmtTime(e.timestamp)}</span>
          </div>
          {e.args && <pre className="agent-audit-args">{e.args}</pre>}
          {e.result && <pre className="agent-audit-result">{e.result}</pre>}
        </div>
      ))}
      {hasMore && (
        <button className="agent-audit-more" onClick={() => setShowAll(true)}>
          显示全部 {entries.length} 条记录
        </button>
      )}
    </div>
  )
})

// ── 长期记忆面板：列出当前项目工作区的跨会话记忆条目，支持人工归档（软删除）──
// 数据源为主进程 memoryStore：智能体自动沉淀的结论在此可见、可裁决，
// 记错的条目归档后不再注入提示词（保留存档供审计）。
const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  correction: '纠正偏好',
  convention: '项目约定',
  command: '已验证命令',
  error_fix: '错误解法',
  decision: '决策记录',
  file_role: '文件角色',
}

export const MemoryPanel = React.memo(function MemoryPanel({ dir }: { dir: string }) {
  const [entries, setEntries] = useState<AgentMemoryEntry[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const refresh = useCallback(() => {
    // dir 变化时先回到加载态，避免短暂展示上一个工作区的条目
    setEntries(null)
    window.api.memstoreList(dir).then(list => setEntries(list)).catch(() => setEntries([]))
  }, [dir])
  useEffect(() => { refresh() }, [refresh])
  const archive = useCallback(async (id: string) => {
    try { await window.api.memstoreArchive(dir, id) } catch { /* 归档失败时靠刷新兜底 */ }
    refresh()
  }, [dir, refresh])
  // 恢复：归档是软删除，此前单向、界面上没有回退路径，误点只能去手改
  // Agent session/memory/*.json。主进程侧同时把矛盾计数归零（见 memstore-unarchive）。
  const unarchive = useCallback(async (id: string) => {
    try { await window.api.memstoreUnarchive(dir, id) } catch { /* 恢复失败时靠刷新兜底 */ }
    refresh()
  }, [dir, refresh])
  // 彻底删除：只对已归档条目开放（活跃条目走「归档」这条软删除路径）。
  // 两步确认 —— 删掉就没有副本、也没有撤销，而本模块的设计原则本是「归档而非物理删除」，
  // 所以多问一次；确认态用行内小按钮而不是模态，避免为一个图标动作引入弹窗。
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null)
  const remove = useCallback(async (id: string) => {
    try { await window.api.memstoreDelete(dir, id) } catch { /* 删除失败时靠刷新兜底 */ }
    setConfirmDelId(null)
    refresh()
  }, [dir, refresh])

  // ── 待确认队列（「写入前确认」模式下由 memoryWriter.submit 投递）──
  // 队列是全局的（各工作区各一批），这里全部列出并标注归属 —— 否则「切到别的工作区
  // 才看得到自己刚沉淀的那条」会让人找不到。
  const pending = useMemoryPendingStore(s => s.items)
  const removePending = useMemoryPendingStore(s => s.remove)
  const adopt = useCallback(async (p: PendingMemory) => {
    try {
      await window.api.memstoreUpsert(p.dir, [p.candidate])
    } catch {
      // 采纳失败就留在队列里让用户重试 —— 静默丢弃等于把用户刚批准的东西吃掉
      notify('采纳失败，已保留在待确认队列', 'error')
      return
    }
    removePending(p.id)
    if (p.dir === dir) refresh()   // 只有写的是当前工作区才需要刷新列表
  }, [dir, refresh, removePending])
  const adoptAll = useCallback(async () => {
    const total = pending.length
    let ok = 0
    for (const p of pending) {
      try {
        await window.api.memstoreUpsert(p.dir, [p.candidate])
        removePending(p.id)
        ok++
      } catch { /* 单条失败保留在队列里，继续处理其余 */ }
    }
    if (ok > 0) refresh()
    notify(ok === total ? `已采纳 ${ok} 条记忆` : `已采纳 ${ok} / ${total} 条，失败项已保留`, ok === total ? 'success' : 'error')
  }, [pending, refresh, removePending])
  const ignoreAll = useCallback(() => {
    for (const p of pending) removePending(p.id)
  }, [pending, removePending])
  // 跨工作区混合时才显示归属标签，单工作区时避免冗余噪声
  const multiDir = new Set(pending.map(p => p.dir)).size > 1

  if (entries === null) return <div className="agent-audit-empty">加载中…</div>
  const active = entries.filter(e => !e.archived).sort((a, b) => b.updatedAt - a.updatedAt)
  const archived = entries.filter(e => e.archived).sort((a, b) => b.updatedAt - a.updatedAt)
  const fmtDate = (t: number) => new Date(t).toLocaleDateString('zh-CN')
  return (
    <div className="agent-mem-list">
      {/* 待确认区固定在最上方：它比已落库的条目更需要立刻被看到 */}
      {pending.length > 0 && (
        <div className="agent-mem-pending">
          <div className="agent-mem-pending-head">
            <span className="agent-mem-pending-title">待确认 {pending.length} 条</span>
            <span className="agent-mem-pending-bulk">
              <button className="agent-mem-pending-adoptall" onClick={() => void adoptAll()}>全部采纳</button>
              <button className="agent-mem-pending-ignoreall" onClick={ignoreAll}>全部忽略</button>
            </span>
          </div>
          {pending.map(p => (
            <div className="agent-mem-pending-row" key={p.id}>
              <div className="agent-mem-line">
                <span className="agent-mem-cat">{MEMORY_CATEGORY_LABELS[p.candidate.category] || p.candidate.category}</span>
                <span className={`agent-mem-src ${p.candidate.source}`}>{p.candidate.source === 'user' ? '用户' : '智能体'}</span>
                {typeof p.candidate.confidence === 'number' && (
                  <span className="agent-mem-conf" title="置信度">{Math.round(p.candidate.confidence * 100)}%</span>
                )}
                {multiDir && <span className="agent-mem-origin-inline" title={p.dir}>{dirLabel(p.dir)}</span>}
                <span className="agent-mem-pending-actions">
                  <button className="agent-mem-pending-yes" onClick={() => void adopt(p)}>采纳</button>
                  <button className="agent-mem-pending-no" onClick={() => removePending(p.id)}>忽略</button>
                </span>
              </div>
              <div className="agent-mem-content">{p.candidate.content}</div>
              <div className="agent-mem-origin" title={`出处：${p.candidate.origin}`}>出处：{p.candidate.origin}</div>
            </div>
          ))}
        </div>
      )}
      {entries.length === 0 && (
        <div className="agent-audit-empty">
          {pending.length > 0 ? '暂无已落库的记忆。' : '暂无长期记忆。智能体在会话中沉淀的结论会出现在这里。'}
        </div>
      )}
      {active.length === 0 && entries.length > 0 && <div className="agent-audit-empty">暂无活跃记忆条目。</div>}
      {active.map(e => (
        <div className="agent-mem-row" key={e.id}>
          <div className="agent-mem-line">
            <span className="agent-mem-cat">{MEMORY_CATEGORY_LABELS[e.category] || e.category}</span>
            <span className={`agent-mem-src ${e.source}`}>{e.source === 'user' ? '用户' : '智能体'}</span>
            <span className="agent-mem-conf" title="置信度">{Math.round(e.confidence * 100)}%</span>
            {e.hits > 1 && <span className="agent-mem-hits" title="被沉淀 / 确认次数（相似条目合并时 +1）">命中 ×{e.hits}</span>}
            {e.contradictions > 0 && <span className="agent-mem-contra" title="工具实测与该记忆矛盾的次数，累计 2 次自动归档">矛盾 ×{e.contradictions}</span>}
            <span className="agent-mem-time">{fmtDate(e.updatedAt)}</span>
            <button className="agent-mem-archive" title="归档（不再注入提示词，保留存档）" onClick={() => archive(e.id)}><Trash2Icon size={11} /></button>
          </div>
          <div className="agent-mem-content">{e.content}</div>
          {e.origin && <div className="agent-mem-origin" title={`出处：${e.origin}`}>出处：{e.origin}</div>}
          {e.anchorPath && <div className="agent-mem-anchor" title={e.anchorSymbol ? `锚点符号：${e.anchorSymbol}` : undefined}>锚点：{e.anchorPath}</div>}
        </div>
      ))}
      {archived.length > 0 && (
        <>
          <button className="agent-mem-archived-toggle" onClick={() => setShowArchived(v => !v)}>
            <ChevronRightIcon size={11} className={`agent-tool-chev ${showArchived ? 'open' : ''}`} /> 已归档 {archived.length} 条
          </button>
          {showArchived && archived.map(e => (
            <div className="agent-mem-row archived" key={e.id}>
              <div className="agent-mem-line">
                <span className="agent-mem-cat">{MEMORY_CATEGORY_LABELS[e.category] || e.category}</span>
                {e.origin && <span className="agent-mem-origin-inline" title={`出处：${e.origin}`}>{e.origin}</span>}
                <span className="agent-mem-time">{fmtDate(e.updatedAt)}</span>
                {confirmDelId === e.id ? (
                  <span className="agent-mem-confirm">
                    <button className="agent-mem-confirm-yes" title="彻底删除，无法撤销" onClick={() => remove(e.id)}>删除</button>
                    <button className="agent-mem-confirm-no" onClick={() => setConfirmDelId(null)}>取消</button>
                  </span>
                ) : (
                  <>
                    <button className="agent-mem-restore" title="恢复为活跃条目（矛盾计数一并归零）" onClick={() => unarchive(e.id)}><RotateCcwIcon size={11} /></button>
                    <button className="agent-mem-delete" title="彻底删除（不可恢复）" onClick={() => setConfirmDelId(e.id)}><Trash2Icon size={11} /></button>
                  </>
                )}
              </div>
              <div className="agent-mem-content">{e.content}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
})

// ── 调试面板：按轮展示请求 payload / 用量 / 耗时 / 工具调用链（最新在前）──
export const DebugTurnRow = React.memo(function DebugTurnRow({ t }: { t: DebugTurn }) {
  const [open, setOpen] = useState(false)
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  return (
    <div className="agent-debug-row">
      <div className="agent-debug-line">
        <span className="agent-debug-turn">#{t.turn}</span>
        <span className="agent-debug-dur">{t.durationMs}ms</span>
        <span className="agent-debug-time">{fmtTime(t.timestamp)}</span>
      </div>
      <div className="agent-debug-metrics">
        <span>prompt {t.promptTokens} · completion {t.completionTokens}</span>
        {typeof t.ttftMs === 'number' && <span>首token {t.ttftMs}ms</span>}
        {typeof t.tps === 'number' && <span>{t.tps.toFixed(1)} t/s</span>}
        <span>消息 {t.msgCount} · 工具 {t.toolCount}</span>
        {t.dropped > 0 && <span className="agent-debug-dropped">裁剪 {t.dropped}</span>}
      </div>
      {t.tools.length > 0 && (
        <div className="agent-debug-tools">
          {t.tools.map((tc, i) => (
            <span className={`agent-debug-tool ${tc.failed ? 'fail' : 'ok'}`} key={i}>{tc.name} · {tc.durationMs}ms {tc.failed ? '✗' : '✓'}</span>
          ))}
        </div>
      )}
      <button className="agent-debug-payload-toggle" onClick={() => setOpen(v => !v)}>
        <ChevronRightIcon size={11} className={`agent-tool-chev ${open ? 'open' : ''}`} /> {open ? '收起请求 payload' : '展开请求 payload'}
      </button>
      {open && <pre className="agent-debug-payload">{t.requestPayload}</pre>}
    </div>
  )
})

export const DebugPanel = React.memo(function DebugPanel() {
  const [turns, setTurns] = useState<DebugTurn[]>(() => getDebugTurns())
  useEffect(() => {
    setTurns(getDebugTurns())
    return subscribeDebug(() => setTurns(getDebugTurns()))
  }, [])
  if (turns.length === 0) return <div className="agent-audit-empty">暂无调试记录（发起一次对话后出现）。</div>
  return (
    <div className="agent-debug-list">
      {turns.map(t => <DebugTurnRow t={t} key={t.id} />)}
    </div>
  )
})
