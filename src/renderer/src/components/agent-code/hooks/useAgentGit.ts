// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentGit —— Git 变更列表 / 分支切换（只读视图）                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「Git 变更（只读）」与「Git 分支」两块，逻辑与注释未改。
//
// 自持：gitChanges / gitLoading / currentBranch / branches / branchMenuOpen /
//       workspaceMenuOpen 六个 state，以及分支菜单、工作区菜单的按钮与浮层 ref。
// 外部输入：workspaceDir（当前项目工作区）、右侧面板模式与开关（打开 diff 面板需要）。
// 对外输出：变更数据与加载态、分支信息、两个菜单的开关与 ref、以及各类刷新/跳转回调。

import { useCallback, useEffect, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import type { GitChangesData } from '../../AgentGitDiff'

export function useAgentGit({ workspaceDir, rightPanelMode, treeOpen, setRightPanelMode, setTreeOpen, setContextModalOpen }: {
  workspaceDir: string | undefined
  rightPanelMode: 'files' | 'browser' | 'terminal' | 'diff' | 'menu'
  treeOpen: boolean
  setRightPanelMode: (v: 'files' | 'browser' | 'terminal' | 'diff' | 'menu') => void
  setTreeOpen: (v: boolean) => void
  setContextModalOpen: (v: boolean) => void
}) {
  // Git 变更以「特殊预览标签」形式打开；activeTabPath 命中该哨兵时，预览区渲染 AgentGitDiff。
  const [gitChanges, setGitChanges] = useState<GitChangesData | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  // Git 分支选择器
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const branchBtnRef = useRef<HTMLButtonElement>(null)
  const branchMenuRef = useRef<HTMLDivElement>(null)

  // 工作区切换菜单
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const workspaceBtnRef = useRef<HTMLButtonElement>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)


  // ── Git 变更（只读）：拉取工作区改动，供预览区的 Git 变更标签渲染 ──
  // 内容与上次完全一致时不 setState：展开面板会顺带静默刷新（toggleGitDiff / openGitDiff），
  // `git diff HEAD` 的 IPC 回来几乎必然落在展开动画中途，换了对象身份就让每个 GitFileBlock
  // 重跑 parseUnifiedDiff + computeInlineHighlights（逐行 LCS，文件折叠着也照跑）——主线程
  // 一顿，就是变更视图特有的"滑一半卡一下"。其余三个视图没有这份重活，所以只有它抖。
  const lastPayloadRef = useRef<string | null>(null)
  const commitChanges = useCallback((next: GitChangesData) => {
    const sig = JSON.stringify(next)
    if (sig === lastPayloadRef.current) return
    lastPayloadRef.current = sig
    setGitChanges(next)
  }, [])

  const refreshGitChanges = useCallback(async (silent = false) => {
    const dir = workspaceDir
    if (!dir) { commitChanges({ isRepo: false, staged: [], unstaged: [] }); return }
    if (!silent) setGitLoading(true)
    try {
      const r = await window.api.gitChanges(dir)
      commitChanges(r as GitChangesData)
    } catch (e: any) {
      commitChanges({ isRepo: false, staged: [], unstaged: [], error: e?.message || String(e) })
    } finally {
      if (!silent) setGitLoading(false)
    }
  }, [workspaceDir, commitChanges])

  // 打开 Git 变更面板：切换到 diff 模式并刷新
  const openGitDiff = useCallback(() => {
    setTreeOpen(true)
    setContextModalOpen(false)
    setRightPanelMode('diff')
    void refreshGitChanges(true)
  }, [refreshGitChanges])

  // 消息底部文件变更汇总的跳转：打开变更面板并定位到指定文件的 diff（自动展开+滚动+短暂高亮）
  const [gitFocusPath, setGitFocusPath] = useState<string | null>(null)
  const openGitDiffAt = useCallback((absPath: string) => {
    setGitFocusPath(absPath)
    openGitDiff()
  }, [openGitDiff])
  const onGitFocusHandled = useCallback(() => setGitFocusPath(null), [])

  // 顶栏「变更」按钮切换态：diff 模式且面板展开时再点收起，否则展开并切换到 diff。
  // 收起时必须**同时收起面板**：原来只把 mode 切回 'files'，面板却仍然展开着，
  // 而文件树只在 files 模式下渲染（AgentPreviewSlot 的 treeHidden），于是「关掉变更面板」
  // 的实际结果是当面亮出一棵文件树——用户反馈的「关闭的时候把文件树展开了」。
  // mode 仍复位成 'files'：右侧那个面板开关只切显隐、不改模式，若 mode 停在 'diff'，
  // 文件树就再没有任何入口了。
  const toggleGitDiff = useCallback(() => {
    if (rightPanelMode === 'diff' && treeOpen) {
      setRightPanelMode('files')
      setTreeOpen(false)
    } else {
      setRightPanelMode('diff')
      setTreeOpen(true)
      void refreshGitChanges(true)
    }
  }, [rightPanelMode, treeOpen, setRightPanelMode, setTreeOpen, refreshGitChanges])

  // 文件监听回调：仅当 diff 模式打开时，随文件改动静默刷新变更列表（不转圈）。
  const onWorkspaceFilesChanged = useCallback(() => {
    if (rightPanelMode === 'diff') void refreshGitChanges(true)
  }, [rightPanelMode, refreshGitChanges])

  // 切换工作区且 diff 模式打开时，静默刷新为新工作区的改动。
  useEffect(() => {
    if (rightPanelMode === 'diff') void refreshGitChanges(true)
  }, [workspaceDir, refreshGitChanges, rightPanelMode])

  // ── Git 分支：获取当前分支 + 列出所有本地分支 ──
  const refreshBranch = useCallback(async () => {
    const dir = workspaceDir
    if (!dir) { setCurrentBranch(null); setBranches([]); return }
    try {
      const [branchRes, listRes] = await Promise.all([
        window.api.gitListBranches(dir),
        window.api.gitListBranches(dir),
      ])
      const cur = branchRes.branches.find(b => b.current)
      setCurrentBranch(cur?.name ?? null)
      setBranches(listRes.branches.map(b => b.name))
    } catch {
      setCurrentBranch(null)
      setBranches([])
    }
  }, [workspaceDir])

  const checkoutBranch = useCallback(async (branch: string) => {
    const dir = workspaceDir
    if (!dir || branch === currentBranch) return
    try {
      const res = await window.api.gitCheckoutBranch(dir, branch)
      if (res.success) {
        setBranchMenuOpen(false)
        await refreshBranch()
        notify(`已切换到分支 ${branch}`, 'success')
      } else {
        notify(`切换失败：${res.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      notify(`切换失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [workspaceDir, currentBranch, refreshBranch])

  // 工作区变化时刷新分支信息
  useEffect(() => { void refreshBranch() }, [refreshBranch])

  usePopoverDismiss(branchMenuOpen, setBranchMenuOpen, branchBtnRef, undefined, branchMenuRef)

  usePopoverDismiss(workspaceMenuOpen, setWorkspaceMenuOpen, workspaceBtnRef, undefined, workspaceMenuRef)

  return {
    gitChanges, gitLoading, currentBranch, branches,
    branchMenuOpen, setBranchMenuOpen, branchBtnRef, branchMenuRef,
    workspaceMenuOpen, setWorkspaceMenuOpen, workspaceBtnRef, workspaceMenuRef,
    gitFocusPath, refreshGitChanges, openGitDiff, openGitDiffAt, onGitFocusHandled,
    toggleGitDiff, onWorkspaceFilesChanged, refreshBranch, checkoutBranch,
  }
}
