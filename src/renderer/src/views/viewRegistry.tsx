/**
 * 视图渲染注册表：view key → 界面组件。
 *
 * 抽出来的原因：导航栏改版后，「工具箱」聚合页需要在页内渲染被收进去的界面，
 * 与 App 主路由是同一套映射。若各自维护一份 switch，增删界面时必然漏改一处。
 */
import React, { lazy, Suspense } from 'react'
import CardsView from '../components/CardsView'
import SettingsView from '../components/SettingsView'
import EnginesView from '../components/EnginesView'
import ModelEndpointsView from '../components/ModelEndpointsView'
import ModelFoldersView from '../components/ModelFoldersView'
import HuggingFaceView from '../components/HuggingFaceView'
import ModelsView from '../components/ModelsView'
import ModelMonitoringView from '../components/ModelMonitoringView'
import AboutView from '../components/AboutView'
import AgentsView from '../components/AgentsView'
import WelcomeView from '../components/WelcomeView'
import LlamaChatView from '../components/LlamaChatView'
import ModelToolsView from '../components/ModelToolsView'
import KnowledgeView from '../components/KnowledgeView'
import TtsView from '../components/TtsView'
import SttView from '../components/SttView'
import OcrView from '../components/OcrView'
import ImageGenView from '../components/ImageGenView'
import MermaidTestView from '../components/MermaidTestView'
import RechartsTestView from '../components/RechartsTestView'
import SvgTestView from '../components/SvgTestView'
import TokenStatsView from '../components/TokenStatsView'
import AudioCppView from '../components/AudioCppView'
import type { ViewKey } from '../utils/navConfig'

// BenchmarkView 静态引入了 recharts（约 1.3MB）。如果这里也用静态 import，
// Rollup 必须把 recharts 提到主包——因为 recharts/ChartCard 里的懒加载 chunk
// 与它共享同一份依赖，只要有一个 eager 引入者，整条依赖链就回不到懒 chunk。
// 隔一层 lazy 之后，recharts 变成两者共享的按需 chunk，首屏不再背这 1.3MB。
const BenchmarkView = lazy(() => import('../components/BenchmarkView'))

export function renderViewComponent(view: ViewKey): React.ReactNode {
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
    case 'benchmark': return (
      <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-secondary)' }}>加载基准测试…</div>}>
        <BenchmarkView />
      </Suspense>
    )
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
