// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentPreviewTabs —— 预览标签页与内容读取                             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 顶部的预览域（openTabs 起、到 closeTabMenu 止），
// 逻辑与注释均未改动。
//
// 自持：openTabs / activeTabPath / htmlViewMode / mdViewMode / htmlAnnotateActive /
//       htmlAnnotations / tabMenu / previewHighlightLine / previewEditing /
//       previewDraft 共 10 个 state，以及 htmlPreviewRef / tabMenuRef /
//       previewJumpRef / openTabsRef 四个 ref。
// 外部输入：仅 setRightPanelMode（打开文件时把右侧面板切回「文件」模式）。
// 对外输出：标签页数据与派生量（activeTab / isPreviewHtml / isPreviewMarkdown）、
//           打开与关闭标签的回调、HTML 预览构建（buildHtmlSrcDoc）、Markdown
//           本地图片内联、以及编辑态与右键菜单状态。
//
// 说明：HTML UI 注释的注入/开关/清空/删除回调与 iframe postMessage 推送 effect
// 已一并收进本 hook（它们只依赖本 hook 自持的 htmlPreviewRef / htmlAnnotateActive /
// htmlAnnotations）。仍留在 AgentCodeView 的只有 sendAnnotationsToAgent /
// sendHtmlAnnotations 两个「发消息」动作——它们依赖 handleSend，调用点必须在
// handleSend 之后。

import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import AGENT_ANNOTATE_SCRIPT from '../../../utils/agentAnnotateScript.js?raw'
import katexCssInline from 'katex/dist/katex.min.css?inline'
import katexJsInline from 'katex/dist/katex.min.js?raw'
import { notify } from '../../../store/notificationStore'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { CODE_EXT, MD_EXT, IMG_EXT } from '../utils/fileExt'
import { MEM_IMG_PREFIX } from '../utils/constants'
import { renderMathInHtml } from '../utils/mathHtml'
import { dirName, pathDir } from '../utils/paths'
import { extractTextFromBuffer, isBinaryDoc } from '../../../utils/extractText'
import type { PreviewTab } from '../types'
import type { UiAnnotation } from '../../AgentBrowser'
import type { PanelView, RightPanelMode } from './useAgentUiState'

const LEGACY_DOC_ERROR = '旧版 .doc 无法解析：请在 Word 里另存为 .docx 再预览'

/** base64 → 字节。优先用原生 Uint8Array.fromBase64（一次调用，解码在实现内部完成）；
 *  环境不支持或输入非法时，退回 atob + 逐字符 charCodeAt 循环（旧行为）。
 *  后者对 48MB 的 PDF 要跑 6400 万次，同步卡住主线程几百毫秒——而且这段在 await 之后的
 *  微任务里执行，仍会被算进触发它的那次 click 任务。 */
