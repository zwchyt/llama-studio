// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentSessionActions —— 队列补写、片段引用、停止、目录与重命名交互      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的一组会话级动作（逻辑与注释未变）：
//   · queueRemoved          —— 队列出队检测（多重集语义，正确处理重复文本）
//   · appendQueuedUserMsg   —— 队列真正执行时把该条用户消息补写进历史真相源 + live msgs
//   · addCodeSnippet        —— 源码预览选中代码后生成代码片段胶囊（按行号整行切片）
//   · handleStop            —— 停止生成（中止当前流式 + 退出工具循环）
//   · changeProjectDir      —— 为项目选择/切换工作目录
//   · 项目 / 会话重命名交互（sessRenamingId / projRenamingId 及其输入框 ref）
//
// 依赖注入采用「整域透传」：projects / run / ui / preview / inputDomain 直接传各 hook
// 的返回值。本 hook 在 useAgentLoop 之前调用（queueRemoved / appendQueuedUserMsg
// 是循环域的入参）；消息行的动作 ref（msgRowActionsRef）则归属 useAgentMessageActions。
//
// 注：openPreviewAtLine / openFileAtLine 两个「预览域 → 外部」的桥接回调已并入
// useAgentPreviewTabs，本文件不再持有。

import { useCallback, useRef, useState } from 'react'
import { safeCall } from '../../../utils/safeCall'
import { newMsgId, uniqueId } from '../utils/ids'
import { dirName } from '../utils/paths'
import type { AgentMessage, AgentProject } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'
import type { useAgentRunState } from './useAgentRunState'
import type { useAgentUiState } from './useAgentUiState'
import type { useAgentPreviewTabs } from './useAgentPreviewTabs'
import type { useAgentInput } from './useAgentInput'

