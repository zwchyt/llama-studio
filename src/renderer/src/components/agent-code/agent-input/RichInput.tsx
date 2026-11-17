// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：RichInput —— 支持「内联胶囊」的富文本输入框（contenteditable）          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 为什么不用 textarea：textarea 只能放纯文本，放不进 DOM 元素，所以折叠胶囊只能待在
// 输入框外面的一行里（上方或下方），永远插不到文字中间。
// 换成 contenteditable 后，胶囊是 contenteditable=false 的行内节点，光标停在哪就插在哪。
//
// 与 React 的分工（决定 IME 会不会被打断）：
//   · DOM 是编辑中的真相源，React **不**受控渲染文本；
//   · 只有「外部写入的值」与 DOM 当前序列化结果不一致时才重建 DOM（发送清空 / 历史召回 /
//     slash 展开这类程序化写入）；平时打字一个节点都不动，组字期间更是绝不重建。
//   · 序列化：DOM → { text, chips }。text 里每个胶囊位置是一个 \uFFFC 占位符，
//     chips 按出现顺序一一对应 —— 发送时按这个顺序拼回去，顺序天然等于看到的顺序。

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'

/** 胶囊在文本里的占位符（OBJECT REPLACEMENT CHARACTER，编辑器界通用做法） */
export const CHIP_MARK = '\uFFFC'

export type ChipKind = 'fold' | 'quote' | 'image' | 'file' | 'code'
export type RichChip = {
  id: string
  /** 展开进正文的内容（图片/文件为空串：它们走 attachments 通道） */
  text: string
  kind: ChipKind
  /** 显示用标签；缺省时按 kind 自动生成（代码片段用 "file.ts:L10-L20"） */
  label?: string
}
export type RichValue = { text: string; chips: RichChip[] }

export type RichInputHandle = {
  focus: () => void
  /** 聚焦并把光标钉到内容末尾（编辑器从未有过光标时的兜底） */
  focusEnd: () => void
  /** 把插入光标定位到 (x, y) 所指的位置：文件拖放悬停时光标跟随鼠标滑动，
      滑到哪里松手就插到哪里（Chromium 对文件拖放不会自动移动光标，需手动定位）。
      鼠标不在编辑器文字区上时，退回失焦前的光标位置 / 末尾。 */
  caretToPointer: (x: number, y: number) => void
  /** 在失焦前的光标位置显示插入指示线（纯几何定位，不碰选区、不抢焦点）——
      引用弹层出现时标出「胶囊会插到哪」，插入或弹层关闭后由 hideDragCaret 消失 */
  showCaretBar: () => void
  /** 聚焦并恢复到失焦前的光标位置；从未记录过则钉到末尾（点引用按钮等编辑器
      已失焦的场景用——用户光标放在哪，插入就在哪） */
  restoreCaret: () => void
  /** 隐藏拖放插入指示线（drop / 拖离编辑器时调用） */
  hideDragCaret: () => void
  /** 在光标处插入纯文本（走 execCommand，保留原生撤销栈） */
  insertText: (text: string) => void
  /** 在光标处插入一颗胶囊（长粘贴 = fold；选区引用 = quote） */
  insertChip: (text: string, kind?: ChipKind, id?: string, label?: string) => void
  /** 用 text 替换 [start, end)（@ 补全用；偏移以 text 为准，胶囊算 1 个字符） */
  replaceRange: (start: number, end: number, text: string) => void
  /** 按 id 删掉一颗胶囊（编辑弹窗里清空内容时用） */
  removeChip: (id: string) => void
  /** 光标在文本中的偏移（胶囊算 1 个字符） */
  getCaretOffset: () => number
  setCaretOffset: (n: number) => void
  clear: () => void
  resize: () => void
}

type Props = {
  value: RichValue
  onChange: (v: RichValue) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /** 返回 true 表示这次粘贴已被接管（调用方插了胶囊），不再走默认粘贴 */
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => boolean
  /** 点胶囊标签：折叠/引用 → 打开编辑弹窗；图片/文件 → 预览（由父级按 kind 决定） */
  onEditChip?: (id: string, kind: ChipKind) => void
  /** 悬停胶囊：id=null 表示离开。rect 用于父级把预览卡定位到胶囊上方 */
  onChipHover?: (id: string | null, kind?: ChipKind, rect?: DOMRect) => void
  placeholder?: string
  ariaLabel?: string
  maxHeight: number
  className?: string
}

