// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentInputHints —— 输入框的两个补全浮层（@ 提及 / 斜杠命令）          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的「@ 提及」与「/命令」两块，逻辑与注释均未改动。
//
// 自持：allFilesRef / atLoadedDirRef / atAnchorRef / atPopRef / slashAnchorRef /
//       slashPopRef 六个 ref，以及 atQuery / atFiles / slashQuery / slashList /
//       slashIdx 五个 state，外加「工作区切换时清空文件缓存」的 effect。
// 外部输入：输入框自身（input / setInput / textareaRef / autoResize）、光标插入
//           与区间替换（insertAtCursor / replaceRange）、
//           当前工作区目录（workspaceDir）。
// 对外输出：两个浮层的激活态与列表、浮层元素 ref、以及检测/选择/关闭回调。
//
// 说明：onPickSlash 只把「/命令名 」插进输入框，命令的真正分发在 handleSend 里
// 完成——因此本 hook 不依赖 runSlashAction。调用点选在 handleKeyDown 之前：该位置
// 之后才有代码引用本域符号，移动不影响既有行为。

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {useStore} from '../../../store/useStore'
import {usePopoverDismiss} from '../../../utils/usePopoverDismiss'
import {filterCommands} from '../../../agent/slashCommands'
import type { FlatFileEntry } from '../types'

