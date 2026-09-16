// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentViewEffects —— 与 DOM 布局相关的副作用（侧栏可见性 / 跳行 / 测高）║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的三段 effect（逻辑与注释未变）：
//   1. 侧栏可见性跟随预览标签：无打开标签时自动展开侧栏
//   2. 预览跳行：内容渲染完成后把目标行滚到中间并短暂高亮（仅代码预览有效）
//   3. 输入框区域测高：写入 CSS 变量 --chat-input-h，使浮动按钮精确浮在输入框上方
//
// 依赖注入采用「整域透传」：preview / ui / scroll 直接传各 hook 的返回值。
// chatInputAreaRef 由调用方持有（同一 ref 也作为 props 传给布局组件）。
//
// ── 历史说明（原文件遗留注释，保留备查）──
// 测量计划卡片（agent-task-card-inline）高度，写入 CSS 变量 --task-card-h。
// 卡片是 absolute 浮层、脱离文档流，展开时会向上遮挡消息区；
// 把其高度作为 .chat-messages 的底部预留空间，消息区即可上移、不被遮挡。
// 卡片关闭（taskModalOpen=false）或收起时高度记为 0。
// 跟降策略：
//  - 收缩方向（收起/关闭动画）scrollHeight 减小，此处用「实时」贴底判断跟降，避免误判；
//  - 展开方向 scrollHeight 增大，实时判断会误判为离底，故不由这里滚，交由按钮 onClick 的双 rAF 兜底；
//  - 非用户触发的高度变化（如模型刷新计划项）守 atBottom，避免打断用户向上翻看。
// 注：上述 --task-card-h 写入逻辑在当前代码中已不存在（无 CSS 消费方），
// 原注释随本次搬移一并归档于此，避免信息丢失。

import React, { useEffect } from 'react'
import type { useAgentPreviewTabs } from './useAgentPreviewTabs'
import type { useAgentUiState } from './useAgentUiState'
import type { useAgentScroll } from './useAgentScroll'

export function useAgentViewEffects({
  preview, ui, scroll, chatInputAreaRef,
}: {
  preview: ReturnType<typeof useAgentPreviewTabs>
  ui: ReturnType<typeof useAgentUiState>
  scroll: ReturnType<typeof useAgentScroll>
  chatInputAreaRef: React.RefObject<HTMLDivElement | null>
}) {
  const { openTabs, activeTabPath, previewJumpRef, setPreviewHighlightLine } = preview
  const { setSidebarOpen } = ui
  const { chatScrollRef } = scroll

  // 终端面板：首次真正切换到 terminal 模式后才挂载并常驻——挂载必然发生在可见容器内
  // （xterm open 于 display:none 容器会拿到失真尺寸）；此后面板级切换只切 CSS hidden，
  // 不卸载 xterm 实例，切回时不重建、不触发 replay 回放大段 backlog（避免界面卡顿）
  useEffect(() => {
    setSidebarOpen(openTabs.length === 0)
  }, [openTabs.length])

  // 内容渲染完成后执行跳转：把目标行滚到中间并短暂高亮。仅对代码预览有效（Markdown 无行结构）。
  useEffect(() => {
    const jump = previewJumpRef.current
    if (!jump || activeTabPath !== jump.path) return
    const tab = openTabs.find(t => t.path === jump.path)
    if (!tab || tab.loading || tab.content == null) return
    previewJumpRef.current = null
    const line = jump.line
    requestAnimationFrame(() => {
      const el = document.getElementById(`agent-preview-line-${line}`)
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      setPreviewHighlightLine(line)
      setTimeout(() => setPreviewHighlightLine(null), 1600)
    })
  }, [activeTabPath, openTabs])

  // 测量输入框区域高度，写入 CSS 变量，使浮动按钮精确浮在输入框上方
  useEffect(() => {
    const el = chatInputAreaRef.current
    if (!el) return
    const apply = () => {
      const root = chatScrollRef.current?.closest('.agent-code-chat') as HTMLElement | null
      if (root) root.style.setProperty('--chat-input-h', `${el.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
}
