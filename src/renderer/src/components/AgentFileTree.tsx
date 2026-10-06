import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, memo } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  ChevronRightIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon, LoaderIcon, CornerDownLeftIcon, CopyIcon, SearchIcon, XIcon, ChevronsUpIcon, ChevronsDownIcon, PencilIcon, Trash2Icon
} from '@animateicons/react/lucide'
import { fileMeta } from '../utils/fileIcon'
import { notify } from '../store/notificationStore'
import { useBubbleTip } from './useBubbleTip'

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

// 退场要等容器高度动画播完才卸载，时长跟着本次行数走 —— 与 CSS 的 --ft-span-out 同式：
//   slots = min(count, ANIM_ROWS) - 1 ; step = min(STEP, WINDOW / slots) ; span = step*slots + ROW
// 只有收起侧压密（要尽快让位）；展开侧的间隔固定 64ms 不压，压了「一行一行」就糊成一片。
// ⚠️ 四个常数必须与 agent-code.css 的 --ft-step / --ft-window / --ft-anim-rows /
// --ft-row-dur 完全一致：短了掐断最后一行，长了留一段空等。+20ms 是收尾余量。
const FT_STEP_MS = 64
const FT_ROW_MS = 240
const FT_WINDOW_MS = 460
const FT_ANIM_ROWS = 24
const exitSpanMs = (count: number): number => {
  const slots = Math.max(Math.min(Math.max(count, 1), FT_ANIM_ROWS) - 1, 0)
  const step = Math.min(FT_STEP_MS, FT_WINDOW_MS / Math.max(slots, 1))
  return Math.round(step * slots + FT_ROW_MS) + 20
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// 绝对路径的父目录（树节点 path 由主进程 join 生成，分隔符跟随平台）
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

// 相对工作区根的路径：统一正斜杠，越出工作区时原样返回
function relativeTo(p: string, root: string): string {
  const norm = (s: string) => s.replace(/[\\/]+/g, '/')
  const base = norm(root).replace(/\/+$/, '')
  const full = norm(p)
  if (!base) return full
  return full.toLowerCase().startsWith(base.toLowerCase() + '/') ? full.slice(base.length + 1) : full
}

interface FileNode {
  name: string
  path: string
  isDir: boolean
  size?: number
  children?: FileNode[]
  loaded?: boolean
  truncated?: boolean
  total?: number
}

// 树形连接线：在节点行左侧（宽度 = level * 缩进）叠一层绝对定位的引导列，
// 每列一个 16px 单元格，列高 = 行高，相邻行的竖线首尾相接即成连续引导线。
// 祖先列按「该祖先是否为末子节点」续线或留空，自身列画折角
// （--mid = ├─ 通高，--last = └─ 竖线只到行中）。
// 用覆盖层而非改行内 DOM 结构：行布局与 padding 完全不变，几百个节点不多一层重排成本。
function TreeGuides({ prefix, isLast }: { prefix: boolean[]; isLast: boolean }) {
  return (
    <span className="file-tree-guides" aria-hidden>
      {prefix.map((cont, i) => (
        <span key={i} className={`file-tree-guide${cont ? ' file-tree-guide--cont' : ''}`} />
      ))}
      <span className={`file-tree-guide file-tree-guide--${isLast ? 'last' : 'mid'}`} />
    </span>
  )
}

function updateNodeInTree(root: FileNode, targetPath: string, updates: Partial<FileNode>): FileNode {
  if (root.path === targetPath) return { ...root, ...updates }
  if (root.children) {
    return { ...root, children: root.children.map(child => updateNodeInTree(child, targetPath, updates)) }
  }
  return root
}

// memo：文件树是整页重渲染的最大单项成本（几百个节点的递归重建 ≈ 10-30ms/次）。
// 流式期间整页可能频繁重渲染，包 memo 后只要 workspaceDir/回调引用不变就整树跳过。
export default memo(function AgentFileTree({ workspaceDir, onPreviewFile, onSendFileName, onFilesChanged }: { workspaceDir: string; onPreviewFile?: (path: string) => void; onSendFileName?: (name: string) => void; onFilesChanged?: () => void }) {
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}；已有 hover 动画的走 showTip/hideTip 合并）
  const { tipHandlers: tip, tipNode, showTip, hideTip } = useBubbleTip()
  const [tree, setTree] = useState<FileNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 收起的退场动画要「先播完再卸载」：expanded 在点击当刻就置闭（箭头/文件夹图标即时翻转），
  // 容器由 closing 集合托住、再多挂 exitSpanMs(行数)，到点才真正卸载。
  // 宽度 FLIP 也必须留到卸载那一帧才做——行还挂着时面板宽度没变，提前量会得到
  // to === before 而整段跳过，之后行消失、面板骤窄，就是「收起时宽度弹一下」。
  const [closing, setClosing] = useState<Set<string>>(new Set())
  const exitTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set())
  const [errorSet, setErrorSet] = useState<Set<string>>(new Set())
  // 多文件选中（Ctrl+Click），用于拖拽多文件一次性拖入输入框
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  // 右键菜单：文件与文件夹节点均可触发，{ x, y } 为屏幕坐标，name/path 为当前节点
  // confirmDel=true 时菜单切换为删除二次确认（文件不可恢复，必须点两下）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string; path: string; isDir: boolean; confirmDel?: boolean } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 内联重命名：path=目标节点绝对路径，name=其原名称（用于判断是否真改过），text=输入框内容
  const [renaming, setRenaming] = useState<{ path: string; name: string; text: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  // 同一次「路径+文本」只结算一次：Enter 提交后紧跟的 blur 会带同一份快照再触发一遍，
  // 而此时原路径已改名成功，第二次调用只会弹出「原文件不存在」的假错误。
  const renameSettledRef = useRef<string | null>(null)
  // 图片悬停缩略图
  const [imgTooltip, setImgTooltip] = useState<{ x: number; y: number; dataUrl: string } | null>(null)
  const imgHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imgHoverPath = useRef<string | null>(null)
  // 节点图标动画联动：鼠标落在节点行任意位置（名称/留白）都触发类型图标动画
  const nodeIconRefs = useRef(new Map<string, { startAnimation: () => void; stopAnimation: () => void }>())
  const resultIconRefs = useRef(new Map<string, { startAnimation: () => void; stopAnimation: () => void }>())

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 面板宽度 FLIP 过渡（双向）：外层面板是 fit-content，内在尺寸变化无法被 CSS transition 补间。
  // 展开/收起时内容都在同帧即时出现/退出（不播折叠动画——长目录逐帧重排很贵），
  // 旧宽→新宽的差值当帧可测，用像素宽做一段 0.2s 平滑过渡后释放回 fit-content。
  // 全程只有这一段轻量动画；严禁与折叠动画串行或叠加（那是此前卡顿的根因）。
  const rootElRef = useRef<HTMLDivElement>(null)
  const panelWidthBeforeRef = useRef<number | null>(null)
  // 在飞动画的收尾句柄。必须在量新目标之前释放：面板带着内联 width 时 offsetWidth 读到的
  // 是被钉住的值，第二次展开会量到 to === before 而直接跳过动画，面板僵在旧宽、
  // 等上一段 transitionend 释放内联样式时才凭空跳过去（抖动的来源）。
  const flipReleaseRef = useRef<(() => void) | null>(null)
  const markPanelWidth = useCallback(() => {
    const panel = rootElRef.current?.closest('.agent-code-tree') as HTMLElement | null
    if (!panel) { panelWidthBeforeRef.current = null; return }
    // 先量后取消：读到的是当前补间值，新动画就从眼睛看到的宽度接着走；
    // 若先取消再量，起点会变成上一段的目标宽，动画没走完时点下去就向前跳一下。
    const current = panel.offsetWidth
    flipReleaseRef.current?.()
    panelWidthBeforeRef.current = current
  }, [])
  useLayoutEffect(() => {
    const before = panelWidthBeforeRef.current
    panelWidthBeforeRef.current = null
    if (before == null) return
    const panel = rootElRef.current?.closest('.agent-code-tree') as HTMLElement | null
    if (!panel) return
    // FLIP：先钉回旧宽→强制回流→带过渡过到新宽；结束后清空内联样式回到 fit-content
    const to = panel.offsetWidth
    if (to === before) return
    panel.style.transition = 'none'
    panel.style.width = before + 'px'
    void panel.offsetWidth
    panel.style.transition = 'width .2s cubic-bezier(.4, 0, .2, 1)'
    panel.style.width = to + 'px'
    // release 先声明：它被 onEnd 调用时 onEnd 必然已就位；写成 function 声明反而会让
    // TS 认为可能在上面的 !panel 窄化之前被调用，闭包里 panel 退回可空。
    const release = (): void => {
      panel.style.transition = ''
      panel.style.width = ''
      panel.removeEventListener('transitionend', onEnd)
      flipReleaseRef.current = null
    }
    // 必须校验 e.target：transitionend 会冒泡，面板内任何元素的 width 过渡
    // （重命名框、折叠按钮）结束都会命中，提前释放内联宽度就是跳一下。
    const onEnd = (e: TransitionEvent): void => {
      if (e.target !== panel || e.propertyName !== 'width') return
      release()
    }
    panel.addEventListener('transitionend', onEnd)
    flipReleaseRef.current = release
    // 绝不在这里 return release：本效应同时依赖 expanded 与 closing，
    // 任何一次「不相关的 closing 变动」（别的目录退场到点、cancelExit）重跑本效应时，
    // React 会先执行这里的 cleanup → 把正在播的宽度动画从中间掐断、面板瞬跳到自然宽，
    // 看着就像动画又渲染了一遍。释放只交给：transitionend、下一次 markPanelWidth
    // 的显式取消、以及下面那条只在卸载时跑一次的清理。
  }, [expanded, closing])

  // 卸载收尾：清掉仍在飞的宽度动画与退场定时器，别让回调在组件销毁后再 setState
  useEffect(() => () => {
    flipReleaseRef.current?.()
    exitTimersRef.current.forEach(t => clearTimeout(t))
    exitTimersRef.current.clear()
  }, [])

  // 退场到点：容器卸载，面板宽度到这一帧才变化 → 先量旧宽，再摘掉托挂标记
  const beginExit = useCallback((path: string, count: number) => {
    setClosing(prev => (prev.has(path) ? prev : new Set(prev).add(path)))
    const timers = exitTimersRef.current
    const old = timers.get(path)
    if (old) clearTimeout(old)
    timers.set(path, setTimeout(() => {
      timers.delete(path)
      markPanelWidth()
      setClosing(prev => {
        if (!prev.has(path)) return prev
        const s = new Set(prev); s.delete(path); return s
      })
    }, exitSpanMs(count)))
  }, [markPanelWidth])

  // 退场途中又点开：取消卸载，容器原地从「退场」切回「入场」
  const cancelExit = useCallback((path: string) => {
    const t = exitTimersRef.current.get(path)
    if (t) { clearTimeout(t); exitTimersRef.current.delete(path) }
    setClosing(prev => {
      if (!prev.has(path)) return prev
      const s = new Set(prev); s.delete(path); return s
    })
  }, [])

  const fetchChildren = useCallback(async (path: string): Promise<{ children: FileNode[]; truncated: boolean; total: number } | { error: string }> => {
    const res = await window.api.expandFileTree(path)
    if (res.success && res.children) {
      const children: FileNode[] = res.children.map(c => ({ name: c.name, path: c.path, isDir: c.isDir, size: c.size }))
      return { children, truncated: !!res.truncated, total: res.total ?? children.length }
    }
    return { error: res.error || '展开目录失败' }
  }, [])

  const refreshDir = useCallback(async (path: string) => {
    const r = await fetchChildren(path)
    if ('error' in r) return // 静默：目录可能已被删除/移动
    setTree(prev => prev ? updateNodeInTree(prev, path, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
  }, [fetchChildren])

  const toggleExpand = useCallback(async (node: FileNode, e?: React.MouseEvent) => {
    if (!node.isDir) {
      // Ctrl/Cmd+Click：切换多选（不触发预览）
      if (e && (e.ctrlKey || e.metaKey)) {
        setSelectedFiles(prev => {
          const next = new Set(prev)
          if (next.has(node.path)) next.delete(node.path)
          else next.add(node.path)
          return next
        })
        return
      }
      // 文件：仅触发预览，清除多选
      setSelectedFiles(new Set())
      onPreviewFile?.(node.path)
      return
    }

    // 展开/收起一律用函数式更新：未加载目录需 await 网络加载，若用闭包内的
    // expanded 快照整体覆盖，快速连续展开两个目录时后完成的一次会把
    // 先完成的展开状态抹掉（lost update，目录「自动收回」）。
    if (expandedRef.current.has(node.path)) {
      // 不调 markPanelWidth：退场期间容器仍挂载，面板宽度不变，
      // 量了会让下一次 FLIP 效应拿到「新旧相同」而空跑一段。
      beginExit(node.path, node.children?.length ?? 0)
      setExpanded(prev => { const s = new Set(prev); s.delete(node.path); return s })
      return
    }
    // 展开：若该目录正在退场途中，取消卸载定时器，容器原地切回入场
    cancelExit(node.path)
    // 宽度 FLIP 的起点必须在点击这一帧就量定，不能等到 await 之后：
    // 首次展开要读目录，量得越晚、起点越落后于用户眼前看到的宽度（期间任何一次
    // 重排都会让「起点」和「用户记忆里的起点」对不上），表现为第一次展开抖一下。
    markPanelWidth()

    if (!node.loaded) {
      setLoadingSet(prev => new Set(prev).add(node.path))
      setErrorSet(prev => { const s = new Set(prev); s.delete(node.path); return s })
      const r = await fetchChildren(node.path)
      if ('error' in r) {
        // 展开没发生 → 撤掉刚打下的宽度起点。否则下一次任意 expanded 变化会拿这个
        // 过期值当 FLIP 起点，凭空做一段「从旧宽度出发」的动画。
        panelWidthBeforeRef.current = null
        setTree(prev => prev ? updateNodeInTree(prev, node.path, { loaded: false }) : prev)
        setErrorSet(prev => new Set(prev).add(node.path))
      } else {
        setTree(prev => prev ? updateNodeInTree(prev, node.path, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
      }
      setLoadingSet(prev => { const s = new Set(prev); s.delete(node.path); return s })
    }

    setExpanded(prev => new Set(prev).add(node.path))
  }, [onPreviewFile, fetchChildren, markPanelWidth, beginExit, cancelExit])

  // 根目录加载（workspaceDir 变化时）
  useEffect(() => {
    savedExpandRef.current = null
    // 换工作区：退场托挂与定时器全部作废，否则旧路径的到点回调会去动新树的宽度标记
    exitTimersRef.current.forEach(t => clearTimeout(t))
    exitTimersRef.current.clear()
    setClosing(new Set())
    if (!workspaceDir) { setTree(null); setExpanded(new Set()); setErrorSet(new Set()); return }
    const name = workspaceDir.split('\\').pop()?.split('/').pop() || workspaceDir
    const root: FileNode = { name, path: workspaceDir, isDir: true, children: [], loaded: false }
    setTree(root)
    setExpanded(new Set([workspaceDir]))
    setErrorSet(new Set())
    ;(async () => {
      setLoadingSet(prev => new Set(prev).add(workspaceDir))
      const r = await fetchChildren(workspaceDir)
      if ('error' in r) {
        setTree(prev => prev ? updateNodeInTree(prev, workspaceDir, { loaded: true }) : prev)
        setErrorSet(prev => new Set(prev).add(workspaceDir))
      } else {
        setTree(prev => prev ? updateNodeInTree(prev, workspaceDir, { children: r.children, loaded: true, truncated: r.truncated, total: r.total }) : prev)
      }
      setLoadingSet(prev => { const s = new Set(prev); s.delete(workspaceDir); return s })
    })()
  }, [workspaceDir, fetchChildren])

  // 自动监听目录变化：启动 watcher 并监听变更事件，刷新所有已展开节点（免去手动刷新按钮）
  useEffect(() => {
    if (!workspaceDir) return
    window.api.startAgentFileWatch(workspaceDir)
    const onChange = (data?: { dir: string; filename: string }) => {
      // 忽略 .git 内部写入：git status/diff 等会刷新 .git/index，否则会与 Git 变更面板刷新形成回环。
      const fn = data?.filename || ''
      if (fn === '.git' || fn.startsWith('.git/') || fn.startsWith('.git\\')) return
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        const dirs = [workspaceDir, ...Array.from(expandedRef.current).filter(p => p !== workspaceDir)]
        dirs.forEach(p => refreshDir(p))
        onFilesChanged?.()
      }, 300)
    }
    window.api.onAgentFileChanged(onChange)
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      window.api.removeAgentFileListeners()
      window.api.stopAgentFileWatch()
    }
  }, [workspaceDir, refreshDir, onFilesChanged])

  // 拖入输入框完成后清除多选高亮
  useEffect(() => {
    const clear = () => setSelectedFiles(new Set())
    window.addEventListener('agent-file-drop-done', clear)
    return () => window.removeEventListener('agent-file-drop-done', clear)
  }, [])

  // 复制到剪贴板（优先 navigator.clipboard，失败回退 execCommand）
  const copyText = useCallback(async (text: string, okMsg: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      notify(okMsg, 'success')
    } catch {
      notify('复制失败', 'error')
    }
  }, [])

  // 删除文件（仅文件节点提供；目录递归删除风险过高，主进程同样拒收非空目录）
  const deleteFile = useCallback(async (path: string) => {
    const res = await window.api.deletePath(path, false)
    if (!res.success) { notify(res.error || '删除失败', 'error'); return }
    notify('已删除文件', 'success')
    void refreshDir(parentDir(path))
  }, [refreshDir])

  // 提交内联重命名：空值或原名不改盘，失败把主进程原因原样抛出
  const commitRename = useCallback(async () => {
    const cur = renaming
    if (!cur) return
    const key = `${cur.path}\u0000${cur.text}`
    if (renameSettledRef.current === key) return
    renameSettledRef.current = key
    setRenaming(null)
    const name = cur.text.trim()
    if (!name || name === cur.name) return
    const res = await window.api.renamePath(cur.path, name)
    if (!res.success) { notify(res.error || '重命名失败', 'error'); return }
    notify('已重命名', 'success')
    void refreshDir(parentDir(cur.path))
  }, [renaming, refreshDir])

  // 点击空白 / 右键别处 / 按下 Esc 时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      // 菜单内部点击不关闭，交给菜单项自身处理
      if (menuRef.current?.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    // 捕获阶段先于节点 onClick，避免关闭后立即触发展开等
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('contextmenu', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('contextmenu', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  // 进入重命名时聚焦输入框，并只选中主文件名（不含扩展名）——整串选中极易连带改掉扩展名
  useEffect(() => {
    if (!renaming) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(dot > 0 ? dot : 0, el.value.length)
  }, [renaming?.path])

  const renderNode = (node: FileNode, level: number, prefix: boolean[], isLast: boolean, ord = 0) => {
    const isExpanded = expanded.has(node.path)
    // 退场托挂：已收起但容器仍挂载播退场动画（此时 isExpanded 为 false）
    const isClosing = closing.has(node.path) && !isExpanded
    const isLoading = loadingSet.has(node.path)
    const isError = errorSet.has(node.path)
    // 该节点正在内联改名：名称位换成输入框，同时关掉行拖拽（否则框内选字会被整行拖走）
    const renamingHere = renaming && renaming.path === node.path ? renaming : null
    // 图片文件检测（用于悬停缩略图）
    const ext = (!node.isDir ? (/\.([a-z0-9]+)$/i.exec(node.name)?.[1] || '').toLowerCase() : '')
    const isImage = IMG_EXT.has(ext)
    // 文件与目录节点都弹出自定义菜单（重命名/复制路径/复制相对路径）；
    // 「发送到输入框」「删除」只对文件开放——目录名发进输入框无意义，递归删目录不可恢复。
    const onNodeContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY, name: node.name, path: node.path, isDir: node.isDir })
    }
    const onNodeMouseEnter = (e: React.MouseEvent) => {
      // 节点行任意位置（名称/留白）hover → 触发类型图标动画；图片节点兼做悬停缩略图
      // 方法级 ?.()：Map 值类型契约由 fileIcon.ts 适配器保证，但防御未来混入的
      // 静态图标 ref（DOM 元素）——get() 非 undefined 但缺方法时不再 TypeError
      nodeIconRefs.current.get(node.path)?.startAnimation?.()
      if (!isImage) return
      const rect = e.currentTarget.getBoundingClientRect()
      imgHoverPath.current = node.path
      if (imgHoverTimer.current) clearTimeout(imgHoverTimer.current)
      imgHoverTimer.current = setTimeout(async () => {
        if (imgHoverPath.current !== node.path) return
        const r = await window.api.readFileBase64(node.path)
        if (r.success && r.dataUrl && imgHoverPath.current === node.path) {
          setImgTooltip({ x: rect.left + rect.width / 2, y: rect.top, dataUrl: r.dataUrl })
        }
      }, 350)
    }
    const onNodeMouseLeave = () => {
      nodeIconRefs.current.get(node.path)?.stopAnimation?.()
      if (!isImage) return
      imgHoverPath.current = null
      if (imgHoverTimer.current) { clearTimeout(imgHoverTimer.current); imgHoverTimer.current = null }
      setImgTooltip(null)
    }
    return (
      <div key={node.path} style={level > 0 ? { '--file-tree-stagger': ord } as React.CSSProperties : undefined}>
        <div
          className={`file-tree-node ${isError ? 'file-tree-node-error' : ''} ${level > 0 ? 'file-tree-node--sub' : ''} ${!node.isDir ? 'file-tree-node--leaf' : ''} ${ctxMenu?.path === node.path ? 'file-tree-node--pinned' : ''} ${!node.isDir && selectedFiles.has(node.path) ? 'file-tree-node--selected' : ''}`}
          style={{ paddingLeft: level * 16, '--file-tree-level': level } as React.CSSProperties}
          onClick={(e) => toggleExpand(node, e)}
          onContextMenu={onNodeContextMenu}
          onMouseDown={!node.isDir && !renamingHere ? (e) => {
            // 仅按下时启用 draggable，避免悬停时浏览器强制显示拓拽光标
            const el = e.currentTarget
            el.setAttribute('draggable', 'true')
            const cleanup = () => { el.removeAttribute('draggable'); document.removeEventListener('mouseup', cleanup) }
            document.addEventListener('mouseup', cleanup)
          } : undefined}
          onDragStart={!node.isDir && !renamingHere ? (e) => {
            // 多文件拖拽：若当前文件在多选中，拖动所有选中文件；否则只拖当前一个
            const paths = selectedFiles.has(node.path) && selectedFiles.size > 1
              ? Array.from(selectedFiles)
              : [node.path]
            const names = paths.map(p => p.replace(/\\/g, '/').split('/').pop() || p)
            e.dataTransfer.setData('application/x-agent-file-path', paths[0])
            e.dataTransfer.setData('application/x-agent-file-name', names[0])
            e.dataTransfer.setData('application/x-agent-files', JSON.stringify(paths.map((p, i) => ({ path: p, name: names[i] }))))
            e.dataTransfer.effectAllowed = 'copy'
          } : undefined}
          onDragEnd={!node.isDir ? (e) => {
            (e.currentTarget as HTMLElement).removeAttribute('draggable')
          } : undefined}
          onMouseEnter={onNodeMouseEnter}
          onMouseLeave={onNodeMouseLeave}
        >
          {level > 0 && <TreeGuides prefix={prefix} isLast={isLast} />}
          <span className="file-tree-arrow">
            {node.isDir ? (
              isLoading ? <LoaderIcon size={12} className="spin" /> : isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />
            ) : (
              <span style={{ width: 12, display: 'inline-block' }} />
            )}
          </span>
          <span className="file-tree-icon">
            {node.isDir
              ? (isExpanded
                  ? <FolderOpenIcon ref={el => { if (el) nodeIconRefs.current.set(node.path, el); else nodeIconRefs.current.delete(node.path) }} size={14} />
                  : <FolderIcon ref={el => { if (el) nodeIconRefs.current.set(node.path, el); else nodeIconRefs.current.delete(node.path) }} size={14} />)
              : (() => { const { Icon, color } = fileMeta(node.name); return <Icon ref={el => { if (el) nodeIconRefs.current.set(node.path, el); else nodeIconRefs.current.delete(node.path) }} size={14} style={{ color }} /> })()}
          </span>
          {renamingHere ? (
            <input
              ref={renameInputRef}
              className="file-tree-rename-input"
              value={renamingHere.text}
              spellCheck={false}
              onChange={e => setRenaming({ ...renamingHere, text: e.target.value })}
              onClick={e => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') { commitRename() }
                // Esc 取消：把当前「路径+文本」记为已结算，避免紧随其后的 blur 又把它提交
                if (e.key === 'Escape') { renameSettledRef.current = `${renamingHere.path}\u0000${renamingHere.text}`; setRenaming(null) }
              }}
            />
          ) : (
            <span className="file-tree-name">{node.name}</span>
          )}
          {!node.isDir && node.size != null && <span className="file-tree-size">{formatFileSize(node.size)}</span>}
          {isError && <AlertCircle size={12} className="file-tree-error-icon" />}
        </div>
        {isError && (
          <div className="file-tree-error-row" style={{ paddingLeft: (level + 1) * 16 }} onClick={() => toggleExpand(node)}>
            展开失败，点击重试
          </div>
        )}
        {/* 收起时整棵子树不挂载（而非留在 DOM 里靠 content-visibility 隐藏）：
            隐藏的子孙不参与样式计算，上一轮已播完的入场动画对象不会被取消，
            再展开时 animation-name 计算值没变 → 动画只播一次。新节点才必然新动画。
            退场得先播完才走到这一步，所以 closing 期间容器多挂 exitSpanMs(行数)，
            靠 --out 类切到退场动画：动画名不同 → 必然新建；卸载后再展开又是全新节点。 */}
        {node.isDir && (isExpanded || isClosing) && (
          <div
            className={`file-tree-children${isClosing ? ' file-tree-children--out' : ''}`}
            /* 行数交给 CSS：退场级联要按「倒数第几行」排（自下而上卷走，与容器高度
               从下沿收起的方向一致），只给每行正序号算不出倒数。 */
            style={{ '--file-tree-count': node.children?.length ?? 0 } as React.CSSProperties}
          >
            {node.children?.map((child, i, arr) => renderNode(
              child,
              level + 1,
              // 子级的祖先续线 = 本级续线 + 本行折角列是否续线。根（level 0）自身不画折角列，
              // 不能占一格，否则所有子级整体右移一列、根级分组线在行间断开。
              level > 0 ? [...prefix, !isLast] : prefix,
              i === arr.length - 1,
              i
            ))}
            {node.truncated && (
              <div className="file-tree-truncated" style={{ paddingLeft: (level + 1) * 16 }}>
                目录文件过多，仅显示前 {node.children?.length ?? 0} / {node.total} 个
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── 文件搜索/过滤：非空查询时用 listFlatFiles 拉平并按名称过滤，空查询回到树 ──
  const [query, setQuery] = useState('')
  // 双态折叠按钮：有展开的子目录时一键收起（仅保留根目录，第一层仍可见）；
  // 全收起后变为展开态，点击恢复收起前的目录层级快照；无快照时展开所有已加载目录
  const hasExpandedSubdirs = useMemo(() => {
    for (const p of expanded) if (p !== workspaceDir) return true
    return false
  }, [expanded, workspaceDir])
  const savedExpandRef = useRef<Set<string> | null>(null)
  const toggleAllDirs = useCallback(() => {
    if (hasExpandedSubdirs) {
      savedExpandRef.current = new Set(expandedRef.current)
      // 每个展开目录各自托挂退场；宽度 FLIP 由各 beginExit 的到点定时器负责。
      // 这里不调 markPanelWidth：容器仍挂着，宽度不变，量了就是空跑一段动画。
      const counts = new Map<string, number>()
      const walkCounts = (n: FileNode): void => {
        if (n.isDir) counts.set(n.path, n.children?.length ?? 0)
        n.children?.forEach(walkCounts)
      }
      if (tree) walkCounts(tree)
      Array.from(expandedRef.current).forEach(p => { if (p !== workspaceDir) beginExit(p, counts.get(p) ?? 0) })
      setExpanded(workspaceDir ? new Set([workspaceDir]) : new Set())
      return
    }
    markPanelWidth()
    const saved = savedExpandRef.current
    if (saved && saved.size > 1) {
      saved.forEach(p => cancelExit(p))
      setExpanded(new Set(saved))
      return
    }
    // 无快照：展开树中所有已加载的目录（未加载的需异步拉取，不在此自动触发）
    if (!tree) return
    const all = new Set<string>()
    const walk = (n: FileNode) => {
      if (!n.isDir) return
      if (n.loaded) all.add(n.path)
      n.children?.forEach(walk)
    }
    walk(tree)
    if (all.size) { all.forEach(p => cancelExit(p)); setExpanded(all) }
  }, [hasExpandedSubdirs, workspaceDir, tree, markPanelWidth, beginExit, cancelExit])
  const [flat, setFlat] = useState<{ name: string; path: string; relPath: string }[] | null>(null)
  const [flatLoading, setFlatLoading] = useState(false)
  const ensureFlat = useCallback(async () => {
    if (!workspaceDir) return
    setFlatLoading(true)
    try {
      const res = await window.api.listFlatFiles(workspaceDir, { maxDepth: 12, maxFiles: 3000 })
      setFlat(res.success && res.files ? res.files : [])
    } catch { setFlat([]) } finally { setFlatLoading(false) }
  }, [workspaceDir])
  useEffect(() => { setQuery(''); setFlat(null) }, [workspaceDir])
  useEffect(() => { if (query.trim() && flat === null && !flatLoading) void ensureFlat() }, [query, flat, flatLoading, ensureFlat])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !flat) return []
    return flat.filter(f => f.relPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)).slice(0, 300)
  }, [query, flat])

  return (
    <div className="file-tree" ref={rootElRef}>
      {tipNode}
      <div className="file-tree-header">
        <span className="file-tree-title">
          <FolderOpenIcon size={14} />
          <span className="file-tree-title-text">文件浏览器</span>
        </span>
      </div>
      {/* 目录名称行：右侧双态按钮——有展开子目录时一键收起，全收起后可展开恢复 */}
      <div className="file-tree-path">
        <span className="file-tree-path-text" {...tip(workspaceDir)}>{workspaceDir}</span>
        {workspaceDir && (
          <button
            className="file-tree-collapse-dirs"
            aria-label={hasExpandedSubdirs ? '收起所有展开的子目录' : '展开子目录（恢复上次层级）'}
            {...tip(hasExpandedSubdirs ? '收起所有展开的子目录' : '展开子目录（恢复上次层级）')}
            onClick={toggleAllDirs}
          >
            {hasExpandedSubdirs ? <ChevronsUpIcon size={12} /> : <ChevronsDownIcon size={12} />}
          </button>
        )}
      </div>
      {workspaceDir && (
        <div className="file-tree-search">
          <SearchIcon size={12} className="file-tree-search-icon" />
          <input
            className="file-tree-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件…"
            spellCheck={false}
          />
          {query && (
            <button className="file-tree-search-clear" onClick={() => setQuery('')}><XIcon size={11} /></button>
          )}
        </div>
      )}
      <div className="file-tree-content">
        {!workspaceDir ? (
          <div className="file-tree-empty">点击上方的文件夹图标选择目录</div>
        ) : query.trim() ? (
          flatLoading && flat === null ? (
            <div className="file-tree-loading">搜索中…</div>
          ) : results.length === 0 ? (
            <div className="file-tree-empty">无匹配文件</div>
          ) : (
            <div className="file-tree-nodes">
              {results.map(f => (
                <div className="file-tree-result" key={f.path}
                  onMouseEnter={(e) => { resultIconRefs.current.get(f.path)?.startAnimation?.(); showTip(f.relPath, e.currentTarget) }}
                  onMouseLeave={() => { resultIconRefs.current.get(f.path)?.stopAnimation?.(); hideTip() }}
                  onClick={() => onPreviewFile?.(f.path)}>
                  {(() => { const { Icon, color } = fileMeta(f.name); return <Icon ref={el => { if (el) resultIconRefs.current.set(f.path, el); else resultIconRefs.current.delete(f.path) }} size={14} style={{ color }} /> })()}
                  <span className="file-tree-result-name">{f.name}</span>
                  <span className="file-tree-result-dir">{f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : ''}</span>
                </div>
              ))}
            </div>
          )
        ) : tree ? (
          <div className="file-tree-nodes">{renderNode(tree, 0, [], true)}</div>
        ) : (
          <div className="file-tree-loading">加载中...</div>
        )}
      </div>
      {ctxMenu && (() => {
        // 视口边界修正：菜单超出右/下边界时向左/上翻转，避免溢出被裁切
        const MENU_W = 168
        // 每项约 30px（6px 上下内边距 + 12px 字号 + 2px 间距）；删除二次确认态只有提示 + 两个按钮
        const MENU_H = ctxMenu.confirmDel ? 80 : (ctxMenu.isDir ? 3 : 5) * 30 + 8
        const x = Math.min(ctxMenu.x, window.innerWidth - MENU_W - 8)
        const y = Math.min(ctxMenu.y, window.innerHeight - MENU_H - 8)
        return (
          <div
            ref={menuRef}
            className="file-tree-ctx-menu"
            style={{ left: Math.max(8, x), top: Math.max(8, y) }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {ctxMenu.confirmDel ? (
              <>
                <div className="file-tree-ctx-hint">删除「{ctxMenu.name}」？该操作不可恢复</div>
                <div className="file-tree-ctx-row">
                  <button className="file-tree-ctx-item file-tree-ctx-item--danger" onClick={() => { deleteFile(ctxMenu.path); setCtxMenu(null) }}>
                    <Trash2Icon size={13} /> 删除
                  </button>
                  <button className="file-tree-ctx-item" onClick={() => setCtxMenu({ ...ctxMenu, confirmDel: false })}>
                    <XIcon size={13} /> 取消
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* 目录节点不提供「发送到输入框/删除」：前者会把目录名发进输入框，后者不可恢复 */}
                {!ctxMenu.isDir && (
                  <button
                    className="file-tree-ctx-item"
                    onClick={() => { onSendFileName?.(ctxMenu.name); setCtxMenu(null) }}
                  >
                    <CornerDownLeftIcon size={13} />
                    发送到输入框
                  </button>
                )}
                <button
                  className="file-tree-ctx-item"
                  onClick={() => {
                    // 新的一次改名会话：清掉上次的结算标记
                    renameSettledRef.current = null
                    setRenaming({ path: ctxMenu.path, name: ctxMenu.name, text: ctxMenu.name })
                    setCtxMenu(null)
                  }}
                >
                  <PencilIcon size={13} />
                  {ctxMenu.isDir ? '重命名' : '重命名文件'}
                </button>
                {/* 两项都不给磁盘绝对路径：「复制路径」从工作目录的上一级起算（带项目文件夹名），
                    「复制相对路径」从工作目录本身起算 */}
                <button
                  className="file-tree-ctx-item"
                  onClick={() => { copyText(relativeTo(ctxMenu.path, parentDir(workspaceDir)), '已复制路径'); setCtxMenu(null) }}
                >
                  <CopyIcon size={13} />
                  复制路径
                </button>
                <button
                  className="file-tree-ctx-item"
                  onClick={() => { copyText(relativeTo(ctxMenu.path, workspaceDir), '已复制相对路径'); setCtxMenu(null) }}
                >
                  <CopyIcon size={13} />
                  复制文件名
                </button>
                {!ctxMenu.isDir && (
                  <button
                    className="file-tree-ctx-item file-tree-ctx-item--danger"
                    onClick={() => setCtxMenu({ ...ctxMenu, confirmDel: true })}
                  >
                    <Trash2Icon size={13} />
                    删除文件
                  </button>
                )}
              </>
            )}
          </div>
        )
      })()}
      {imgTooltip && (
        <div className="file-tree-img-tooltip" style={{ left: imgTooltip.x, top: imgTooltip.y }}>
          <img src={imgTooltip.dataUrl} alt="preview" />
        </div>
      )}
    </div>
  )
})
