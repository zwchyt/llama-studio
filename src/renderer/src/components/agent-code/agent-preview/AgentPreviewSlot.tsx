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

import React, { Suspense } from 'react'
import { EllipsisVerticalIcon, EyeIcon, CodeIcon, PencilIcon, SaveIcon, SendIcon, MessageSquarePlusIcon, Trash2Icon, XIcon, CopyIcon } from '@animateicons/react/lucide'
import AgentFileTree from '../../AgentFileTree'
import AgentBrowser, { ANNOTATION_KIND_LABEL, type UiAnnotation } from '../../AgentBrowser'
import AgentGitDiff from '../../AgentGitDiff'
import TerminalView from '../../TerminalView'
import { extToMonacoLang } from '../../MonacoEditor'
import { useAgentTerminalStore } from '../../../store/terminalStore'
import { useStore } from '../../../store/useStore'
import { GIT_DIFF_TAB } from '../utils/constants'
import { AgentMarkdown } from '../agent-message'
import { PdfViewer } from './PdfViewer'
import type { useAgentPreviewTabs } from '../hooks/useAgentPreviewTabs'
import type { AgentProject } from '../../../../../shared/types'

const MonacoEditor = React.lazy(() => import('../../MonacoEditor'))

type PreviewDomain = ReturnType<typeof useAgentPreviewTabs>

type RightPanelMode = 'files' | 'browser' | 'terminal' | 'diff'
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
  previewResizing: boolean
  startRightResize: (e: React.PointerEvent) => void
  startPreviewResize: (e: React.PointerEvent) => void
  previewHandleIconRef: React.RefObject<{ startAnimation: () => void; stopAnimation: () => void } | null>
  previewPanelHandleIconRef: React.RefObject<{ startAnimation: () => void; stopAnimation: () => void } | null>
  terminalMounted: boolean
  handlePreviewMouseDown: (e: React.MouseEvent) => void
  handlePreviewMouseUp: (e: React.MouseEvent) => void
  // 打开文件 / 片段
  openFileAtLine: (abs: string, line?: number) => void
  addCodeSnippet: (startLine: number, endLine: number, text: string) => void
  insertAtCursor: (text: string) => void
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
  preview, activeProject, rightPanelMode, treeOpen, plainChat, rightResizing, previewResizing,
  startRightResize, startPreviewResize, previewHandleIconRef, previewPanelHandleIconRef,
  terminalMounted, handlePreviewMouseDown, handlePreviewMouseUp,
  openFileAtLine, addCodeSnippet, insertAtCursor,
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
  return (
    <div className={`agent-code-right-slot${rightPanelMode !== 'files' || slotEmpty ? ' panel-resizable' : ''}`}>
      <div
        className={`agent-code-right-edge-handle${rightResizing ? ' agent-code-resize-handle--active' : ''}${rightPanelMode === 'files' || !treeOpen ? ' hidden' : ''}`}
        onPointerDown={startRightResize}
        onMouseEnter={() => previewHandleIconRef.current?.startAnimation()}
        onMouseLeave={() => previewHandleIconRef.current?.stopAnimation()}
      >
        <EllipsisVerticalIcon ref={previewHandleIconRef} size={16} className="nav-animate-icon agent-resize-handle-icon" />
      </div>
      <div
        className={`agent-code-right-edge-handle${previewResizing ? ' agent-code-resize-handle--active' : ''}${(openTabs.length === 0 || rightPanelMode !== 'files') ? ' hidden' : ''}`}
        onPointerDown={startPreviewResize}
        onMouseEnter={() => previewPanelHandleIconRef.current?.startAnimation()}
        onMouseLeave={() => previewPanelHandleIconRef.current?.stopAnimation()}
      >
        <EllipsisVerticalIcon ref={previewPanelHandleIconRef} size={16} className="nav-animate-icon agent-resize-handle-icon" />
      </div>
      <div className={`agent-code-right-collapser ${rightPanelMode !== 'files' ? 'panel-resizable' : ''} ${treeOpen && !slotEmpty ? '' : 'collapsed'}`}>
        <div className={`agent-code-right-body${treeHidden ? ' tree-collapsed' : ''}`}>
          <div className={`agent-code-tree${treeHidden ? ' hidden' : ''}`}>
            <AgentFileTree workspaceDir={activeProject.workspaceDir} onPreviewFile={openPreview} onSendFileName={insertAtCursor} onFilesChanged={onWorkspaceFilesChanged} />
          </div>
          <div className={`agent-browser-wrap ${rightPanelMode === 'browser' ? '' : 'hidden'}`}>
            <AgentBrowser visible={rightPanelMode === 'browser' && treeOpen} onSendToAgent={sendAnnotationsToAgent} />
          </div>
          {/* 内嵌终端：首次点开后常驻（含 App.tsx 终端视图条件渲染配合，
             同一 session 的 xterm 实例任意时刻只 attach 到一个 DOM 容器）；
             面板级 files/browser 切换仅 hidden 不卸载，xterm 不重建、不触发 replay 回放大段 backlog（避免界面卡顿） */}
          {terminalMounted && currentView === 'agent-code' && (
            <div className={`agent-browser-wrap${rightPanelMode === 'terminal' ? '' : ' hidden'}`}>
              <div className="agent-terminal">
                <TerminalView store={useAgentTerminalStore} />
              </div>
            </div>
          )}
          <div className={`agent-code-diff-wrap${rightPanelMode === 'diff' ? '' : ' hidden'}`}>
            <AgentGitDiff data={gitChanges} loading={gitLoading} onRefresh={refreshGitChanges} onOpenFile={openFileAtLine} workspaceDir={activeProject.workspaceDir} focusPath={gitFocusPath} onFocusHandled={onGitFocusHandled} />
          </div>
          <div className={`agent-code-preview-group ${openTabs.length === 0 ? 'collapsed' : ''} ${rightPanelMode === 'browser' || rightPanelMode === 'terminal' || rightPanelMode === 'diff' ? 'hidden' : ''}`}>
            <div className="agent-code-preview">
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
                {!activeTab ? null
                  : activeTab.loading ? <div className="file-tree-loading">读取中…</div>
                    : activeTab.error ? <div className="agent-code-preview-error">{activeTab.error}</div>
                      : activeTab.isImage ? (
                        activeTab.imageDataUrl
                          ? <div className="agent-code-preview-image"><img src={activeTab.imageDataUrl} alt={activeTab.name} /></div>
                          : <div className="agent-code-preview-error">无法预览该图片</div>
                      )
                        : activeTab.isPdf ? (
                          // 版面渲染：pdf.js 逐页画 canvas（key 绑 path，切标签即销毁旧文档）
                          activeTab.pdfData
                            ? <PdfViewer key={activeTab.path} data={activeTab.pdfData} />
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
        </div>
      </div>
    </div>
  )
}