function decodeBase64Bytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (typeof native === 'function') {
    try { return native(b64) } catch { /* 非法输入，落到下面 */ }
  }
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function useAgentPreviewTabs({ setRightPanelMode, setTreeOpen, closePanel }: {
  setRightPanelMode: React.Dispatch<React.SetStateAction<RightPanelMode>>
  /** 打开文件时把右侧面板展开（通用模式默认收起，否则预览不可见） */
  setTreeOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 关掉最后一个文件标签时，「预览」那列工作区跟着关掉（最后一列则整块面板收起） */
  closePanel: (view: PanelView) => void
}) {
  const PREVIEW_MAX_BYTES = 128 * 1024
  // PDF / DOCX 要在渲染进程整体解码，给原始体积留个上限（base64 约 4/3 倍 → 约 48MB 文件）
  const BINARY_DOC_MAX_B64 = 64 * 1024 * 1024
  // PreviewTab 类型已抽至 agent-code/types
  const [openTabs, setOpenTabs] = useState<PreviewTab[]>([])
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  // HTML 预览模式：'preview' 渲染成网页（沙箱 iframe，允许脚本），'source' 按源码逐行显示。
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('preview')
  // Markdown 预览模式：'preview' 渲染成排版后的文档，'source' 按源码（Monaco）逐行显示。
  const [mdViewMode, setMdViewMode] = useState<'preview' | 'source'>('preview')
  // HTML 预览 iframe 的 UI 注释（复用 agentAnnotateScript，同源注入）：激活态 + 注释列表
  const [htmlAnnotateActive, setHtmlAnnotateActive] = useState(false)
  const [htmlAnnotations, setHtmlAnnotations] = useState<UiAnnotation[]>([])
  const htmlPreviewRef = useRef<HTMLIFrameElement | null>(null)
  // 预览标签右键菜单：{x,y} 屏幕坐标 + 目标标签 path
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  // 点击 diff 行 → 打开源文件并跳到对应行：记录待跳转目标（内容渲染完成后由 effect 滚动+高亮）。
  const previewJumpRef = useRef<{ path: string; line: number } | null>(null)
  const [previewHighlightLine, setPreviewHighlightLine] = useState<number | null>(null)
  // 性能优化：避免删除项目/切换会话时重复触发 codemap 构建与工作区同步


  const [previewEditing, setPreviewEditing] = useState(false)
  const [previewDraft, setPreviewDraft] = useState<string | null>(null)
  // 切 tab / 关闭 tab 时退出编辑态
  useEffect(() => { setPreviewEditing(false); setPreviewDraft(null) }, [activeTabPath])
  const openTabsRef = useRef<PreviewTab[]>([])
  useEffect(() => { openTabsRef.current = openTabs }, [openTabs])
  const activeTab = openTabs.find(t => t.path === activeTabPath) || null
  // 保存源码预览：写回文件并同步 openTabs 内容，退出编辑态
  const savePreviewFile = useCallback(async (content: string) => {
    const tab = openTabsRef.current.find(t => t.path === activeTabPath) || null
    // 哨兵标签（Git 变更面板 / 内存图片）背后没有文件可写
    if (!tab || tab.path.startsWith('pi-undo:') || tab.path.startsWith(MEM_IMG_PREFIX)) {
      notify('当前标签不支持保存', 'error'); return
    }
    // 二进制文档的 content 是抽取出的文本而非文件本体，写回等于用一段文本盖掉整个 PDF/DOCX。
    // 编辑按钮已按 isBinaryDoc 隐藏，这里兜住 Monaco 的 Ctrl+S 那条路。
    if (tab.isBinaryDoc) { notify('PDF / DOCX 预览的是抽取文本，不能写回原文件', 'error'); return }
    try {
      const res = await window.api.writeFile(tab.path, content)
      if (!res.success) { notify('保存失败：' + (res.error || '未知错误'), 'error'); return }
      setOpenTabs(prev => prev.map(t => t.path === tab.path ? { ...t, content } : t))
      setPreviewDraft(null)
      setPreviewEditing(false)
      notify(`已保存 ${tab.name}`, 'success')
    } catch (e: any) {
      notify('保存失败：' + (e?.message || '未知错误'), 'error')
    }
  }, [activeTabPath, setOpenTabs])
  const isPreviewMarkdown = useMemo(() => {
    const p = activeTabPath || ''
    const extMatch = /\.([a-z0-9]+)$/i.exec(p)
    const ext = extMatch ? extMatch[1].toLowerCase() : ''
    if (MD_EXT.has(ext)) return true
    if (CODE_EXT.has(ext)) return false
    const c = activeTab?.content
    if (c && /(^|\n)\s*(<[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?>|#{1,6}\s|>\s|[-*+]\s+\S|\d+\.\s+\S|```|!?\[|\[.+\]\(|\|[^\n]*\|)/.test(c.slice(0, 3000))) {
      return true
    }

    const base = dirName(p).toLowerCase()
    return /^(readme|changelog|license|licence|contributing|notice|authors|code_of_conduct|security|todo|notes?)$/.test(base)
  }, [activeTabPath, activeTab?.content])

  // 是否为 HTML 文件（可切换“渲染预览 / 源码”）。
  const isPreviewHtml = useMemo(() => {
    const ext = (/\.([a-z0-9]+)$/i.exec(activeTabPath || '')?.[1] || '').toLowerCase()
    return ext === 'html' || ext === 'htm'
  }, [activeTabPath])

  // 源码预览逐行高亮 HTML（整文高亮一次后拆行，随内容/路径变化重算）。
  // 源码预览行高亮由 MonacoEditor 的 deltaDecorations 完成（highlightLine prop）  // 供 HTML 预览 iframe 注入的 KaTeX CSS：把字体 url() 改写为基于应用自身源的
  // 绝对 URL（iframe 与应用同源，直接加载无 CORS 问题）。若原样内联，字体根路径
  // （开发期如 /@fs/…）会被 iframe 里的 <base> 解析成相对预览目录的路径，加载不到。
  const katexCssForIframe = useMemo(() => katexCssInline.replace(/url\((['"]?)([^'")]+)\1\)/g, (m: string, _q: string, u: string) => {
    if (/^(data:|https?:|file:)/i.test(u)) return m
    try { return `url("${new URL(u, window.location.href).href}")` } catch { return m }
  }), [])

  // 构造 iframe 的 srcDoc：注入 <base> 使相对路径（css/js/图片）能相对文件所在目录解析。
  // base 走自定义协议 app://（主进程 protocol.handle 提供），不用 file://——about:srcdoc 的
  // iframe 加载 file:// 会被 Chromium 直接拦掉（Not allowed to load local resource）。
  const buildHtmlSrcDoc = (content: string, filePath: string): string => {
    const dir = filePath.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')
    // 逐段编码（空格 / 中文等），但把 Windows 盘符的冒号还原：E: 不能变成 E%3A
    const encodedDir = dir.replace(/^\/+/, '').split('/').map(s => encodeURIComponent(s)).join('/').replace(/%3A/g, ':')
    const baseTag = `<base href="app://local/${encodedDir}/">`
    // 注入本地 KaTeX CSS + JS，避免依赖 CDN。同时预渲染 $/$$ 公式。
    const katexInject = `<style>${katexCssForIframe}</style><script>${katexJsInline}<\/script>`
    // 剥离预览 HTML 自带的 KaTeX CDN 引用（样式/脚本）：本地 KaTeX 已注入，
    // CDN 版既冗余又会被继承自应用的 CSP 拦截报错，且离线不可用。
    const rendered = renderMathInHtml(content)
      .replace(/<link[^>]*href=["'][^"']*katex[^"']*["'][^>]*>/gi, '')
      .replace(/<script[^>]*src=["'][^"']*katex[^"']*["'][^>]*>\s*<\/script>/gi, '')
    if (/<head[^>]*>/i.test(rendered)) return rendered.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${katexInject}`)
    if (/<html[^>]*>/i.test(rendered)) return rendered.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}${katexInject}</head>`)
    return `<head>${baseTag}${katexInject}</head>` + rendered
  }

  // 预览 iframe 的 srcDoc：里面要内联整套 KaTeX（CSS + JS 约 300KB），还要逐条渲染公式，
  // 构建一次并不便宜。此前是在 JSX 里直接调用 buildHtmlSrcDoc，于是**任何一次重渲染**
  // （切标签、开注释面板、父级任何 state 变化）都会重跑一遍，点击处理器里同步跑出上千毫秒。
  // 两层处理：
  //   ① useMemo 按「内容 + 路径」记忆化——重渲染不再重算；
  //   ② useDeferredValue 把首次构建挪到低优先级渲染——点击处理器立刻返回，不再触发长任务告警。
  const srcDocInput = useMemo(
    () => ({ content: activeTab?.content ?? '', path: activeTabPath ?? '' }),
    [activeTab?.content, activeTabPath],
  )
  const deferredSrcDocInput = useDeferredValue(srcDocInput)
  const htmlPreviewSrcDoc = useMemo(
    () => (isPreviewHtml ? buildHtmlSrcDoc(deferredSrcDocInput.content, deferredSrcDocInput.path) : ''),
    [isPreviewHtml, deferredSrcDocInput],
  )

  const inlineLocalImages = useCallback(async (markdown: string, baseFilePath: string): Promise<string> => {
    const dir = pathDir(baseFilePath)

    type Match = { type: 'md'; full: string; alt: string; url: string } | { type: 'html'; full: string; src: string; url: string }

    const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
    const htmlImgRe = /<img\b([^>]*)>/gi
    const matches: Match[] = []

    let m: RegExpExecArray | null
    while ((m = mdImgRe.exec(markdown)) !== null) {
      const url = m[2]!.trim()
      if (/^(https?:|data:|file:\/\/|\/)/.test(url)) continue
      matches.push({ type: 'md', full: m[0], alt: m[1]!, url })
    }
    while ((m = htmlImgRe.exec(markdown)) !== null) {
      const attrs = m[1]!
      const srcM = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      const url = srcM ? (srcM[2] ?? srcM[3] ?? srcM[4] ?? '') : ''
      if (!url || /^(https?:|data:|file:\/\/|\/)/.test(url)) continue
      matches.push({ type: 'html', full: m[0], src: url, url })
    }

    if (matches.length === 0) return markdown

    const replaced = await Promise.all(matches.map(async (match) => {
      const abs = (dir + '/' + match.url).replace(/\\/g, '/').replace(/\/+/g, '/')
      const r = await window.api.readFileBase64(abs)
      return { ...match, dataUrl: r.success ? r.dataUrl : null }
    }))

    let out = markdown
    for (const item of replaced) {
      if (!item.dataUrl) continue
      if (item.type === 'md') {
        out = out.split(item.full).join(`![${item.alt}](${item.dataUrl})`)
      } else {
        // 替换 HTML <img> 标签中的 src 属性（支持双引号和单引号）
        const newTag = item.full.replace(/\bsrc\s*=\s*(['"])([^'"]*)\1/i, `src=$1${item.dataUrl}$1`)
        out = out.split(item.full).join(newTag)
      }
    }
    return out
  }, [])

  const openPreview = useCallback(async (path: string, panelMode: PanelView = 'files') => {
    const name = dirName(path)
    const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase()
    const isImage = IMG_EXT.has(ext)
    // PDF 走版面渲染（pdf.js 画页面）；DOCX 只有文本抽取一条路。两者都不能当文本读：
    // 主进程 readFile 的 25k token 预算守卫会把二进制残骸估成「内容过多…请使用 Grep」，
    // 那是给 agent 工具看的建议语，对预览毫无意义（src/main/ipc.ts 的 MAX_READ_TOKENS）。
    const isPdf = !isImage && /\.pdf$/i.test(name)
    const binaryDoc = !isImage && !isPdf && isBinaryDoc(name)
    // .doc（2003 的老二进制格式）全仓没有解析器（mammoth 只认 .docx），当文本读只会得到
    // 一屏乱码。判定并进建标签这一次 setState：否则先亮一帧「读取中…」再跳错误。
    const legacyDoc = !isImage && !isPdf && !binaryDoc && ext === 'doc'
    // 切到该文件所属的面板工作区（默认文件树那列；输入框附件走独立预览列），并把右侧
    // 面板展开——通用模式的右槽默认收起（没有文件树），不主动展开的话「打开文件」看起来毫无反应。
    setRightPanelMode(panelMode)
    setTreeOpen(true)
    // 已打开则仅切换到该标签，不重复读取
    setOpenTabs(prev => {
      if (prev.some(t => t.path === path)) return prev
      return [...prev, { path, name, content: null, lines: null, truncated: false, loading: !legacyDoc, error: legacyDoc ? LEGACY_DOC_ERROR : null, isImage, imageDataUrl: null, isBinaryDoc: isPdf || binaryDoc, isPdf, pdfData: null }]
    })
    setActiveTabPath(path)
    if (legacyDoc) return
    // 图片：读为 data URL 直接渲染 <img>，不当文本读（二进制会被拒）
    if (isImage) {
      const r = await window.api.readFileBase64(path)
      setOpenTabs(prev => prev.map(t => t.path === path ? {
        ...t, loading: false, isImage: true,
        error: r.success ? null : (r.error || '读取失败'),
        imageDataUrl: r.success ? (r.dataUrl ?? null) : null,
      } : t))
      return
    }
    if (isPdf || binaryDoc) {
      const r = await window.api.readFileBase64(path)
      const base64 = r.dataUrl?.split(',')[1] ?? ''
      if (!r.success || !base64) {
        setOpenTabs(prev => prev.map(t => t.path === path ? { ...t, loading: false, error: r.error || '读取失败' } : t))
        return
      }
      // read-file-base64 没有体积上限，而版面渲染要把整个 PDF 待在内存里解码：
      // 超过约 48MB（base64 后 64M 字符）直接拒，免得主进程 readFileSync 与解码一起把界面冻住
      if (base64.length > BINARY_DOC_MAX_B64) {
        setOpenTabs(prev => prev.map(t => t.path === path ? { ...t, loading: false, error: '文件过大（超过约 48MB），预览里不解码' } : t))
        return
      }
      const bytes = decodeBase64Bytes(base64)
      // PDF：字节交给 PdfViewer 逐页画 canvas（它自己会复制一份再交给 pdf.js）
      if (isPdf) {
        setOpenTabs(prev => prev.map(t => t.path === path ? { ...t, loading: false, pdfData: bytes } : t))
        return
      }
      // DOCX：抽取纯文本，只读展示
      const text = await extractTextFromBuffer(name, bytes.buffer as ArrayBuffer)
      setOpenTabs(prev => prev.map(t => t.path === path ? {
        ...t,
        loading: false,
        // 抽不出任何文本时给一句能看懂的话，别把解析库的异常抛给人看
        content: text || null,
        error: text ? null : '未能抽取到文本：文档可能是扫描件或图片型页面',
        lines: text ? text.split('\n').length : null,
      } : t))
      return
    }
    const res = await window.api.readFile(path, { maxBytes: PREVIEW_MAX_BYTES, raw: true })
    let content = res.success ? (res.content || '') : null
    // 仅对疑似 Markdown 的内容内联本地图片（避免代码文件被无意义扫描）。
    if (content && /(^|\n)\s*(<[a-zA-Z]|#{1,6}\s|>\s|!\[|\[.+\]|```|[-*+]\s+\S)/.test(content.slice(0, 3000))) {
      try { content = await inlineLocalImages(content, path) } catch { /* 内联失败不影响文本预览 */ }
    }
    setOpenTabs(prev => prev.map(t => t.path === path ? {
      ...t,
      loading: false,
      error: res.success ? null : (res.error || '读取失败'),
      content,
      lines: res.success ? (res.lines ?? 0) : null,
      truncated: !!res.truncated,
    } : t))
  }, [inlineLocalImages])

  // 内存图片：没有磁盘路径的图（剪贴板粘贴、从浏览器 / 看图软件拖入）也走右侧预览面板。
  // 图片数据本来就在 dataUrl 里，直接建一个装好图的标签，不需要任何磁盘读取。
  // 标签键用 MEM_IMG_PREFIX + 文件名（真实路径不可能长这样，不会撞车）；同名再点不新开标签——
  // 同一张就不动，换了一张（同名不同图）就把图刷新掉，免得开出一排同名标签。
  const openMemoryImage = useCallback((name: string, dataUrl: string, panelMode: PanelView = 'preview') => {
    const key = MEM_IMG_PREFIX + name
    setRightPanelMode(panelMode)
    setTreeOpen(true)
    setOpenTabs(prev => {
      const hit = prev.find(t => t.path === key)
      if (hit) {
        return hit.imageDataUrl === dataUrl ? prev
          : prev.map(t => t.path === key ? { ...t, imageDataUrl: dataUrl, loading: false, error: null } : t)
      }
      return [...prev, {
        path: key, name, content: null, lines: null, truncated: false,
        loading: false, error: null, isImage: true, imageDataUrl: dataUrl,
        isBinaryDoc: false, isPdf: false, pdfData: null,
      }]
    })
    setActiveTabPath(key)
  }, [])

  const closeTab = useCallback((path: string) => {
    const next = openTabsRef.current.filter(t => t.path !== path)
    setOpenTabs(next)
    setActiveTabPath(cur => {
      if (cur !== path) return cur
      return next.length ? next[next.length - 1].path : null
    })
    // 最后一个标签关了，「预览」这一列就没内容可看了：跟着收掉，
    // 留着一块空面板既占宽又要点两次才关干净
    if (next.length === 0) closePanel('preview')
  }, [closePanel])

  // 关闭其他 / 关闭全部标签（右键菜单用）
  const closeOtherTabs = useCallback((path: string) => {
    setOpenTabs(openTabsRef.current.filter(t => t.path === path))
    setActiveTabPath(path)
  }, [])
  const closeAllTabs = useCallback(() => {
    setOpenTabs([])
    setActiveTabPath(null)
    closePanel('preview')
  }, [closePanel])
  // 右键菜单：点菜单外 / Esc 关闭
  const closeTabMenu = useCallback(() => setTabMenu(null), [setTabMenu])
  usePopoverDismiss(!!tabMenu, closeTabMenu, undefined, undefined, tabMenuRef)

  // ── HTML 预览 iframe 的 UI 注释（同源 iframe：直接读写 contentWindow）──
  // iframe 每次 srcDoc 变化都会重载，onLoad 时重新注入脚本（脚本自带防重复保护）
  // 性能排查开关：false 时 HTML 预览不注入注释脚本（整个注释功能关闭）。
  // 用于对比「注释功能是否导致预览卡顿」——改完保存（dev 热更新）拖拽测试即可。
  const HTML_ANNOTATE_ENABLED = true
  const injectHtmlAnnotate = useCallback(() => {
    if (!HTML_ANNOTATE_ENABLED) return
    const win = htmlPreviewRef.current?.contentWindow as (Window & { __agentAnnotate?: any }) | null
    if (!win) return
    // 注入 <script> 而不是 win.eval：CSP 的 script-src 已不含 'unsafe-eval'（见 renderer/index.html），
    // eval 会被拦掉；内联脚本则由 'unsafe-inline' 放行，效果一致（脚本自带防重复注入保护）。
    try {
      const doc = win.document
      const s = doc.createElement('script')
      s.textContent = AGENT_ANNOTATE_SCRIPT
      const parent = doc.head || doc.documentElement
      parent.appendChild(s)
    } catch { }
  }, [])

  const toggleHtmlAnnotate = useCallback(() => {
    const win = htmlPreviewRef.current?.contentWindow as (Window & { __agentAnnotate?: any }) | null
    try { win?.__agentAnnotate?.toggle() } catch { }
  }, [])

  const clearHtmlAnnotations = useCallback(() => {
    setHtmlAnnotations([])
    const win = htmlPreviewRef.current?.contentWindow as (Window & { __agentAnnotate?: any }) | null
    try { win?.__agentAnnotate?.clear() } catch { }
  }, [])

  const removeHtmlAnnotation = useCallback((id: string) => {
    setHtmlAnnotations(prev => prev.filter(a => a.id !== id))
    const win = htmlPreviewRef.current?.contentWindow as (Window & { __agentAnnotate?: any }) | null
    try { win?.__agentAnnotate?.removeById(id) } catch { }
  }, [])

  // HTML 预览 iframe 的注释状态：同源 iframe 用 postMessage 事件驱动推送
  // （脚本 sync() 时发送），无需轮询——拖拽预览宽度时零跨进程开销。
  // 内容比较后才 setState，避免无谓的整组件重渲染。
  useEffect(() => {
    if (!HTML_ANNOTATE_ENABLED || !isPreviewHtml || htmlViewMode !== 'preview') return
    const onMsg = (e: MessageEvent) => {
      if (!e.data || e.data.source !== 'agent-annotate') return
      const snap = e.data.data
      if (!snap) return
      // 这两次 setState 会让 AgentCodeView 整棵工作台重渲染，而 React 18 的自动批处理在
      // 微任务里刷新 —— 仍算在这个 message 任务头上，就是「'message' handler took 178ms」的来源。
      // 放进 startTransition：渲染变成可中断的低优先级任务，handler 立刻返回；注释是辅助信息，
      // 晚一帧显示没有影响（拖拽预览宽度、开关注释面板都不受影响）。
      startTransition(() => {
        setHtmlAnnotateActive(prev => prev === !!snap.active ? prev : !!snap.active)
        setHtmlAnnotations(prev => {
          const next = snap.annotations || []
          if (prev.length === next.length && prev.every((a, i) => a.id === next[i].id && a.note === next[i].note && a.kind === next[i].kind)) return prev
          return next
        })
      })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [isPreviewHtml, htmlViewMode])

  // 打开源文件并跳转到指定行（供 Git diff 行点击使用）。
  // openPreview 完成后由 useAgentViewEffects 的跳行 effect 滚动 + 短暂高亮。
  const openPreviewAtLine = useCallback(async (absPath: string, line: number) => {
    setPreviewHighlightLine(null)
    previewJumpRef.current = { path: absPath, line }
    await openPreview(absPath)
  }, [openPreview])

  // 打开文件的通用回调（可选跳转到指定行）：Git 变更面板与工具卡（Read 文件名跳读取起始行）共用。
  // 用 useCallback 固定引用——此前内联箭头每次渲染新建，击穿 AgentGitDiff 内部文件块的 memo，
  // 导致点一次按钮就对全部 diff 行重跑高亮计算。
  const openFileAtLine = useCallback((abs: string, line?: number) => {
    if (line != null) void openPreviewAtLine(abs, line)
    else void openPreview(abs)
  }, [openPreviewAtLine, openPreview])

  return {
    openTabs, setOpenTabs, activeTab, activeTabPath, setActiveTabPath,
    htmlViewMode, setHtmlViewMode, mdViewMode, setMdViewMode,
    htmlAnnotateActive, setHtmlAnnotateActive, htmlAnnotations, setHtmlAnnotations,
    injectHtmlAnnotate, toggleHtmlAnnotate, clearHtmlAnnotations, removeHtmlAnnotation,
    htmlPreviewRef, tabMenu, setTabMenu, tabMenuRef, previewJumpRef,
    previewHighlightLine, setPreviewHighlightLine,
    previewEditing, setPreviewEditing, previewDraft, setPreviewDraft,
    isPreviewHtml, isPreviewMarkdown, htmlPreviewSrcDoc, inlineLocalImages,
    openPreview, openPreviewAtLine, openFileAtLine, openMemoryImage,
    savePreviewFile, closeTab, closeOtherTabs, closeAllTabs, closeTabMenu,
  }
}
