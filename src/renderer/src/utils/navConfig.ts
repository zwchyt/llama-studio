/**
 * 导航单一数据源。
 *
 * 此前同一份导航清单分散在 5 处各自维护：useStore 的 view 联合类型、
 * TopNavBar 的 NAV_GROUPS、Sidebar 手写的 NavItem 列表、App 的 currentView
 * switch、sound.ts 的 NAV_CUES。增删一个界面要改 5 个文件，极易漏。
 *
 * 现在导航结构只在这里定义：
 *   - NAV_SECTIONS  导航栏常驻项（分节，供顶栏分隔线 / 侧栏小节标题共用）
 *   - TOOL_GROUPS   「工具箱」页内的分组项
 *   - TOOLS_ENTRY   导航栏上的「工具箱」入口（不是 view，点击进入聚合页）
 *
 * 视图与组件的映射仍在 views/viewRegistry.tsx；音效仍在 utils/sound.ts
 * （按 view key 查表，与导航位置无关，因此不需要跟着搬）。
 */
import type { ElementType } from 'react'
import type { useStore } from '../store/useStore'
import {
  LayoutDashboardIcon, SearchIcon, ActivityIcon, ServerIcon,
  InfoIcon, FileTextIcon, CodeIcon, SettingsIcon, BookOpenIcon,
  AudioLinesIcon, ImageIcon, MicIcon, BrainIcon, ChartBarIcon,
  TrendingUpIcon, SlidersHorizontalIcon, FolderOpenIcon, BoxesIcon,
  CpuIcon, PlugZapIcon, GitBranchIcon, LayoutGridIcon
} from '@animateicons/react/lucide'

export type ViewKey = ReturnType<typeof useStore.getState>['view']

export interface NavDef {
  key: ViewKey
  label: string
  icon: ElementType
  color: string
  runningSource?: 'models' | 'llama'
  persistent?: boolean
}

export interface NavSection {
  label: string
  items: NavDef[]
}

/** 导航栏常驻项：只放高频界面，保证一屏能看清全部名称 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: '导航',
    items: [
      { key: 'cards', label: '我的模板', icon: LayoutDashboardIcon, color: '#8b5cf6', runningSource: 'models', persistent: true },
      { key: 'models', label: '模型', icon: BoxesIcon, color: '#3b82f6' },
      { key: 'hub', label: '模型中心', icon: SearchIcon, color: '#0ea5e9' }
    ]
  },
  {
    label: '工作台',
    items: [
      { key: 'agent-code', label: 'Agent Code', icon: CodeIcon, color: '#10b981' }
    ]
  },
  {
    label: '服务',
    items: [
      { key: 'llama', label: 'Web 界面', icon: ServerIcon, color: '#14b8a6', runningSource: 'llama' },
      // 「聊天」项与 ChatView 界面已移除：原生聊天的功能已并入 Agent Code 的纯聊天模式。
      { key: 'monitoring', label: '模型运行数据', icon: ActivityIcon, color: '#ef4444', runningSource: 'models' },
      { key: 'token-stats', label: 'Token 统计', icon: TrendingUpIcon, color: '#f59e0b', runningSource: 'models' },
      { key: 'knowledge', label: '知识库', icon: BookOpenIcon, color: '#0d9488' }
    ]
  },
  {
    label: '系统',
    items: [
      { key: 'folders', label: '模型文件夹', icon: FolderOpenIcon, color: '#6b7280' },
      { key: 'settings', label: '设置', icon: SettingsIcon, color: '#6b7280' }
    ]
  }
]

/** 「工具箱」页内分组：低频界面集中在此，页内二级导航切换 */
export const TOOL_GROUPS: NavSection[] = [
  {
    label: '生成',
    items: [
      { key: 'imagegen', label: '图像生成', icon: ImageIcon, color: '#8b5cf6', runningSource: 'models' },
      { key: 'tts', label: '语音合成', icon: AudioLinesIcon, color: '#f43f5e' },
      { key: 'stt', label: '语音转写', icon: MicIcon, color: '#f43f5e' },
      { key: 'audiocpp', label: '音频工作室', icon: AudioLinesIcon, color: '#0ea5e9' }
    ]
  },
  {
    label: '分析',
    items: [
      { key: 'benchmark', label: '性能测试', icon: ChartBarIcon, color: '#f59e0b' },
      { key: 'ocr', label: 'OCR', icon: FileTextIcon, color: '#a855f7', runningSource: 'models' },
      { key: 'model-tools', label: '模型工具', icon: SlidersHorizontalIcon, color: '#06b6d4' }
    ]
  },
  {
    label: '系统',
    items: [
      { key: 'agents', label: 'AI Agent', icon: BrainIcon, color: '#d946ef' },
      { key: 'engines', label: '后端与引擎', icon: CpuIcon, color: '#6b7280' },
      { key: 'endpoints', label: '外部端点', icon: PlugZapIcon, color: '#6b7280' },
      { key: 'about', label: '关于', icon: InfoIcon, color: '#6366f1' }
    ]
  },
  {
    label: '开发测试',
    items: [
      { key: 'mermaid-test', label: 'Mermaid 测试', icon: GitBranchIcon, color: '#f59e0b' },
      { key: 'recharts-test', label: 'Recharts 测试', icon: ChartBarIcon, color: '#3b82f6' },
      { key: 'svg-test', label: 'SVG 测试', icon: ImageIcon, color: '#8b5cf6' }
    ]
  }
]

/** 导航栏上的「工具箱」入口。它不对应某个 view，点击进入聚合页。
 *  显式标注类型：`as const` 会让推断结果引用库内部的 IconProps 类型，
 *  在 composite 工程里无法被声明文件命名（TS4023）。 */
export const TOOLS_ENTRY: { label: string; icon: ElementType; color: string } = {
  label: '工具箱',
  icon: LayoutGridIcon,
  color: '#7c3aed'
}

/** 收进工具箱的全部 view：命中即由 ToolsHub 接管渲染 */
export const GROUPED_VIEWS: ReadonlySet<ViewKey> = new Set(
  TOOL_GROUPS.flatMap((g) => g.items.map((i) => i.key))
)

/** 全量索引：ToolsHub 取标题/配色，导航组件查定义 */
export const NAV_DEF_BY_KEY: Record<string, NavDef> = Object.fromEntries(
  [...NAV_SECTIONS.flatMap((s) => s.items), ...TOOL_GROUPS.flatMap((g) => g.items)]
    .map((d) => [d.key, d])
)

/** 记住上次在工具箱里打开的界面，避免每次进来都回到默认项 */
export const TOOLS_LAST_VIEW_STORAGE_KEY = 'toolsLastView'

/** 工具箱兜底落地页（无历史记录时打开的第一个界面） */
export const TOOLS_FALLBACK_VIEW: ViewKey = 'imagegen'

/** 解析点开「工具箱」时应落在哪个界面 */
export function resolveToolsEntryView(): ViewKey {
  try {
    const last = localStorage.getItem(TOOLS_LAST_VIEW_STORAGE_KEY)
    if (last && GROUPED_VIEWS.has(last as ViewKey)) return last as ViewKey
  } catch { /* ignore */ }
  return TOOLS_FALLBACK_VIEW
}

/** 工具箱内是否存在「正在运行」的界面（用于导航栏上的运行指示灯） */
export function groupedHasRunning(hasRunningModels: boolean, activeChatUrl: string | null): boolean {
  return TOOL_GROUPS.some((g) => g.items.some((i) =>
    (i.runningSource === 'models' && hasRunningModels) ||
    (i.runningSource === 'llama' && !!activeChatUrl)
  ))
}