const chipLabel = (chip: RichChip): string => {
  if (chip.label) return chip.label
  if (chip.kind === 'quote') return '引用'
  // 图片 / 文件胶囊直接显示文件名（超长由 CSS 省略）
  if (chip.kind === 'image' || chip.kind === 'file') return chip.text
  const lines = chip.text.split('\n').length
  return lines > 1 ? `已折叠 ${lines} 行` : `已折叠 ${chip.text.length} 字符`
}

// 胶囊前面的彩色小图标（内联 SVG，静态字符串，内容由本文件写死）
export const CHIP_ICON: Record<ChipKind, string> = {
  fold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 7C7 7 5 9 5 11.5V17h5v-5H7.6c.1-1.3.9-2.2 2.4-2.4L9.5 7Zm9 0C16 7 14 9 14 11.5V17h5v-5h-2.4c.1-1.3.9-2.2 2.4-2.4L18.5 7Z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M20.5 16.5 16 12l-5.5 5.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8L13.5 3Z"/><path d="M13.5 3v5h5"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>',
}

// ── 两套胶囊预览卡的互斥桥 ──
// 输入框（AgentInputArea）与消息气泡（SentChip）各自渲染预览卡，且都有「离开胶囊
// 延迟关」的悬停桥；不互斥的话，跨这两套快速移动鼠标时两张卡会短暂并存重叠。
// 任何卡打开时登记自己的关闭函数，登记动作会立即关掉另一套还挂着的卡。
// 不需要注销：卡卸载后 close 只是幂等的 setState，残留登记无害。
let activeChipTipCloser: (() => void) | null = null
export function claimChipTip(close: () => void): void {
  const prev = activeChipTipCloser
  activeChipTipCloser = close
  if (prev && prev !== close) prev()
}

/** DOM → { text, chipIds }：文本节点直取，<br> 记换行，胶囊记一个占位符 */function serializeIds(root: Node): { text: string; ids: string[] } {
  const ids: string[] = []
  let text = ''
  const walk = (node: Node): void => {
    node.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) {
        text += (n as Text).data
        return
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return
      const el = n as HTMLElement
      const chipId = el.dataset.chipId
      if (chipId) {
        ids.push(chipId)
        text += CHIP_MARK
        return
      }
      if (el.tagName === 'BR') {
        text += '\n'
        return
      }
      // 浏览器在 contenteditable 里按 Enter / 粘贴多行可能塞 <div>/<p>：当作"换行 + 内容"
      if (el.tagName === 'DIV' || el.tagName === 'P') {
        if (text && !text.endsWith('\n')) text += '\n'
        walk(el)
        return
      }
      walk(el)
    })
  }
  walk(root)
  // 首尾的换行只来自 contenteditable 为「只有胶囊、无文字」时自动补的占位 <br>，
  // 不是用户内容。带进去的话 renderDom 重建时又会变成换行文本节点，
  // 表现为胶囊上方那块空的可编辑行。这里去掉首尾换行，中间换行照常保留。
  return { text: text.replace(/^\n+|\n+$/g, ''), ids }
}

function buildChip(chip: RichChip): HTMLElement {
  const el = document.createElement('span')
  el.className = 'chat-inline-chip'
  el.contentEditable = 'false'
  el.dataset.chipId = chip.id
  el.dataset.kind = chip.kind
  const icon = document.createElement('span')
  icon.className = 'chat-inline-chip-icon'
  icon.innerHTML = CHIP_ICON[chip.kind]
  const label = document.createElement('span')
  label.className = 'chat-inline-chip-label'
  label.textContent = chipLabel(chip)
  const x = document.createElement('button')
  x.type = 'button'
  x.className = 'chat-inline-chip-x'
  x.setAttribute('aria-label', '移除')
  x.tabIndex = -1
  x.textContent = '×'
  el.append(icon, label, x)
  return el
}

