import React, { lazy, Suspense, useDeferredValue, useEffect, useMemo } from 'react'
import { LoaderIcon } from '@animateicons/react/lucide'
import { useStore } from './store/useStore'
import { useImageStore } from './store/imageStore'
import { useThemeStore } from './store/themeStore'
import Sidebar from './components/Sidebar'
import SplashScreen from './components/SplashScreen'
import UpdateBannerGroup from './components/UpdateBannerGroup'
import BackendDownloadBanner from './components/BackendDownloadBanner'
import { paramSetOf, ENGINE_REPOS } from './utils/engine'
import { endpointOfCard, probeTargetOf } from './utils/endpoint'
import { notify } from './store/notificationStore'
import { playEvent, playNavSound, warmUpAudio } from './utils/sound'
import TitleBar from './components/TitleBar'
import { GROUPED_VIEWS, navKeyOf } from './utils/navConfig'
import { renderViewComponent } from './views/viewRegistry'
import ThemeToggle from './components/ThemeToggle'
import './styles/titlebar.css'
import './styles/app-background.css'
import { buildDefaultTemplate } from './utils/defaultTemplate'
import { writeToTerminal } from './utils/terminalSink'
import { useAgentTerminalStore } from './store/terminalStore'
import type { Template, ModelMetrics, SystemMetrics, ReleaseInfo } from '../../shared/types'

// ── 懒加载的重界面 ──
// 这五个原本都是静态 import，于是不管用户第一屏看的是哪一页，它们（连同各自拖着的
// markstream / xterm / mermaid / pdfjs / recharts…）都会被打进入口包并在启动时执行。
// 实测入口 chunk 因此有 12.3MB、占渲染产物 41%，首屏光「解析 + 编译 + 执行」就花掉 920ms
// （domInteractive 11ms → DOMContentLoaded 932ms）。隔一层 lazy 后它们变成按需 chunk，
// 只有真正进入对应界面才下载。
// 注意：AgentCodeView / LlamaChatView 是「常驻挂载」的（见下方 LazyOnce），光有 lazy 不够，
// 还要配合「首次访问才渲染」才能把它们移出首屏。
// import 函数单独抽出来：lazy() 用它，首屏空闲时的预加载也用它（同一个模块缓存，不会重复下载）。
const importAgentCode = () => import('./components/AgentCodeView')
const importLlamaChat = () => import('./components/LlamaChatView')

const ChatWindow = lazy(() => import('./components/ChatWindow'))
const LlamaChatView = lazy(importLlamaChat)
const AgentCodeView = lazy(importAgentCode)
const ToolsHub = lazy(() => import('./components/ToolsHub'))
const CreateModal = lazy(() => import('./components/CreateModal'))

/** 懒加载 chunk 落地前的占位。
 *
 *  不能用 fallback={null}：工作台整块（含经 portal 注入侧栏的会话列表）都在这个 chunk 里，
 *  空 fallback 会让「还没进过工作台」时的首次点击变成整个界面空白 —— 右侧没内容、侧栏下面的
 *  会话列表也没有，看起来就像卡死了。给个骨架，至少让人知道在加载。 */
function LazySkeleton({ label }: { label: string }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 10, color: 'var(--text-muted)',
    }}>
      <LoaderIcon size={18} className="spin" />
      <span style={{ fontSize: 13 }}>{label}</span>
    </div>
  )
}

/** 首次访问才加载、之后永久挂载的懒加载界面。
 *
 *  工作台与 Web 界面原本是「无条件挂载 + display:none 隐藏」——为的是切走时不卸载：
 *  卸载会打断正在进行的生成 / 工具循环，也会让内嵌 WebUI 的 iframe 重新加载。
 *  但那样它们在首屏就参与打包与执行，而工作台拖着 markstream / xterm / mermaid 整棵树，
 *  是入口包最大的一块。
 *  这里改成「访问过才渲染」：没进过就不挂载，chunk 也就不会下载；进过一次就永久挂载，
 *  之后切走仍按原来的 display:none 隐藏。
 *  正常情况下看不到 fallback —— AppMain 会在首屏空闲时预加载这两个 chunk（见那里的注释）。 */
