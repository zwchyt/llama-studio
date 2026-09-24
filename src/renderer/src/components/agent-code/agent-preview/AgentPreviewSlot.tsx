// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：AgentPreviewSlot —— 右侧面板槽位（文件树 / 浏览器 / 终端 / 变更 / 预览）║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 从 AgentCodeView.tsx 的 JSX 中原样搬出（结构与注释未改），仅把原来靠闭包读取的
// 状态与回调改为显式 props。
//
// ⚠️ 这是一次「视图先行」的拆分：右侧面板的状态（openTabs / 各 viewMode / 注释 /
//    编辑草稿）与回调目前仍由 AgentCodeView 持有，因此本组件 props 较多（约 45 项）。
//    下一步应把这一整块状态收进 hooks/useAgentPreviewTabs.ts，届时本组件只需接收
//    该 hook 的返回值，props 数量可降到个位数。先拆视图是为了让 useAgentPreviewTabs
//    的接口边界有据可依，而不是凭空设计。

import React, { Suspense, useRef, useState, useEffect, useCallback } from 'react'
import { EllipsisVerticalIcon, ChevronRightIcon, EyeIcon, CodeIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, GlobeIcon, PencilIcon, PlusIcon, SaveIcon, SendIcon, MessageSquarePlusIcon, TerminalIcon, Trash2Icon, XIcon, CopyIcon } from '@animateicons/react/lucide'
import AgentFileTree from '../../AgentFileTree'
import AgentBrowser, { ANNOTATION_KIND_LABEL, type UiAnnotation } from '../../AgentBrowser'
import AgentGitDiff from '../../AgentGitDiff'
import TerminalView from '../../TerminalView'
import { extToMonacoLang } from '../../MonacoEditor'
import { useAgentTerminalStore } from '../../../store/terminalStore'
import { useStore } from '../../../store/useStore'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { GIT_DIFF_TAB } from '../utils/constants'
import { AgentMarkdown } from '../agent-message'
// PdfViewer 内部静态依赖 pdfjs+worker（≈2MB）：改为 React.lazy —— 只在真正打开
// PDF 预览标签的那一刻才加载对应 chunk，避免 pdfjs 常驻首屏主 bundle
// （与 extractText.ts 的按需加载同批优化；Suspense 包裹见下方渲染处）。
const PdfViewer = React.lazy(() => import('./PdfViewer').then(m => ({ default: m.PdfViewer })))
import type { useAgentPreviewTabs } from '../hooks/useAgentPreviewTabs'
import type { AniIconHandle } from '../types'
import type { AgentProject } from '../../../../../shared/types'

const MonacoEditor = React.lazy(() => import('../../MonacoEditor'))

type PreviewDomain = ReturnType<typeof useAgentPreviewTabs>

type RightPanelMode = 'files' | 'browser' | 'terminal' | 'diff' | 'menu'
/** 可常驻标签条的四个工作区（menu 是选择界面，不算工作区） */
type PanelView = 'files' | 'diff' | 'terminal' | 'browser'
const PANEL_LABEL: Record<PanelView, string> = { files: '文件树', diff: '变更', terminal: '终端', browser: '浏览器' }
// 与 AgentCodeViewLayout.tsx 里 binds 的按键一一对应，改了那边要改这里
const PANEL_SHORTCUT: Record<PanelView, string> = { files: 'F1', diff: 'F2', terminal: 'F3', browser: 'F4' }
type GitChanges = Parameters<typeof AgentGitDiff>[0]['data']

