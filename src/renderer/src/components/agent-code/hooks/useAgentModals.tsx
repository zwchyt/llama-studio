// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentModals —— 提示词 / 知识库弹层、欢迎页建议与注释发送              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的一组弹层与「发送」动作（逻辑与注释未变）：
//   · openPromptModal / saveSystemPrompt —— 系统提示词编辑器（含审批开关与项目记忆草稿）
//   · openKbModal                        —— 知识库列表弹层（只读展示本机全部知识库）
//   · SUGGESTIONS / sendSuggestion      —— 欢迎页建议（按工作区模式各一套；模型未启动则填入输入框）
//   · sendAnnotationsToAgent             —— 浏览器 UI 注释发送
//   · sendHtmlAnnotations                —— HTML 预览注释发送（发送后清空宿主面板与页内角标）
//
// SUGGESTIONS 含 JSX 图标，故本文件为 .tsx。
// UI 注释的注入 / 开关 / 清空 / 删除与推送 effect 已抽至 useAgentPreviewTabs。

import React, { useCallback } from 'react'
import { Bot, Bug } from 'lucide-react'
import { CodeIcon, GitBranchIcon, GlobeIcon, BrainIcon, BookOpenIcon, FileTextIcon } from '@animateicons/react/lucide'
import { notify } from '../../../store/notificationStore'
import { formatAnnotations } from '../../AgentBrowser'
import type { AgentMode, CardState } from '../../../../../shared/types'
import type { useAgentProjects } from './useAgentProjects'
import type { useAgentUiState } from './useAgentUiState'
import type { useAgentPreviewTabs } from './useAgentPreviewTabs'
import type { useAgentInput } from './useAgentInput'

export function useAgentModals({
  projects: projectsDomain, ui, preview: previewDomain, inputDomain,
  loading, apiBaseUrl, runningCard, handleSend,
}: {
  projects: ReturnType<typeof useAgentProjects>
  ui: ReturnType<typeof useAgentUiState>
  preview: ReturnType<typeof useAgentPreviewTabs>
  inputDomain: ReturnType<typeof useAgentInput>
  loading: boolean
  apiBaseUrl: string | null
  runningCard: CardState | undefined
  handleSend: (overrideText?: string) => void
}) {
  const { activeProject, activeProjectId, updateProject } = projectsDomain
  const {
    promptModalOpen, setPromptModalOpen, promptDraft, setPromptDraft,
    approveWriteEditDraft, setApproveWriteEditDraft, memoryDraft, setMemoryDraft,
    setKnowledgeBases, kbModalOpen, setKbModalOpen,
  } = ui
  const { htmlAnnotations, setHtmlAnnotations, htmlPreviewRef } = previewDomain
  const { setInput } = inputDomain

  // 系统提示词编辑器
  const openPromptModal = useCallback(() => {
    const next = !promptModalOpen
    setPromptModalOpen(next)
    if (next) {
      setPromptDraft(activeProject.systemPrompt ?? '')
      setApproveWriteEditDraft(!!activeProject.approveWriteEdit)
      setMemoryDraft(activeProject.memory?.notes ?? '')
      window.api.knowledgeList().then(setKnowledgeBases).catch(() => { })
    }
  }, [activeProject, promptModalOpen])

  const saveSystemPrompt = useCallback(() => {
    updateProject(activeProjectId, {
      systemPrompt: promptDraft,
      approveWriteEdit: approveWriteEditDraft,
      memory: { notes: memoryDraft.trim(), updatedAt: Date.now() },
    })
    setPromptModalOpen(false)
    notify('已保存系统提示词', 'success')
  }, [activeProjectId, promptDraft, approveWriteEditDraft, memoryDraft, updateProject])

  // 知识库弹层（独立按钮；只读展示本机全部知识库——工具常驻，模型按名称自行检索任意库）
  const openKbModal = useCallback(() => {
    const next = !kbModalOpen
    setKbModalOpen(next)
    if (next) {
      window.api.knowledgeList().then(setKnowledgeBases).catch(() => { })
    }
  }, [kbModalOpen])

  // 欢迎页建议：按工作区模式各一套。模型已启动则直接发送，否则填入输入框待手动发送。
  // 编码模式那套围绕「读代码 / 改代码」；通用模式那套刻意对齐它真正能用的四个工具
  // （时间 / 网络搜索 / 网页抓取 / 知识库检索），不出现文件与终端相关的引导。
  const AGENT_SUGGESTIONS: { text: string; icon: React.ReactNode }[] = [
    { text: '讲讲这个代码库的架构', icon: <CodeIcon size={13} /> },
    { text: '总结最近的 git 改动', icon: <GitBranchIcon size={13} /> },
    { text: '智能体的运行主循环在哪，它做了什么？', icon: <Bot size={13} /> },
    { text: '找出并修复这个项目里的一个 bug', icon: <Bug size={13} /> },
  ]
  const CHAT_SUGGESTIONS: { text: string; icon: React.ReactNode }[] = [
    { text: '帮我查一下最近的热点新闻', icon: <GlobeIcon size={13} /> },
    { text: '用简单的话解释一个概念', icon: <BrainIcon size={13} /> },
    { text: '从知识库里找相关文档', icon: <BookOpenIcon size={13} /> },
    { text: '把一段网页内容总结成要点', icon: <FileTextIcon size={13} /> },
  ]
  const SUGGESTIONS: Record<AgentMode, { text: string; icon: React.ReactNode }[]> = {
    code: AGENT_SUGGESTIONS,
    chat: CHAT_SUGGESTIONS,
  }
  const sendSuggestion = useCallback((text: string) => {
    if (loading || !apiBaseUrl || !runningCard) {
      setInput(text)
      return
    }
    handleSend(text)
  }, [loading, apiBaseUrl, runningCard, handleSend])

  // ── UI 注释的「发送」动作（注入/开关/清空/删除与推送 effect 已抽至
  // agent-code/hooks/useAgentPreviewTabs.ts）──
  // UI 注释发送（浏览器注释面板）：模型已启动直接发送，否则填入输入框待手动发送
  const sendAnnotationsToAgent = useCallback((text: string) => {
    if (loading || !apiBaseUrl || !runningCard) {
      setInput(text)
      notify('模型未启动，UI 注释已填入输入框', 'info')
      return
    }
    handleSend(text)
    notify('UI 注释已发送给 Agent', 'success')
  }, [loading, apiBaseUrl, runningCard, handleSend, notify])

  // HTML 预览注释发送：发送后清空宿主面板 + 页面内角标（卡片消失，内容已在会话可复查）
  const sendHtmlAnnotations = useCallback(() => {
    if (!htmlAnnotations.length) return
    sendAnnotationsToAgent(formatAnnotations(htmlAnnotations))
    setHtmlAnnotations([])
    const win = htmlPreviewRef.current?.contentWindow as (Window & { __agentAnnotate?: any }) | null
    try { win?.__agentAnnotate?.clear() } catch { }
  }, [htmlAnnotations, sendAnnotationsToAgent])

  return {
    openPromptModal, saveSystemPrompt, openKbModal,
    SUGGESTIONS, sendSuggestion, sendAnnotationsToAgent, sendHtmlAnnotations,
  }
}
