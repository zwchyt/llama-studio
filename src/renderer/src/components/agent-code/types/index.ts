// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-code 跨模块共享类型                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 这里只放「会被两个以上模块引用」或「作为模块对外契约」的类型。
// 模块私有类型（如 agent-diff 的 DiffRow）留在各自模块内。
//
// 来源：原先散落在 AgentCodeView.tsx 主组件体内的 interface / type 声明，
// 本次拆分仅做搬移，字段与语义完全未变。

import type { ReactNode } from 'react'
import type { AgentMessage } from '../../../../../shared/types'

// ── 顶栏 / 输入框按钮的动态图标句柄（@animateicons 实例）──
export interface AniIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

// ── 已完成助手消息行的操作回调集合 ──
// 用 ref 持有、引用稳定，配合 React.memo 让已完成消息行完全跳过 reconcile。
export type AgentMsgRowActions = {
  onPreviewFile: (p: string, line?: number) => void
  canUndoFor: (tc: NonNullable<AgentMessage['toolCalls']>[number]) => boolean
  onUndo: (msgId: string, tc: NonNullable<AgentMessage['toolCalls']>[number]) => void
  openGitDiffAt: (p: string) => void
  handleUndoAll: (msgId: string, toolCalls: AgentMessage['toolCalls']) => void
  copyMessage: (content: string) => void | Promise<void>
  regenerateAt: (msgId: string) => void | Promise<void>
}

// ── renderSegmentsFor 的渲染选项 ──
export type RenderSegmentsOpts = {
  thinkDone: boolean
  onPreviewFile: (p: string, line?: number) => void
  canUndoFor: AgentMsgRowActions['canUndoFor']
  onUndo: AgentMsgRowActions['onUndo']
  streamStartAt?: number  // 流开始时刻：思考块实时头部时间据此连续计时（含 TTFT）
  meta?: ReactNode        // 模型名 + token 计数徽标：常驻思考块头部（流式中含 t/s，完成后保留）
}

// ── 预览区标签页 ──
export interface PreviewTab {
  path: string
  name: string
  content: string | null
  lines: number | null
  truncated: boolean
  loading: boolean
  error: string | null
  isImage?: boolean
  imageDataUrl?: string | null
}

// ── 输入区引用的代码片段（预览区框选 → 附加到输入框）──
export interface CodeSnippet {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  code: string
  preview: string
}

// ── @ 提及浮层的文件条目 ──
export interface FlatFileEntry {
  name: string
  path: string
  relPath: string
}