function LazyOnce({ active, label, children }: {
  active: boolean
  label: string
  children: React.ReactNode
}) {
  return active ? <Suspense fallback={<LazySkeleton label={label} />}>{children}</Suspense> : null
}

const searchParams = new URLSearchParams(window.location.search)
const initChatUrl = searchParams.get('chat_url')

export default function App() {
  const chatUrl = initChatUrl

  if (chatUrl) {
    return <Suspense fallback={null}><ChatWindow url={chatUrl} /></Suspense>
  }

  return <AppMain />
}

function AppMain() {
  // 开屏动画：dataReady=初始化数据已就绪（触发爆炸退场），splashExited=开屏已完全卸载
  const appStartRef = React.useRef(performance.now())
  // 开屏动画：先按 localStorage 快照（通常正确），initUiSettings 异步从后端同步后会校正
  const [splashExited, setSplashExited] = React.useState(() => !useStore.getState().splashEnabled)
  const [dataReady, setDataReady] = React.useState(false)
  const processedHfDownloads = React.useRef(new Set<string>())
  const processedModelDownloads = React.useRef(new Set<string>())
  const timeoutsRef = React.useRef<ReturnType<typeof setTimeout>[]>([])

  const view = useStore(s => s.view)
  // 视图切换的「延迟值」：懒加载的视图在 chunk 到位前会挂起，若直接渲染新 view，
  // React 会先把旧视图换成 Suspense 占位、chunk 到了再换成真视图 —— 中间多出一次视觉状态，
  // 而真视图还带 `view-content-in` 的 12px 位移动画，连起来就是肉眼可见的抖动。
  // 用 useDeferredValue 后，React 在低优先级渲染里**继续显示旧视图**，等新视图能渲染了才切换：
  // 全程只有一次视觉状态变化、一次入场动画。导航高亮仍用实时的 view，点下去立刻响应。
  const deferredView = useDeferredValue(view)
  // 「对话 / 工作台」共用 agent-code 这一个 view，靠 mode 区分，导航音要用到它（见下方 playNavSound）
  const agentMode = useStore(s => s.agentMode)
  // 工作台 / Web 界面的「是否已访问过」。首次进入后永久为 true —— 它们必须保持挂载
  // （卸载会打断正在进行的生成、也会让内嵌 WebUI 的 iframe 重载），所以只用它控制
  // 「要不要开始加载」，不用它控制卸载。初始值取当前 view：直接落在该页时首帧就渲染，不闪。
  const [agentCodeMounted, setAgentCodeMounted] = React.useState(view === 'agent-code')
  const [llamaMounted, setLlamaMounted] = React.useState(view === 'llama')
  useEffect(() => {
    if (view === 'agent-code') setAgentCodeMounted(true)
    if (view === 'llama') setLlamaMounted(true)
  }, [view])
  // 空闲预加载：工作台 / Web 界面的 chunk 很大，但用户不一定马上点进去。
  // 不在启动时同步加载 —— 那等于把成本压回首屏；而是等首屏画完、主线程空闲时悄悄下好，
  // 用户真正点进去时通常已经就绪，连骨架都看不到。
  // 用 requestIdleCallback（带超时兜底）：它只在空闲窗口跑，不会跟首屏抢主线程；
  // 但实测它会被后台 / 遮挡的窗口节流（连 timeout 都不兑现），所以再挂一条 setTimeout 保证执行。
  // 两条同时触发也没关系：动态 import 走模块缓存，重复调用是幂等的。
  //
  // ⚠️ 加载完还要**挂载**（setAgentCodeMounted）—— 只下载不挂载是不够的：
  // 应用左侧导航栏底部那个会话列表，是 AgentCodeViewLayout 通过 portal 注入
  // #sidebar-agent-slot 的（见 AgentCodeViewLayout 里的 setSessionSlot）。
  // 组件不挂载 → portal 不存在 → 那个槽位一直空着，用户不进「对话/工作台」就看不到会话列表。
  // 这里在 chunk 就绪后把它挂起来（外层用 display:none 藏着，不会改变任何视觉），
  // 于是 portal 恢复、侧栏列表照旧显示，而首屏仍然不背这笔成本。
  useEffect(() => {
    let cancelled = false
    const preload = () => {
      void importAgentCode().then(() => { if (!cancelled) setAgentCodeMounted(true) })
      void importLlamaChat()
    }
    const idle = window.requestIdleCallback(preload, { timeout: 2000 })
    const t = window.setTimeout(preload, 3000)
    return () => {
      cancelled = true
      window.cancelIdleCallback(idle)
      window.clearTimeout(t)
    }
  }, [])
  // 背景图：有图才给根节点加类与变量（无图时一切照旧，不给全局样式加任何负担）
  const backgroundUrl = useStore(s => s.backgroundUrl)
  const backgroundStrength = useStore(s => s.backgroundStrength)
  const showCreateModal = useStore(s => s.showCreateModal)
  const activeBackend = useStore(s => s.activeBackend)
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

  useEffect(() => {
    // 防御性检查：如果 window.api 未定义（preload 未正确注入），跳过所有 IPC 调用并告警
    if (!window.api) {
      console.error('[App] window.api 未定义！preload 脚本可能未正确注入。')
      return
    }

    useStore.getState().initUiSettings().then(() => {
      // initUiSettings 从后端同步了正确值，校正开屏状态（首次启动时 localStorage 可能为空/陈旧）
      setSplashExited(!useStore.getState().splashEnabled)
    })

    // 背景图：localStorage 里只存文件名，字节要找主进程回读成 data URL
    void useStore.getState().loadBackgroundImage()

    // Agent Code 工作台：启动时从磁盘恢复项目（含会话）历史
    window.api.loadAgentProjects()
      .then((projects) => { if (Array.isArray(projects)) useStore.getState().setAgentProjects(projects) })
      .catch(() => { })

    // 模型自定义 Logo（logos/logos.json 映射 + 图片缓存）：全局加载一次，两处界面共用
    useStore.getState().loadModelLogos().catch(() => { })

    // 模型能力检测缓存（model-capabilities.json）：启动即载入，避免打开下拉时重读 GGUF
    useStore.getState().loadModelCapabilities().catch(() => { })

    // Stage 2: Default schema (activeBackend watcher at line 200 will re-fetch on backend change)
    window.api.getCommands('', 'llamacpp').then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    }).catch(() => { })

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
    // 外部端点表：必须在 list-templates 之后读 —— 老卡片是在那次调用里被迁移成端点记录的，
    // 先读会拿到迁移前的空表，卡片就找不到自己的端点了。放 finally 是为了模板读取失败时
    // 「外部端点」页仍有数据可列。
    const loadModelEndpoints = (): void => {
      window.api.listModelEndpoints()
        .then((list) => useStore.getState().setModelEndpoints(Array.isArray(list) ? list : []))
        .catch(() => { })
    }
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
        useStore.getState().setTemplatesReady(true)
      })
      .finally(loadModelEndpoints)

      ; (async () => {
        try {
          const [paths, backendsData] = await Promise.all([
            window.api.getPaths(),
            window.api.listBackends()
          ])
          setPaths(paths)
          setBackends(backendsData)
          if (backendsData.length > 0) {
            setActiveBackend(backendsData[0])
            useStore.getState().setBackendsStatus('ready')
          }
          // 空数组保持 'loading'：首次启动时主进程立即返回空数组、扫描在后台进行，
          // 不能据此判定"没有后端"（滥用会闪出错误的空态）。待 'backends-updated' 到达再切 ready。
        } catch (e) {
          console.error('初始化错误:', e)
          useStore.getState().setBackendsStatus('error')
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
          }).catch(() => { })

          // 数据初始化完成：至少展示 1.2s 后触发开屏爆炸退场
          const elapsed = performance.now() - appStartRef.current
          const wait = Math.max(0, 1200 - elapsed)
          window.setTimeout(() => setDataReady(true), wait)
        }
      })()

    // Stage 3: Low priority — defer to next microtask so it overlaps with UI render
    queueMicrotask(() => { checkUpdates() })
    queueMicrotask(() => { checkAppUpdate() })
    const ENGINE_RELEASE_CACHE_TTL = 12 * 60 * 60 * 1000
    let engineCheckTimer: ReturnType<typeof window.setTimeout> | null = null
    const checkEngineReleasesFromNetwork = () => {
      if (engineCheckTimer) return
      engineCheckTimer = window.setTimeout(() => {
        engineCheckTimer = null
        Promise.allSettled(Object.values(ENGINE_REPOS).map(async (repo) => [repo, await window.api.checkUpdates(repo)] as const))
          .then(results => {
            const cache: Record<string, ReleaseInfo> = {}
            const now = Date.now()
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value[1]) {
                cache[r.value[0]] = r.value[1]
                useStore.getState().setEngineRelease(r.value[0], r.value[1])
                if (r.value[0] === ENGINE_REPOS.llamacpp) useStore.getState().setReleaseInfo(r.value[1])
              }
            }
            window.api.setEngineReleasesCache(Object.keys(cache).length > 0 ? cache : null, now).catch(() => { })
          })
          .catch(() => { })
      }, 30_000)
    }
    const applyEngineReleasesCache = async () => {
      try {
        const { cache, checkedAt } = await window.api.getEngineReleasesCache()
        if (cache && checkedAt && Date.now() - checkedAt < ENGINE_RELEASE_CACHE_TTL) {
          for (const [repo, info] of Object.entries(cache)) {
            useStore.getState().setEngineRelease(repo, info)
            if (repo === ENGINE_REPOS.llamacpp) useStore.getState().setReleaseInfo(info)
          }
          return
        }
      } catch { /* ignore */ }
      checkEngineReleasesFromNetwork()
    }
    applyEngineReleasesCache()
    // Agent 检测不在启动时触发：AgentsView 首次进入且无缓存数据时自行拉取，
    // 避免应用启动就被 npm list + registry 检查拖慢

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

    // 后端目录后台重扫完成且内容有变化时，主进程广播最新列表（list-backends 现在永远
    // 用注册表即时应答，校验在后台静默进行）——此处无缝热替换；当前选中后端仍存在则保留。
    // 收到广播即视为权威结果：无论是否为空都进入 'ready'，结束首屏 loading 态。
    window.api.onBackendsUpdated((list) => {
      setBackends(list)
      useStore.getState().setBackendsStatus('ready')
      const cur = useStore.getState().activeBackend
      if ((!cur || !list.some(b => b.name === cur.name)) && list[0]) {
        setActiveBackend(list[0])
      }
    })
    return () => {
      if (engineCheckTimer) window.clearTimeout(engineCheckTimer)
      window.api.removeModelErrorListener()
      window.api.removeModelDiagnosisListener()
      window.api.removeBackendsUpdatedListener()
    }
  }, [])

  // 外部端点卡的掉线检测：服务/端点不由本应用启动，主进程收不到 exit 事件，只能定期探。
  // 只管「已启用且在运行 → 探测不通就停用」，不做自动重连：服务重启后由用户点一下卡片。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const st0 = useStore.getState()
      const attached = st0.cards.filter(c => c.template.external && c.status === 'running')
      if (attached.length === 0) return
      for (const card of attached) {
        const ep = endpointOfCard(card, st0.modelEndpoints)
        const stop = (why: string): void => {
          const st = useStore.getState()
          if (st.cards.find(c => c.template.id === card.template.id)?.status !== 'running') return
          st.setCardStatus(card.template.id, 'idle')
          st.clearModelMetrics(card.template.id)
          if (ep?.kind === 'local-port') void window.api.detachEndpoint(card.template.id).catch(() => { })
          notify(why, 'error')
        }
        if (!ep) { stop(`「${card.template.name}」没有关联的端点记录了，请到「外部端点」页重新添加`); continue }
        window.api.probeEndpoint(probeTargetOf(ep))
          .then((p) => {
            if (p.ok) return
            stop(ep.kind === 'local-port'
              ? `:${ep.port} 上的服务已停止，已自动断开接管`
              : `端点 ${ep.baseUrl} 探测不通，已停用：${p.error ?? ''}`)
          })
          .catch(() => { /* 探测通道本身异常（主进程忙）不动状态 */ })
      }
    }, 20000)
    return () => window.clearInterval(timer)
  }, [])

  // 引擎发布信息变化时自动写回缓存（手动检查或下载后复查触发）
  const syncEngineCache = async (releases: Record<string, ReleaseInfo | null>) => {
    const now = Date.now()
    const filtered = Object.fromEntries(Object.entries(releases).filter(([, v]) => v !== null)) as Record<string, ReleaseInfo>
    await window.api.setEngineReleasesCache(Object.keys(filtered).length > 0 ? filtered : null, now).catch(() => { })
  }
  useEffect(() => {
    // subscribe 会在任意 store 字段变化时触发；只有 engineReleases 内容真正变化才写盘，
    // 否则 metrics 每 2 秒广播一次都会重写 settings.json
    let lastSig = JSON.stringify(useStore.getState().engineReleases)
    const unsub = useStore.subscribe((s) => {
      const sig = JSON.stringify(s.engineReleases)
      if (sig === lastSig) return
      lastSig = sig
      syncEngineCache(s.engineReleases)
    })
    return unsub
  }, [])

  useEffect(() => {
    window.api.onTerminalData(({ id, data }) => writeToTerminal(id, data))
    window.api.onTerminalExited(({ id, exitCode }) => {
      const { markExited, sessions, activeId } = useAgentTerminalStore.getState()
      markExited(id)
      // 只在命令失败时给错误音：正常退出、主动关终端不该打扰
      if (exitCode !== 0) playEvent('error')
      if (id === activeId && sessions.length > 1) {
        const remaining = sessions.filter(s => s.id !== id)
        if (remaining.length > 0) useAgentTerminalStore.getState().setActive(remaining[remaining.length - 1].id)
      }
    })
    window.api.onTerminalTitle(({ id, title }) => {
      useAgentTerminalStore.getState().updateTitle(id, title)
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
          // 模型文件动辄几 GB，下载要几分钟到几十分钟，人早就不在窗口前了
          playEvent('complete')
          const hfTimeout = setTimeout(() => removeHfDownload(data.filename), 2500)
          timeoutsRef.current.push(hfTimeout)
        } else {

          setHfDownload({
            repoId: '',
            filename: data.filename,
            percent: data.percent,
            phase: data.phase,
            speed: data.speed,
            receivedBytes: data.receivedBytes,
            totalBytes: data.totalBytes
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
        playEvent('complete')
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

  // 注：这里原有一条「没有 activeChatUrl 且 view==='llama' 就弹回 welcome」的 effect，已删除。
  // 它让「Web 界面」这一项永远无法成为当前页（点它会被立刻弹走），于是侧栏上它既没有
  // 「当前页」竖条，也站不住；同时把 LlamaChatView 自带的「暂无活跃的聊天会话 / 前往启动模型」
  // 空状态变成了永远显示不出来的死代码。现在没服务器时也能停在 Web 界面看那段空状态。

  useEffect(() => {
    window.api.onDownloadProgress((data) => {
      // 主进程全流程成功后会推送 phase:'done' 收尾事件；该事件与 invoke 回执走
      // 不同 IPC 管道、顺序不保证，必须在此兜底清空，否则最后一条 extracting
      // 进度可能晚到并把横幅卡在「解压后端中...」
      useStore.getState().setDownloadProgress(data.phase === 'done' ? null : data)
      if (data.phase === 'done') playEvent('complete')
    })
    return () => window.api.removeDownloadListener()
  }, [])

  // 音频解锁：Chromium 只认「用户手势内」的 AudioContext 恢复，而下面这些事件音（服务就绪、
  // 下载完成、生成结束）全部来自异步回调或 IPC 推送，不在手势里。所以在第一次点击时解锁一次，
  // 之后所有事件音都能出声。只挂一次，出声后立即摘掉监听。
  useEffect(() => {
    const unlockOnce = (): void => { warmUpAudio(); window.removeEventListener('pointerdown', unlockOnce) }
    window.addEventListener('pointerdown', unlockOnce)
    return () => window.removeEventListener('pointerdown', unlockOnce)
  }, [])

  // 导航切换音：每一屏一个不同音效，对照表在 utils/sound.ts 的 NAV_CUES。
  // 挂在这里而不是各导航组件里，因为侧栏、顶栏、欢迎页按钮、卡片跳转最终都汇到 view 变更，一处全覆盖。
  // 首帧不响：启动时恢复上次页面不该一进应用就出声。
  // 只认 view 的变化：agentMode 在依赖里只是给「对话 / 工作台」挑音效（两者共用 agent-code），
  // 它本身不是导航——欢迎页那两张模式卡片切的就是 agentMode，不该出声。
  // 两者互切（view 不变）由 Sidebar 的 openItem 自己补一声。
  const prevViewRef = React.useRef<string | null>(null)
  useEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = view
    if (prev === null || prev === view) return
    playNavSound(navKeyOf({ key: view, mode: view === 'agent-code' ? agentMode : undefined }))
  }, [view, agentMode])

  useEffect(() => {
    window.api.onModelLog((data) => {
      useStore.getState().appendModelLog(data.id, data.stream, data.text)
      // 供图像生成界面可视化进度（解析加载/采样/解码阶段的日志进度条）
      useImageStore.getState().ingestModelLog(data.id, data.text)
    })
    window.api.onModelReady((data) => {
      useStore.getState().setCardReady(data.id, true)
      // 大模型加载动辄几十秒，人往往已经切走窗口 —— 成功音告知服务已可用
      playEvent('success')
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
    // 系统级资源指标（GPU/CPU/内存/显存）：常驻订阅 —— 与模型是否运行无关，
    // 「运行状态」面板在空载时也持续显示这些数据（模型自身的 decode/TTFT/
    // 生成进度等运行数据仍只随模型启动后由上面的 metrics-update 提供）
    window.api.onSystemMetricsUpdate((raw: Record<string, unknown>) => {
      const d = raw as Record<string, unknown>
      const partial: Partial<SystemMetrics> = {}
      if (d.gpuTemperature !== undefined) partial.gpuTemperature = d.gpuTemperature as number | null
      if (d.gpuUtilization !== undefined) partial.gpuUtilization = d.gpuUtilization as number | null
      if (d.vramUsedMb !== undefined) partial.vramUsedMb = d.vramUsedMb as number | null
      if (d.vramTotalMb !== undefined) partial.vramTotalMb = d.vramTotalMb as number | null
      if (d.gpuName !== undefined) partial.gpuName = String(d.gpuName)
      if (d.gpuPowerDraw !== undefined) partial.gpuPowerDraw = d.gpuPowerDraw as number | null
      if (d.cpuUsage !== undefined) partial.cpuUsage = d.cpuUsage as number | null
      if (d.ramUsedMb !== undefined) partial.ramUsedMb = d.ramUsedMb as number | null
      if (d.ramTotalMb !== undefined) partial.ramTotalMb = d.ramTotalMb as number | null
      useStore.getState().setSystemMetrics(partial)
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

  // 收进「工具箱」的界面统一由 ToolsHub 接管：它内部用二级导航切换具体界面，
  // 于是导航栏只需保留高频入口，低频界面照样能在页内直接切换。
  // 其余界面走 viewRegistry 的同一套映射（与 ToolsHub 共用，避免两处 switch）。
  const currentView = useMemo(() => {
    if (GROUPED_VIEWS.has(deferredView)) return <ToolsHub />
    return renderViewComponent(deferredView)
  }, [deferredView])

  // 强度换成两个值交给 CSS：面板实心度与压在图上的薄纱透明度（强度越低纱越厚）。
  // 明暗各走一条曲线：浅色底下要「够亮」才压得住深字，暗色底下要「够暗」才压得住
  // 浅字（#ced2d9）。共用一条曲线时，暗色拉到 90+ 就等于把浅色 UI 的透法直接搬到亮图上，
  // 照片亮部穿过面板把文字吃掉。暗色因此少透 25 个点、纱加厚到最多 0.72。
  const darkTheme = useThemeStore(s => s.theme === 'dark')
  const bgVars = backgroundUrl ? ({
    '--app-bg-fill': `${100 - Math.round(backgroundStrength * (darkTheme ? 0.65 : 0.9))}%`,
    '--app-bg-veil-o': `${(((100 - backgroundStrength) / 100) * (darkTheme ? 0.72 : 0.5)).toFixed(3)}`
  } as React.CSSProperties) : undefined

  return (
    <>
      <div className={`app${backgroundUrl ? ' has-bg' : ''}`} style={bgVars}>
        {/* 背景图是整窗最底一层：图用 img 铺（几 MB 的 data URL 塞进 style 属性不现实），
          薄纱压在图上，界面所有面板浮在两者之上、靠半透明底色透出。 */}
        {backgroundUrl && (
          <div className="app-bg" aria-hidden="true">
            <img className="app-bg-img" src={backgroundUrl} alt="" />
            <div className="app-bg-veil" />
          </div>
        )}
        <TitleBar />
        <ThemeToggle />
        <UpdateBannerGroup />
        <BackendDownloadBanner />
        <div className="main-layout">
          <Sidebar />
          <main className="content" style={view === 'llama' ? { display: 'none' } : {}}>
            {/* 刻意**不**给这个容器加 key={view}：key 一变 React 会把整棵子树销毁重建，
              于是新视图挂起时没有"旧内容"可保留 → 渲染 fallback（null）→ 界面空白一下再跳出来。
              去掉 key 之后，配合上面的 useDeferredValue，chunk 没就绪时会**继续显示旧视图**，
              到位了再换 —— 全程不出现空白。
              入场动画不受影响：子元素的 view-content-in 仍会随新元素挂载而播放，
              只有容器自身那条 view-fade-in 不再重播（视觉上几乎无差别）。 */}
            <div
              className="view-transition"
              style={view === 'agent-code' ? { display: 'none' } : {}}
            >
              <Suspense fallback={null}>{currentView}</Suspense>
            </div>
            {/* Agent Code 工作台：首次进入才加载（见 LazyOnce），之后常驻挂载 —— 切走时不卸载组件，
              保证正在进行的生成 / 工具循环不被打断，进度、滚动、输入框状态全部保留。 */}
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
              <LazyOnce active={agentCodeMounted} label="正在加载工作台…"><AgentCodeView /></LazyOnce>
            </div>
          </main>
          <div style={{ flex: view === 'llama' ? 1 : 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: view === 'llama' ? 'flex' : 'none', flex: 1, overflow: 'hidden', flexDirection: 'column', padding: 24 }}>
              <LazyOnce active={llamaMounted} label="正在加载 Web 界面…"><LlamaChatView /></LazyOnce>
            </div>
          </div>
        </div>
        {showCreateModal && <Suspense fallback={null}><CreateModal /></Suspense>}
      </div>
      {!splashExited && (
        <SplashScreen startExit={dataReady} onExited={() => setSplashExited(true)} />
      )}
    </>
  )
}
