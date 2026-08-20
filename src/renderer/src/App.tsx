import React, { useEffect, useMemo } from 'react'
import { useStore, type AgentStatus } from './store/useStore'
import { useImageStore } from './store/imageStore'
import Sidebar from './components/Sidebar'
import CardsView from './components/CardsView'
import SettingsView from './components/SettingsView'
import EnginesView from './components/EnginesView'
import ModelFoldersView from './components/ModelFoldersView'
import HuggingFaceView from './components/HuggingFaceView'
import ModelsView from './components/ModelsView'
import ModelMonitoringView from './components/ModelMonitoringView'
import AboutView from './components/AboutView'
import AgentsView from './components/AgentsView'
import WelcomeView from './components/WelcomeView'
import ChatView from './components/ChatView'
import CreateModal from './components/CreateModal'
import SplashScreen from './components/SplashScreen'
import UpdateBannerGroup from './components/UpdateBannerGroup'
import BackendDownloadBanner from './components/BackendDownloadBanner'
import { paramSetOf, ENGINE_REPOS } from './utils/engine'
import ChatWindow from './components/ChatWindow'
import LlamaChatView from './components/LlamaChatView'
import TerminalView from './components/TerminalView'
import ModelToolsView from './components/ModelToolsView'
import KnowledgeView from './components/KnowledgeView'
import TtsView from './components/TtsView'
import SttView from './components/SttView'
import OcrView from './components/OcrView'
import BenchmarkView from './components/BenchmarkView'
import ImageGenView from './components/ImageGenView'
import AgentCodeView from './components/AgentCodeView'
import TokenStatsView from './components/TokenStatsView'
import JsonUiView from './components/JsonUiView'
import AudioCppView from './components/AudioCppView'
import ModelDiagnosisPanel from './components/ModelDiagnosisPanel'
import TitleBar from './components/TitleBar'
import TopNavBar from './components/TopNavBar'
import LayoutModeToggle from './components/LayoutModeToggle'
import ThemeToggle from './components/ThemeToggle'
import { useLayoutStore } from './store/layoutStore'
import './styles/titlebar.css'
  import { buildDefaultTemplate } from './utils/defaultTemplate'
import { writeToTerminal } from './utils/terminalRegistry'
import { useTerminalStore } from './store/terminalStore'
import type { Template, ModelMetrics } from '../../shared/types'

const searchParams = new URLSearchParams(window.location.search)
const initChatUrl = searchParams.get('chat_url')

export default function App() {
  const chatUrl = initChatUrl

  if (chatUrl) {
    return <ChatWindow url={chatUrl} />
  }

  return <AppMain />
}

