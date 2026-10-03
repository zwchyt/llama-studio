/**
 * 导航单一数据源。
 *
 * 同一份导航清单此前分散在多处各自维护（useStore 的 view 联合类型、两套导航栏
 * 各自的分组、App 的 currentView switch、sound.ts 的 NAV_CUES），增删一个界面要改
 * 好几个文件，极易漏。现在只在这里定义：
 *   - MODE_ITEMS    「对话 / 工作台」两项（Agent Code 的两种模式）
 *   - NAV_ITEMS     导航栏常驻项中，「工具箱」入口**之前**的那一段（平铺，不分节）
 *   - NAV_TAIL_ITEMS 导航栏常驻项中，「工具箱」入口**之后**的那一段（目前只有「设置」）
 *   - TOOL_GROUPS   「工具箱」页内的分组项（分节，节名是工具箱左栏的小标题）
 *   - TOOLS_ENTRY   导航栏上的「工具箱」入口（不是 view，点击进入聚合页）
 *
 * 「对话 / 工作台」共用 agent-code 这一个 view，靠 mode 字段区分，见 navKeyOf。
 * 它们不排在常驻列表里，而是渲染在导航栏底部 Agent Code 会话槽内（见 Sidebar.tsx）。
 * 视图与组件的映射仍在 views/viewRegistry.tsx；音效仍在 utils/sound.ts
 * （按 view key 查表，与导航位置无关，因此不需要跟着搬）。
 */
import type { ElementType } from 'react'
import type { useStore } from '../store/useStore'
import type { AgentMode } from '../../../shared/types'
import {
  LayoutDashboardIcon, SearchIcon, ActivityIcon, ServerIcon,
  InfoIcon, FileTextIcon, CodeIcon, SettingsIcon, BookOpenIcon,
  AudioLinesIcon, ImageIcon, MicIcon, BrainIcon, ChartBarIcon,
  TrendingUpIcon, SlidersHorizontalIcon, FolderOpenIcon, BoxesIcon,
  CpuIcon, PlugZapIcon, GitBranchIcon, LayoutGridIcon, MessageSquareIcon
} from '@animateicons/react/lucide'

export type ViewKey = ReturnType<typeof useStore.getState>['view']

export interface NavDef {
  key: ViewKey
  /** Agent Code 的工作区模式。同一个 view 被「对话 / 工作台」两个导航项共用，
      靠这个字段区分当前该点亮哪一个。 */
  mode?: AgentMode
  label: string
  icon: ElementType
  color: string
  /** 该界面靠哪个服务「活着」：'models' = 有模型在跑，'llama' = 聊天服务在跑。
   *  **当前没有任何消费方**——导航栏已改成只表达「当前在哪一页」，不再有「运行中就点亮」的
   *  跟随逻辑（那会让好几项一起变色，盖过唯一该看的信息）。字段留着描述界面与服务的归属关系，
   *  将来若要做运行指示灯，判据直接取这里。 */
  runningSource?: 'models' | 'llama'
  /** 同上，暂无消费方：原先表示「常驻项只要运行就变绿」。 */
  persistent?: boolean
}

/** 导航项的唯一键：带 mode 的项光靠 view key 分不开。
    参数只取 key / mode，方便调用方直接用 view + mode 拼键。 */
export const navKeyOf = (item: Pick<NavDef, 'key' | 'mode'>): string =>
  item.mode ? `${item.key}:${item.mode}` : item.key

export interface NavSection {
  label: string
  items: NavDef[]
}

/** 「对话 / 工作台」两项：Agent Code 这一个界面的两种模式。
 *  它们不排进导航栏常驻列表，而是渲染在导航栏底部 Agent Code 会话槽里、
 *  「新建聊天 / 新添项目」之上（见 Sidebar.tsx）——模式切换、新建、会话列表本就是
 *  同一件事的三个动作，从上到下连成一条；分在导航栏一头一尾反而要来回找。
 *  顺序 / 图标 / 配色仍由这里唯一定义。 */
export const MODE_ITEMS: NavDef[] = [
  // 「对话」就是 Agent Code 的通用模式（原生聊天界面已并入这里）；「工作台」是同一界面的编码模式。
  { key: 'agent-code', mode: 'chat', label: '聊天', icon: MessageSquareIcon, color: '#8b5cf6' },
  { key: 'agent-code', mode: 'code', label: '编码', icon: CodeIcon, color: '#10b981' }
]

/** 导航栏常驻项（「工具箱」入口**之前**的那一段）：从上到下按这个顺序排，不再分节。
 *  顺序：模型管理 → 知识库 → Web 界面 → 运行状态 → Token 统计。
 *  「设置」不在这里，见下面的 NAV_TAIL_ITEMS。 */
export const NAV_ITEMS: NavDef[] = [
  { key: 'cards', label: '模型管理', icon: LayoutDashboardIcon, color: '#8b5cf6', runningSource: 'models', persistent: true },
  { key: 'knowledge', label: '知识库', icon: BookOpenIcon, color: '#0d9488' },
  { key: 'llama', label: 'Web 界面', icon: ServerIcon, color: '#14b8a6', runningSource: 'llama' },
  { key: 'monitoring', label: '运行状态', icon: ActivityIcon, color: '#ef4444', runningSource: 'models' },
  { key: 'token-stats', label: 'Token 统计', icon: TrendingUpIcon, color: '#f59e0b', runningSource: 'models' }
]

/** 导航栏常驻项（「工具箱」入口**之后**的那一段）。
 *  单独拆一段的原因：「工具箱」不对应任何 view、由 Sidebar 直接渲染，而它要排在「设置」之前。
 *  顺序仍必须只在本文件里定义，所以按「工具箱之前 / 之后」切成两段，由 Sidebar 夹着渲染。 */
export const NAV_TAIL_ITEMS: NavDef[] = [
  { key: 'settings', label: '设置', icon: SettingsIcon, color: '#6b7280' }
]

/** 「工具箱」页内分组：低频界面集中在此，页内二级导航切换 */
export const TOOL_GROUPS: NavSection[] = [
  {
    label: '模型',
    items: [
      { key: 'models', label: '模型', icon: BoxesIcon, color: '#3b82f6' },
      { key: 'hub', label: '模型中心', icon: SearchIcon, color: '#0ea5e9' }
    ]
  },
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
      { key: 'folders', label: '模型文件夹', icon: FolderOpenIcon, color: '#6b7280' },
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

/** 全量索引：ToolsHub 取标题/配色，导航组件查定义。
 *  按 navKeyOf 建键（不带 mode 的项 key 就是 view），所以 ToolsHub 仍能用 view 直接查。
 *  MODE_ITEMS 也要并进来：它们虽不在常驻列表里，仍是两个合法导航项。 */
export const NAV_DEF_BY_KEY: Record<string, NavDef> = Object.fromEntries(
  [...MODE_ITEMS, ...NAV_ITEMS, ...NAV_TAIL_ITEMS, ...TOOL_GROUPS.flatMap((g) => g.items)]
    .map((d) => [navKeyOf(d), d])
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
