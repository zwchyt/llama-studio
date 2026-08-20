import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { safeCall } from '../utils/safeCall'
import { paramSetOf } from '../utils/engine'
import {
  LayoutDashboardIcon,
  HardDriveIcon, SearchIcon, ActivityIcon, ServerIcon,
  MessageSquareIcon, TerminalIcon, InfoIcon, FileTextIcon, CodeIcon, ChevronDownIcon,
  SettingsIcon, BookOpenIcon, AudioLinesIcon, ImageIcon, MicIcon,
  BrainIcon, ChartBarIcon, TrendingUpIcon, SlidersHorizontalIcon, FolderOpenIcon, BoxesIcon, CpuIcon, SparklesIcon
} from '@animateicons/react/lucide'
import '../styles/topnav.css'

type ViewKey = ReturnType<typeof useStore.getState>['view']

interface NavDef {
  key: ViewKey
  label: string
  icon: React.ElementType
  color: string
  runningSource?: 'models' | 'llama'
  persistent?: boolean
}

const NAV_GROUPS: NavDef[][] = [
  [
    { key: 'cards', label: '我的模板', icon: LayoutDashboardIcon, color: '#8b5cf6', runningSource: 'models', persistent: true },
    { key: 'models', label: '模型', icon: BoxesIcon, color: '#3b82f6' },
    { key: 'hub', label: '模型中心', icon: SearchIcon, color: '#0ea5e9' },
    { key: 'jsonui', label: 'AI 面板', icon: SparklesIcon, color: '#a855f7' },
  ],
  [
    { key: 'llama', label: 'llama-server', icon: ServerIcon, color: '#14b8a6', runningSource: 'llama' },
    { key: 'chat', label: '聊天', icon: MessageSquareIcon, color: '#ec4899', runningSource: 'models' },
    { key: 'monitoring', label: '模型运行数据', icon: ActivityIcon, color: '#ef4444', runningSource: 'models' },
    { key: 'token-stats', label: 'Token 统计', icon: TrendingUpIcon, color: '#f59e0b', runningSource: 'models' },
    { key: 'benchmark', label: '性能测试', icon: ChartBarIcon, color: '#f59e0b' },
    { key: 'terminal', label: '终端', icon: TerminalIcon, color: '#64748b' },
    { key: 'ocr', label: 'OCR', icon: FileTextIcon, color: '#a855f7', runningSource: 'models' },
    { key: 'model-tools', label: '模型工具', icon: SlidersHorizontalIcon, color: '#06b6d4' },
    { key: 'knowledge', label: '知识库', icon: BookOpenIcon, color: '#0d9488' },
    { key: 'tts', label: '语音合成', icon: AudioLinesIcon, color: '#f43f5e' },
    { key: 'stt', label: '语音转写', icon: MicIcon, color: '#f43f5e' },
    { key: 'imagegen', label: '图像生成', icon: ImageIcon, color: '#8b5cf6', runningSource: 'models' },
    { key: 'audiocpp', label: '音频工作室', icon: AudioLinesIcon, color: '#0ea5e9' },
  ],
  [
    { key: 'agent-code', label: 'Agent Code', icon: CodeIcon, color: '#10b981' },
  ],
  [
    { key: 'agents', label: 'AI Agent', icon: BrainIcon, color: '#d946ef' },
    { key: 'engines', label: '后端与引擎', icon: CpuIcon, color: '#6b7280' },
    { key: 'folders', label: '模型文件夹', icon: FolderOpenIcon, color: '#6b7280' },
    { key: 'settings', label: '设置', icon: SettingsIcon, color: '#6b7280' },
    { key: 'about', label: '关于', icon: InfoIcon, color: '#6366f1' },
  ],
]