export type AgentPreviewSlotProps = {
  /** 预览域（useAgentPreviewTabs 的返回值）：标签页 / 视图模式 / 编辑态 / 打开与关闭回调 */
  preview: PreviewDomain
  activeProject: AgentProject
  rightPanelMode: RightPanelMode
  treeOpen: boolean
  /** 通用模式（由所属工作区的 mode 推导）：文件树列整列不出现——它是编码工作台的东西。
      预览 / 浏览器 / 终端保留（顶栏仍能进入），所以只收树，不整块收掉右侧面板。 */
  plainChat: boolean
  rightResizing: boolean
  startRightResize: (e: React.PointerEvent) => void
  previewHandleIconRef: React.RefObject<{ startAnimation: () => void; stopAnimation: () => void } | null>
  terminalMounted: boolean
  handlePreviewMouseDown: (e: React.MouseEvent) => void
  handlePreviewMouseUp: (e: React.MouseEvent) => void
  // 打开文件 / 片段
  openFileAtLine: (abs: string, line?: number) => void
  addCodeSnippet: (startLine: number, endLine: number, text: string) => void
  insertAtCursor: (text: string) => void
  /** 面板内工作区选择界面：点一行=打开并切到该工作区（不影响其它已打开的） */
  showRightTab: (tab: PanelView) => void
  /** 已打开的工作区标签（顺序 = 打开顺序），顶部标签条按它渲染 */
  openPanels: PanelView[]
  /** 关闭某个标签：不影响其它已打开的工作区 */
  closePanel: (view: PanelView) => void
  /** 标签条右键菜单：关闭除 keep 外的其他标签 / 关闭 keep 右侧（打开顺序在其后）的标签 / 关闭全部 */
  closeOtherPanels: (keep: PanelView) => void
  closePanelsRight: (view: PanelView) => void
  closeAllPanels: () => void
  // HTML UI 注释
  htmlAnnotateActive: boolean
  htmlAnnotations: UiAnnotation[]
  injectHtmlAnnotate: () => void
  toggleHtmlAnnotate: () => void
  clearHtmlAnnotations: () => void
  removeHtmlAnnotation: (id: string) => void
  sendHtmlAnnotations: () => void
  sendAnnotationsToAgent: (text: string) => void
  // Git 变更面板
  gitChanges: GitChanges | null
  gitLoading: boolean
  gitFocusPath: string | null
  onGitFocusHandled: () => void
  refreshGitChanges: (silent?: boolean) => void
  onWorkspaceFilesChanged: () => void
}

