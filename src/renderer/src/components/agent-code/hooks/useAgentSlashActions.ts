// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentSlashActions —— 动作型 /命令 分发（renderer 侧直接处理）         ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的 runSlashAction（/clear、/compact、/branch、/export、
// /undo、/thinking、/audit、/debug、/kb、/plan … 的 renderer 侧实现），逻辑与注释均未改动。
//
// 与「提示词模板展开」的分工：模板展开（expandCommandTemplate）发生在
// useAgentLoop.handleSend 内、展开结果真的发给模型；本 hook 只处理 kind === 'action'
// 的命令，不产生模型调用。每个命令产出一个文本结果（写入对话）或直接执行 UI 动作。
//
// 外部输入：项目 / 会话域（含 exportSession）、运行态（runningCard / cards / modelLabel /
//           slashCommands / thinkingLevel）、任务清单、压缩域 handleManualCondense、
//           撤销备份 ref（backupsRef / handleUndoRef）。
// 对外输出：runSlashAction（供 useAgentLoop.handleSend 在 /命令 展开前消费）。
//
// 注意：依赖数组与原实现逐项一致（含 cards / thinkingLevel / currentPlanItems 等）。

import React, { useCallback } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { mergeCommands } from '../../../agent/slashCommands'
import { newMsgId, uniqueId } from '../utils/ids'
import type { AgentMessage, AgentProject, AgentSession, CardState, ThinkingLevel, TodoUpdate } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'

