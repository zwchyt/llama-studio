// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentInput —— 输入框核心 + 附件/引用/代码片段/选区浮层               ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的整个输入域，逻辑与注释均未改动。
//
// 自持：
//   · 输入核心：input / packedInput 两个 state，textareaRef / inputOverflowRef /
//     inputHistoryRef / historyIdxRef 四个 ref；
//   · 附件与文件选择器：attachedFiles / filePickerOpen 两个 state（弹窗左侧「已选」列表由
//     attachedFiles 派生，不另存一份），fileInputRef；含 readAttachmentFile / handleAttachmentSelect /
//     removeAttachment / handleFilePickerAttach / handleInputDragOver / handleInputDrop /
//     handleFilePickerRemove / toggleFilePicker；
//   · 引用胶囊与代码片段：refChips / codeSnippets 两个 state；
//   · 选区浮层：selectionPopover / previewSelPopover 两个 state，previewSelRef /
//     selectionPopoverRef / previewDragStartLineRef 三个 ref。
// 外部输入：draftScope（输入草稿的隔离作用域）与 attachScope（附件的隔离作用域，
// 传当前项目 id）——其余回调只依赖上面这些自持值。
//
// 注意：addCodeSnippet 未搬入本 hook（它依赖预览域的 activeTab / activeTabPath，
// 而预览域的 useAgentPreviewTabs 在本 hook 之后调用）。它留在 AgentCodeView 中，
// 通过本 hook 返回的 setCodeSnippets / setPreviewSelPopover 操作状态。
// 对外输出：输入核心（input / packedInput / textareaRef / autoResize /
//           insertAtCursor / replaceRange / recallHistory …）、附件与引用胶囊、
//           代码片段、文件选择器、以及两个选区浮层的状态与回调。
//
// 说明：这些成员原先分散在主文件的 6 处（input 声明处 / packedInput 声明处 /
// filePickerOpen 声明处 / 选区浮层声明处 / replaceRange 与 recallHistory 附近 /
// 附件与文件选择器一段）。已验证各段在「本 hook 调用点 ~ 原声明处」区间内均无引用，
// 因此可整体前移到调用点一次性收口。

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { INPUT_FOLD_CAP } from '../utils/constants'
import { previewLineNoFromTarget, selectionMarkdown, selectionTextWithMath } from '../utils/dom'
import { uniqueId } from '../utils/ids'
import { binaryDocLabel, extractTextFromBuffer, extractTextFromFile, isBinaryDoc } from '../../../utils/extractText'
import type { CodeSnippet } from '../types'

// PDF/docx 抽出的正文没有文件名上下文，标出来源；解析失败也要留一行，免得模型收到空附件却无人报错
function wrapBinaryDocText(name: string, text: string): string {
  const label = binaryDocLabel(name)
  return text ? `[${label}: ${name}]\n${text}` : `[${label}: ${name}]（文本提取失败）`
}

// 只看文件名判图片：拖拽与工作区选择只拿得到路径/名字，没有 File.type 可用
const IMAGE_NAME_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i
function isImageName(name: string): boolean { return IMAGE_NAME_RE.test(name) }

// 输入托盘里的一颗待发送附件。
// 图片不再带「正文行内记号」：图片胶囊自成一整行排在正文上方，正文里不留任何占位文字。
type DraftAttachment = {
  id: string; name: string; isImage: boolean; dataUrl?: string; content?: string; path?: string
}