export function useAgentSessionActions({
  projects: projectsDomain, run, ui, preview: previewDomain, inputDomain,
}: {
  projects: ReturnType<typeof useAgentProjects>
  run: ReturnType<typeof useAgentRunState>
  ui: ReturnType<typeof useAgentUiState>
  preview: ReturnType<typeof useAgentPreviewTabs>
  inputDomain: ReturnType<typeof useAgentInput>
}) {
  const {
    activeProjectId, activeSessionId, activeSession,
    updateProject, updateSessionInProject,
  } = projectsDomain
  const {
    abortRef, piReadyRef, currentStreamIdRef, followUpQueueRef, prevQueueRef,
    appendLiveUserMsgRef, setQueueInfo, setLoading,
  } = run
  const { approvalResolveRef } = ui
  const { activeTab, activeTabPath } = previewDomain
  const { setCodeSnippets, setPreviewSelPopover } = inputDomain

  // 队列出队检测：返回 prev 中存在、next 中不存在的项（多重集语义，正确处理重复文本）
  function queueRemoved(prev: string[], next: string[]): string[] {
    const removed: string[] = []
    const nextCount = new Map<string, number>()
    for (const x of next) nextCount.set(x, (nextCount.get(x) ?? 0) + 1)
    for (const x of prev) {
      const c = nextCount.get(x) ?? 0
      if (c > 0) nextCount.set(x, c - 1)
      else removed.push(x)
    }
    return removed
  }

  // 队列真正执行（出队）时，把该条用户消息补写进历史真相源 + 本轮 live msgs，
  // 使其此刻出现在对话里（而非提前堆入）；live msgs 同步避免轮末 commit 覆盖丢失。
  const appendQueuedUserMsg = useCallback((text: string) => {
    const pid = activeProjectId
    const sid = activeSessionId
    if (!pid || !sid) return
    const userMsg: AgentMessage = { id: newMsgId(), role: 'user', content: text }
    const sess = activeSession
    const base = sess && sess.id === sid ? sess.messages : []
    updateSessionInProject(pid, sid, { messages: [...base, userMsg] })
    appendLiveUserMsgRef.current(userMsg)
  }, [updateSessionInProject, activeSession, activeSessionId, activeProjectId])

  // ── 代码片段胶囊：从源码预览中选中代码后引用 ──
  // 注：state（codeSnippets）与 setter 由 useAgentInput 持有，此处只做「预览域 →
  // 输入域」的桥接——切片需要预览域的 activeTab / activeTabPath，而 useAgentInput
  // 在 useAgentPreviewTabs 之前调用，故本回调留在本 hook（而非 useAgentInput）。
  // 代码内容按行号从文件原文整行切片（而非原始选区字符串）：
  // 保证标注 L a-b 与内容严格一致，半行选择也自动补全为完整行；选区字符串仅作兜底。
  const addCodeSnippet = useCallback((startLine: number, endLine: number, text: string) => {
    const path = activeTabPath || ''
    const fileName = path.replace(/\\/g, '/').split('/').pop() || 'code'
    const fileContent = activeTab?.content
    const code = fileContent != null
      ? fileContent.split('\n').slice(startLine - 1, endLine).join('\n')
      : text
    // 缩略生成：取第一行非空内容，超30字符截断
    const lines = code.split('\n').filter(l => l.trim())
    let preview = lines[0]?.trim() || ''
    if (preview.length > 30) preview = preview.slice(0, 30) + '···'
    // 去重：同一文件同一行范围不重复添加
    setCodeSnippets(prev => {
      if (prev.some(s => s.filePath === path && s.startLine === startLine && s.endLine === endLine)) return prev
      return [...prev, { id: uniqueId('snip'), filePath: path, fileName, startLine, endLine, code, preview }]
    })
    setPreviewSelPopover(null)
    try { window.getSelection()?.removeAllRanges() } catch { /* ignore */ }
  }, [activeTabPath, activeTab?.content])

  // ── 停止生成（中止当前流式 + 退出工具循环）──
  const handleStop = useCallback(() => {
    abortRef.current.aborted = true
    // 若正卡在「破坏性工具审批」弹窗，按停止等价于「拒绝」，避免挂死
    if (approvalResolveRef.current) approvalResolveRef.current(false)
    // pi 引擎：中止 pi session
    if (piReadyRef.current.ready) {
      const sid = `pi-${piReadyRef.current.sid}`
      window.api.piAgent.abort(sid).catch(() => { })
      // 清空 steer/followUp 队列，避免 abort 后队列自动续跑；
      // 重置 prevQueue 使随后 SDK 的 queue_update（移除条目）不被误判为「已执行」而补写历史
      window.api.piAgent.clearQueue(sid).catch(() => { })
      followUpQueueRef.current = []
      prevQueueRef.current = { followUp: [] }
      setQueueInfo({ followUp: [] })
    }
    const resolve = abortRef.current.resolve
    if (resolve) { resolve(); abortRef.current.resolve = null }
    currentStreamIdRef.current = null
    setLoading(false)
  }, [])

  // 为已有/默认项目选择或切换工作目录（默认项目 sessions:[] 且 workspaceDir:'' 时也可使用）
  const changeProjectDir = useCallback(async (projId: string) => {
    const res = await safeCall<{ path: string | null }>(() => window.api.selectDirectory(), '选择目录')
    if (!res?.path) return
    // 更改目录后，标题同步显示为该目录的主目录文件名，
    // 使左侧标题栏始终等于当前切换到的目录名
    const patch: Partial<AgentProject> = { workspaceDir: res.path, title: dirName(res.path) }
    updateProject(projId, patch)
  }, [updateProject])

  // ── 项目 / 会话重命名交互（侧栏内联编辑）──
  const [sessRenamingId, setSessRenamingId] = useState<string | null>(null)
  const [sessRenameText, setSessRenameText] = useState('')
  const sessRenameInputRef = useRef<HTMLInputElement>(null)
  const [projRenamingId, setProjRenamingId] = useState<string | null>(null)
  const [projRenameText, setProjRenameText] = useState('')
  const projRenameInputRef = useRef<HTMLInputElement>(null)

  const confirmProjRename = () => {
    const text = projRenameText.trim()
    if (text && projRenamingId) updateProject(projRenamingId, { title: text })
    setProjRenamingId(null)
  }

  const startSessRename = (sessId: string, currentTitle: string) => {
    setSessRenamingId(sessId)
    setSessRenameText(currentTitle)
    setTimeout(() => sessRenameInputRef.current?.focus(), 0)
  }

  const confirmSessRename = (projId: string, sessId: string) => {
    const text = sessRenameText.trim()
    if (text) updateSessionInProject(projId, sessId, { title: text })
    setSessRenamingId(null)
  }

  return {
    queueRemoved, appendQueuedUserMsg, addCodeSnippet, handleStop, changeProjectDir,
    sessRenamingId, setSessRenamingId, sessRenameText, setSessRenameText, sessRenameInputRef,
    projRenamingId, setProjRenamingId, projRenameText, setProjRenameText, projRenameInputRef,
    confirmProjRename, startSessRename, confirmSessRename,
  }
}
