// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentMessageActions —— 消息级操作（复制 / 重生成 / 重发 / 分支 /     ║
// ║        编辑 / 撤销）                                                         ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「消息级操作」整块，逻辑与注释均未改动。
//
// 本 hook 不持有自己的 state——它操作的是「Agent 循环」与「项目会话」两个域的
// 共享可变引用（backupsRef / piReadyRef / regenRollbackRef / handleUndoRef）以及
// 会话消息本身。因此这些引用由调用方持有并通过参数传入，本 hook 只负责把它们
// 组合成面向消息行的动作集合。
//
// 外部输入：活动会话与项目（读写消息、重跑轮次）、运行态（loading / runningCard /
//           runPiTurn）、会话更新器（updateSessionInProject / setProjects /
//           setActiveSessionId）、四个共享 ref、以及内联编辑的两组 state。
// 对外输出：copyMessage / regenerateAt / resendAt / branchAt / editAt / confirmEdit /
//           handleUndo / handleUndoAll / canUndoFor / onUndoTool。

import { useCallback, useRef } from 'react'
import { notify } from '../../../store/notificationStore'
import { parseThinkSegments } from '../agent-message'
import { uniqueId } from '../utils/ids'
import { dirName } from '../utils/paths'
import type { AgentMessage, AgentProject, AgentSession, CardState } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'
import type { useAgentGit } from './useAgentGit'
import type { AgentMsgRowActions } from '../types'

import React from 'react'

type RunPiTurn = (
  pid: string, sid: string, displayMsgs: AgentMessage[],
  opts: { port: number; text: string; workspaceDir: string; approveWriteEdit?: boolean; knowledgeBaseId?: string; memory?: AgentSession['memory'] }
) => Promise<{ errored: boolean; aborted: boolean }>