/** 把「文本偏移」换算成 DOM Range（胶囊 / <br> 各算 1 个字符，与 text 口径一致） */
function rangeAt(el: HTMLElement, offset: number): Range {
  const range = document.createRange()
  let remaining = offset
  let done = false
  const walk = (node: Node): boolean => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        const len = (n as Text).data.length
        if (remaining <= len) { range.setStart(n, remaining); done = true; return true }
        remaining -= len
        continue
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue
      const eln = n as HTMLElement
      if (eln.dataset.chipId || eln.tagName === 'BR') {
        if (remaining === 0) { range.setStartBefore(n); done = true; return true }
        remaining -= 1
        if (remaining === 0) { range.setStartAfter(n); done = true; return true }
        continue
      }
      if (walk(n)) return true
    }
    return false
  }
  walk(el)
  if (!done) { range.selectNodeContents(el); range.collapse(false) }
  else range.collapse(true)
  return range
}

export const RichInput = forwardRef<RichInputHandle, Props>(function RichInput(
  { value, onChange, onKeyDown, onPaste, onEditChip, onChipHover, placeholder, ariaLabel, maxHeight, className },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null)
  // 正在 IME 组字：期间绝不重建 DOM
  const composingRef = useRef(false)
  // chips 的即时镜像：一次挂多个附件时会**连续**调 insertChip，而 value 要等 React 重渲染
  // 才更新——直接读闭包里的 value.chips 会让第二颗把第一颗的正文覆盖成空串。
  const chipsRef = useRef<RichChip[]>(value.chips)
  // ⚠️ 刻意**不在渲染期**赋值：insertChip 会先写 ref 再 onChange，若中间插入一次
  // 带着旧 value.chips 的重渲染，ref 会被旧数组盖回去 —— 下一轮 serialize 就查不到
  // 刚插入的胶囊，正文退化成空串（表现为「引用胶囊没内容 / 气泡里没有胶囊」）。
  // ref 只在三处更新：renderDom（外部写入）、serialize（每次序列化后自纠）、insertChip。
  // 注意：DOM 驱动的更新（打字/插胶囊/删胶囊）必须同步它，否则 useLayoutEffect 会误判
  // 为「外部写入」而 renderDom 重建整段 DOM，光标就丢回最前面；而 value 驱动的更新
  // （编辑弹窗改胶囊正文）绝不能同步，否则检测不到变化、DOM 上的标签不刷新。
  const renderedChipsRef = useRef<RichChip[]>([])

  const serialize = useCallback((): RichValue => {
    const el = elRef.current
    if (!el) return value
    const { text, ids } = serializeIds(el)
    const byId = new Map(chipsRef.current.map(c => [c.id, c]))
    // 顺序以 DOM 为准：父级只管内容，位置由编辑器决定
    const chips = ids.map(id => byId.get(id) ?? { id, text: '', kind: 'fold' as ChipKind })
    chipsRef.current = chips
    renderedChipsRef.current = chips
    return { text, chips }
  }, [value])

  const resize = useCallback(() => {
    const el = elRef.current
    if (!el) return
    const { text, ids } = serializeIds(el)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden'
    // 只有胶囊没有文字也算「有内容」：serializeIds 会 trim 首尾换行，纯胶囊输入框
    // 的 text 是空串，漏判的话占位提示会顶在胶囊前面
    el.dataset.empty = text.length === 0 && ids.length === 0 ? 'true' : 'false'
  }, [maxHeight])

  /** 把 value 写进 DOM（只在外部写入时调用） */
  const renderDom = useCallback((v: RichValue) => {
    const el = elRef.current
    if (!el) return
    el.textContent = ''
    chipsRef.current = v.chips
    const parts = v.text.split(CHIP_MARK)
    parts.forEach((part, i) => {
      if (part) el.appendChild(document.createTextNode(part))
      const chip = v.chips[i]
      if (i < parts.length - 1 && chip) el.appendChild(buildChip(chip))
    })
    resize()
  }, [resize])

  // 外部写入同步：只在「值与 DOM 不一致」时重建（打字时两者一致，直接跳过）
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const { text, ids } = serializeIds(el)
    // 胶囊正文也要比：在编辑弹窗里改了内容，DOM 里的「已折叠 N 行」得跟着更新
    const chipsDirty = value.chips.length !== renderedChipsRef.current.length
      || value.chips.some((c, i) => c.id !== renderedChipsRef.current[i]?.id || c.text !== renderedChipsRef.current[i]?.text)
    const same = text === value.text
      && ids.length === value.chips.length
      && ids.every((id, i) => id === value.chips[i]!.id)
      && !chipsDirty
    if (same) { resize(); return }
    if (composingRef.current) return
    renderDom(value)
    renderedChipsRef.current = value.chips
  }, [value, renderDom, resize])

  useEffect(() => { resize() }, [resize])

  const emit = useCallback(() => {
    onChange(serialize())
    resize()
  }, [serialize, onChange, resize])

  const caretAt = useCallback((offset: number) => {
    const el = elRef.current
    if (!el) return
    const r = rangeAt(el, offset)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  }, [])

  // 失焦前的光标位置（serialize 口径偏移）：桌面拖入文件会让窗口获焦、光标被
  // Chromium 丢回最前面，restoreCaret 靠它还原用户离开前的位置
  const lastCaretRef = useRef<number | null>(null)
  // 文件拖放悬停时的自定义插入指示线：系统"+复制"徽章是 OS 画的，去不掉，
  // 但可以用主题色竖条标记插入点，比细光标显眼得多
  const dragCaretRef = useRef<HTMLDivElement>(null)

  const caretOffset = useCallback((): number => {
    const el = elRef.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return 0
    const r = sel.getRangeAt(0)
    if (!el.contains(r.endContainer)) return serializeIds(el).text.length
    const pre = document.createRange()
    pre.selectNodeContents(el)
    pre.setEnd(r.endContainer, r.endOffset)
    return serializeIds(pre.cloneContents()).text.length
  }, [])

  const insertChip = useCallback((text: string, kind: ChipKind = 'fold', fixedId?: string, label?: string) => {
    const el = elRef.current
    if (!el || !text) return
    // 附件/代码片段用它们自己的 id：删胶囊时父级据此同步摘掉本体
    const id = fixedId ?? `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const node = buildChip({ id, text, kind, label })
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
      const r = sel.getRangeAt(0)
      r.deleteContents()
      r.insertNode(node)
      r.setStartAfter(node)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    } else {
      // 桌面拖入 / 程序化插入：焦点不在编辑器内，选区不在 el 里。
      // 只 appendChild 的话，contenteditable 会在胶囊旁自动补一个 <br> 占位行：
      // serializeIds 把 <br> 读成 '\n'，胶囊就被挤到各自一行（多个文件上下堆叠），
      // 且胶囊上方会多出一块"可以输入文字"的空行。
      // 显式把光标落在胶囊之后，与有选区的分支保持一致，不再产生占位行。
      el.appendChild(node)
      const after = document.createRange()
      after.setStartAfter(node)
      after.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(after)
    }
    // 编辑器里只有不可编辑的胶囊时，浏览器会在胶囊前面自动补一个 <br> 当光标落点，
    // pre-wrap 下就显示成「胶囊上方还能打字的一行」。没有真实文字时把这个开头占位 <br>
    // 清掉；光标仍由上面的 range 放在胶囊右边，上方空行随之消失。
    if (!Array.from(el.childNodes).some(c => c.nodeType === Node.TEXT_NODE && (c as Text).data.trim())) {
      while (el.firstChild?.nodeName === 'BR') el.firstChild.remove()
    }
    // 新胶囊的正文由调用方持有：把「旧 chips + 新胶囊」一起回传，顺序以 DOM 为准
    const { text: nextText, ids } = serializeIds(el)
    const byId = new Map(chipsRef.current.map(c => [c.id, c]))
    byId.set(id, { id, text, kind, label })
    const nextChips = ids.map(i => byId.get(i) ?? { id: i, text: '', kind })
    chipsRef.current = nextChips
    // DOM 驱动的插入必须同步这个镜像，否则 useLayoutEffect 会把这次 onChange 误判成
    // 外部写入而 renderDom 重建整段 DOM——光标丢回输入框最前面。
    renderedChipsRef.current = nextChips
    onChange({ text: nextText, chips: nextChips })
    resize()
    el.focus()
    // focus 后再把光标钉回新胶囊右边：拖放等场景下 Chromium 会忽略 focus 前设置的选区，
    // 把光标丢回编辑器最前面（还会在开头补一个 <br> 当光标载体），于是光标一直在最前面
    // 闪烁，下一次插入也会插到最前面。这里强制落回胶囊右边。
    const caret = document.createRange()
    caret.setStartAfter(node)
    caret.collapse(true)
    const finalSel = window.getSelection()
    finalSel?.removeAllRanges()
    finalSel?.addRange(caret)
    // focus 可能又在开头补了占位 <br>：一并清掉（光标已钉在胶囊右边，不受影响）
    if (!Array.from(el.childNodes).some(c => c.nodeType === Node.TEXT_NODE && (c as Text).data.trim())) {
      while (el.firstChild?.nodeName === 'BR') el.firstChild.remove()
    }
  }, [value, onChange, resize])

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    // 聚焦并把光标钉到内容末尾：拖入文件等「编辑器原本无焦点」的场景，
    // 裸 focus() 会让 Chromium 把光标放到最前面；先建好末尾选区再插入，
    // 后续 insertChip 就走与项目内添加完全一致的光标处插入路径。
    focusEnd: () => {
      const el = elRef.current
      if (!el) return
      el.focus()
      const r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    },
    caretToPointer: (x: number, y: number) => {
      const el = elRef.current
      if (!el) return
      const hit = document.caretRangeFromPoint(x, y)
      const bar = dragCaretRef.current
      if (hit && el.contains(hit.startContainer)) {
        // 鼠标悬在编辑器文字/胶囊上：光标跟随到所指位置（胶囊上会落到它前/后）
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(hit)
        // 同步移动自定义插入指示线（系统"+复制"徽章挡住细光标时也能看清插入点）
        if (bar) {
          let { left, top, height } = hit.getBoundingClientRect()
          if (height === 0) {
            const host = (hit.startContainer.nodeType === Node.TEXT_NODE
              ? hit.startContainer.parentElement
              : hit.startContainer) as HTMLElement | null
            const hr = host?.getBoundingClientRect()
            if (hr) { top = hr.top; height = hr.height }
          }
          if (height > 0 && !(left === 0 && top === 0)) {
            bar.style.display = 'block'
            bar.style.left = `${left}px`
            bar.style.top = `${top}px`
            bar.style.height = `${height}px`
          } else {
            bar.style.display = 'none'
          }
        }
        return
      }
      // 鼠标不在编辑器文字区上（工具栏/上下文行）：退回失焦前位置；从未记录过则末尾
      if (bar) bar.style.display = 'none'
      el.focus()
      const off = lastCaretRef.current
      const sel = window.getSelection()
      if (off == null) {
        const r = document.createRange()
        r.selectNodeContents(el)
        r.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(r)
        return
      }
      // 内容已变化导致越界时 rangeAt 自带末尾兜底
      caretAt(off)
    },
    restoreCaret: () => {
      const el = elRef.current
      if (!el) return
      el.focus()
      const off = lastCaretRef.current
      const sel = window.getSelection()
      if (off == null) {
        const r = document.createRange()
        r.selectNodeContents(el)
        r.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(r)
        return
      }
      // 恢复到失焦前的位置；内容已变化导致越界时 rangeAt 自带末尾兜底
      caretAt(off)
    },
    showCaretBar: () => {
      const el = elRef.current
      if (!el) return
      const off = lastCaretRef.current
      const bar = dragCaretRef.current
      // 从没点过输入框：没有可标记的位置（引用会插到末尾），不显示
      if (!bar || off == null) return
      const r = rangeAt(el, off)
      let { left, top, height } = r.getBoundingClientRect()
      if (height === 0) {
        const host = (r.startContainer.nodeType === Node.TEXT_NODE
          ? r.startContainer.parentElement
          : r.startContainer) as HTMLElement | null
        const hr = host?.getBoundingClientRect()
        if (hr) { top = hr.top; height = hr.height }
      }
      if (height > 0 && !(left === 0 && top === 0)) {
        bar.style.display = 'block'
        bar.style.left = `${left}px`
        bar.style.top = `${top}px`
        bar.style.height = `${height}px`
      } else {
        bar.style.display = 'none'
      }
    },
    hideDragCaret: () => {
      if (dragCaretRef.current) dragCaretRef.current.style.display = 'none'
    },
    insertText: (text: string) => {
      const el = elRef.current
      if (!el) return
      el.focus()
      if (!document.execCommand('insertText', false, text)) {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0)
          r.deleteContents()
          r.insertNode(document.createTextNode(text))
          r.collapse(false)
        }
      }
      emit()
    },
    insertChip,
    replaceRange: (start: number, end: number, text: string) => {
      const el = elRef.current
      if (!el) return
      el.focus()
      const a = rangeAt(el, start)
      const b = rangeAt(el, Math.max(start, end))
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      // setBaseAndExtent 支持跨节点选区（起点/终点可能在文本节点与胶囊节点之间）
      sel.setBaseAndExtent(a.startContainer, a.startOffset, b.startContainer, b.startOffset)
      document.execCommand('insertText', false, text)
      emit()
    },
    removeChip: (id: string) => {
      const el = elRef.current
      if (!el) return
      const node = el.querySelector(`[data-chip-id="${id}"]`)
      if (node) { node.remove(); emit() }
    },
    getCaretOffset: caretOffset,
    setCaretOffset: (n: number) => { elRef.current?.focus(); caretAt(n) },
    clear: () => {
      const el = elRef.current
      if (!el) return
      el.textContent = ''
      onChange({ text: '', chips: [] })
      resize()
    },
    resize,
  }), [emit, insertChip, caretAt, caretOffset, resize, onChange])

  return (
    <>
    <div
      ref={elRef}
      className={`chat-input chat-input-editor${className ? ` ${className}` : ''}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-placeholder={placeholder}
      spellCheck={false}
      onInput={() => { if (!composingRef.current) emit() }}
      // 失焦时记住光标位置：拖文件回来后 restoreCaret 据此还原，光标不会跑到最前面
      onBlur={() => { lastCaretRef.current = caretOffset() }}
      // 组字期间不 emit，data-empty 不会更新，占位伪元素会把组字文字顶到提示后面
      onCompositionStart={() => {
        composingRef.current = true
        if (elRef.current) elRef.current.dataset.empty = 'false'
      }}
      onCompositionEnd={() => { composingRef.current = false; emit() }}
      onKeyDown={e => {
        onKeyDown?.(e)
        // 父级没接管（例如模型没启动、不能发送）：Enter 自己换行
        if (e.key === 'Enter' && !e.defaultPrevented) {
          e.preventDefault()
          document.execCommand('insertLineBreak')
          emit()
        }
      }}
      onPaste={e => {
        if (onPaste?.(e)) return
        // 默认粘贴只取纯文本：避免把外部 HTML / 样式带进编辑器
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        if (text) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'))
        emit()
      }}
      onMouseOver={e => {
        if (!onChipHover) return
        const chipEl = (e.target as HTMLElement).closest('.chat-inline-chip') as HTMLElement | null
        const id = chipEl?.dataset.chipId
        if (!chipEl || !id) return
        onChipHover(id, (chipEl.dataset.kind as ChipKind) ?? 'fold', chipEl.getBoundingClientRect())
      }}
      onMouseOut={e => {
        if (!onChipHover) return
        const chipEl = (e.target as HTMLElement).closest('.chat-inline-chip') as HTMLElement | null
        if (!chipEl) return
        // 在胶囊内部（图标→标签→×）移动不算离开
        const to = e.relatedTarget as Node | null
        if (to && chipEl.contains(to)) return
        onChipHover(null)
      }}
      onClick={e => {
        const t = e.target as HTMLElement
        const chipEl = t.closest('.chat-inline-chip') as HTMLElement | null
        if (!chipEl) return
        const id = chipEl.dataset.chipId
        if (!id) return
        if (t.closest('.chat-inline-chip-x')) {
          e.preventDefault()
          chipEl.remove()
          emit()
          return
        }
        e.preventDefault()
        onEditChip?.(id, (chipEl.dataset.kind as ChipKind) ?? 'fold')
      }}
    />
    <div ref={dragCaretRef} className="chat-drag-caret" aria-hidden="true" />
    </>
  )
})
