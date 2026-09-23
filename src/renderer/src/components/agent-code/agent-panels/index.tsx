// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-panels —— 长期记忆只读面板                                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 只订阅主进程 memoryStore 与 props，不依赖主组件状态，因此可以零 props 整体搬离。
//
// 历史上这里还有 AuditPanel（操作审计）与 DebugPanel / DebugTurnRow（调试）两个面板。
// 这两套功能（面板 + 顶栏按钮 + /audit、/debug 斜杠命令 + 底层 auditLog / debugLog 记录）
// 已整体移除，本文件只剩长期记忆面板。
//
// 对外导出：MemoryPanel

import React, { useCallback, useEffect, useState } from 'react'
import {Trash2Icon, ChevronRightIcon, RotateCcwIcon} from 'lucide-react'
import { useMemoryPendingStore, type PendingMemory } from '../../../store/memoryPendingStore'
import { notify } from '../../../store/notificationStore'
import type { AgentMemoryEntry } from '../../../../../shared/types'

/** 取路径最后一段作工作区名（本地实现，避免为一个显示用的小函数引入 utils/paths 依赖） */
const dirLabel = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

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

  if (entries === null) return <div className="agent-card-empty">加载中…</div>
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
        <div className="agent-card-empty">
          {pending.length > 0 ? '暂无已落库的记忆。' : '暂无长期记忆。智能体在会话中沉淀的结论会出现在这里。'}
        </div>
      )}
      {active.length === 0 && entries.length > 0 && <div className="agent-card-empty">暂无活跃记忆条目。</div>}
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