export function useAgentMessageActions({
  activeSession, activeProject, activeProjectId, activeSessionId,
  loading, runningCard, updateSessionInProject, setProjects, setActiveSessionId,
  runPiTurn, backupsRef, piReadyRef, regenRollbackRef, handleUndoRef,
  editingMsgId, setEditingMsgId, editDraft, setEditDraft,
  openFileAtLine, openGitDiffAt,
}: {
  activeSession: AgentSession | null
  activeProject: AgentProject
  activeProjectId: string
  activeSessionId: string
  loading: boolean
  runningCard: CardState | undefined
  updateSessionInProject: ReturnType<typeof useAgentProjects>['updateSessionInProject']
  setProjects: ReturnType<typeof useAgentProjects>['setProjects']
  setActiveSessionId: ReturnType<typeof useAgentProjects>['setActiveSessionId']
  runPiTurn: RunPiTurn
  backupsRef: React.RefObject<Record<string, { path: string; content: string }>>
  piReadyRef: React.RefObject<{ sid: string | null; ready: boolean }>
  regenRollbackRef: React.RefObject<{ sid: string; messages: AgentMessage[] } | null>
  handleUndoRef: React.RefObject<((msgId: string, tcId: string) => Promise<void>) | null>
  editingMsgId: string | null
  setEditingMsgId: React.Dispatch<React.SetStateAction<string | null>>
  editDraft: string
  setEditDraft: React.Dispatch<React.SetStateAction<string>>
  /** 打开文件（可选跳行）：供消息行的「预览文件」动作使用（来自预览域） */
  openFileAtLine: (abs: string, line?: number) => void
  /** 打开 Git diff：供消息行的工具卡「查看变更」动作使用（来自 Git 域） */
  openGitDiffAt: ReturnType<typeof useAgentGit>['openGitDiffAt']
}) {

  // ── 消息级操作：复制 / 重新生成 / 重发 / 分支 / 编辑 / 撤销 ──
  const copyMessage = useCallback(async (content: string) => {
    // 复制时剥离思考链（<think>…</think>），只保留模型正文；
    // 用户消息无思考链，过滤后内容不变
    const plain = parseThinkSegments(content).filter(s => s.type === 'text').map(s => s.value).join('')
    try { await navigator.clipboard.writeText(plain); notify('已复制到剪贴板', 'success') }
    catch { notify('复制失败', 'error') }
  }, [])

  // 重新生成 / 重发失败回滚：依据 agent 返回结果，恢复原有消息
  const rollbackIfFailed = (r: { errored: boolean; aborted: boolean }) => {
    if (!r.errored || r.aborted) { regenRollbackRef.current = null; return }
    const rb = regenRollbackRef.current
    regenRollbackRef.current = null
    if (rb && rb.sid === activeSessionId) {
      updateSessionInProject(activeProjectId, activeSessionId, { messages: rb.messages })
      notify('重新生成失败，已恢复原有回复', 'error')
    }
  }

  // 重新生成：截断到该助手消息之前（保留其前置 user 轮），重跑一轮
  const regenerateAt = useCallback(async (msgId: string) => {
    if (loading || !runningCard || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0) return
    const base = msgs.slice(0, idx)
    if (base.length === 0) return
    regenRollbackRef.current = { sid: activeSessionId, messages: msgs.map(m => ({ ...m })) }
    updateSessionInProject(activeProjectId, activeSessionId, { messages: base })
    const lastUser = [...base].reverse().find(m => m.role === 'user')
    // pi SDK：重建 session（history=base 不含最后 user，由 prompt 重发该消息）
    piReadyRef.current = { sid: '', ready: false }
    const r = await runPiTurn(activeProjectId, activeSessionId, base, {
      port: runningCard.template.serverPort,
      text: lastUser?.content ?? '',
      workspaceDir: activeProject.workspaceDir,
      approveWriteEdit: !!activeProject.approveWriteEdit,
      knowledgeBaseId: activeProject.knowledgeBaseId,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runPiTurn])

  // 重发：截断保留到该 user 消息（含），重新生成其回复
  const resendAt = useCallback(async (msgId: string) => {
    if (loading || !runningCard || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0 || msgs[idx]!.role !== 'user') return
    const base = msgs.slice(0, idx + 1)
    regenRollbackRef.current = { sid: activeSessionId, messages: msgs.map(m => ({ ...m })) }
    updateSessionInProject(activeProjectId, activeSessionId, { messages: base })
    // pi SDK：重建 session（history=base 不含最后 user，由 prompt 重发该消息）
    piReadyRef.current = { sid: '', ready: false }
    const r = await runPiTurn(activeProjectId, activeSessionId, base, {
      port: runningCard.template.serverPort,
      text: msgs[idx]!.content,
      workspaceDir: activeProject.workspaceDir,
      approveWriteEdit: !!activeProject.approveWriteEdit,
      knowledgeBaseId: activeProject.knowledgeBaseId,
    })
    rollbackIfFailed(r)
  }, [loading, runningCard, activeSession, activeProject, activeProjectId, activeSessionId, updateSessionInProject, runPiTurn])

  // 分支：从指定 user 消息处复制出一条新会话（不自动运行）
  const branchAt = useCallback((msgId: string) => {
    if (!activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx < 0 || msgs[idx]!.role !== 'user') return
    const branchMsgs = msgs.slice(0, idx + 1).map(m => ({ ...m }))
    const branchSess: AgentSession = { id: uniqueId('sess'), title: activeSession.title + ' (分支)', messages: branchMsgs }
    setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, sessions: [...p.sessions, branchSess] } : p))
    setActiveSessionId(branchSess.id)
    notify('已创建分支对话', 'success')
  }, [activeSession, activeProjectId, setProjects, setActiveSessionId])

  // 编辑用户消息：进入内联编辑（保存时截断其后所有消息，不自动发送）
  const editAt = useCallback((msgId: string) => {
    const m = activeSession?.messages.find(x => x.id === msgId)
    if (!m || m.role !== 'user') return
    setEditingMsgId(msgId)
    setEditDraft(m.content)
  }, [activeSession])

  const confirmEdit = useCallback(() => {
    if (!editingMsgId || !activeSession) return
    const msgs = activeSession.messages
    const idx = msgs.findIndex(m => m.id === editingMsgId)
    if (idx < 0) { setEditingMsgId(null); return }
    const newContent = editDraft
    const updated = msgs.slice(0, idx).concat({ ...msgs[idx]!, content: newContent })
    // 编辑历史消息会改动/截断历史，旧摘要可能失真：清除 memory，下次发送按需重新压缩
    updateSessionInProject(activeProjectId, activeSessionId, { messages: updated, memory: undefined })
    setEditingMsgId(null)
  }, [editingMsgId, editDraft, activeSession, activeProjectId, activeSessionId, updateSessionInProject])

  // 一键撤销：把工具执行前的原文件内容写回（仅当前会话内存备份有效）
  // pi 模式：备份在 main 侧（backupsRef 存 `pi-undo:<id>` 标记，走 pi-agent-undo IPC）
  const handleUndo = useCallback(async (msgId: string, tcId: string) => {
    const b = backupsRef.current[tcId]
    if (!b) return
    const markRestored = (): void => {
      delete backupsRef.current[tcId]
      setProjects(prev => prev.map(p => p.id === activeProjectId ? {
        ...p,
        sessions: p.sessions.map(s => s.id === activeSessionId ? {
          ...s,
          messages: s.messages.map(m => m.id === msgId ? {
            ...m,
            toolCalls: (m.toolCalls || []).map(t => t.id === tcId ? { ...t, restored: true, backupPath: undefined } : t)
          } : m)
        } : s)
      } : p))
    }
    if (b.path.startsWith('pi-undo:')) {
      // pi 模式：撤销在 main 进程执行（写回备份或删除新建文件）
      const backupId = b.path.slice('pi-undo:'.length)
      try {
        const res = await window.api.piAgent.undo(`pi-${activeSessionId}`, backupId)
        if (!res.success) { notify('撤销失败：' + (res.error || '未知错误'), 'error'); return }
        markRestored()
        notify('已恢复文件', 'success')
      } catch (e: any) {
        notify('撤销失败：' + (e?.message || '未知错误'), 'error')
      }
      return
    }
    let res: { success: boolean; error?: string }
    try {
      res = await window.api.writeFile(b.path, b.content)
    } catch (e: any) {
      notify('恢复失败：' + (e?.message || '未知错误'), 'error')
      return
    }
    if (!res.success) { notify('恢复失败：' + (res.error || '未知错误'), 'error'); return }
    markRestored()
    notify('已恢复文件：' + dirName(b.path), 'success')
  }, [activeProjectId, activeSessionId, setProjects])
  // 转发给 runSlashAction 使用（其定义早于 handleUndo）
  handleUndoRef.current = handleUndo

  // 一键撤销本次全部修改：同一消息内所有仍在备份中的工具调用（Write/Edit 等）
  // 逐一把原文件内容写回；成功后统一标记 restored 并弹一条汇总通知（避免逐条 toast）。
  const handleUndoAll = useCallback(async (msgId: string, toolCalls: AgentMessage['toolCalls']) => {
    const entries = (toolCalls || []).map(tc => ({ id: tc.id, b: backupsRef.current[tc.id] })).filter(e => e.b)
    if (!entries.length) return
    let ok = 0
    const failed: string[] = []
    const okIds = new Set<string>()
    for (const { id, b } of entries) {
      try {
        const res = await window.api.writeFile(b.path, b.content)
        if (!res.success) { failed.push(dirName(b.path)); continue }
        delete backupsRef.current[id]
        okIds.add(id)
        ok++
      } catch { failed.push(dirName(b.path)) }
    }
    setProjects(prev => prev.map(p => p.id === activeProjectId ? {
      ...p,
      sessions: p.sessions.map(s => s.id === activeSessionId ? {
        ...s,
        messages: s.messages.map(m => m.id === msgId ? {
          ...m,
          toolCalls: (m.toolCalls || []).map(t => okIds.has(t.id) ? { ...t, restored: true, backupPath: undefined } : t)
        } : m)
      } : s)
    } : p))
    if (ok && failed.length === 0) notify(`已撤销 ${ok} 个文件的修改`, 'success')
    else if (ok) notify(`已撤销 ${ok} 个文件的修改，${failed.length} 个失败：${failed.join('、')}`, 'error')
    else notify('撤销失败：' + failed.join('、'), 'error')
  }, [activeProjectId, activeSessionId, setProjects])

  // 稳定的「可撤销判断 / 撤销回调」引用：直接内联箭头函数会导致每次父组件重渲染都生成
  // 新函数身份，击穿 ToolCallGroup / ToolCallCard 的 React.memo，使工具卡片在流式每帧
  // （~100ms）都重新挂载 → 展开状态下 ToolArgsView / ToolResultView 反复重算 → 工具栏卡顿跳动。
  // 用 useCallback 固定身份后，memo 生效，非变化的卡片被跳过，抖动消除。
  const canUndoFor = useCallback((tc: NonNullable<AgentMessage['toolCalls']>[number]) => !!backupsRef.current[tc.id], [])
  const onUndoTool = useCallback((msgId: string, tc: NonNullable<AgentMessage['toolCalls']>[number]) => { void handleUndo(msgId, tc.id) }, [handleUndo])

  // 已完成消息行动作经「稳定 ref」传给 memo 行组件：ref 引用不变，useCallback 依赖
  // 漂移不会击穿 AgentMessageRow 的 React.memo（流式期间已完成行整行跳过 reconcile）。
  const msgRowActionsRef = useRef<AgentMsgRowActions>(null!)
  msgRowActionsRef.current = {
    onPreviewFile: openFileAtLine,
    canUndoFor,
    onUndo: onUndoTool,
    openGitDiffAt,
    handleUndoAll,
    copyMessage,
    regenerateAt,
  }

  return {
    copyMessage, regenerateAt, resendAt, branchAt, editAt, confirmEdit,
    handleUndo, handleUndoAll, canUndoFor, onUndoTool, msgRowActionsRef,
  }
}

