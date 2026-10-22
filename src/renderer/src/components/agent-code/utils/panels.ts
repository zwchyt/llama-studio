// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：右侧面板五视图的单一真源（顺序 / 文案 / 图标 / 快捷键）                 ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 此前「文件树→F1 … 预览→F5」在两处各写一份（AgentPreviewSlot 的卡片提示文案、
// AgentCodeViewLayout 的 keydown 绑定），靠注释约定「改了那边要改这里」。
// 现在顺序、文案、图标、快捷键与按键绑定表都从这里出，任何一处改动不会再漏另一边。

import { EyeIcon, FolderIcon, GitBranchIcon, GlobeIcon, TerminalIcon } from '@animateicons/react/lucide'
import type { PanelView } from '../hooks/useAgentUiState'

// 展示顺序，与 PANEL_SHORTCUT 的 F1~F5 一一对应（标签条、「+」菜单、选择界面共用）
export const PANEL_ORDER: PanelView[] = ['files', 'diff', 'terminal', 'browser', 'preview']

export const PANEL_LABEL: Record<PanelView, string> = {
  files: '文件树', preview: '预览', diff: '变更', terminal: '终端', browser: '浏览器',
}

export const PANEL_ICON: Record<PanelView, typeof FolderIcon> = {
  files: FolderIcon, preview: EyeIcon, diff: GitBranchIcon, terminal: TerminalIcon, browser: GlobeIcon,
}

export const PANEL_SHORTCUT: Record<PanelView, string> = {
  files: 'F1', diff: 'F2', terminal: 'F3', browser: 'F4', preview: 'F5',
}

/** keydown 绑定表：由 PANEL_ORDER + PANEL_SHORTCUT 推导，不手写第二份。 */
export const PANEL_BINDS: ReadonlyArray<{ tab: PanelView; code: string }> =
  PANEL_ORDER.map(v => ({ tab: v, code: PANEL_SHORTCUT[v] }))
