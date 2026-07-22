import React, { useEffect, useMemo } from 'react'
import { useStore, type AgentStatus } from './store/useStore'
import { notify } from './store/notificationStore'
import Sidebar from './components/Sidebar'
import CardsView from './components/CardsView'
import SettingsView from './components/SettingsView'
import HuggingFaceView from './components/HuggingFaceView'
import ModelsView from './components/ModelsView'
import ModelMonitoringView from './components/ModelMonitoringView'
import AboutView from './components/AboutView'
import AgentsView from './components/AgentsView'
import WelcomeView from './components/WelcomeView'
import ChatView from './components/ChatView'
import CreateModal from './components/CreateModal'
import SplashScreen from './components/SplashScreen'
import UpdateBanner from './components/UpdateBanner'
import AppUpdateBanner from './components/AppUpdateBanner'
import BackendDownloadBanner from './components/BackendDownloadBanner'
import ChatWindow from './components/ChatWindow'
import LlamaChatView from './components/LlamaChatView'
import TerminalView from './components/TerminalView'
import OcrView from './components/OcrView'
import BenchmarkView from './components/BenchmarkView'
import AgentCodeView from './components/AgentCodeView'
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
  const showCreateModal = useStore(s => s.showCreateModal)
  const activeBackend = useStore(s => s.activeBackend)
  const activeChatUrl = useStore(s => s.activeChatUrl)
  const setBackends = useStore(s => s.setBackends)
  const setModels = useStore(s => s.setModels)
  const setImageModels = useStore(s => s.setImageModels)
  const setChatTemplates = useStore(s => s.setChatTemplates)
  const setActiveBackend = useStore(s => s.setActiveBackend)
  const setCommandsSchema = useStore(s => s.setCommandsSchema)
  const setCards = useStore(s => s.setCards)
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

    // Stage 2: Default schema (activeBackend watcher at line 200 will re-fetch on backend change)
    window.api.getCommands('').then((cmds) => {
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

    // Stage 1: First-paint critical — fetch 3 IPC calls in parallel
    ;(async () => {
      try {
        const [paths, backendsData, templates] = await Promise.all([
          window.api.getPaths(),
          window.api.listBackends(),
          window.api.listTemplates()
        ])
        setPaths(paths)
        setBackends(backendsData)
        if (backendsData.length > 0) setActiveBackend(backendsData[0])
        setCards(
          (templates as Template[]).map((t) => ({
            template: t,
            status: 'idle',
            expanded: false,
            monitorExpanded: true
          }))
        )
      } catch (e) {
        console.error('初始化错误:', e)
      } finally {
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
      notify(`模型错误：${data.error}`, 'error')
    })
    return () => window.api.removeModelErrorListener()
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
            backend?.name || ''
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
          backend?.name || ''
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
    window.api.getCommands(activeBackend.name).then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    })
  }, [activeBackend, setCommandsSchema])

  useEffect(() => {
    if (!activeChatUrl && view === 'llama') setView('welcome')
  }, [activeChatUrl, view, setView])

  useEffect(() => {
    window.api.onDownloadProgress((data) => {
      useStore.getState().setDownloadProgress(data)
    })
    return () => window.api.removeDownloadListener()
  }, [])

  useEffect(() => {
    window.api.onModelLog((data) => {
      useStore.getState().appendModelLog(data.id, data.stream, data.text)
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
      case 'models': return <ModelsView />
      case 'monitoring': return <ModelMonitoringView />
      case 'about': return <AboutView />
      case 'agents': return <AgentsView />
      case 'chat': return <ChatView />
      case 'welcome': return <WelcomeView />
      case 'llama': return <LlamaChatView />
      case 'ocr': return <OcrView />
      case 'benchmark': return <BenchmarkView />
      case 'agent-code': return null
      case 'terminal': return null
      default: return <CardsView />
    }
  }, [view])

  return (
    <>
    <div className="app">
      <UpdateBanner />
      <AppUpdateBanner />
      <BackendDownloadBanner />
      <div className="main-layout">
        <Sidebar />
        <main className="content" style={view === 'llama' ? { display: 'none' } : {}}>
          <div
            className="view-transition"
            key={view}
            style={view === 'agent-code' || view === 'terminal' ? { display: 'none' } : {}}
          >
            {currentView}
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
          {/* 终端视图常驻挂载，仅按 view 切换显示/隐藏：切到其它侧边栏页再返回时，
              各终端的滚动历史与活动 PTY 全部保留（对应 local-studio 的 PersistentTerminals）。 */}
          <div
            className="terminal-view-host"
            style={{
              display: view === 'terminal' ? 'flex' : 'none',
              flex: 1,
              minHeight: 0,
              padding: 0,
              overflow: 'hidden',
            }}
          >
            <TerminalView />
          </div>
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
