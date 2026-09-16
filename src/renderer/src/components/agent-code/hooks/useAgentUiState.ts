// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentUiState —— 界面状态域（面板 / 弹层 / 模型选择器 / 任务卡 / 审批） ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的界面状态声明与其配套回调 / effect，逻辑与注释均未改动：
//   · 顶栏卡片按钮 ref（上下文 / 压缩 / 审计 / 轨迹 / 调试 / 提示词 / 知识库 / 记忆）
//   · 模型选择器（打开态、宽度估算、能力徽标、Logo 菜单与设置/移除）
//   · 联网搜索开关（searchEnabled / searchProvider 与其变更回调 applySearchChange）
//   · 侧栏 / 文件树 / 右侧面板模式 / 终端挂载 / 各功能面板开关
//   · 任务清单卡（Todo 面板）：打开态、关闭过渡态、计划项与标题、派生计数
//   · 破坏性审批弹窗（approvalReq / resolveApproval / 键盘导航）
//   · 提示词卡与知识库卡的草稿态
//   · 用户消息内联编辑态（editingMsgId / editDraft）
//
// 外部输入：agentCards（模型下拉列表）、loading 与 piReadyRef（联网搜索变更需作废 pi 会话）。
// 对外输出：上述全部 state（值 + setter）与 ref、以及若干派生值 / 回调。
//
// 注意：面板的 usePopoverDismiss 调用与 handleModelAction 仍留在主组件
// （前者与 condenseOpen 等循环域状态交织，后者是独立的模型卡动作域）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { safeCall } from '../../../utils/safeCall'
import { detectModelCapabilities } from '../../../utils/modelCapabilities'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { askUserQuestionRegistry } from '../../../utils/askUserQuestionRegistry'
import type { CardState, KnowledgeBaseMeta, TodoUpdate } from '../../../../../shared/types'

