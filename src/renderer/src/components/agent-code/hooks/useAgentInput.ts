// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentInput —— 输入框核心 + 附件/引用/代码片段/选区浮层               ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的整个输入域，逻辑与注释均未改动。
//
// 自持：
//   · 输入核心：input / packedInput 两个 state，textareaRef / inputOverflowRef /
//     inputHistoryRef / historyIdxRef 四个 ref；
//   · 附件与文件选择器：attachedFiles / filePickerAttached / filePickerOpen 三个 state，
//     fileInputRef；含 readAttachmentFile / handleAttachmentSelect / removeAttachment /
//     handleFilePickerAttach / handleInputDragOver / handleInputDrop /
//     handleBrowseSystemFiles / handleFilePickerRemove / toggleFilePicker；
//   · 引用胶囊与代码片段：refChips / codeSnippets 两个 state；
//   · 选区浮层：selectionPopover / previewSelPopover 两个 state，previewSelRef /
//     selectionPopoverRef / previewDragStartLineRef 三个 ref。
// 外部输入：无——本 hook 的所有回调只依赖上面这些自持值。
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

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { safeCall } from '../../../utils/safeCall'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import { INPUT_FOLD_CAP } from '../utils/constants'
import { previewLineNoFromTarget } from '../utils/dom'
import { uniqueId } from '../utils/ids'
import { binaryDocLabel, extractTextFromBuffer, extractTextFromFile, isBinaryDoc } from '../../../utils/extractText'
import type { CodeSnippet } from '../types'

// PDF/docx 抽出的正文没有文件名上下文，标出来源；解析失败也要留一行，免得模型收到空附件却无人报错
function wrapBinaryDocText(name: string, text: string): string {
  const label = binaryDocLabel(name)
  return text ? `[${label}: ${name}]\n${text}` : `[${label}: ${name}]（文本提取失败）`
}