export function AgentPreviewSlot({
  preview, activeProject, rightPanelMode, treeOpen, plainChat, rightResizing,
  startRightResize, previewHandleIconRef,
  terminalMounted, handlePreviewMouseDown, handlePreviewMouseUp,
  openFileAtLine, addCodeSnippet, insertAtCursor, showRightTab, openPanels, closePanel,
  closeOtherPanels, closePanelsRight, closeAllPanels,
  htmlAnnotateActive, htmlAnnotations, injectHtmlAnnotate, toggleHtmlAnnotate,
  clearHtmlAnnotations, removeHtmlAnnotation, sendHtmlAnnotations, sendAnnotationsToAgent,
  gitChanges, gitLoading, gitFocusPath, onGitFocusHandled, refreshGitChanges, onWorkspaceFilesChanged,
}: AgentPreviewSlotProps) {
  // 顶层视图名（App 级）直接从 store 读，避免为此再透传一层 props
  const currentView = useStore(s => s.view)
  // 预览域整体解构，避免在调用处铺开 30 余个 props
  const {
    openTabs, setOpenTabs, activeTab, activeTabPath, setActiveTabPath,
    htmlViewMode, setHtmlViewMode, mdViewMode, setMdViewMode,
    htmlPreviewRef, tabMenu, setTabMenu, tabMenuRef,
    previewHighlightLine, previewEditing, setPreviewEditing, previewDraft, setPreviewDraft,
    isPreviewHtml, isPreviewMarkdown, buildHtmlSrcDoc,
    openPreview, savePreviewFile, closeTab, closeOtherTabs, closeAllTabs,
  } = preview
  // 文件树列在「非 files 视图」与通用模式下都不出现，两种情况都算「树已收起」。
  // 再加一条 !treeOpen：顶栏关闭 浏览器/终端/变更 时会把 mode 复位成 'files' 并同时
  // 收起面板，两个 state 在同一次渲染生效——若只看 mode，整块面板会在 200ms 的收起
  // 过渡里先亮出一棵文件树再淡出（明显闪一下）。面板收起时树本来就不该渲染。
  const treeHidden = plainChat || rightPanelMode !== 'files' || !treeOpen
  // 树收起后若又没有打开的预览标签、也不在浏览器/终端/变更模式，右侧槽里其实空无一物：
  // 此时整槽收起，否则会剩一条约 19px 的边框空条挂在右缘（树是 display:none，
  // 但 collapser 自身的 border + margin 仍在）。
  const slotEmpty = plainChat && rightPanelMode === 'files' && openTabs.length === 0
  // treeOnly 只决定面板挂不挂 panel-resizable 类（那条规则改的是预览组的伸缩方式，
  // 见 agent-code.css）；两种情况面板宽度都由 --agent-right-width 定，左缘手柄通用。
  const treeOnly = openPanels.every(v => v === 'files')

  // ── 收起动画对齐左栏：两层修正 ——
  //    1) 位移：collapsed 态的 margin-right 需等于面板自身宽度（--agent-right-collapse-offset）。
  //       文件树模式宽度由内容撑开、可拖模式会被窗口收窄封顶（max-width: calc(100% - 16px)），
  //       CSS 拿不到自身宽度，只能 JS 实测写入。
  //    2) 时长：左右同为 0.25s 时，宽面板必然滑得更快（px/s 与宽度成正比，左栏 ~216px、
  //       右栏常 ~480px+，速度差 2 倍以上）。按时长 ∝ 位移换算（--agent-right-collapse-dur），
  //       让两侧 px/s 与左栏一致；0.15s~0.6s 上下限防止极端宽度下动画过闪或过拖。
  //    用 ResizeObserver 持续实测（同时观察左栏 collapser，拖左栏宽度也会重算），
  //    直接写 CSS 变量不走 setState——拖拽改宽每帧触发，重渲染这个重组件会拖卡顿。
  //    注意：收起态（含过渡途中）跳过测量，原因见 measure 内注释。
  const collapserRef = useRef<HTMLDivElement>(null)
  // 拖宽期间不测量：测得的宽度每帧都变，写回面板根就等于每帧一次整树样式重算（拖拽时
  // 发虚的来源之一）。松手后由下面那个 effect 补测一次，收起位移仍等于终宽。
  const draggingRef = useRef(false)
  draggingRef.current = rightResizing
  const measureRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const el = collapserRef.current
    if (!el) return
    const leftEl = document.querySelector('.agent-code-sidebar-collapser') as HTMLElement | null
    const measure = () => {
      if (draggingRef.current) return
      // 收起态（含收起过渡途中）不测量：panel-resizable 的 max-width: calc(100% - 16px)
      // 以槽宽为基准，槽随 margin 收缩时面板会被挤压变窄——把挤出来的小宽度写进变量，
      // margin 就收不干净（右侧残留空档）。collapsed 类在过渡开始即加上，跳过即可。
      if (el.classList.contains('collapsed')) return
      const w = el.offsetWidth
      if (w <= 0) return
      // 值没变就不写：这两个是「继承型」自定义属性，写在面板根上会让整棵子树重算样式，
      // 而 ResizeObserver 在展开/收起动画里是逐帧回调的（变更视图条目最多，逐帧重算
      // 就是肉眼可见的卡顿）。max-width 封顶延后后面板滑动途中宽度恒定，也就恒定不写。
      const write = (name: string, value: string) => {
        if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
      }
      write('--agent-right-collapse-offset', `${w}px`)
      // 左栏位移 = collapser 宽度（width 已含 16px 外边距，见 agent-code.css），margin 滑出不改 offsetWidth
      const lw = leftEl && leftEl.offsetWidth > 0 ? leftEl.offsetWidth : 216
      const dur = Math.min(0.6, Math.max(0.15, 0.25 * (w + 16) / lw))
      write('--agent-right-collapse-dur', `${dur.toFixed(3)}s`)
    }
    measureRef.current = measure
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (leftEl) ro.observe(leftEl)
    return () => {
      ro.disconnect()
      measureRef.current = null
    }
  }, [])
  useEffect(() => {
    if (!rightResizing) measureRef.current?.()
  }, [rightResizing])

  // 工作区标签条的右键菜单（与文件标签的右键菜单同款：fixed 定位于光标处 + 点外/Esc 关闭）。
  // 只存视图级交互状态（屏幕坐标 + 被右键的标签），动作仍由上层 ui 域的三个回调承担。
  const [panelTabMenu, setPanelTabMenu] = useState<{ x: number; y: number; view: PanelView } | null>(null)
  const panelTabMenuRef = useRef<HTMLDivElement>(null)
  const closePanelTabMenu = useCallback(() => setPanelTabMenu(null), [])
  usePopoverDismiss(!!panelTabMenu, closePanelTabMenu, undefined, undefined, panelTabMenuRef)

  // 工作区动态图标的句柄：整个容器 hover 即驱动图标动画（不必精确移到图标上）。
  // @animateicons 仅在「未传 ref」时自己监听图标自身 hover；一旦传了 ref 就交给外部控制
  // ——与 TopbarBtn / AniIconButton 同款做法。三处各自一份 ref 表：同一 PanelView 可能在
  // 标签条与选择卡片里同时挂载（menu 模式下两者共存），共用一份会互相覆盖。
  const tabIconRefs = useRef<Partial<Record<PanelView, AniIconHandle | null>>>({})
  const addMenuIconRefs = useRef<Partial<Record<PanelView, AniIconHandle | null>>>({})
  const pickerIconRefs = useRef<Partial<Record<PanelView, AniIconHandle | null>>>({})
  const addBtnIconRef = useRef<AniIconHandle | null>(null)

  // 「+」按钮的下拉菜单状态
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  // 下拉菜单位置（相对于 agent-code-panel-head）
  const [addMenuPos, setAddMenuPos] = useState<{ left: number } | null>(null)
  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!addMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (addMenuRef.current?.contains(t) || addBtnRef.current?.contains(t)) return
      setAddMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [addMenuOpen])
  const toggleAddMenu = useCallback(() => {
    setAddMenuOpen(prev => {
      const next = !prev
      if (next && addBtnRef.current) {
        const btnRect = addBtnRef.current.getBoundingClientRect()
        const headEl = addBtnRef.current.closest('.agent-code-panel-head')
        if (headEl) {
          const headRect = headEl.getBoundingClientRect()
          setAddMenuPos({ left: btnRect.left - headRect.left })
        }
      }
      return next
    })
  }, [])
  const handleAddWorkspace = useCallback((v: PanelView) => {
    setAddMenuOpen(false)
    showRightTab(v)
  }, [showRightTab])

  return (
    <div className={`agent-code-right-slot${!treeOnly || slotEmpty ? ' panel-resizable' : ''}`}>
      {/* 面板左缘调宽手柄：四个视图共用这一根，拖它改整块面板宽度（--agent-right-width）。
          原先「只开文件树」时这里换的是另一根调 --agent-preview-width 的手柄，但面板已是
          定宽、预览组又 flex-grow:1 填满剩余，那根手柄拖动不产生任何位移，故合并掉。 */}
      <div
        className={`agent-code-right-edge-handle${rightResizing ? ' agent-code-resize-handle--active' : ''}${treeOpen ? '' : ' hidden'}`}
        onPointerDown={startRightResize}
        onMouseEnter={() => previewHandleIconRef.current?.startAnimation()}
        onMouseLeave={() => previewHandleIconRef.current?.stopAnimation()}
      >
        <EllipsisVerticalIcon ref={previewHandleIconRef} size={16} className="nav-animate-icon agent-resize-handle-icon" />
      </div>
      <div ref={collapserRef} className={`agent-code-right-collapser ${!treeOnly ? 'panel-resizable' : ''} ${treeOpen && !slotEmpty ? '' : 'collapsed'}`}>
        {/* 面板顶部：已打开工作区的标签条（可并存、点标签切换、× 单独关闭）+「+」开选择界面。
            通用模式没有这套工作区，维持原样（只有内容区）。 */}
        {!plainChat && openPanels.length > 0 && (
          <div className="agent-code-panel-head">
            <div className="agent-code-panel-tabs">
              {openPanels.map(v => {
                const Icon = v === 'files' ? FolderIcon : v === 'diff' ? GitBranchIcon : v === 'terminal' ? TerminalIcon : GlobeIcon
                const active = rightPanelMode === v
                return (
                  <div
                    key={v}
                    className={`agent-code-panel-tab${active ? ' active' : ''}`}
                    onMouseEnter={() => tabIconRefs.current[v]?.startAnimation?.()}
                    onMouseLeave={() => tabIconRefs.current[v]?.stopAnimation?.()}
                    onContextMenu={(e) => {
                      // 右键标签条 → 弹出关闭菜单（复用文件标签菜单的样式与定位范式：
                      // fixed + 光标坐标，并按窗口边界收进可视区）
                      e.preventDefault()
                      e.stopPropagation()
                      const MENU_W = 168, MENU_H = 148
                      setPanelTabMenu({
                        x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
                        y: Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
                        view: v,
                      })
                    }}
                  >
                    <button
                      className="agent-code-panel-tab-btn"
                      onClick={() => showRightTab(v)}
                      title={PANEL_LABEL[v]}
                      aria-current={active ? 'true' : undefined}
                    >
                      <Icon ref={el => { tabIconRefs.current[v] = el as AniIconHandle | null }} size={12} className="nav-animate-icon" />
                      <span>{PANEL_LABEL[v]}</span>
                    </button>
                    <button
                      className="agent-code-panel-tab-close"
                      onClick={() => closePanel(v)}
                      title={`关闭${PANEL_LABEL[v]}`}
                      aria-label={`关闭${PANEL_LABEL[v]}`}
                    >
                      <XIcon size={10} />
                    </button>
                  </div>
                )
              })}
              {openPanels.length > 0 && (
                <button
                  ref={addBtnRef}
                  className={`agent-code-panel-tab-add${addMenuOpen ? ' active' : ''}`}
                  onClick={toggleAddMenu}
                  title="添加工作区"
                  aria-label="添加工作区"
                  onMouseEnter={() => addBtnIconRef.current?.startAnimation?.()}
                  onMouseLeave={() => addBtnIconRef.current?.stopAnimation?.()}
                >
                  <PlusIcon ref={addBtnIconRef as never} size={12} className="nav-animate-icon" />
                </button>
              )}
            </div>
            {/* 下拉菜单渲染在 .agent-code-panel-tabs 外部，避免被 overflow-x: auto 裁剪 */}
            {addMenuOpen && addMenuPos && (
              <div ref={addMenuRef} className="agent-code-add-workspace-menu" style={{ left: addMenuPos.left }}>
                {(['files', 'diff', 'terminal', 'browser'] as PanelView[]).filter(v => !openPanels.includes(v)).map(v => {
                  const Icon = v === 'files' ? FolderIcon : v === 'diff' ? GitBranchIcon : v === 'terminal' ? TerminalIcon : GlobeIcon
                  return (
                    <button
                      key={v}
                      className="agent-code-add-workspace-item"
                      onClick={() => handleAddWorkspace(v)}
                      onMouseEnter={() => addMenuIconRefs.current[v]?.startAnimation?.()}
                      onMouseLeave={() => addMenuIconRefs.current[v]?.stopAnimation?.()}
                    >
                      <Icon ref={el => { addMenuIconRefs.current[v] = el as AniIconHandle | null }} size={14} className="nav-animate-icon" />
                      <span>{PANEL_LABEL[v]}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {/* 标签条右键菜单：与文件标签菜单同款（fixed 定位、点外/Esc 关闭）。
                渲染在 .agent-code-panel-tabs 外部，避免被其 overflow-x: auto 裁剪 */}
            {panelTabMenu && (
              <div
                ref={panelTabMenuRef}
                className="file-tree-ctx-menu"
                style={{ left: panelTabMenu.x, top: panelTabMenu.y }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <button className="file-tree-ctx-item" onClick={() => { closePanelTabMenu(); closePanel(panelTabMenu.view) }}>
                  <XIcon size={13} /> 关闭标签
                </button>
                <button className="file-tree-ctx-item" onClick={() => { closePanelTabMenu(); closeOtherPanels(panelTabMenu.view) }}>
                  <XIcon size={13} /> 关闭其他标签
                </button>
                <button className="file-tree-ctx-item" onClick={() => { closePanelTabMenu(); closePanelsRight(panelTabMenu.view) }}>
                  <ChevronRightIcon size={13} /> 关闭右侧标签
                </button>
                <button className="file-tree-ctx-item" onClick={() => { closePanelTabMenu(); closeAllPanels() }}>
                  <Trash2Icon size={13} /> 关闭全部标签
                </button>
              </div>
            )}
          </div>
        )}
        <div className={`agent-code-right-body${treeHidden ? ' tree-collapsed' : ''}`}>
          {rightPanelMode !== 'menu' && (
            <>
              <div className={`agent-code-tree${treeHidden ? ' hidden' : ''}`}>
                <AgentFileTree workspaceDir={activeProject.workspaceDir} onPreviewFile={openPreview} onSendFileName={insertAtCursor} onFilesChanged={onWorkspaceFilesChanged} />
              </div>
              <div className={`agent-browser-wrap ${rightPanelMode === 'browser' ? '' : 'hidden'}`}>
                <AgentBrowser visible={rightPanelMode === 'browser' && treeOpen} onSendToAgent={sendAnnotationsToAgent} />
              </div>
              {terminalMounted && currentView === 'agent-code' && (
                <div className={`agent-browser-wrap${rightPanelMode === 'terminal' ? '' : ' hidden'}`}>
                  <div className="agent-terminal">
                    <TerminalView store={useAgentTerminalStore} workspaceDir={plainChat ? '' : activeProject.workspaceDir} />
                  </div>
                </div>
              )}
              <div className={`agent-code-diff-wrap${rightPanelMode === 'diff' ? '' : ' hidden'}`}>
                <AgentGitDiff data={gitChanges} loading={gitLoading} onRefresh={refreshGitChanges} onOpenFile={openFileAtLine} workspaceDir={activeProject.workspaceDir} focusPath={gitFocusPath} onFocusHandled={onGitFocusHandled} />
              </div>
              <div className={`agent-code-preview-group ${openTabs.length === 0 && rightPanelMode !== 'files' ? 'collapsed' : ''} ${rightPanelMode === 'browser' || rightPanelMode === 'terminal' || rightPanelMode === 'diff' ? 'hidden' : ''}`}>
            <div className={`agent-code-preview${openTabs.length === 0 ? ' agent-code-preview--empty' : ''}`}>
              <div className="agent-code-preview-header">
                <div className="agent-code-preview-tabs">
                  {openTabs.map((t, tabIdx) => (
                    <div
                      key={t.path}
                      className={`agent-code-preview-tab ac-icon-btn ${t.path === activeTabPath ? 'active' : ''}`}
                      onClick={() => setActiveTabPath(t.path)}
                      onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, path: t.path }) }}
                      onMouseDown={(e) => {
                        const el = e.currentTarget
                        el.setAttribute('draggable', 'true')
                        const cleanup = () => { el.removeAttribute('draggable'); document.removeEventListener('mouseup', cleanup) }
                        document.addEventListener('mouseup', cleanup)
                      }}
                      onDragStart={(e) => { e.dataTransfer.setData('text/x-tab-idx', String(tabIdx)); e.dataTransfer.effectAllowed = 'move' }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const fromIdx = Number(e.dataTransfer.getData('text/x-tab-idx'))
                        if (isNaN(fromIdx) || fromIdx === tabIdx) return
                        setOpenTabs(prev => {
                          const next = [...prev]
                          const [moved] = next.splice(fromIdx, 1)
                          next.splice(tabIdx, 0, moved)
                          return next
                        })
                      }}
                      onDragEnd={(e) => { (e.currentTarget as HTMLElement).removeAttribute('draggable') }}
                    >
                      <span className="agent-code-preview-tab-name">{t.name}</span>
                      <button
                        className="agent-code-preview-tab-close"
                        onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
                      >
                        <XIcon size={10} />
                      </button>
                    </div>
                  ))}
                </div>
                <span className="agent-code-preview-actions">
                  {isPreviewHtml && (
                    <button
                      className="btn btn-xs ac-icon-btn agent-code-preview-htmltoggle"
                      onClick={() => setHtmlViewMode(m => m === 'preview' ? 'source' : 'preview')}
                      title={htmlViewMode === 'preview' ? '查看源码' : '渲染预览'}
                    >
                      {htmlViewMode === 'preview' ? <CodeIcon size={12} /> : <EyeIcon size={12} />}
                    </button>
                  )}
                  {isPreviewMarkdown && (
                    <button
                      className="btn btn-xs ac-icon-btn agent-code-preview-mdtoggle"
                      onClick={() => setMdViewMode(m => m === 'preview' ? 'source' : 'preview')}
                      title={mdViewMode === 'preview' ? '查看源码' : '渲染预览'}
                    >
                      {mdViewMode === 'preview' ? <CodeIcon size={12} /> : <EyeIcon size={12} />}
                    </button>
                  )}
                  {/* HTML 预览的 UI 注释：点击预览元素添加注释（发送给 Agent 自动定位修改） */}
                  {isPreviewHtml && htmlViewMode === 'preview' && (
                    <button
                      className={`btn btn-xs ac-icon-btn agent-code-preview-annotate${htmlAnnotateActive ? ' active' : ''}`}
                      onClick={toggleHtmlAnnotate}
                    >
                      <MessageSquarePlusIcon size={12} />
                      {htmlAnnotations.length > 0 && <span className="agent-code-preview-annotate-count">{htmlAnnotations.length}</span>}
                    </button>
                  )}
                  {/* 源码预览编辑：进入/退出编辑态；保存写回文件。
                    Markdown 在「源码」模式下同样允许编辑（渲染态不可直接编辑）。
                    PDF / DOCX 不给编辑：预览的是抽取文本，写回会毁掉原文件（保存处另有兜底）。 */}
                  {!isPreviewHtml && (!isPreviewMarkdown || mdViewMode === 'source') && activeTab && !activeTab.isBinaryDoc && activeTabPath !== GIT_DIFF_TAB && (
                    previewEditing ? (
                      <>
                        <button className="btn btn-xs ac-icon-btn agent-code-preview-save" onClick={() => { if (previewDraft !== null) savePreviewFile(previewDraft) }} disabled={previewDraft === null || previewDraft === activeTab.content}>
                          <SaveIcon size={12} /> 保存
                        </button>
                        <button className="btn btn-xs ac-icon-btn" onClick={() => { setPreviewDraft(null); setPreviewEditing(false) }}>
                          <XIcon size={12} /> 取消
                        </button>
                      </>
                    ) : (
                      <button className="btn btn-xs ac-icon-btn" onClick={() => setPreviewEditing(true)} title="编辑此文件">
                        <PencilIcon size={12} />
                      </button>
                    )
                  )}
                  <button className="btn btn-xs agent-code-preview-close ac-icon-btn" onClick={() => activeTab && closeTab(activeTab.path)} disabled={!activeTab}>
                    <XIcon size={12} />
                  </button>
                </span>
              </div>
              {tabMenu && (() => {
                const MENU_W = 160, MENU_H = 140
                const x = Math.min(tabMenu.x, window.innerWidth - MENU_W - 8)
                const y = Math.min(tabMenu.y, window.innerHeight - MENU_H - 8)
                return (
                  <div ref={tabMenuRef} className="file-tree-ctx-menu" style={{ left: Math.max(8, x), top: Math.max(8, y) }} onContextMenu={(e) => e.preventDefault()}>
                    <button className="file-tree-ctx-item" onClick={() => { closeTab(tabMenu.path); setTabMenu(null) }}><XIcon size={13} /> 关闭</button>
                    <button className="file-tree-ctx-item" onClick={() => { closeOtherTabs(tabMenu.path); setTabMenu(null) }}><XIcon size={13} /> 关闭其他</button>
                    <button className="file-tree-ctx-item" onClick={() => { closeAllTabs(); setTabMenu(null) }}><Trash2Icon size={13} /> 关闭全部</button>
                    {tabMenu.path !== GIT_DIFF_TAB && (
                      <button className="file-tree-ctx-item" onClick={() => { navigator.clipboard.writeText(tabMenu.path).catch(() => { }); setTabMenu(null) }}><CopyIcon size={13} /> 复制路径</button>
                    )}
                  </div>
                )
              })()}
              <div className="agent-code-preview-body">
                {!activeTab ? (
                  <div className="agent-code-preview-empty">
                    <FolderOpenIcon size={36} className="agent-code-preview-empty-icon" />
                    <span className="agent-code-preview-empty-title">选择文件以预览</span>
                    <span className="agent-code-preview-empty-desc">从左侧文件树中点击文件，在此处查看内容</span>
                  </div>
                )
                  : activeTab.loading ? <div className="file-tree-loading">读取中…</div>
                    : activeTab.error ? <div className="agent-code-preview-error">{activeTab.error}</div>
                      : activeTab.isImage ? (
                        activeTab.imageDataUrl
                          ? <div className="agent-code-preview-image"><img src={activeTab.imageDataUrl} alt={activeTab.name} /></div>
                          : <div className="agent-code-preview-error">无法预览该图片</div>
                      )
                        : activeTab.isPdf ? (
                          // 版面渲染：pdf.js 逐页画 canvas（key 绑 path，切标签即销毁旧文档）
                          // PdfViewer 是 lazy chunk（内含 pdfjs），Suspense 兜首帧加载占位
                          activeTab.pdfData
                            ? (
                              <Suspense fallback={<div className="file-tree-loading">加载 PDF 渲染器…</div>}>
                                <PdfViewer key={activeTab.path} data={activeTab.pdfData} />
                              </Suspense>
                            )
                            : <div className="agent-code-preview-error">无法预览该 PDF</div>
                        )
                          : isPreviewHtml && htmlViewMode === 'preview' ? (
                            <>
                              <iframe
                                ref={htmlPreviewRef}
                                className="agent-code-preview-html"
                                title={activeTab.name}
                                // 不设 sandbox：预览页常需 localStorage/字体等同源能力，
                                // 而 allow-scripts+allow-same-origin 的沙箱可被逃逸（Chromium
                                // 每次挂载都告警），安全上等价于无沙箱。预览内容为用户
                                // 本地生成的文件，直接同源运行，避免假沙箱告警与功能破坏。
                                srcDoc={buildHtmlSrcDoc(activeTab.content ?? '', activeTab.path)}
                                onLoad={injectHtmlAnnotate}
                              />
                              {/* UI 注释面板（复用浏览器注释面板样式） */}
                              {htmlAnnotations.length > 0 && (
                                <div className="agent-browser-annotations">
                                  <div className="agent-browser-annotations-head">
                                    <span>UI 注释（{htmlAnnotations.length}）</span>
                                    <button className="agent-browser-annotations-clear" onClick={clearHtmlAnnotations}><Trash2Icon size={11} /> 清空</button>
                                  </div>
                                  <div className="agent-browser-annotations-list">
                                    {htmlAnnotations.map(a => (
                                      <div className="agent-browser-annotations-item" key={a.id}>
                                        <div className="agent-browser-annotations-note">
                                          <span className={`agent-ann-kind kind-${a.kind}`}>{ANNOTATION_KIND_LABEL[a.kind]}</span>{a.note}
                                        </div>
                                        {a.kind === 'area' && a.rect
                                          ? <div className="agent-browser-annotations-sel" title={`${Math.round(a.rect.w)}×${Math.round(a.rect.h)} @ (${Math.round(a.rect.x)}, ${Math.round(a.rect.y)})`}>区域 {Math.round(a.rect.w)}×{Math.round(a.rect.h)} @ ({Math.round(a.rect.x)},{Math.round(a.rect.y)}) · 覆盖 {a.elements.length} 元素</div>
                                          : a.kind === 'text'
                                            ? <div className="agent-browser-annotations-sel" title={a.text}>"{a.text}"</div>
                                            : <div className="agent-browser-annotations-sel" title={a.elements.map(e => e.selector).join('\n')}>{a.elements.length > 1 ? `多选 ${a.elements.length} 个元素` : (a.elements[0]?.selector || '')}</div>}
                                        {a.component && <div className="agent-browser-annotations-comp" title={a.component}>{a.component}</div>}
                                        <button className="agent-browser-annotations-del" onClick={() => removeHtmlAnnotation(a.id)}><XIcon size={11} /></button>
                                      </div>
                                    ))}
                                  </div>
                                  <button className="agent-browser-annotations-send" onClick={sendHtmlAnnotations}>
                                    <SendIcon size={12} /> 发送给 Agent
                                  </button>
                                </div>
                              )}
                            </>
                          )
                            : isPreviewMarkdown && mdViewMode === 'preview' ? (
                              <div className="agent-code-preview-md chat-msg-markdown">
                                <AgentMarkdown content={activeTab.content ?? ''} />
                              </div>
                            ) : (
                              <div className="agent-code-preview-editor" onMouseDown={previewEditing ? undefined : handlePreviewMouseDown} onMouseUp={previewEditing ? undefined : handlePreviewMouseUp}>
                                <Suspense fallback={<div className="file-tree-loading">加载编辑器…</div>}>
                                  <MonacoEditor
                                    value={previewEditing && previewDraft !== null ? previewDraft : activeTab?.content ?? ''}
                                    language={extToMonacoLang(activeTabPath || '')}
                                    readOnly={!previewEditing}
                                    highlightLine={previewEditing ? null : previewHighlightLine}
                                    onChange={v => { if (previewEditing) setPreviewDraft(v) }}
                                    onSave={v => savePreviewFile(v)}
                                    onSelectionAction={previewEditing ? undefined : (text, startLine, endLine) => addCodeSnippet(startLine, endLine, text)}
                                  />
                                </Suspense>
                              </div>
                            )}
              </div>
            </div>
          </div>
            </>
          )}
          {/* 「»」展开的工作区选择界面：上下竖排四个入口，点一个是「打开并切过去」 */}
          {rightPanelMode === 'menu' && (
            <div className="agent-code-panel-picker">
              <div className="agent-code-panel-picker-list">
                {(['files', 'diff', 'terminal', 'browser'] as PanelView[]).map(v => {
                  const Icon = v === 'files' ? FolderIcon : v === 'diff' ? GitBranchIcon : v === 'terminal' ? TerminalIcon : GlobeIcon
                  return (
                    <button
                      key={v}
                      className={`agent-code-panel-picker-item picker-${v}`}
                      onClick={() => showRightTab(v)}
                      onMouseEnter={() => pickerIconRefs.current[v]?.startAnimation?.()}
                      onMouseLeave={() => pickerIconRefs.current[v]?.stopAnimation?.()}
                    >
                      <Icon ref={el => { pickerIconRefs.current[v] = el as AniIconHandle | null }} size={18} className="nav-animate-icon" />
                      <span className="agent-code-panel-picker-name">{PANEL_LABEL[v]}</span>
                      {openPanels.includes(v) && <span className="agent-code-panel-picker-tag">已打开</span>}
                      <span className="agent-code-panel-picker-key">{PANEL_SHORTCUT[v]}</span>
                      <ChevronRightIcon size={14} className="agent-code-panel-picker-arrow" />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