export function useAgentSlashActions({
  activeProject, activeProjectId, activeSession, activeSessionId,
  setProjects, setActiveSessionId, updateSessionInProject, exportSession,
  runningCard, cards, modelLabel, slashCommands, thinkingLevel, setThinkingLevel,
  currentPlanItems, handleManualCondense, backupsRef, handleUndoRef,
}: {
  activeProject: AgentProject
  activeProjectId: string
  activeSession: AgentSession | null
  activeSessionId: string
  setProjects: ReturnType<typeof useAgentProjects>['setProjects']
  setActiveSessionId: ReturnType<typeof useAgentProjects>['setActiveSessionId']
  updateSessionInProject: ReturnType<typeof useAgentProjects>['updateSessionInProject']
  exportSession: ReturnType<typeof useAgentProjects>['exportSession']
  runningCard: CardState | undefined
  cards: CardState[]
  modelLabel: string
  slashCommands: ReturnType<typeof useStore.getState>['slashCommands']
  thinkingLevel: ThinkingLevel
  setThinkingLevel: React.Dispatch<React.SetStateAction<ThinkingLevel>>
  currentPlanItems: TodoUpdate[]
  handleManualCondense: () => Promise<void>
  backupsRef: React.RefObject<Record<string, { path: string; content: string }>>
  handleUndoRef: React.RefObject<((msgId: string, tcId: string) => Promise<void>) | null>
}) {


  // ── 动作型 /命令 分发（renderer 侧直接处理，不发给模型）──
  // 每个命令产出一个文本结果（写入对话）或直接执行 UI 动作（如 clear/compact）。
  const runSlashAction = useCallback(async (name: string, args: string): Promise<void> => {
    const st = useStore.getState()
    const pid = activeProjectId
    const metrics = runningCard ? st.modelMetrics[runningCard.template.id] : undefined
    // 确保存在会话（无则就地创建），并返回当前消息基数
    const ensureSession = (): { sid: string; base: AgentMessage[] } => {
      let sid = activeSessionId
      let base = activeSession ? activeSession.messages : []
      if (!activeSession) {
        sid = uniqueId('sess')
        const fresh: AgentSession = { id: sid, title: `/${name}`, messages: [] }
        setProjects(prev => prev.map(p => p.id === pid ? { ...p, sessions: [...p.sessions, fresh] } : p))
        setActiveSessionId(sid)
        base = []
      }
      return { sid, base }
    }
    // 把命令与结果作为 user/assistant 两条消息写入会话
    const appendResult = (text: string): void => {
      const { sid, base } = ensureSession()
      const userMsg: AgentMessage = { id: newMsgId(), role: 'user', content: args ? `/${name} ${args}` : `/${name}` }
      const aMsg: AgentMessage = { id: newMsgId(), role: 'assistant', content: text }
      updateSessionInProject(pid, sid, { messages: [...base, userMsg, aMsg] })
    }
    switch (name) {
      case 'help': {
        const all = mergeCommands(slashCommands)
        const lines = all.map(c => `- \`/${c.name}\` — ${c.description}`)
        appendResult(`# 可用命令\n\n${lines.join('\n')}\n\n（在输入框输入 \`/\` 可唤起自动补全）`)
        return
      }
      case 'status': {
        const model = runningCard ? modelLabel : '（模型未启动）'
        const msgs = activeSession?.messages ?? []
        const parts = [
          '**会话状态**',
          `- 模型：${model}`,
          `- 消息数：${msgs.length}`,
          `- 工作区：${activeProject.workspaceDir || '—'}`,
        ]
        if (metrics) {
          parts.push(`- Prompt Token：${metrics.nPromptTokens}`)
          parts.push(`- 已解码 Token：${metrics.nDecoded}`)
        }
        appendResult(parts.join('\n'))
        return
      }
      case 'context': {
        const m = metrics
        if (!m || !m.nCtx) { appendResult('当前模型未运行或无法读取上下文窗口信息。'); return }
        const used = (m.nPromptTokensProcessed || m.nPromptTokens) + (m.nDecoded || 0)
        const pct = m.nCtx ? Math.round((used / m.nCtx) * 100) : 0
        appendResult([
          '**上下文窗口**',
          `- 上下文大小：${m.nCtx} token`,
          `- 当前占用：约 ${used} token（${pct}%）`,
          `- Prompt：${m.nPromptTokens} / 已处理 ${m.nPromptTokensProcessed} / 缓存 ${m.nPromptTokensCache}`,
          `- 已解码：${m.nDecoded}`,
        ].join('\n'))
        return
      }
      case 'clear': {
        const { sid } = ensureSession()
        updateSessionInProject(pid, sid, { messages: [] })
        notify('已清空当前会话', 'success')
        return
      }
      case 'model': {
        const cur = runningCard ? modelLabel : '（未启动）'
        const running = cards.filter(c => c.status === 'running')
        const others = running.filter(c => c !== runningCard).map(c => `- ${c.template.name}（端口 ${c.template.serverPort}）`)
        appendResult([
          '**当前模型**',
          `- ${cur}`,
          ...(others.length ? ['', '**其他运行中模型**', ...others] : []),
          '',
          '切换模型请在「模型卡片」页启动目标模型，或在顶部模型下拉中选择。',
        ].join('\n'))
        return
      }
      case 'thinking': {
        const arg = args.trim().toLowerCase()
        const valid: ThinkingLevel[] = ['low', 'medium', 'high']
        if (arg && valid.includes(arg as ThinkingLevel)) {
          setThinkingLevel(arg as ThinkingLevel)
          if (runningCard) window.api.piAgent.setThinkingLevel(`pi-${activeSessionId}`, arg as ThinkingLevel).catch(() => { })
          appendResult(`思考程度已设置为 **${arg}**。`)
          return
        }
        appendResult(`当前思考程度：**${thinkingLevel}**\n可选值：low / medium / high（用法：\`/thinking high\`）`)
        return
      }
      case 'tasks': {
        if (!currentPlanItems.length) { appendResult('当前没有待办事项。'); return }
        const done = currentPlanItems.filter(i => i.status === 'completed').length
        const lines = currentPlanItems.map(t => `- [${t.status ?? 'pending'}] ${t.content ?? t.id ?? ''}`)
        appendResult(`**待办清单（${done}/${currentPlanItems.length}）**\n\n${lines.join('\n')}`)
        return
      }
      case 'stats': {
        const m = metrics
        if (!m) { appendResult('当前没有可统计的运行指标（模型未启动）。'); return }
        const decode = m.decodeTokS.length ? m.decodeTokS[m.decodeTokS.length - 1] : 0
        const req = m.reqPerSec.length ? m.reqPerSec[m.reqPerSec.length - 1] : 0
        appendResult([
          '**运行统计**',
          `- Prompt Token：${m.nPromptTokens}`,
          `- 已解码 Token：${m.nDecoded}`,
          `- 缓存 Prompt Token：${m.nPromptTokensCache}`,
          `- 首字延迟(TTFT)：${m.ttftMs ?? '—'} ms`,
          `- Prefill：${m.prefillTokS ?? '—'} tok/s`,
          `- 解码：${decode} tok/s`,
          `- 请求速率：${req} req/s`,
          `- 上下文：${m.nCtx}`,
        ].join('\n'))
        return
      }
      case 'compact': {
        await handleManualCondense()
        appendResult('已触发历史压缩，结果见顶部压缩提示。')
        return
      }
      case 'files': {
        const dir = activeProject.workspaceDir
        if (!dir) { appendResult('未设置工作区目录，无法列出文件。'); return }
        try {
          const res = await window.api.expandFileTree(dir, 60)
          if (!res.success || !res.children) { appendResult(`列出文件失败：${res.error || '未知错误'}`); return }
          const items = res.children.slice().sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
          const lines = items.slice(0, 40).map(c => `${c.isDir ? '📁' : '📄'} ${c.name}`)
          const more = items.length > 40 ? `\n…等共 ${res.total ?? items.length} 项` : ''
          appendResult(`**工作区文件** \`${dir}\`\n\n${lines.join('\n')}${more}`)
        } catch (e: any) {
          appendResult(`列出文件失败：${e?.message || e}`)
        }
        return
      }
      case 'git': {
        const dir = activeProject.workspaceDir
        if (!dir) { appendResult('未设置工作区目录，无法查看 Git 变更。'); return }
        try {
          const data = await window.api.gitChanges(dir)
          if (!data.isRepo) { appendResult(`\`${dir}\` 不是 Git 仓库。`); return }
          if (data.error) { appendResult(`读取 Git 变更失败：${data.error}`); return }
          const fmt = (arr: { path: string; status: string }[]) => arr.map(f => `- ${f.status} ${f.path}`).join('\n')
          const staged = data.staged.length ? `**已暂存（${data.staged.length}）**\n${fmt(data.staged)}` : ''
          const unstaged = data.unstaged.length ? `**未暂存（${data.unstaged.length}）**\n${fmt(data.unstaged)}` : ''
          appendResult([
            `**Git 变更** \`${dir}\``,
            `共 ${data.staged.length + data.unstaged.length} 个文件变更`,
            '', staged, unstaged,
            data.staged.length + data.unstaged.length === 0 ? '工作区干净，无改动。' : '',
          ].filter(Boolean).join('\n'))
        } catch (e: any) {
          appendResult(`读取 Git 变更失败：${e?.message || e}`)
        }
        return
      }
      case 'memory': {
        const dir = activeProject.workspaceDir
        if (!dir) { appendResult('未设置工作区目录，无法读取长期记忆。'); return }
        try {
          const list = await window.api.memstoreList(dir)
          const active = list.filter(e => !e.archived)
          if (!active.length) { appendResult('暂无长期记忆条目。'); return }
          const lines = active.slice(0, 15).map(e => `- [${e.category}] ${e.content}`)
          appendResult(`**长期记忆（${active.length} 条活跃）**\n\n${lines.join('\n')}`)
        } catch (e: any) {
          appendResult(`读取长期记忆失败：${e?.message || e}`)
        }
        return
      }
      case 'kb': {
        try {
          const list = await window.api.knowledgeList()
          if (!list.length) { appendResult('当前没有已加载的知识库。'); return }
          const lines = list.map(k => `- ${k.name}${k.id === activeProject.knowledgeBaseId ? '（当前绑定）' : ''}`)
          appendResult(`**知识库（${list.length} 个）**\n\n${lines.join('\n')}`)
        } catch (e: any) {
          appendResult(`读取知识库失败：${e?.message || e}`)
        }
        return
      }
      case 'branch': {
        if (!activeSession) { appendResult('当前没有可分支的会话。'); return }
        const branchMsgs = activeSession.messages.map(m => ({ ...m }))
        const branchSess: AgentSession = { id: uniqueId('sess'), title: activeSession.title + ' (分支)', messages: branchMsgs }
        setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, sessions: [...p.sessions, branchSess] } : p))
        setActiveSessionId(branchSess.id)
        notify('已创建分支对话', 'success')
        appendResult(`已创建当前会话的分支：**${branchSess.title}**。`)
        return
      }
      case 'export': {
        await exportSession(activeSessionId)
        appendResult('已触发会话导出（结果见系统通知）。')
        return
      }
      case 'undo': {
        if (!activeSession) { appendResult('当前没有会话，无法撤销。'); return }
        let last: { msgId: string; tcId: string; path: string } | null = null
        for (const m of activeSession.messages) {
          for (const tc of m.toolCalls || []) {
            const b = backupsRef.current[tc.id]
            if (b) last = { msgId: m.id, tcId: tc.id, path: b.path }
          }
        }
        if (!last) { appendResult('没有可撤销的文件修改。'); return }
        if (handleUndoRef.current) await handleUndoRef.current(last.msgId, last.tcId)
        appendResult(`已撤销最近一次文件修改：${last.path.startsWith('pi-undo:') ? '(Pi 备份)' : last.path}`)
        return
      }
      default:
        return
    }
  }, [activeProjectId, activeSessionId, activeSession, activeProject, runningCard, cards, modelLabel, slashCommands, thinkingLevel, currentPlanItems, updateSessionInProject, setProjects, setActiveSessionId, setThinkingLevel, handleManualCondense, exportSession, notify])

  return { runSlashAction }
}
