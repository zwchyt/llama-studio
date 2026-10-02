/**
 * 视图渲染注册表：view key → 界面组件。
 *
 * 抽出来的原因：导航栏改版后，「工具箱」聚合页需要在页内渲染被收进去的界面，
 * 与 App 主路由是同一套映射。若各自维护一份 switch，增删界面时必然漏改一处。
 */
import React, { lazy, Suspense } from 'react'
import CardsView from '../components/CardsView'
import type { ViewKey } from '../utils/navConfig'

// ── 视图 chunk 的导入函数 ──
// lazy() 与 hover 预取（preloadViewOnHover）共用同一份：少写一遍路径，
// 也不会出现「新加了视图、却忘了加进预取表」的漂移。
const VIEW_CHUNKS = {
  hub: () => import('../components/HuggingFaceView'),
  settings: () => import('../components/SettingsView'),
  engines: () => import('../components/EnginesView'),
  endpoints: () => import('../components/ModelEndpointsView'),
  folders: () => import('../components/ModelFoldersView'),
  models: () => import('../components/ModelsView'),
  monitoring: () => import('../components/ModelMonitoringView'),
  'token-stats': () => import('../components/TokenStatsView'),
  about: () => import('../components/AboutView'),
  agents: () => import('../components/AgentsView'),
  welcome: () => import('../components/WelcomeView'),
  llama: () => import('../components/LlamaChatView'),
  ocr: () => import('../components/OcrView'),
  benchmark: () => import('../components/BenchmarkView'),
  'model-tools': () => import('../components/ModelToolsView'),
  knowledge: () => import('../components/KnowledgeView'),
  tts: () => import('../components/TtsView'),
  stt: () => import('../components/SttView'),
  imagegen: () => import('../components/ImageGenView'),
  audiocpp: () => import('../components/AudioCppView'),
  'mermaid-test': () => import('../components/MermaidTestView'),
  'recharts-test': () => import('../components/RechartsTestView'),
  'svg-test': () => import('../components/SvgTestView'),
}

// ── 除首屏那一个外，全部走 lazy ──
// 默认 view 是 'cards'（useStore 的初始值），只有 CardsView 参与首屏绘制，而且 LCP 元素
// （卡片名 span.card-name-text）就在它里面 —— 它必须保持 eager，不能隔一层 Suspense 去等。
// 其余视图各自拖着重量级依赖（recharts / mermaid / pdfjs / xterm / markstream…），静态 import
// 会把它们全拉进主包 —— 实测入口 chunk 曾因此有 12.3MB，首屏光「解析 + 编译 + 执行」就 920ms。
// 隔一层 lazy 后它们变成按需 chunk（当前入口 1,989 kB）。
// 前提是没人再 eager 引入它们 —— ToolsHub 走的就是本文件的 renderViewComponent，没有自己 import。
const HuggingFaceView = lazy(VIEW_CHUNKS.hub)
const SettingsView = lazy(VIEW_CHUNKS.settings)
const EnginesView = lazy(VIEW_CHUNKS.engines)
const ModelEndpointsView = lazy(VIEW_CHUNKS.endpoints)
const ModelFoldersView = lazy(VIEW_CHUNKS.folders)
const ModelsView = lazy(VIEW_CHUNKS.models)
const ModelMonitoringView = lazy(VIEW_CHUNKS.monitoring)
const TokenStatsView = lazy(VIEW_CHUNKS['token-stats'])
const AboutView = lazy(VIEW_CHUNKS.about)
const AgentsView = lazy(VIEW_CHUNKS.agents)
const WelcomeView = lazy(VIEW_CHUNKS.welcome)
const LlamaChatView = lazy(VIEW_CHUNKS.llama)
const OcrView = lazy(VIEW_CHUNKS.ocr)
const BenchmarkView = lazy(VIEW_CHUNKS.benchmark)
const ModelToolsView = lazy(VIEW_CHUNKS['model-tools'])
const KnowledgeView = lazy(VIEW_CHUNKS.knowledge)
const TtsView = lazy(VIEW_CHUNKS.tts)
const SttView = lazy(VIEW_CHUNKS.stt)
const ImageGenView = lazy(VIEW_CHUNKS.imagegen)
const AudioCppView = lazy(VIEW_CHUNKS.audiocpp)
const MermaidTestView = lazy(VIEW_CHUNKS['mermaid-test'])
const RechartsTestView = lazy(VIEW_CHUNKS['recharts-test'])
const SvgTestView = lazy(VIEW_CHUNKS['svg-test'])

/** 为什么 fallback 是 null，而不是一个"加载中…"占位：
 *
 *  `.view-transition` 有一条规则会给它的**直接子元素**套上卡片样式
 *  （global.css：background: var(--surface) / border / border-radius / box-shadow）——
 *  任何占位元素放在那个位置都会被渲染成**一整张空卡片**，看起来就像"界面加载了另外一个东西"。
 *
 *  而占位本身是不必要的：App 那边用 useDeferredValue 把 view 的切换延后，React 会继续显示
 *  旧视图直到新视图能渲染，所以正常路径上根本不会挂起。真遇到慢 chunk 时，宁可什么都不画
 *  （旧内容还在屏幕上），也不要闪一张空卡片。
 *  再配合 preloadViewOnHover：鼠标移到导航项时就把该视图的 chunk 拉下来，
 *  点下去时通常已经就绪。 */
export function renderViewComponent(view: ViewKey): React.ReactNode {
  // 单个 Suspense 兜住整个 switch，避免各视图逐个包一层。
  // CardsView 是 eager 的，包在 Suspense 里也不会触发（没有挂起子节点时它是空操作）。
  return <Suspense fallback={null}>{renderView(view)}</Suspense>
}

function renderView(view: ViewKey): React.ReactNode {
  switch (view) {
    case 'hub': return <HuggingFaceView />
    case 'settings': return <SettingsView />
    case 'engines': return <EnginesView />
    case 'endpoints': return <ModelEndpointsView />
    case 'folders': return <ModelFoldersView />
    case 'models': return <ModelsView />
    case 'monitoring': return <ModelMonitoringView />
    case 'token-stats': return <TokenStatsView />
    case 'about': return <AboutView />
    case 'agents': return <AgentsView />
    case 'welcome': return <WelcomeView />
    case 'llama': return <LlamaChatView />
    case 'ocr': return <OcrView />
    case 'benchmark': return <BenchmarkView />
    case 'model-tools': return <ModelToolsView />
    case 'knowledge': return <KnowledgeView />
    case 'tts': return <TtsView />
    case 'stt': return <SttView />
    case 'imagegen': return <ImageGenView />
    case 'audiocpp': return <AudioCppView />
    case 'mermaid-test': return <MermaidTestView />
    case 'recharts-test': return <RechartsTestView />
    case 'svg-test': return <SvgTestView />
    case 'agent-code': return null
    default: return <CardsView />
  }
}

/** 导航项 hover 时预取该视图的 chunk。
 *
 *  这是**唯一**的预取入口 —— 刻意不做启动后的批量预取：
 *  生产实测首次点击 40ms、二次 24ms（chunk 已在内存），差别很小，说明"等 chunk"在生产环境
 *  本来就不明显；而批量预取要在启动后额外拉 571 kB（23 个视图 chunk 合计），收益配不上这份复杂度。
 *  鼠标移到导航项上时顺手拉一下：成本为零，又覆盖了绝大多数点击（用户点之前鼠标必然已在该项上）。 */
export function preloadViewOnHover(view: ViewKey): void {
  void VIEW_CHUNKS[view as keyof typeof VIEW_CHUNKS]?.()
}