function AppMain() {
  // 开屏动画：dataReady=初始化数据已就绪（触发爆炸退场），splashExited=开屏已完全卸载
  const appStartRef = React.useRef(performance.now())
  // 开屏动画：默认开启；此处按用户设置快照一次，仅在本次启动生效（设置改动在下次启动时应用）
  const [splashExited, setSplashExited] = React.useState(() => !useStore.getState().splashEnabled)
  const [dataReady, setDataReady] = React.useState(false)
  const processedHfDownloads = React.useRef(new Set<string>())
  const processedModelDownloads = React.useRef(new Set<string>())
  const timeoutsRef = React.useRef<ReturnType<typeof setTimeout>[]>([])

  const view = useStore(s => s.view)
  const layoutMode = useLayoutStore(s => s.mode)
  const showCreateModal = useStore(s => s.showCreateModal)
  const activeBackend = useStore(s => s.activeBackend)
  const activeChatUrl = useStore(s => s.activeChatUrl)
  const setBackends = useStore(s => s.setBackends)
  const setBackendsReady = useStore(s => s.setBackendsReady)
  const setModels = useStore(s => s.setModels)
  const setImageModels = useStore(s => s.setImageModels)
  const setChatTemplates = useStore(s => s.setChatTemplates)
  const setActiveBackend = useStore(s => s.setActiveBackend)
  const setCommandsSchema = useStore(s => s.setCommandsSchema)
  const setPaths = useStore(s => s.setPaths)
  const setReleaseInfo = useStore(s => s.setReleaseInfo)
  const setCheckingUpdate = useStore(s => s.setCheckingUpdate)
  const setAppReleaseInfo = useStore(s => s.setAppReleaseInfo)
  const setAppCheckingUpdate = useStore(s => s.setAppCheckingUpdate)
  const setHfDownload = useStore(s => s.setHfDownload)
  const removeHfDownload = useStore(s => s.removeHfDownload)
  const upsertModelDownload = useStore(s => s.upsertModelDownload)
  const removeModelDownload = useStore(s => s.removeModelDownload)
  const setView = useStore(s => s.setView)

  useEffect(() => {
    // 防御性检查：如果 window.api 未定义（preload 未正确注入），跳过所有 IPC 调用并告警
    if (!window.api) {
      console.error('[App] window.api 未定义！preload 脚本可能未正确注入。')
      return
    }

    useStore.getState().initUiSettings()

    // Agent Code 工作台：启动时从磁盘恢复项目（含会话）历史
    window.api.loadAgentProjects()
      .then((projects) => { if (Array.isArray(projects)) useStore.getState().setAgentProjects(projects) })
      .catch(() => {})

    // 模型自定义 Logo（logos/logos.json 映射 + 图片缓存）：全局加载一次，两处界面共用
    useStore.getState().loadModelLogos().catch(() => {})

    // 模型能力检测缓存（model-capabilities.json）：启动即载入，避免打开下拉时重读 GGUF
    useStore.getState().loadModelCapabilities().catch(() => {})

    // Stage 2: Default schema (activeBackend watcher at line 200 will re-fetch on backend change)
    window.api.getCommands('', 'llamacpp').then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    }).catch(() => {})

    // Stage 1.5: models — CardsView (default) doesn't need it; ModelsView has own loading state
    window.api.listModels()
      .then((m) => setModels(m))
      .catch((e) => console.error('[listModels]', e))
    window.api.listImageModels()
      .then((m) => setImageModels(m))
      .catch((e) => console.error('[listImageModels]', e))
    window.api.listChatTemplates()
      .then((m) => setChatTemplates(m))
      .catch((e) => console.error('[listChatTemplates]', e))

    // Stage 1: First-paint critical — 模板（模型卡片）独立尽早加载：
    // 不等待 listBackends（后端目录递归扫描可能较慢），进入界面后卡片尽快出现；
    // 加载完成前 CardsView 显示骨架占位（templatesReady=false），不闪"还没有模板"空态。
    window.api.listTemplates()
      .then((templates) => {
        const st = useStore.getState()
        st.setCards(
          (templates as Template[]).map((t) => ({
            template: t,
            status: 'idle',
            expanded: false,
            monitorExpanded: true
          }))
        )
        st.setTemplatesReady(true)
      })
      .catch((e) => {
        console.error('[listTemplates]', e)
        useStore.getState().setTemplatesReady(true) // 失败也结束加载态，避免一直占位
      })

    ;(async () => {
      try {
        const [paths, backendsData] = await Promise.all([
          window.api.getPaths(),
          window.api.listBackends()
        ])
        setPaths(paths)
        setBackends(backendsData)
        if (backendsData.length > 0) setActiveBackend(backendsData[0])
      } catch (e) {
        console.error('初始化错误:', e)
      } finally {
        setBackendsReady(true)
        // 同步主进程中实际在运行的模型状态（刷新后恢复运行中标识）
        window.api.getRunningProcesses().then((runningIds: string[]) => {
          if (runningIds.length > 0) {
            const st = useStore.getState()
            for (const id of runningIds) {
              st.setCardStatus(id, 'running')
            }
          }
        }).catch(() => {})

        // 数据初始化完成：至少展示 1.2s 后触发开屏爆炸退场
        const elapsed = performance.now() - appStartRef.current
        const wait = Math.max(0, 1200 - elapsed)
        window.setTimeout(() => setDataReady(true), wait)
      }
    })()

    // Stage 3: Low priority — defer to next microtask so it overlaps with UI render
    queueMicrotask(() => { checkUpdates() })
    queueMicrotask(() => { checkAppUpdate() })
    // 启动 10s 后自动检测四个引擎（llama.cpp / TensorSharp / TurboQuant / BeeLlama）
    // 是否有新版本，结果写入 store 供设置页各下载区块直接展示（不再依赖手动点击检查）
    const engineCheckTimer = window.setTimeout(() => {
      Promise.allSettled(Object.values(ENGINE_REPOS).map(async (repo) => [repo, await window.api.checkUpdates(repo)] as const))
        .then(results => {
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value[1]) {
              useStore.getState().setEngineRelease(r.value[0], r.value[1])
              // llama.cpp 同步更新旧版 releaseInfo 入口，保持顶部更新横幅行为一致
              if (r.value[0] === ENGINE_REPOS.llamacpp) useStore.getState().setReleaseInfo(r.value[1])
            }
          }
        })
        .catch(() => {})
    }, 30_000)
    queueMicrotask(async () => {
      try {
        const agents = await window.api.listGlobalAgents() as AgentStatus[]
        useStore.getState().setAgentStatuses(agents)
        const installed = agents.filter(a => a.installed && a.version).map(a => ({ pkg: a.pkg, version: a.version! }))
        if (installed.length > 0) {
          const updates = await window.api.checkAgentUpdates(installed)
          useStore.getState().setAgentUpdates(updates)
        }
      } catch { /* ignore */ }
    })

    window.api.onModelError((data) => {
      const s = useStore.getState()
      s.setCardStatus(data.id, 'error')
      const card = s.cards.find(c => c.template.id === data.id)
      if (card && card.template.serverPort === s.activeChatPort) {
        s.clearActiveChat()
      }
      // 错误详情展示由 model-diagnosis 诊断卡片接管（含原因与修复建议），
      // model-error 通道仅保留状态副作用（卡片置 error），不再弹出红色 toast。
    })

    window.api.onModelDiagnosis((d) => {
      useStore.getState().setModelDiagnosis(d.id, d)
    })
    return () => {
      window.clearTimeout(engineCheckTimer)
      window.api.removeModelErrorListener()
      window.api.removeModelDiagnosisListener()
    }
  }, [])

  useEffect(() => {
    window.api.onTerminalData(({ id, data }) => writeToTerminal(id, data))
    window.api.onTerminalExited(({ id }) => {
      const { markExited, sessions, activeId } = useTerminalStore.getState()
      markExited(id)
      if (id === activeId && sessions.length > 1) {
        const remaining = sessions.filter(s => s.id !== id)
        if (remaining.length > 0) useTerminalStore.getState().setActive(remaining[remaining.length - 1].id)
      }
    })
    window.api.onTerminalTitle(({ id, title }) => {
      useTerminalStore.getState().updateTitle(id, title)
    })
    return () => window.api.removeTerminalListeners()
  }, [])

  useEffect(() => {
    window.api.onHfDownloadProgress(async (data) => {
      try {
        upsertModelDownload({
          id: data.id || data.filename,
          url: '',
          filename: data.filename,
          destPath: data.destPath,
          receivedBytes: data.receivedBytes,
          totalBytes: data.totalBytes,
          speed: data.speed,
          percent: data.percent,
          phase: data.phase,
          repoId: data.repoId
        })

        if (data.phase === 'done') {
          if (processedHfDownloads.current.has(data.filename)) return
          processedHfDownloads.current.add(data.filename)
          setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'saving' })

          const models = await window.api.listModels()
          useStore.getState().setModels(models)

          setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'creating_template' })
          const { cards, activeBackend: backend, addCard: add } = useStore.getState()
          const template = buildDefaultTemplate(
            data.filename,
            data.destPath,
            cards.map(c => c.template),
            backend?.name || '',
            backend?.kind
          )
          const res = await window.api.saveTemplate(template)
          if (res.success) add({ ...template, id: res.id })

          setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'done' })
          const hfTimeout = setTimeout(() => removeHfDownload(data.filename), 2500)
          timeoutsRef.current.push(hfTimeout)
        } else {
          
          setHfDownload({
            repoId: '',
            filename: data.filename,
            percent: data.percent,
            phase: data.phase,
            speed: data.speed
          })
        }
      } catch (e) {
        console.error('[onHfDownloadProgress error]', e)
      }
    })
    return () => {
      window.api.removeHfDownloadListener()
      timeoutsRef.current.forEach(clearTimeout)
      timeoutsRef.current = []
    }
  }, [])

  useEffect(() => {
    window.api.onModelDownloadProgress(async (data) => {
      
      if (data.repoId) return
      upsertModelDownload(data)
      if (data.phase === 'done') {
        if (processedModelDownloads.current.has(data.id)) return
        processedModelDownloads.current.add(data.id)
        const models = await window.api.listModels()
        useStore.getState().setModels(models)
        
        const { cards, activeBackend: backend, addCard: add } = useStore.getState()
        const template = buildDefaultTemplate(
          data.filename,
          data.destPath,
          cards.map(c => c.template),
          backend?.name || '',
          backend?.kind
        )
        const res = await window.api.saveTemplate(template)
        if (res.success) add({ ...template, id: res.id })
        const dlTimeout = setTimeout(() => removeModelDownload(data.id), 4000)
        timeoutsRef.current.push(dlTimeout)
      }
    })
    
    window.api.listModelDownloads().then(list => {
      list.forEach((dl) => upsertModelDownload(dl))
    })
    return () => {
      window.api.removeModelDownloadListener()
      timeoutsRef.current.forEach(clearTimeout)
      timeoutsRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!activeBackend) return
    // 切换后端时按其后端类型加载默认参数集（模板级的 paramSet 在参数设置里另行控制）
    window.api.getCommands(activeBackend.name, paramSetOf(activeBackend.kind)).then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    })
  }, [activeBackend, setCommandsSchema])

  useEffect(() => {
    if (!activeChatUrl && view === 'llama') setView('welcome')
  }, [activeChatUrl, view, setView])

  useEffect(() => {
    window.api.onDownloadProgress((data) => {
      // 主进程全流程成功后会推送 phase:'done' 收尾事件；该事件与 invoke 回执走
      // 不同 IPC 管道、顺序不保证，必须在此兜底清空，否则最后一条 extracting
      // 进度可能晚到并把横幅卡在「解压后端中...」
      useStore.getState().setDownloadProgress(data.phase === 'done' ? null : data)
    })
    return () => window.api.removeDownloadListener()
  }, [])

  useEffect(() => {
    window.api.onModelLog((data) => {
      useStore.getState().appendModelLog(data.id, data.stream, data.text)
      // 供图像生成界面可视化进度（解析加载/采样/解码阶段的日志进度条）
      useImageStore.getState().ingestModelLog(data.id, data.text)
    })
    window.api.onModelReady((data) => {
      useStore.getState().setCardReady(data.id, true)
    })
    return () => {
      window.api.removeModelLogListener()
      window.api.removeModelReadyListener()
    }
  }, [])

  function sanitizeMetricsPayload(raw: Record<string, unknown>): Record<string, unknown> | null {
    const id = raw.id
    if (typeof id !== 'string' && typeof id !== 'number') return null
    const out: Record<string, unknown> = { id }
    if (raw.decodeTokS !== undefined) {
      if (typeof raw.decodeTokS === 'number') out.decodeTokS = raw.decodeTokS
      else if (Array.isArray(raw.decodeTokS) && raw.decodeTokS.every(v => typeof v === 'number')) out.decodeTokS = raw.decodeTokS
    }
    // TTFT: accept any positive number (estimated from nPromptTokens / prefillTokS)
    if (typeof raw.ttftMs === 'number' && raw.ttftMs > 0) out.ttftMs = raw.ttftMs
    if (typeof raw.prefillTokS === 'number') out.prefillTokS = raw.prefillTokS
    if (raw.reqPerSec !== undefined) {
      if (typeof raw.reqPerSec === 'number') out.reqPerSec = raw.reqPerSec
      else if (Array.isArray(raw.reqPerSec) && raw.reqPerSec.every(v => typeof v === 'number')) out.reqPerSec = raw.reqPerSec
    }
    if (raw.vramUsedMb !== undefined && (typeof raw.vramUsedMb === 'number' || raw.vramUsedMb === null)) out.vramUsedMb = raw.vramUsedMb
    if (typeof raw.vramTotalMb === 'number') out.vramTotalMb = raw.vramTotalMb
    if (raw.gpuTemperature !== undefined && (typeof raw.gpuTemperature === 'number' || raw.gpuTemperature === null)) out.gpuTemperature = raw.gpuTemperature
    if (raw.gpuUtilization !== undefined && (typeof raw.gpuUtilization === 'number' || raw.gpuUtilization === null)) out.gpuUtilization = raw.gpuUtilization
    if (typeof raw.gpuName === 'string') out.gpuName = raw.gpuName
    if (raw.gpuPowerDraw !== undefined && (typeof raw.gpuPowerDraw === 'number' || raw.gpuPowerDraw === null)) out.gpuPowerDraw = raw.gpuPowerDraw
    if (raw.cpuUsage !== undefined && (typeof raw.cpuUsage === 'number' || raw.cpuUsage === null)) out.cpuUsage = raw.cpuUsage
    if (typeof raw.pid === 'number') out.pid = raw.pid
    if (typeof raw.nPromptTokens === 'number') out.nPromptTokens = raw.nPromptTokens
    if (typeof raw.nCtx === 'number') out.nCtx = raw.nCtx
    if (typeof raw.nPromptTokensCache === 'number') out.nPromptTokensCache = raw.nPromptTokensCache
    if (typeof raw.nPromptTokensProcessed === 'number') out.nPromptTokensProcessed = raw.nPromptTokensProcessed
    if (typeof raw.nDecoded === 'number') out.nDecoded = raw.nDecoded
    if (typeof raw.isProcessing === 'boolean') out.isProcessing = raw.isProcessing
    if (raw.prefillProgress !== undefined && (typeof raw.prefillProgress === 'number' || raw.prefillProgress === null)) out.prefillProgress = raw.prefillProgress
    if (typeof raw.nPredict === 'number') out.nPredict = raw.nPredict
    if (typeof raw.lastUpdated === 'number') out.lastUpdated = raw.lastUpdated
    return out
  }

  useEffect(() => {
    window.api.onMetricsUpdate(async (raw: Record<string, unknown>) => {
      const data = sanitizeMetricsPayload(raw)
      if (!data) return

      const { updateModelMetric } = useStore.getState()
      const mid = String(data.id)
      const d = data as Record<string, any>
      const partial: Partial<ModelMetrics> = {}

      if (d.decodeTokS !== undefined) {
        const rawVal = d.decodeTokS
        if (Array.isArray(rawVal)) {
          if (rawVal.length > 0) {
            partial.decodeTokS = rawVal.slice(-30)
          }
        } else {
          const existing = useStore.getState().modelMetrics[mid]
          const hist = Array.isArray(existing?.decodeTokS) ? (existing!.decodeTokS as unknown[]) : []
          partial.decodeTokS = [...hist, rawVal].slice(-30)
        }
      }
      if (d.ttftMs !== undefined) partial.ttftMs = d.ttftMs as number
      if (d.prefillTokS !== undefined) partial.prefillTokS = d.prefillTokS as number
      if (d.reqPerSec !== undefined) {
        const rawVal = d.reqPerSec
        if (Array.isArray(rawVal)) {
          if (rawVal.length > 0) {
            partial.reqPerSec = rawVal.slice(-30)
          }
        } else {
          const existing = useStore.getState().modelMetrics[mid]
          const hist = Array.isArray(existing?.reqPerSec) ? (existing!.reqPerSec as unknown[]) : []
          partial.reqPerSec = [...hist, rawVal].slice(-30)
        }
      }
      if (d.vramUsedMb !== undefined) partial.vramUsedMb = d.vramUsedMb as number | null
      if (d.vramTotalMb !== undefined) partial.vramTotalMb = d.vramTotalMb as number
      if (d.gpuTemperature !== undefined) partial.gpuTemperature = d.gpuTemperature as number | null
      if (d.gpuUtilization !== undefined) partial.gpuUtilization = d.gpuUtilization as number | null
      if (d.gpuName !== undefined) partial.gpuName = d.gpuName as string
      if (d.gpuPowerDraw !== undefined) partial.gpuPowerDraw = d.gpuPowerDraw as number | null
      if (d.cpuUsage !== undefined) partial.cpuUsage = d.cpuUsage as number | null
      if (d.pid !== undefined) partial.pid = d.pid as number
      if (d.nPromptTokens !== undefined) partial.nPromptTokens = d.nPromptTokens as number
      if (d.nCtx !== undefined) partial.nCtx = d.nCtx as number
      if (d.nPromptTokensCache !== undefined) partial.nPromptTokensCache = d.nPromptTokensCache as number
      if (d.nPromptTokensProcessed !== undefined) partial.nPromptTokensProcessed = d.nPromptTokensProcessed as number
      if (d.nDecoded !== undefined) partial.nDecoded = d.nDecoded as number
      if (d.isProcessing !== undefined) partial.isProcessing = d.isProcessing as boolean
      if (d.prefillProgress !== undefined) partial.prefillProgress = d.prefillProgress as number | null
      if (d.nPredict !== undefined) partial.nPredict = d.nPredict as number

      if (Object.keys(partial).length > 0) updateModelMetric(mid, partial)
    })
    const initMetrics = async () => {
      try {
        const res = await window.api.getMetrics()
        if (res.metrics) {
          Object.values(res.metrics).forEach((m) => { if (m.id) useStore.getState().updateModelMetric(m.id, m) })
        }
      } catch (e) { console.error('初始化指标失败', e) }
      try {
        const runningIds: string[] = await window.api.getRunningProcesses()
        if (runningIds && runningIds.length > 0) {
          const { setCardStatus, cards, setCardReady } = useStore.getState()
          runningIds.forEach((id) => {
            setCardStatus(id, 'running')
            // 刷新后从主进程拉回日志缓存（仅当本地日志为空，避免与实时推送重复追加）
            if (!useStore.getState().modelLogs[id]?.length) {
              window.api.getModelLogs(id).then((entries) => {
                if (!entries?.length || useStore.getState().modelLogs[id]?.length) return
                entries.forEach(e => useStore.getState().appendModelLog(id, e.stream, e.text))
              }).catch(() => { /* ignore */ })
            }
            // 已运行的进程无法直接拿到日志，轮询端口判断是否已就绪
            const port = cards.find(c => c.template.id === id)?.template.serverPort
            if (port) {
              window.api.waitForServer(port)
                .then((ok) => { if (ok) setCardReady(id, true) })
                .catch(() => { /* ignore */ })
            }
          })
        }
      } catch (e) { console.error('同步运行状态失败', e) }
    }
    initMetrics()
    return () => window.api.removeMetricsUpdateListener()
  }, [])

  async function checkUpdates() {
    setCheckingUpdate(true)
    try {
      const info = await window.api.checkUpdates()
      setReleaseInfo(info)
    } finally {
      setCheckingUpdate(false)
    }
  }

  async function checkAppUpdate() {
    setAppCheckingUpdate(true)
    try {
      const info = await window.api.checkAppUpdate()
      setAppReleaseInfo(info)
    } finally {
      setAppCheckingUpdate(false)
    }
  }

  const currentView = useMemo(() => {
    switch (view) {
      case 'hub': return <HuggingFaceView />
      case 'settings': return <SettingsView />
      case 'engines': return <EnginesView />
      case 'folders': return <ModelFoldersView />
      case 'models': return <ModelsView />
      case 'monitoring': return <ModelMonitoringView />
      case 'token-stats': return <TokenStatsView />
      case 'about': return <AboutView />
      case 'agents': return <AgentsView />
      case 'chat': return null
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
      case 'jsonui': return <JsonUiView />
      case 'agent-code': return null
      case 'terminal': return null
      default: return <CardsView />
    }
  }, [view])

  return (
    <>
    <div className={layoutMode === 'topnav' ? 'app layout-topnav' : 'app'}>
      <TitleBar />
      <LayoutModeToggle />
      <ThemeToggle />
      <UpdateBannerGroup />
      <BackendDownloadBanner />
      <ModelDiagnosisPanel />
      {layoutMode === 'topnav' && <TopNavBar />}
      <div className="main-layout">
        {layoutMode === 'sidebar' && <Sidebar />}
        <main className="content" style={view === 'llama' ? { display: 'none' } : {}}>
          <div
            className="view-transition"
            key={view}
            style={view === 'agent-code' || view === 'terminal' || view === 'chat' ? { display: 'none' } : {}}
          >
            {currentView}
          </div>
          {/* 原生聊天视图常驻挂载：流式生成期间切换侧边栏再返回时，
              流监听、思考链展开状态、停止按钮与滚动位置全部保留，
              避免卸载导致 chunk 丢失与流状态被强制清除（与下方 Agent Code / 终端一致）。 */}
          <div
            className="chat-view-host"
            style={{
              display: view === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              // 与原 .view-transition 宿主的 24px 内边距保持一致（.content>* 规则），
              // 避免常驻挂载后聊天卡片贴近内容区两侧边缘
              padding: 24,
              overflow: 'hidden',
            }}
          >
            <ChatView />
          </div>
          {/* Agent Code 工作台常驻挂载：切换侧边栏时不卸载组件，
              保证正在进行的生成 / 工具循环不被打断，进度、滚动、输入框状态全部保留
              （与下方 terminal 视图的常驻挂载做法一致）。 */}
          <div
            className="agent-code-host"
            style={{
              display: view === 'agent-code' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              padding: 0,
              overflow: 'hidden',
            }}
          >
            <AgentCodeView />
          </div>
          {/* 终端视图：仅 view==='terminal' 时挂载（不常驻 display:none），
              避免与 Agent Code 工作台内嵌终端同时渲染同一 session 的 xterm 实例（同一实例
              只能 attach 到一个 DOM 容器，双挂载会把终端内容搬去隐藏容器导致黑屏）。
              切换走时 xterm 实例销毁、PTY 由主进程保活，切回时 terminalCreate 复用并 replay 恢复历史。 */}
          {view === 'terminal' && (
            <div
              className="terminal-view-host"
              style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
                padding: 0,
                overflow: 'hidden',
              }}
            >
              <TerminalView />
            </div>
          )}
        </main>
        <div style={{ flex: view === 'llama' ? 1 : 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: view === 'llama' ? 'flex' : 'none', flex: 1, overflow: 'hidden', flexDirection: 'column', padding: 24 }}>
            <LlamaChatView />
          </div>
        </div>
      </div>
      {showCreateModal && <CreateModal />}
    </div>
    {!splashExited && (
      <SplashScreen startExit={dataReady} onExited={() => setSplashExited(true)} />
    )}
    </>
  )
}