export default function TopNavBar() {
  const { view, setView, backends, backendsReady, activeBackend, setActiveBackend, setCommandsSchema, paths, activeChatUrl, hasRunningModels } = useStore(
    s => ({ view: s.view, setView: s.setView, backends: s.backends, backendsReady: s.backendsReady, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, setCommandsSchema: s.setCommandsSchema, paths: s.paths, activeChatUrl: s.activeChatUrl, hasRunningModels: s.cards.some(c => c.status === 'running') }),
    shallow
  )
  const [openMenu, setOpenMenu] = useState<null | 'backend' | 'folders'>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Record<string, { startAnimation: () => void; stopAnimation: () => void }>>({})

  const handleIconEnter = useCallback((key: string) => {
    iconRefs.current[key]?.startAnimation()
  }, [])

  const handleIconLeave = useCallback((key: string) => {
    iconRefs.current[key]?.stopAnimation()
  }, [])

  // 窗口过窄导航项横向溢出时：鼠标滚轮在导航栏上滚动转为平滑横向滚动。
  // 用 rAF + 指数缓动把滚轮增量合成为目标位置做插值动画，避免逐帧硬跳的卡顿感；
  // 原生监听器 passive:false 以允许 preventDefault
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let target = 0
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(Math.max(now - last, 0) / 16.667, 3)
      last = now
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      target = Math.min(Math.max(target, 0), max)
      const diff = target - el.scrollLeft
      if (Math.abs(diff) < 0.15) {
        el.scrollLeft = target
        raf = 0
        return
      }
      el.scrollLeft += diff * Math.min(1, 0.22 * dt)
      raf = requestAnimationFrame(step)
    }
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return // 未溢出时不拦截
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!delta) return
      e.preventDefault()
      target = Math.min(Math.max(target + delta, 0), Math.max(0, el.scrollWidth - el.clientWidth))
      if (!raf) {
        last = performance.now()
        raf = requestAnimationFrame(step)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // 点击下拉菜单外部时关闭
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if (rightRef.current && !rightRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [openMenu])

  const switchBackend = useCallback(async (name: string) => {
    const b = backends.find((x) => x.name === name)
    if (!b) return
    setActiveBackend(b)
    setOpenMenu(null)
    // 切换后端时按其类型加载默认参数集
    const cmds = await safeCall(() => window.api.getCommands(name, paramSetOf(b.kind)), '切换后端失败')
    if (cmds) setCommandsSchema(cmds)
  }, [backends, setActiveBackend, setCommandsSchema])

  const isRunning = (item: NavDef) =>
    (item.runningSource === 'models' && hasRunningModels) ||
    (item.runningSource === 'llama' && !!activeChatUrl)

  // 常驻项只要运行就点亮；非常驻项仅在当前选中页点亮，避免多个导航同时变绿
  const shouldHighlight = (item: NavDef) => isRunning(item) && (item.persistent || view === item.key)

  const folders: { label: string; path: string }[] = paths ? [
    { label: '/backend', path: paths.backend },
    { label: '/models', path: paths.models },
    { label: '/images', path: paths.chatImages },
    { label: '/pdf_exports', path: paths.chatPdfExports },
    { label: '/chat-templates', path: paths.chatTemplates },
  ] : []

  return (
    <div className="topnav">
      <div className="topnav-scroll" ref={scrollRef}>
        {NAV_GROUPS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <span className="topnav-divider" />}
            {group.map((item) => {
              const iconRefKey = `nav-${item.key}`
              const IconComp = item.icon
              return (
                <button
                  key={item.key}
                  className={`topnav-item ${view === item.key ? 'active' : ''}`}
                  onClick={() => setView(item.key)}
                  style={shouldHighlight(item) ? { color: 'var(--success)' } : {}}
                  onMouseEnter={() => handleIconEnter(iconRefKey)}
                  onMouseLeave={() => handleIconLeave(iconRefKey)}
                >
                  <span
                    className="topnav-ico"
                    style={view === item.key
                      ? { background: item.color, color: '#fff', boxShadow: `0 2px 8px ${item.color}55` }
                      : { background: `${item.color}1c`, color: item.color }}
                  >
                    <IconComp 
                      ref={(el: any) => { iconRefs.current[iconRefKey] = el }}
                      className="nav-animate-icon"
                      size={14}
                    />
                  </span>
                  <span>
                    {item.label}
                  </span>
                  {view === item.key && (
                    <span
                      className="topnav-active-dot"
                      style={{ background: item.color, boxShadow: `0 0 0 3px ${item.color}38` }}
                    />
                  )}
                  {shouldHighlight(item) && <span className="topnav-run-dot" />}
                </button>
              )
            })}
          </React.Fragment>
        ))}
      </div>

      {/* 右侧：后端切换 + 目录快捷入口（下拉，避免横向占位） */}
      <div className="topnav-right" ref={rightRef}>
        {backends.length > 0 && (
          <div className="topnav-menu-host">
            <button
              className={`topnav-item topnav-dd ${openMenu === 'backend' ? 'open' : ''}`}
              onClick={() => setOpenMenu(openMenu === 'backend' ? null : 'backend')}
              onMouseEnter={() => handleIconEnter('backend')}
              onMouseLeave={() => handleIconLeave('backend')}
            >
              <span className="topnav-ico" style={{ background: '#3b82f61c', color: '#3b82f6' }}>
                <HardDriveIcon size={14} ref={(el: any) => { if (el) iconRefs.current['backend'] = el }} className="nav-animate-icon" />
              </span>
              <span className="topnav-backend-name">
                {activeBackend?.name || '后端'}
              </span>
              <ChevronDownIcon size={13} />
            </button>
            {openMenu === 'backend' && (
              <div className="topnav-menu">
                {backends.map((b) => (
                  <button
                    key={b.name}
                    className="topnav-menu-item"
                    onClick={() => switchBackend(b.name)}
                    onMouseEnter={() => handleIconEnter(`backend-${b.name}`)}
                    onMouseLeave={() => handleIconLeave(`backend-${b.name}`)}
                  >
                    <HardDriveIcon size={14} style={{ color: '#3b82f6' }} ref={(el: any) => { if (el) iconRefs.current[`backend-${b.name}`] = el }} className="nav-animate-icon" />
                    <span className="topnav-menu-item-label">{b.name}</span>
                    {activeBackend?.name === b.name && <span className="topnav-active-dot" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {backends.length === 0 && !backendsReady && (
          <span className="topnav-no-backend">扫描后端中…</span>
        )}
        {backends.length === 0 && backendsReady && (
          <span className="topnav-no-backend">未找到后端，请在设置中下载</span>
        )}
        {paths && (
          <div className="topnav-menu-host">
            <button
              className={`topnav-item topnav-dd ${openMenu === 'folders' ? 'open' : ''}`}
              onClick={() => setOpenMenu(openMenu === 'folders' ? null : 'folders')}
              onMouseEnter={() => handleIconEnter('folders')}
              onMouseLeave={() => handleIconLeave('folders')}
            >
              <span className="topnav-ico" style={{ background: '#f59e0b1c', color: '#f59e0b' }}>
                <FolderOpenIcon size={14} ref={(el: any) => { if (el) iconRefs.current['folders'] = el }} className="nav-animate-icon" />
              </span>
              <ChevronDownIcon size={13} />
            </button>
            {openMenu === 'folders' && (
              <div className="topnav-menu">
                {folders.map((f) => (
                  <button
                    key={f.label}
                    className="topnav-menu-item"
                    onClick={() => { window.api.openFolder(f.path); setOpenMenu(null) }}
                    onMouseEnter={() => handleIconEnter(`folder-${f.label}`)}
                    onMouseLeave={() => handleIconLeave(`folder-${f.label}`)}
                  >
                    <FolderOpenIcon size={14} style={{ color: '#f59e0b' }} ref={(el: any) => { if (el) iconRefs.current[`folder-${f.label}`] = el }} className="nav-animate-icon" />
                    <span className="topnav-menu-item-label">打开 {f.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
