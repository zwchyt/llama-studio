// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：DOM 辅助（从事件目标解析源码预览行号）                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。
// 供预览区「框选行」与消息区「点击行号」两处使用，故置于共享 utils。

// 从事件目标解析源码预览行号（含行号槽）；不在预览行内返回 null
export function previewLineNoFromTarget(t: EventTarget | null): number | null {
  const el = t instanceof Element ? t : null
  const line = el?.closest('.agent-code-preview-line')
  const m = line ? /agent-preview-line-(\d+)/.exec(line.id || '') : null
  return m ? Number(m[1]) : null
}

// 公式 → LaTeX 源：KaTeX 把原文留在 MathML 的 <annotation encoding="application/x-tex"> 里，
// 排版后的字符既没有 $ 定界符，也已被拆成上下标等碎片，直接取文本就再也还原不成公式。
function texOf(el: Element): string {
  const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
  if (!tex) return ''
  return el.closest('.math-block, .katex-display') ? `$$${tex}$$` : `$${tex}$`
}

// 选区纯文本（复制用），公式还原成 LaTeX 源。
//
// 不能拿 cloneContents() 的片段找 .katex：选区只要压在公式上（一行文字里混排公式最常见
// 就是这样），片段里就只有公式的子节点，找不到根，整行会退回排版字符。这里按
// 「与选区相交」从所在的正文容器里找公式根，再按文档顺序拼文本。
export function selectionTextWithMath(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ''
  const range = sel.getRangeAt(0)
  const ca = range.commonAncestorContainer
  const base = ca instanceof Element ? ca : ca.parentElement
  if (!base) return sel.toString()
  const scope = base.closest('.chat-msg-markdown, .agent-think-body') ?? base
  if (![...scope.querySelectorAll('.katex')].some(el => range.intersectsNode(el))) return sel.toString()
  const out: string[] = []
  const walk = (node: Node): void => {
    if (!range.intersectsNode(node)) return
    if (node instanceof Element && node.classList.contains('katex')) {
      const tex = texOf(node) || node.textContent
      if (tex) out.push(tex)
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      let t = node.textContent ?? ''
      if (node === range.startContainer) t = t.slice(range.startOffset)
      if (node === range.endContainer) t = t.slice(0, range.endOffset)
      out.push(t)
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(scope)
  return out.join('')
}

// 选区 → Markdown 源（引用用）。
//
// 引用是把取到的字符串再交给会话那套 Markdown 渲染，所以不能喂「排版后的文本」：
// DOM 文本里没有标题层级、列表符号、加粗与代码围栏，块与块之间也没有空行，
// 多行会被挤成一段（原本分居各行的 $ 于是被配成一对，公式顺序看着就乱了）。
// 这里按文档顺序把选区内的 DOM 重新序列化回 Markdown：一个块一行、块间空行，
// 顺序与正文一致，公式取回 LaTeX 源。
export function selectionMarkdown(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ''
  const range = sel.getRangeAt(0)
  const ca = range.commonAncestorContainer
  const base = ca instanceof Element ? ca : ca.parentElement
  const scope = base?.closest('.chat-msg-markdown')
  if (!scope) return selectionTextWithMath(sel)

  const blocks: Array<{ s: string; group?: Element }> = []
  let line = ''
  // 缓冲里只有列表标记、还没接到正文。松散列表（<li> 内套 <p>）会先走到内层的块收尾，
  // 这时若照常成块，标记就单独变成一行项目符号，正文被挤到下一段。
  let markerOnly = false
  // 当前列表项所属列表：项内的后续块仍要与该项用换行相接，别散成独立段落
  let curGroup: Element | undefined

  // prefix：该块每行前缀（引用 > / 嵌套列表缩进）；空行不加，避免尾随空格
  const push = (raw: string, prefix: string, group?: Element): void => {
    if (!raw.trim()) return
    blocks.push({ s: raw.split('\n').map(l => (l ? prefix + l : l)).join('\n'), group: group ?? curGroup })
  }
  const flush = (prefix: string, group?: Element): void => {
    if (markerOnly) return
    push(line.replace(/^[\s\u00a0]+/, '').replace(/[\s\u00a0]+$/, ''), prefix, group)
    line = ''
  }
  // 列表项收尾：整项没接到正文就连标记一起丢掉，不产出孤零零的「-」
  const endItem = (prefix: string, group: Element): void => {
    if (markerOnly) { line = ''; markerOnly = false; return }
    flush(prefix, group)
  }
  const add = (s: string): void => {
    if (!s) return
    // 标记尚未接到正文：跳过纯空白，免得元素间的排版空白把「-」和正文隔开
    if (markerOnly && !s.trim()) return
    line += s
    if (s.trim()) markerOnly = false
  }
  const setLine = (s: string): void => { line = s; markerOnly = false }
  // 选区两端的文本节点只取落在选区内的部分
  const edge = (n: Text): string => {
    let t = n.textContent ?? ''
    if (n === range.startContainer) t = t.slice(range.startOffset)
    if (n === range.endContainer) t = t.slice(0, range.endOffset)
    return t.replace(/\u00a0/g, ' ')
  }
  // 界面件不进引用：代码块头部（语言名、复制按钮）、行号列、图表 SVG
  const chrome = (el: Element): boolean =>
    el.tagName === 'BUTTON' || el.tagName === 'SVG' || el.tagName === 'INPUT' ||
    el.getAttribute('aria-hidden') === 'true' ||
    el.closest('.chat-code-header, .chat-code-line-nums, .agent-window-num') !== null
  const kids = (el: Element, prefix: string): void => el.childNodes.forEach(n => walk(n, prefix))
  // 行内片段：先取到临时缓冲，收成一行（表格单元格里不能带换行）
  const inline = (el: Element): string => {
    const saved = line
    line = ''
    kids(el, '')
    const s = line.replace(/\s+/g, ' ').trim()
    line = saved
    return s
  }
  const wrapped = (el: Element, open: string, close: string, prefix: string): void => {
    const saved = line
    line = ''
    kids(el, prefix)
    const s = line.replace(/^[\s\u00a0]+/, '').replace(/[\s\u00a0]+$/, '')
    line = saved + (s ? open + s + close : '')
    if (s.trim()) markerOnly = false
  }
  // 超长代码块走行窗口，DOM 里只有视口附近的行，逐行取回（行号列已在 chrome 中排除）
  const windowRows = (el: Element): string => {
    const win = el.querySelector('.agent-window')
    if (!win) return ''
    return [...win.querySelectorAll('.agent-window-row')].map(row =>
      [...row.childNodes]
        .filter(n => !(n instanceof Element && n.classList.contains('agent-window-num')))
        .map(n => n.textContent ?? '')
        .join('')
    ).join('\n')
  }
  const codeBlock = (el: Element, prefix: string): boolean => {
    if (!el.classList.contains('chat-code-block')) return false
    flush(prefix)
    const code = el.querySelector('.chat-code-pre code')
    const raw = code?.textContent || windowRows(el)
    const lang = /(?:^|\s)language-([\w+#._-]+)/i.exec(code?.className ?? '')?.[1] ?? ''
    if (raw.trim()) push(`\`\`\`${lang}\n${raw.replace(/\s+$/, '')}\n\`\`\``, prefix)
    return true
  }

  function walk(node: Node, prefix: string): void {
    if (!range.intersectsNode(node)) return
    if (node.nodeType === Node.TEXT_NODE) { add(edge(node as Text)); return }
    const el = node as Element
    // 公式根要先于界面件判定：KaTeX 的可视层带 aria-hidden
    if (el.classList.contains('katex')) { add(texOf(el) || (el.textContent ?? '')); return }
    if (chrome(el) || codeBlock(el, prefix)) return
    switch (el.tagName) {
      case 'BR': add('  \n'); return
      case 'HR': flush(prefix); push('---', prefix); return
      case 'CODE': wrapped(el, '`', '`', prefix); return
      case 'STRONG': case 'B': wrapped(el, '**', '**', prefix); return
      case 'EM': case 'I': wrapped(el, '*', '*', prefix); return
      case 'DEL': case 'S': case 'STRIKE': wrapped(el, '~~', '~~', prefix); return
      case 'A': add(`[${inline(el)}](${el.getAttribute('href') ?? ''})`); return
      case 'IMG': add(`![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`); return
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        flush(prefix)
        setLine('#'.repeat(Number(el.tagName[1])) + ' ')
        kids(el, prefix)
        flush(prefix)
        return
      }
      case 'BLOCKQUOTE':
        flush(prefix)
        kids(el, prefix + '> ')
        flush(prefix)
        return
      case 'UL': case 'OL': {
        flush(prefix)
        const items = [...el.children].filter(c => c.tagName === 'LI')
        items.forEach((li, i) => {
          const box = li.querySelector<HTMLInputElement>(':scope > input[type=checkbox]')
          const marker = box ? `- [${box.checked ? 'x' : ' '}] ` : el.tagName === 'OL' ? `${i + 1}. ` : '- '
          line = marker
          markerOnly = true
          const savedGroup = curGroup
          curGroup = el
          li.childNodes.forEach(n => {
            // 嵌套列表整体再缩进两格，与父项内容对齐
            if (n instanceof Element && (n.tagName === 'UL' || n.tagName === 'OL')) { endItem(prefix, el); walk(n, prefix + '  ') } else walk(n, prefix)
          })
          endItem(prefix, el)
          curGroup = savedGroup
        })
        return
      }
      case 'TABLE': {
        flush(prefix)
        // 表格只有一半选中也整表取回：缺表头分隔行就渲染不出表格
        const rows = [...el.querySelectorAll('tr')].map(tr => {
          const cells = [...tr.children].map(c => inline(c))
          return `| ${cells.join(' | ')} |`
        })
        const head = [...el.querySelectorAll('tr')][0]
        if (head) {
          const n = [...head.children].length
          rows.splice(1, 0, `| ${new Array(n).fill('---').join(' | ')} |`)
        }
        push(rows.join('\n'), prefix)
        return
      }
      case 'PRE': {
        flush(prefix)
        const raw = (el.textContent ?? '').replace(/\s+$/, '')
        if (raw.trim()) push(`\`\`\`\n${raw}\n\`\`\``, prefix)
        return
      }
      case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': {
        // 块级公式单独成块，别并进上下文
        if (el.classList.contains('math-block')) {
          flush(prefix)
          const k = el.querySelector('.katex')
          if (k) push(texOf(k), prefix)
          return
        }
        flush(prefix)
        kids(el, prefix)
        flush(prefix)
        return
      }
      default: kids(el, prefix)
    }
  }

  kids(scope, '')
  flush('')
  const glue = (i: number): string => (blocks[i].group && blocks[i - 1].group ? '\n' : '\n\n')
  const md = blocks.map((b, i) => (i === 0 ? b.s : glue(i) + b.s)).join('')
  return md.trim() || selectionTextWithMath(sel)
}