export function useAgentInput() {

  const [input, setInput] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputHistoryRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)

  const [packedInput, setPackedInput] = useState<string | null>(null)
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

  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; isImage: boolean; dataUrl?: string; content?: string }>>([])
  // 「引用」引用块：以胶囊（图标 + 缩写）形式内嵌在输入框内，
  // 发送时作为引用块（> …）拼入正文。
  const [refChips, setRefChips] = useState<Array<{ id: string; text: string }>>([])
  // 代码片段胶囊：从源码预览中选中代码后引用，发送时以 fenced code block 注入正文。
  // CodeSnippet 类型已抽至 agent-code/types
  const [codeSnippets, setCodeSnippets] = useState<CodeSnippet[]>([])
  const [filePickerAttached, setFilePickerAttached] = useState<Array<{ id: string; path: string; name: string; isDir: boolean }>>([])

  const [filePickerOpen, setFilePickerOpen] = useState(false)

  // 选中「模型输出」文字后浮现的操作条（引用 / 复制 / 追问）。
  // text=选中的纯文本，x/y=选区外接矩形的视口坐标（用 position:fixed 定位）。
  const [selectionPopover, setSelectionPopover] = useState<{ text: string; x: number; y: number } | null>(null)
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
      const text = sel.toString().trim()
      if (!text) { setSelectionPopover(null); return }
      const anchor = sel.anchorNode
      const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement
      // 助手正文气泡或思考链正文均可触发
      const bubble = anchorEl?.closest('.chat-msg-assistant .chat-msg-markdown, .agent-think-body')
      if (!bubble) { setSelectionPopover(null); return }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) { setSelectionPopover(null); return }
      setSelectionPopover({ text, x: rect.left + rect.width / 2, y: rect.top })
    })
  }, [])

  // 操作条开启时，点击其外部任意处即收起（不含操作条自身）。复用已有的 closeSelectionPopover（同时清除选区高亮）。
  usePopoverDismiss(!!selectionPopover, closeSelectionPopover, undefined, undefined, selectionPopoverRef)

  // ── 输入框 @ 文件补全 ──
  // 把 [start, end) 区间的文本替换为 text（用于选中文件时替换触发用的 @查询串）



  // ── 附件 / 图片 ──
  async function readAttachmentFile(file: File): Promise<{ isImage: boolean; dataUrl?: string; text: string }> {
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)
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

  const handleAttachmentSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (e.target) e.target.value = ''  // 允许重复选同名文件
    if (files.length === 0) return
    const read = await Promise.all(files.map(readAttachmentFile))
    const next = files.map((f, i) => ({
      id: uniqueId('att'),
      name: f.name,
      isImage: read[i]!.isImage,
      dataUrl: read[i]!.dataUrl,
      content: read[i]!.text,
    }))
    setAttachedFiles(prev => [...prev, ...next])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachedFiles(prev => prev.filter(a => a.id !== id))
  }, [])

  const handleFilePickerAttach = useCallback(async (entry: { name: string; path: string; isDir: boolean }) => {
    if (entry.isDir) return
    setFilePickerAttached(prev => {
      if (prev.some(a => a.path === entry.path)) return prev
      return [...prev, { id: uniqueId('fp-att'), path: entry.path, name: entry.name, isDir: false }]
    })
    try {
      // 工作区里的 PDF/docx：主进程 readFile 只做文本读取，二进制会返回乱码，
      // 所以走 base64 + 浏览器侧解析这条路（与附件选择器同一个抽取函数）。
      let text: string | null = null
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
      if (text !== null) {
        setAttachedFiles(prev => {
          if (prev.some(a => a.name === entry.name)) return prev
          return [...prev, { id: uniqueId('fp-read'), name: entry.name, isImage: false, content: text }]
        })
      }
    } catch { /* 读取失败，静默跳过 */ }
  }, [])

  // 拖拽文件到输入框：支持内部文件树拖拽与系统资源管理器拖入，均作为附件添加
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
    // 系统资源管理器拖入：经 webUtils 取真实路径后逐个作为附件（目录/取路径失败跳过）
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault()
      for (const f of Array.from(e.dataTransfer.files)) {
        try {
          const p = window.api.getFilePath(f)
          if (p) void handleFilePickerAttach({ name: f.name, path: p, isDir: false })
        } catch { /* 取路径失败，跳过该项 */ }
      }
    }
  }, [handleFilePickerAttach])

  // 浏览系统文件：原生对话框选取任意磁盘文件（多选），逐个作为附件加入
  const handleBrowseSystemFiles = useCallback(async () => {
    const res = await safeCall<{ paths: string[] }>(() => window.api.selectFiles(), '选择文件')
    if (!res?.paths?.length) return
    for (const p of res.paths) {
      const name = p.replace(/\\/g, '/').split('/').pop() || p
      void handleFilePickerAttach({ name, path: p, isDir: false })
    }
  }, [handleFilePickerAttach])

  const handleFilePickerRemove = useCallback((path: string) => {
    setFilePickerAttached(prev => prev.filter(a => a.path !== path))
    const name = path.replace(/\\/g, '/').split('/').pop() || path
    setAttachedFiles(prev => prev.filter(a => a.name !== name))
  }, [])

  const toggleFilePicker = useCallback(() => {
    setFilePickerOpen(v => !v)
  }, [])

  return {
    // 输入核心
    input, setInput, textareaRef, packedInput, setPackedInput, inputOverflowRef,
    autoResize, insertAtCursor, replaceRange, recallHistory, inputHistoryRef, historyIdxRef,
    // 附件与文件选择器
    fileInputRef, attachedFiles, setAttachedFiles, filePickerAttached, setFilePickerAttached,
    filePickerOpen, setFilePickerOpen,
    readAttachmentFile, handleAttachmentSelect, removeAttachment, handleFilePickerAttach,
    handleInputDragOver, handleInputDrop, handleBrowseSystemFiles, handleFilePickerRemove, toggleFilePicker,
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