export function useAgentInput({ draftScope = 'default', attachScope = 'default' }: { draftScope?: string; attachScope?: string } = {}) {

  const [input, setInput] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)

  const [packedInput, setPackedInput] = useState<string | null>(null)

  // ── 输入草稿按作用域隔离（当前传入的是工作区模式：通用 / 编码）──
  // 切模式时把当前草稿（含已折叠成胶囊的长文本）存回原作用域，再恢复目标作用域的草稿。
  // 用 layout effect 而不是 useEffect：在同一帧内完成切换，不会先画出旧文本再替换。
  // scopeRef 记录上一个作用域，effect 因 input 变化重跑时（每次敲字）会立刻早退。
  const draftsRef = useRef<Record<string, { text: string; packed: string | null }>>({})
  const scopeRef = useRef(draftScope)
  useLayoutEffect(() => {
    const prev = scopeRef.current
    if (prev === draftScope) return
    scopeRef.current = draftScope
    draftsRef.current[prev] = { text: input, packed: packedInput }
    const next = draftsRef.current[draftScope]
    setInput(next?.text ?? '')
    setPackedInput(next?.packed ?? null)
  }, [draftScope, input, packedInput])

  const inputOverflowRef = useRef(false)
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, INPUT_FOLD_CAP) + 'px'
    inputOverflowRef.current = el.scrollHeight > INPUT_FOLD_CAP + 1
  }, [])

  // 高度重测 + 自动打包（useLayoutEffect 是防闪烁的关键）：必须在 DOM 更新后、
  // 浏览器绘制前同步完成测量与打包——若放 useEffect，粘贴的长文本会先被画出来
  // 一帧再收进 chip，出现「文本闪一下变胶囊」的过渡；layout 阶段完成的 setState
  // 会在同一帧内同步重渲染，用户只看得到最终态（空框 + chip），没有任何中间画面。
  useLayoutEffect(() => {
    autoResize()
    if (input && inputOverflowRef.current) {
      setPackedInput(prev => (prev ? `${prev}\n\n` : '') + input)
      setInput('')
    }
  }, [autoResize, input])

  // 把文本插入到输入框光标处（追加/插入文本，不触发发送）
  // 用于文件浏览器右键「发送到输入框」：插入文件名到当前光标位置
  const insertAtCursor = useCallback((text: string) => {
    const el = textareaRef.current
    if (!el) {
      setInput(prev => prev ? `${prev}\n${text}` : text)
      autoResize()
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    setInput(next)
    // 还原光标到插入文本之后，并聚焦输入框
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
      autoResize()
    })
  }, [autoResize])

  const replaceRange = useCallback((start: number, end: number, text: string) => {
    const el = textareaRef.current
    if (!el) {
      setInput(prev => prev.slice(0, start) + text + prev.slice(end))
      return
    }
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    setInput(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
      autoResize()
    })
  }, [autoResize])

  const recallHistory = useCallback((dir: number) => {
    const hist = inputHistoryRef.current
    if (hist.length === 0) return
    let idx = historyIdxRef.current
    if (idx === -1) idx = hist.length - 1
    else idx = idx + dir
    if (idx < 0) idx = 0
    if (idx >= hist.length) { historyIdxRef.current = -1; setInput(''); autoResize(); return }
    historyIdxRef.current = idx
    setInput(hist[idx]!)
    autoResize()
  }, [autoResize])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [attachedFiles, setAttachedFiles] = useState<DraftAttachment[]>([])
  // removeAttachment 要按 id 找回它的行内标记，而回调闭包里读不到最新 state
  const attachedFilesRef = useRef<DraftAttachment[]>([])
  attachedFilesRef.current = attachedFiles
  // 「引用」引用块：以胶囊（图标 + 缩写）形式内嵌在输入框内，
  // 发送时作为引用块（> …）拼入正文。
  const [refChips, setRefChips] = useState<Array<{ id: string; text: string }>>([])
  // 代码片段胶囊：从源码预览中选中代码后引用，发送时以 fenced code block 注入正文。
  // CodeSnippet 类型已抽至 agent-code/types
  const [codeSnippets, setCodeSnippets] = useState<CodeSnippet[]>([])
  const [filePickerOpen, setFilePickerOpen] = useState(false)

  // ── 附件按项目隔离 ──
  // 与输入草稿同一套做法：切作用域时把当前附件存回原项目，再恢复该项目的草稿附件，
  // 不沿用上一个项目选的文件。用 layout effect，与项目切换同帧完成，不会先画出旧胶囊。
  const attachDraftsRef = useRef<Record<string, DraftAttachment[]>>({})
  const attachScopeRef = useRef(attachScope)
  useLayoutEffect(() => {
    const prev = attachScopeRef.current
    if (prev === attachScope) return
    attachScopeRef.current = attachScope
    attachDraftsRef.current[prev] = attachedFiles
    setAttachedFiles(attachDraftsRef.current[attachScope] ?? [])
    // 面板浏览的是上一个项目的目录，切项目后不该继续开着
    setFilePickerOpen(false)
  }, [attachScope, attachedFiles])

  // 弹窗左侧「已选」列表由附件派生：另存一份会与托盘走偏（取消胶囊后列表仍留着）
  const filePickerAttached = useMemo(
    () => attachedFiles
      .filter((a): a is DraftAttachment & { path: string } => !!a.path)
      .map(a => ({ id: a.id, path: a.path, name: a.name, isDir: false })),
    [attachedFiles]
  )

  // 选中「模型输出」文字后浮现的操作条（引用 / 复制 / 追问）。
  // text=选中的排版文本（复制用），md=同一选区还原出的 Markdown 源（引用用），
  // x/y=选区外接矩形的视口坐标（用 position:fixed 定位）。
  const [selectionPopover, setSelectionPopover] = useState<{ text: string; md: string; x: number; y: number } | null>(null)
  // 源码预览选区浮动按钮：选中代码后弹出「引用代码」按钮。
  const [previewSelPopover, setPreviewSelPopover] = useState<{ x: number; y: number; startLine: number; endLine: number; text: string } | null>(null)
  const previewSelRef = useRef<HTMLDivElement>(null)
  const selectionPopoverRef = useRef<HTMLDivElement>(null)

  // ── 模型输出文字选区 → 浮动操作条 ──
  // 关闭操作条并清除当前选区（避免残留高亮）。
  const closeSelectionPopover = useCallback(() => {
    setSelectionPopover(null)
    try { window.getSelection()?.removeAllRanges() } catch { /* ignore */ }
  }, [])

  // 新增一个引用块胶囊。
  const addRefChip = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    setRefChips(prev => [...prev, { id: uniqueId('ref'), text: t }])
  }, [])

  // 移除胶囊。
  const removeRefChip = useCallback((id: string) => {
    setRefChips(prev => prev.filter(c => c.id !== id))
  }, [])

  // 复制所选内容到剪贴板。
  const copySelection = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify('已复制所选内容', 'success') }
    catch { notify('复制失败', 'error') }
    closeSelectionPopover()
  }, [closeSelectionPopover])

  // 引用：把选中内容作为引用胶囊添到输入框。
  const quoteSelection = useCallback((text: string) => {
    addRefChip(text)
    closeSelectionPopover()
  }, [addRefChip, closeSelectionPopover])


  const removeCodeSnippet = useCallback((id: string) => {
    setCodeSnippets(prev => prev.filter(s => s.id !== id))
  }, [])

  // ── 源码预览拖选：指针行意图 ──
  // 行号槽 user-select:none，拖选终点落在行号列时文本选区会被吸附到该行
  // 内容开头（零字符命中），仅看字符选区会丢掉用户指针实际扫到的末行。
  // 因此额外记录 mousedown/mouseup 指针所在行，最终范围取字符选区与指针行的并集。
  const previewDragStartLineRef = useRef<number | null>(null)
  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    previewDragStartLineRef.current = previewLineNoFromTarget(e.target)
  }, [])

  // 源码预览 mouseup：检测选区是否在预览代码容器内，提取行号并弹出浮动按钮
  const handlePreviewMouseUp = useCallback((e: React.MouseEvent) => {
    // 先于 rAF 读取指针落点所在行（含行号槽）
    const pointerUpLine = previewLineNoFromTarget(e.target)
    const pointerDownLine = previewDragStartLineRef.current
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPreviewSelPopover(null); return }
      const text = sel.toString()
      if (!text.trim()) { setPreviewSelPopover(null); return }
      const anchor = sel.anchorNode
      const focus = sel.focusNode
      const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement
      const focusEl = focus instanceof Element ? focus : focus?.parentElement
      // 必须在源码预览容器内
      const codeContainer = anchorEl?.closest('.agent-code-preview-code')
      if (!codeContainer || !focusEl?.closest('.agent-code-preview-code')) { setPreviewSelPopover(null); return }
      // 提取行号：从 id="agent-preview-line-N" 中解析
      const anchorLine = anchorEl?.closest('.agent-code-preview-line')
      const focusLine = focusEl?.closest('.agent-code-preview-line')
      if (!anchorLine || !focusLine) { setPreviewSelPopover(null); return }
      const getLineNo = (el: Element): number => {
        const id = el.id || ''
        const m = /agent-preview-line-(\d+)/.exec(id)
        return m ? Number(m[1]) : 0
      }
      const l1 = getLineNo(anchorLine)
      const l2 = getLineNo(focusLine)
      if (!l1 || !l2) { setPreviewSelPopover(null); return }
      let startLine = Math.min(l1, l2)
      let endLine = Math.max(l1, l2)
      const range = sel.getRangeAt(0)
      // 行范围规则（无任何自动修剪）：选区端点落在哪行、指针扫到哪行，
      // 那一行就计入——宁可多计一行，绝不丢行。曾尝试按“末行是否真选中
      // 字符”自动回退，会在行号槽拖选等场景误砍用户意图中的末行，已移除。
      if (pointerDownLine != null && pointerUpLine != null) {
        startLine = Math.min(startLine, pointerDownLine, pointerUpLine)
        endLine = Math.max(endLine, pointerDownLine, pointerUpLine)
      }
      const rect = range.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) { setPreviewSelPopover(null); return }
      // 松手后立即清除原生字符选区，范围显示由整行着色（sel-range）
      // 独家承担——避免原生蓝与整行底色叠加成双重颜色，且原生选区
      // 在按行分块布局里本就刷不到零字符命中的末行。
      try { sel.removeAllRanges() } catch { /* ignore */ }
      setPreviewSelPopover({ x: rect.left + rect.width / 2, y: rect.top, startLine, endLine, text })
    })
  }, [])

  // 源码预览浮动按钮关闭
  const closePreviewSel = useCallback(() => setPreviewSelPopover(null), [setPreviewSelPopover])
  usePopoverDismiss(!!previewSelPopover, closePreviewSel, undefined, undefined, previewSelRef)

  // 鼠标松开时读取选区：仅当选区落在「助手消息气泡」或「思考链」内且非空，才在选区上方弹出操作条。
  const handleMessagesMouseUp = useCallback(() => {
    // 延后一帧读取，确保浏览器已提交本次选区。
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelectionPopover(null); return }
      const text = selectionTextWithMath(sel).trim()
      if (!text) { setSelectionPopover(null); return }
      const anchor = sel.anchorNode
      const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement
      // 助手正文气泡或思考链正文均可触发
      const bubble = anchorEl?.closest('.chat-msg-assistant .chat-msg-markdown, .agent-think-body')
      if (!bubble) { setSelectionPopover(null); return }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) { setSelectionPopover(null); return }
      // 引用走 Markdown 源：排版文本不含标题/列表/围栏标记，多行还会挤成一段，
      // 引用出来的卡片于是排版与公式顺序都走形。
      setSelectionPopover({ text, md: selectionMarkdown(sel).trim(), x: rect.left + rect.width / 2, y: rect.top })
    })
  }, [])

  // 操作条开启时，点击其外部任意处即收起（不含操作条自身）。复用已有的 closeSelectionPopover（同时清除选区高亮）。
  usePopoverDismiss(!!selectionPopover, closeSelectionPopover, undefined, undefined, selectionPopoverRef)

  // ── 输入框 @ 文件补全 ──
  // 把 [start, end) 区间的文本替换为 text（用于选中文件时替换触发用的 @查询串）



  // ── 附件 / 图片 ──
  // 附件记下磁盘绝对路径：右侧「预览」工作区要按路径读原始字节（PDF 版面、DOCX、图片原图）。
  // webUtils.getPathForFile 对内存构造的 File 会抛，取不到就当无路径（点附件回退旧的文本浮层）。
  function attachmentPath(file: File): string | undefined {
    try { return window.api.getFilePath(file) || undefined } catch { return undefined }
  }

  async function readAttachmentFile(file: File): Promise<{ isImage: boolean; dataUrl?: string; text: string }> {
    const isImage = file.type.startsWith('image/') || isImageName(file.name)
    if (isImage) {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result as string)
        r.onerror = () => rej(r.error)
        r.readAsDataURL(file)
      })
      return { isImage: true, dataUrl, text: '' }
    }
    if (isBinaryDoc(file.name)) {
      return { isImage: false, text: wrapBinaryDocText(file.name, await extractTextFromFile(file)) }
    }
    const text = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result as string)
      r.onerror = () => rej(r.error)
      r.readAsText(file)
    })
    return { isImage: false, text }
  }

  // 从 File 列表挂附件：图片读成 data URL 挂成图片胶囊，其余抽正文。
  // 附件选择器与「拖入但取不到磁盘路径」两处共用（后者拿不到 path，只能按 File 读）。
  // 图片只进胶囊行，正文一个字都不动——用户正在打的字不会被附件插进来打断。
  const attachFromFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readAttachmentFile))
    const next = files.map((f, i) => ({
      id: uniqueId('att'),
      name: f.name,
      path: attachmentPath(f),
      isImage: read[i]!.isImage,
      dataUrl: read[i]!.dataUrl,
      content: read[i]!.text,
    }))
    setAttachedFiles(prev => [...prev, ...next])
  }, [])

  const handleAttachmentSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (e.target) e.target.value = ''  // 允许重复选同名文件
    await attachFromFiles(files)
  }, [attachFromFiles])

  const removeAttachment = useCallback((id: string) => {
    setAttachedFiles(prev => prev.filter(a => a.id !== id))
  }, [])

  // 「全部清除」：清空全部待发送附件（正文里不再有与附件绑定的占位文字，无需同步）
  const clearAttachments = useCallback(() => {
    setAttachedFiles([])
  }, [])

  const handleFilePickerAttach = useCallback(async (entry: { name: string; path: string; isDir: boolean }) => {
    if (entry.isDir) return
    // 按路径去重：同名但不同目录的两个文件都该能各自加入（原先按名字去重会静默丢一个）
    if (attachedFilesRef.current.some(a => a.path === entry.path)) return
    const id = uniqueId('fp-att')
    // 图片：与「附件选择器」同一条路——读成 data URL 挂成图片胶囊（自成一整行，正文不受影响）。
    // 内部文件树拖入、系统资源管理器拖入、工作区文件选择器都汇到这个函数，所以三处一起就对了。
    // 早先它们走的是文本附件那条路：图片被当成文件挂在正文上方的托盘里，还常被 readFile 读成乱码。
    if (isImageName(entry.name)) {
      try {
        const b64 = await window.api.readFileBase64(entry.path)
        if (b64.success && b64.dataUrl) {
          setAttachedFiles(prev => [...prev, {
            id, name: entry.name, path: entry.path, isImage: true, dataUrl: b64.dataUrl, content: '',
          }])
          return
        }
      } catch { /* 读不出来则退回下面的普通附件路径，至少按路径还能预览 */ }
    }
    // 先入库，弹窗里的勾选与托盘胶囊同帧出现。读取失败也保留这颗附件：
    // 它在托盘里是「引用」，右侧预览按路径仍能打开原文件。
    // 原先只在文本抽取成功时才建 chip，于是从工作区选的图片、.doc、超大的文本文件
    // 一律静默消失（托盘里看不见，也点不出预览）。
    setAttachedFiles(prev => prev.some(a => a.path === entry.path)
      ? prev
      : [...prev, { id, name: entry.name, isImage: false, path: entry.path, content: '' }])
    let text: string | null = null
    try {
      // 工作区里的 PDF/docx：主进程 readFile 只做文本读取，二进制会返回乱码，
      // 所以走 base64 + 浏览器侧解析这条路（与附件选择器同一个抽取函数）。
      if (isBinaryDoc(entry.name)) {
        const b64 = await window.api.readFileBase64(entry.path)
        const base64 = b64.dataUrl?.split(',')[1] ?? ''
        if (b64.success && base64) {
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
          text = wrapBinaryDocText(entry.name, await extractTextFromBuffer(entry.name, bytes.buffer as ArrayBuffer))
        }
      } else {
        const res = await window.api.readFile(entry.path, { maxBytes: 128 * 1024 })
        if (res.success && typeof res.content === 'string') text = res.content
      }
    } catch { /* 抽取失败：附件仍进托盘，按路径预览 */ }
    // 回填正文按 id 命中：去重时未入库的那个 id 自然落空，不会覆盖已有附件
    setAttachedFiles(prev => prev.map(a => a.id === id ? { ...a, content: text ?? '' } : a))
  }, [])

  // 拖拽文件到输入框：内部文件树拖拽与系统资源管理器拖入都走 handleFilePickerAttach
  // （图片在那里读成 data URL 挂成图片胶囊，其余按路径挂成附件）
  const handleInputDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-agent-file-path') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const handleInputDrop = useCallback((e: React.DragEvent) => {
    // 多文件拖入支持
    const filesJson = e.dataTransfer.getData('application/x-agent-files')
    if (filesJson) {
      e.preventDefault()
      try {
        const files: { path: string; name: string }[] = JSON.parse(filesJson)
        for (const f of files) handleFilePickerAttach({ name: f.name, path: f.path, isDir: false })
      } catch { /* 解析失败回退单文件 */ }
      // 通知文件树清除多选高亮
      window.dispatchEvent(new CustomEvent('agent-file-drop-done'))
      return
    }
    // 单文件回退（内部文件树拖拽）
    const path = e.dataTransfer.getData('application/x-agent-file-path')
    const name = e.dataTransfer.getData('application/x-agent-file-name')
    if (path && name) {
      e.preventDefault()
      handleFilePickerAttach({ name, path, isDir: false })
      window.dispatchEvent(new CustomEvent('agent-file-drop-done'))
      return
    }
    // 系统资源管理器拖入：能取到真实路径的按路径挂（右侧预览打得开原文件）；
    // 取不到路径的（从看图软件 / 浏览器里拖出来的图）按 File 直接读，别静默丢掉
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault()
      const pathless: File[] = []
      for (const f of Array.from(e.dataTransfer.files)) {
        let p = ''
        try { p = window.api.getFilePath(f) } catch { /* 内存构造的 File 取不到路径 */ }
        if (p) void handleFilePickerAttach({ name: f.name, path: p, isDir: false })
        else pathless.push(f)
      }
      if (pathless.length > 0) void attachFromFiles(pathless)
    }
  }, [handleFilePickerAttach, attachFromFiles])

  const handleFilePickerRemove = useCallback((path: string) => {
    // 附件是唯一的真相源（弹窗左侧「已选」由它派生），按路径摘掉即可两边同步
    setAttachedFiles(prev => prev.filter(a => a.path !== path))
  }, [])

  const toggleFilePicker = useCallback(() => {
    setFilePickerOpen(v => !v)
  }, [])

  return {
    // 输入核心
    input, setInput, textareaRef, packedInput, setPackedInput, inputOverflowRef,
    autoResize, insertAtCursor, replaceRange, recallHistory, inputHistoryRef, historyIdxRef,
    // 附件与文件选择器
    fileInputRef, attachedFiles, setAttachedFiles, filePickerAttached,
    filePickerOpen, setFilePickerOpen,
    readAttachmentFile, handleAttachmentSelect, removeAttachment, clearAttachments, handleFilePickerAttach,
    handleInputDragOver, handleInputDrop, handleFilePickerRemove, toggleFilePicker,
    // 引用胶囊 / 代码片段
    refChips, setRefChips, codeSnippets, setCodeSnippets,
    addRefChip, removeRefChip, removeCodeSnippet,
    // 选区浮层
    selectionPopover, setSelectionPopover, selectionPopoverRef,
    previewSelPopover, setPreviewSelPopover, previewSelRef,
    closeSelectionPopover, copySelection, quoteSelection, closePreviewSel,
    handlePreviewMouseDown, handlePreviewMouseUp, handleMessagesMouseUp,
  }
}