export function useAgentUiState({
  agentCards, loading, piReadyRef,
}: {
  agentCards: CardState[]
  loading: boolean
  piReadyRef: React.RefObject<{ sid: string | null; ready: boolean }>
}) {

  const ctxInlineRef = useRef<HTMLButtonElement>(null)
  const condenseBtnRef = useRef<HTMLButtonElement>(null)
  const auditBtnRef = useRef<HTMLButtonElement>(null)
  const trajBtnRef = useRef<HTMLButtonElement>(null)
  const debugBtnRef = useRef<HTMLButtonElement>(null)
  const promptBtnRef = useRef<HTMLButtonElement>(null)
  const kbBtnRef = useRef<HTMLButtonElement>(null)
  const memoryBtnRef = useRef<HTMLButtonElement>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const searchEnabled = useStore(s => s.searchEnabled)
  const searchProvider = useStore(s => s.searchProvider)
  const [searchMenuOpen, setSearchMenuOpen] = useState(false)
  const searchMenuRef = useRef<HTMLDivElement>(null)
  const closeSearchMenu = useCallback(() => setSearchMenuOpen(false), [setSearchMenuOpen])
  usePopoverDismiss(!!searchMenuOpen, closeSearchMenu, undefined, undefined, searchMenuRef)
  const applySearchChange = (enabled: boolean, provider: 'ddg' | 'bing') => {
    setSearchMenuOpen(false)
    const st = useStore.getState()
    if (enabled === st.searchEnabled && provider === st.searchProvider) return
    st.setSearchEnabled(enabled)
    st.setSearchProvider(provider)
    const cur = piReadyRef.current
    const sid = cur.sid
    if (cur.ready && sid && !loading) {
      window.api.piAgent.dispose(`pi-${sid}`).catch(() => { })
      piReadyRef.current = { sid: null, ready: false }
    }
  }
  // 各模型的能力徽标（key = template.id；null = 读取失败/非 GGUF，不显示图标）：
  // 全局 store 共享 + model-capabilities.json 持久化，检测结果不重复读盘
  const modelCaps = useStore(s => s.modelCapabilities)
  const loadModelCapabilities = useStore(s => s.loadModelCapabilities)
  // 下拉面板宽度：按列表中最长模型名 + 行内元素估算，保证名称完整显示不省略
  // （不依赖打开状态：收起时宽度保持同一值，避免关闭动画期间重排抖动）
  const modelPickerWidth = useMemo(() => {
    if (agentCards.length === 0) return 300
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return 300
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    // 行内固定余量：logo 26 + 间距 8×3 + 按钮 28 + 面板/条目内边距 24
    let maxW = 0
    for (const card of agentCards) {
      const caps = modelCaps[card.template.id]
      const capsCount = caps ? Number(!!caps.thinking) + Number(!!caps.tools) + Number(!!caps.vision) : 0
      const capsW = capsCount > 0 ? capsCount * 20 + 4 : 0
      maxW = Math.max(maxW, ctx.measureText(card.template.name).width + 26 + 8 * 3 + 28 + 24 + 24 + capsW)
    }
    return Math.min(Math.max(maxW, 300), 560)
  }, [agentCards, modelCaps])
  // 各模型的自定义 Logo（key = template.id；data URL 或 null=无）：全局 store 共享，
  // 与「我的模板」卡片同一份数据，任一处设置/移除后两处立即同步
  const modelLogos = useStore(s => s.modelLogos)
  const setModelLogoEntry = useStore(s => s.setModelLogoEntry)
  const loadModelLogos = useStore(s => s.loadModelLogos)
  // 打开下拉时兜底补读（App 启动已全局加载；此处幂等，只读缺失项）
  useEffect(() => {
    if (modelPickerOpen) void loadModelLogos().catch(() => { })
  }, [modelPickerOpen, loadModelLogos])
  // 已有 Logo 时点击弹出的菜单（更换/移除）：固定定位坐标来自点击处
  const [logoMenu, setLogoMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const logoMenuRef = useRef<HTMLDivElement>(null)

  // 无 Logo → 直接选图；有 Logo → 弹出更换/移除菜单（菜单 fixed 定位，避开 picker 滚动裁切）
  const toggleLogoMenu = useCallback((e: React.MouseEvent, card: CardState) => {
    if (!modelLogos[card.template.id]) { void pickModelLogo(card); return }
    if (logoMenu?.id === card.template.id) { setLogoMenu(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setLogoMenu({ id: card.template.id, x: rect.right, y: rect.bottom })
  }, [modelLogos, logoMenu])
  // 选图：主进程弹选择框、复制进 logos/ 并更新映射 → 立即刷新图片
  const pickModelLogo = useCallback(async (card: CardState) => {
    const res = await window.api.setModelLogo(card.template.id)
    if (!res.success) {
      if (res.error !== '已取消') notify(`设置 Logo 失败：${res.error}`, 'error')
      return
    }
    const img = await window.api.getModelLogoImage(res.fileName!)
    setModelLogoEntry(card.template.id, img.success && img.dataUrl ? img.dataUrl : null)
    setLogoMenu(null)
  }, [])
  // 移除：删文件 + 清映射记录 + 还原占位图标
  const removeModelLogo = useCallback(async (card: CardState) => {
    const res = await safeCall(() => window.api.removeModelLogo(card.template.id), '移除 Logo 失败')
    if (!res) return
    if (!res.success) { notify(`移除 Logo 失败：${res.error}`, 'error'); return }
    setModelLogoEntry(card.template.id, null)
    setLogoMenu(null)
  }, [])
  // Logo 菜单外部点击收起
  const closeLogoMenu = useCallback(() => setLogoMenu(null), [setLogoMenu])
  usePopoverDismiss(!!logoMenu, closeLogoMenu, undefined, undefined, logoMenuRef)

  // 打开下拉时对未缓存的模型读取 GGUF 元数据并判定能力（只读头部，毫秒级）；
  // 检测成功即持久化到 model-capabilities.json，下次启动直接载入不再读盘
  useEffect(() => {
    if (!modelPickerOpen) return
    void loadModelCapabilities().catch(() => { })
    const store = useStore.getState()
    const missing = store.cards.filter(c => !(c.template.id in modelCaps) && !!c.template.modelPath)
    if (missing.length === 0) return
      ; (async () => {
        await Promise.allSettled(missing.map(async (card) => {
          const res = await window.api.readGgufMeta(card.template.modelPath!)
          if ('error' in res || !card.template.modelPath) return
          const caps = detectModelCapabilities({ architecture: res.architecture, chatTemplate: res.chatTemplate, kv: res.kv })
          useStore.getState().setModelCapabilitiesEntry(card.template.id, caps)
          void window.api.saveModelCapabilities(card.template.id, caps).catch(() => { })
        }))
      })()
    // modelCaps 不参与依赖：缓存命中判断用引用快照，避免打开一次列表触发两轮读取
  }, [modelPickerOpen])
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const attachBtnRef = useRef<HTMLButtonElement>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  // 右侧面板模式：files=文件树+预览 / browser=内嵌浏览器 / terminal=内嵌终端 / diff=Git变更
  const [rightPanelMode, setRightPanelMode] = useState<'files' | 'browser' | 'terminal' | 'diff'>('files')
  const [terminalMounted, setTerminalMounted] = useState(false)
  useEffect(() => {
    if (rightPanelMode === 'terminal') setTerminalMounted(true)
  }, [rightPanelMode])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [contextModalOpen, setContextModalOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)  // 操作审计面板开关
  const [trajOpen, setTrajOpen] = useState(false)  // 轨迹台账面板开关
  const [debugOpen, setDebugOpen] = useState(false)  // 调试面板开关
  const [memoryOpen, setMemoryOpen] = useState(false)  // 长期记忆面板开关
  const treeOpenRef = useRef(treeOpen)
  treeOpenRef.current = treeOpen
  // 任务清单（Todo / Task 工具的可视化面板）
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  // 卡片关闭过渡态：关闭时先播放收起/淡出动画，动画结束再真正卸载（taskModalOpen=false）。
  // 过渡期间卡片真实高度仍由 ResizeObserver 写入 --task-card-h，消息区平滑跟降，无突跳/留缝。
  const [taskCardClosing, setTaskCardClosing] = useState(false)
  // 当前 TodoWrite 计划项（每次新调用替换，不累加）
  const [currentPlanItems, setCurrentPlanItems] = useState<TodoUpdate[]>([])
  // 待办卡片派生计数（头部饼图/滚动计数用）
  const taskDoneCount = currentPlanItems.filter(i => i.status === 'completed').length
  // 计划总标题（plan 级别，区别于每条待办 content）：仅用于内联卡片展示，不持久化
  const [planTitle, setPlanTitle] = useState('')

  const [taskPanelCollapsed, setTaskPanelCollapsed] = useState(false)

  // 点击任务卡片外部 / Escape 关闭：进入过渡态（播放收起动画），而非立即卸载
  useEffect(() => {
    if (!taskModalOpen || taskCardClosing) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTaskCardClosing(true)
      }
    }
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('keydown', close)
    }
  }, [taskModalOpen, taskCardClosing])

  const [reqCount, setReqCount] = useState(0)
  const [cumTokens, setCumTokens] = useState(0)
  const [approvalReq, setApprovalReq] = useState<{ id: string; name: string; args: string } | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const autoApproveRef = useRef(false)
  const rejectBtnRef = useRef<HTMLButtonElement>(null)
  const autoApproveBtnRef = useRef<HTMLButtonElement>(null)
  const allowBtnRef = useRef<HTMLButtonElement>(null)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [approveWriteEditDraft, setApproveWriteEditDraft] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState('')  // 提示词卡片内的项目记忆草稿
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseMeta[]>([])
  const [kbModalOpen, setKbModalOpen] = useState(false)
  const [kbCopiedId, setKbCopiedId] = useState<string | null>(null)

  usePopoverDismiss(promptModalOpen, setPromptModalOpen, promptBtnRef, '.agent-card-prompt')
  usePopoverDismiss(kbModalOpen, setKbModalOpen, kbBtnRef, '.agent-card-kb, .agent-card-kb-panel')

  // 用户消息内联编辑中的消息 id（null = 无）
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const resolveApproval = useCallback((approved: boolean) => {
    const r = approvalResolveRef.current
    approvalResolveRef.current = null
    setApprovalReq(null)
    if (r) r(approved)
  }, [])
  // 审批面板键盘导航：方向键切换按钮，Enter 确认允许，Escape 拒绝
  useEffect(() => {
    if (!approvalReq) return
    const btns = [rejectBtnRef.current, autoApproveBtnRef.current, allowBtnRef.current].filter(Boolean) as HTMLButtonElement[]
    let idx = 2 // 默认聚焦「允许」按钮
    const focusIdx = (i: number) => {
      idx = (i + btns.length) % btns.length
      btns[idx]?.focus()
    }
    focusIdx(idx)
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); focusIdx(idx + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusIdx(idx - 1) }
      else if (e.key === 'Escape') { e.preventDefault(); resolveApproval(false) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [approvalReq, resolveApproval])
  // ── pi 模式：跨进程 AskUserQuestion / 破坏性审批（main 工具执行中等待弹窗结果）──
  useEffect(() => {
    window.api.piAgent.onAsk((id, questions) => {
      askUserQuestionRegistry
        .ask(questions.map(q => ({
          question: q.question,
          options: (q.options ?? []).map(o => ({ label: o, description: '' }))
        })))
        .then((r) => { window.api.piAgent.askResolve(id, r).catch(() => { }) })
        .catch(() => {
          window.api.piAgent.askResolve(id, 'User declined to answer the questions. Continue with the task using your best judgment.').catch(() => { })
        })
    })
    window.api.piAgent.onApprove((id, req) => {
      // 复用现有审批弹窗（approvalReq），确定时回传给 main
      approvalResolveRef.current = (approved) => {
        window.api.piAgent.approveResolve(id, approved).catch(() => { })
      }
      setApprovalReq({ id: String(id), name: req.toolName, args: JSON.stringify(req.args) })
    })
  }, [])

  return {
    // 顶栏卡片按钮 ref
    ctxInlineRef, condenseBtnRef, auditBtnRef, trajBtnRef, debugBtnRef,
    promptBtnRef, kbBtnRef, memoryBtnRef,
    // 模型选择器 / 联网搜索
    modelPickerOpen, setModelPickerOpen, modelPickerRef,
    searchEnabled, searchProvider, searchMenuOpen, setSearchMenuOpen, searchMenuRef,
    closeSearchMenu, applySearchChange,
    modelCaps, loadModelCapabilities, modelPickerWidth,
    modelLogos, setModelLogoEntry, loadModelLogos,
    logoMenu, setLogoMenu, logoMenuRef, toggleLogoMenu, pickModelLogo, removeModelLogo, closeLogoMenu,
    modelBtnRef, attachBtnRef,
    // 侧栏 / 文件树 / 右侧面板 / 终端
    treeOpen, setTreeOpen, rightPanelMode, setRightPanelMode,
    terminalMounted, setTerminalMounted,
    // 功能面板开关
    sidebarOpen, setSidebarOpen, contextModalOpen, setContextModalOpen,
    auditOpen, setAuditOpen, trajOpen, setTrajOpen,
    debugOpen, setDebugOpen, memoryOpen, setMemoryOpen, treeOpenRef,
    // 任务清单卡
    taskModalOpen, setTaskModalOpen, taskCardClosing, setTaskCardClosing,
    currentPlanItems, setCurrentPlanItems, taskDoneCount,
    planTitle, setPlanTitle, taskPanelCollapsed, setTaskPanelCollapsed,
    // 请求计数 / 破坏性审批
    reqCount, setReqCount, cumTokens, setCumTokens,
    approvalReq, setApprovalReq, approvalResolveRef, autoApproveRef,
    rejectBtnRef, autoApproveBtnRef, allowBtnRef, resolveApproval,
    // 提示词卡 / 知识库卡
    promptModalOpen, setPromptModalOpen, promptDraft, setPromptDraft,
    approveWriteEditDraft, setApproveWriteEditDraft, memoryDraft, setMemoryDraft,
    knowledgeBases, setKnowledgeBases, kbModalOpen, setKbModalOpen, kbCopiedId, setKbCopiedId,
    // 用户消息内联编辑
    editingMsgId, setEditingMsgId, editDraft, setEditDraft,
  }
}