export function useAgentInputHints({
  input, setInput, insertAtCursor, replaceRange, textareaRef, autoResize, workspaceDir, plainChat,
}: {
  input: string
  setInput: (v: string) => void
  insertAtCursor: (text: string) => void
  replaceRange: (start: number, end: number, text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  autoResize: () => void
  workspaceDir: string
  /** 通用模式（聊天工作区）：不提供 / 命令——斜杠命令是编码工作台的能力 */
  plainChat: boolean
}) {
  // 工作区文件缓存（扁平列表），按 workspaceDir 加载一次，过滤纯前端
  // FlatFileEntry 类型已抽至 agent-code/types
  const allFilesRef = useRef<FlatFileEntry[]>([])
  const atLoadedDirRef = useRef<string>('')
  const [atQuery, setAtQuery] = useState<string | null>(null) // 非空=浮层激活，存 @ 后的查询串
  const [atFiles, setAtFiles] = useState<FlatFileEntry[]>([]) // 当前过滤后的列表
  const atAnchorRef = useRef<number | null>(null) // @ 在 input 中的起始索引
  const atPopRef = useRef<HTMLDivElement>(null)


  // 首次需要时按工作区目录加载扁平文件列表（带上限保护，见主进程 list-flat-files）
  const ensureWorkspaceFiles = useCallback(async (dir: string) => {
    if (!dir || atLoadedDirRef.current === dir) return
    atLoadedDirRef.current = dir
    try {
      const res = await window.api.listFlatFiles(dir, { maxDepth: 12, maxFiles: 3000 })
      if (res.success && res.files) allFilesRef.current = res.files
      else allFilesRef.current = []
    } catch {
      allFilesRef.current = []
    }
  }, [])

  // 根据光标位置检测是否处于「@触发」状态：@ 前为空白或行首，@ 后无空白
  const detectAt = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (m) {
      const atStart = caret - (m[2]!.length + 1) // @ 符号的索引
      atAnchorRef.current = atStart
      setAtQuery(m[2]!)
      return true
    }
    atAnchorRef.current = null
    setAtQuery(null)
    return false
  }, [])

  // 按 atQuery 过滤工作区文件（匹配文件名或相对路径，不区分大小写）
  const filterAtFiles = useCallback((query: string) => {
    const q = query.toLowerCase()
    const all = allFilesRef.current
    const matched = q
      ? all.filter(f => f.name.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q))
      : all
    setAtFiles(matched.slice(0, 50))
  }, [])

  // 选中文件：把 @查询串 替换为文件名文本，插入到输入框，不发送
  const onPickAtFile = useCallback((entry: FlatFileEntry) => {
    const anchor = atAnchorRef.current
    if (anchor == null) { insertAtCursor(entry.name); setAtQuery(null); return }
    // 替换从 @ 到当前光标处的整段（即 @查询串）
    const caret = textareaRef.current?.selectionStart ?? input.length
    replaceRange(anchor, caret, entry.name)
    setAtQuery(null)
  }, [insertAtCursor, replaceRange, input.length])

  // 点击浮层外部 / 切换工作区关闭浮层
  const closeAtQuery = useCallback(() => setAtQuery(null), [setAtQuery])
  usePopoverDismiss(atQuery !== null, closeAtQuery, undefined, undefined, atPopRef, true)

  // 切换工作区目录时重置文件缓存（下次输入 @ 重新加载）
  useEffect(() => {
    atLoadedDirRef.current = ''
    allFilesRef.current = []
    setAtQuery(null)
  }, [workspaceDir])

  // ── /命令 自动补全浮层 ──
  const [slashQuery, setSlashQuery] = useState<string | null>(null) // 非空=浮层激活，存 / 后的查询串
  const [slashList, setSlashList] = useState<import('../../../../../shared/types').SlashCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const slashCommands = useStore(s => s.slashCommands)
  const slashAnchorRef = useRef<number | null>(null) // / 在 input 中的起始索引
  const slashPopRef = useRef<HTMLDivElement>(null)

  // 根据光标位置检测是否处于「/命令触发」状态：/ 前为空白或行首，/ 后无空格
  // 通用模式不提供斜杠命令（/clear、/compact 等都是编码工作台的能力），直接不触发。
  const detectSlash = useCallback((value: string, caret: number) => {
    if (plainChat) {
      slashAnchorRef.current = null
      setSlashQuery(null)
      return false
    }
    const before = value.slice(0, caret)
    const m = /(^|\s)\/([a-zA-Z0-9_\-]*)$/.exec(before)
    if (m) {
      const slashStart = caret - (m[2]!.length + 1)
      slashAnchorRef.current = slashStart
      const q = m[2]!
      setSlashQuery(q)
      setSlashList(filterCommands(q, slashCommands))
      setSlashIdx(0)
      return true
    }
    slashAnchorRef.current = null
    setSlashQuery(null)
    return false
  }, [slashCommands, plainChat])

  // 切到通用模式时若浮层正开着（切模式前已输入 /xxx），立即关闭
  useEffect(() => { if (plainChat) setSlashQuery(null) }, [plainChat])

  // 选中命令：把 /查询串 替换为 "/name "（留出参数位置），不发送
  const onPickSlash = useCallback((cmd: import('../../../../../shared/types').SlashCommand) => {
    const anchor = slashAnchorRef.current
    const el = textareaRef.current
    const caret = el?.selectionStart ?? input.length
    if (anchor == null) { setInput(`/${cmd.name} `); setSlashQuery(null); return }
    const next = input.slice(0, anchor) + `/${cmd.name} ` + input.slice(caret)
    setInput(next)
    setSlashQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = anchor + cmd.name.length + 2
      el?.setSelectionRange(pos, pos)
      autoResize()
    })
  }, [input, autoResize])

  // 浮层外部点击关闭
  const closeSlashQuery = useCallback(() => setSlashQuery(null), [setSlashQuery])
  usePopoverDismiss(slashQuery !== null, closeSlashQuery, undefined, undefined, slashPopRef, true)

  return {
    atQuery, setAtQuery, atFiles, setAtFiles, atAnchorRef, atPopRef,
    slashQuery, setSlashQuery, slashList, setSlashList, slashIdx, setSlashIdx, slashAnchorRef, slashPopRef,
    ensureWorkspaceFiles, detectAt, filterAtFiles, onPickAtFile, closeAtQuery,
    detectSlash, onPickSlash, closeSlashQuery,
  }
}
