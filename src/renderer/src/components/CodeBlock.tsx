import React, { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { Check, Copy, ChevronDown } from 'lucide-react'
import { WindowedText } from './agent-code/WindowedText'
import { highlightLines } from './agent-code/utils/highlightLines'
import { useThrottledValue } from '../utils/useThrottledValue'
import { useBubbleTip } from './useBubbleTip'
// 本组件是共享组件（Agent Code 消息与模型中心 README 都会渲染），样式跟着组件走，
// 原先寄存在 chat.css 里、靠 AgentCodeView 的静态引入才生效，已迁到自己的文件
import '../styles/code-block.css'

/**
 * 代码块组件：用 highlight.js 高亮，带语言标签、复制按钮和折叠/展开。
 * 供 markstream 的 code_block 节点覆写使用（见 ../markdown/markstream）。
 *
 * isStreaming 的语义由覆写组件按 `stream`（= <MarkdownRender> 的 codeBlockStream）透传：
 * 流式实例 true / 结束实例 false。
 *
 * 流式显示优化（isStreaming=true）：
 * 代码输出是「一卡一卡」的显示层根源——旧实现每次值变化都 textContent 全文替换 +
 * 整块 <pre> 重绘（几百行的块 × 每秒 25 次更新 = 每帧重绘整个块）。
 * 流式期间改为「逐行 span」渲染：稳定 key 让 React 只更新最后一行文本节点，
 * 浏览器 paint 区域收缩到最后一行；hljs 高亮推迟到值稳定（isStreaming 翻转）后
 * 一次性执行，避免流式中反复整块 innerHTML 替换。
 */
interface CodeBlockProps {
  language: string
  value: string
  showLineNumbers?: boolean
  isStreaming?: boolean
}

// 超过该行数即切换为行窗口（仅完成态）。取值理由：阈值以下逐行行号列 + 代码列的成本可接受，
// 且能保留原有折行视觉；阈值以上是「上千个 span + 两个完整行列表」的固定成本，展开即卡。
export const CODE_WINDOW_LINES = 300
// 与 .chat-code-window 的 12.5px × 1.6 对齐（见 styles/agent-code.css 末尾
// 「长内容行窗口：固定行高契约」）
const CODE_WINDOW_ROW_HEIGHT = 20
const CODE_WINDOW_VIEW_HEIGHT = 420

/** 流式高亮的节流窗口。流式期间本组件随每个 delta 批次重渲染，而 hljs 是整块 O(n) 计算
 *  （见本文件头部注释记录的代价）。120ms ≈ 8 次/秒，对「代码逐行变色」已足够连续。 */
const CODE_STREAM_HIGHLIGHT_MS = 120

export default function CodeBlock({ language, value, showLineNumbers, isStreaming }: CodeBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  // 收尾高亮推迟到「本块进入视口」再做。
  // 长回答里同时存在几十个代码块，流结束的那一次 commit 会让它们的 useEffect 全部同步
  // 执行——实测 30KB / 36 个块时 hljs 计算 19.0ms + innerHTML 整体替换（jsdom 下 75ms，
  // 真实 Chromium 约 8~15ms），合计一次 30~100ms 的主线程阻塞，正是「输出结束瞬间白一下」。
  // 只高亮视口附近的块：视口内通常 2~3 块，其余留纯文本，滚动到时再补。
  const [inView, setInView] = useState(false)

  // 长块降级判定必须放在下面两个 effect 之前：依赖数组在 render 期间求值，晚声明会触发 TDZ。
  const lines = useMemo(() => value.split('\n'), [value])
  const lineCount = lines.length
  // 流式分支与收尾分支的行盒数必须一致，否则任何一次「分支/实例切换」都会让代码块整体跳一行。
  // 实测（styles 全量生效下）：
  //   收尾分支走 hljs 的 innerHTML —— 末尾的 \n 在 <pre> 里不产生行盒 → 2 行 = 64px；
  //   流式分支把 split('\n') 的末尾空串渲染成 \u00A0 —— 多出一个 20px 行盒 → 3 行 = 84px。
  // 差值正好一行 20px，与「代码块底边每帧跳 20px」的现象完全吻合。
  // 这里让流式分支丢掉末尾空行，与收尾分支对齐（实测两者都变成 64px）。
  const codeLines = useMemo(
    () => (isStreaming && lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines),
    [lines, isStreaming]
  )
  // 流式高亮：整体高亮一次、再按行输出（见 utils/highlightLines 的 splitBalancedLines）。
  // 关键取舍：**只节流颜色，不节流文本** —— 渲染始终用当前的 codeLines，高亮快照只作为
  // 「这一行该染什么色」的来源。连文本一起节流会让代码块滞后一个窗口，反而丢掉顺滑感。
  const streamValue = useThrottledValue(value, [value], !!isStreaming, CODE_STREAM_HIGHLIGHT_MS)
  const streamHtml = useMemo(() => {
    if (!isStreaming) return null
    const h = highlightLines(streamValue, language, false)
    if (!h) return null
    // 末尾空行处理必须与 codeLines 一致，否则两个分支行盒数差 1、切换时整块跳一行。
    return streamValue.endsWith('\n') ? h.slice(0, -1) : h
  }, [isStreaming, streamValue, language])
  // 长块降级：整块 hljs 高亮是「一个 HTML 字符串塞进一个 <code>」，无法按行窗口化；逐行 hljs
  // 又会因跨行字符串 / 注释 / 模板串错色。所以超阈值的完成态块改为纯文本行窗口，头部标注已
  // 省略高亮，复制仍用完整原文。阈值以下完全走原路径（含语法高亮与折行）。
  const windowed = !isStreaming && lineCount > CODE_WINDOW_LINES
  // 流式态：逐行 span 只保证「只更新最后一行」，不保证 DOM 有界——行数持续增长时节点线性增加。
  // 超阈值同样改走行窗口 + 贴底跟随；阈值以下保留逐行 span（对短块它更省，且能逐行着色）。
  const streamingWindowed = !!isStreaming && lineCount > CODE_WINDOW_LINES
  const windowedAny = windowed || streamingWindowed

  useEffect(() => {
    if (isStreaming || windowed) return
    const el = rootRef.current
    if (!el) return
    // 无 IntersectionObserver（测试环境）时退化为立即高亮，保持旧行为
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) { setInView(true); io.disconnect() }
      },
      // 上下各留 300px 预取带：滚动到附近时高亮已就绪，不会看到「先纯文本后变色」
      { rootMargin: '300px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [isStreaming, windowed])

  // 完成态代码内容：能高亮就高亮，否则退回纯文本（转义后作为 HTML 注入）。
  //
  // 为什么不用「<code ref> + useEffect 里写 innerHTML」：effect 在**绘制之后**才执行，
  // 于是「流式结束 → 切到完成态」那一帧 <code> 还是空的，代码块先塌成一行（只剩 padding）
  // 再长回来 —— 实测到 pre 高度从 344px 掉到 24px 的单帧塌陷，肉眼就是一次明显闪动。
  // 改成渲染期算出 HTML：首次绘制就带着完整内容，不存在空帧；
  // 同时非视口内的块按上方注释的原意显示**纯文本**（旧实现其实渲染成了空块）。
  //
  // 未指定语言时不回退 highlightAuto：它会逐个尝试全部内置语法，实测比指定语言慢
  // 10~20 倍（683 字符 4.04ms vs 0.41ms），对 5KB 以上的块更甚；而它给 mermaid /
  // svg / 图表降级内容（这些块的语言标记本就是空串或非 hljs 语言）猜出来的结果也不准确。
  const codeHtml = useMemo(() => {
    if (isStreaming || windowed || !inView) return null
    try {
      if (language && hljs.getLanguage(language)) {
        const t0 = performance.now()
        const html = hljs.highlight(value, { language }).value
        const dt = performance.now() - t0
        if (dt > 10) console.debug(`[stream-diag] hljs ${dt.toFixed(1)}ms lang=${language} chars=${value.length}`)
        return html
      }
    } catch {
      /* 高亮失败退回纯文本 */
    }
    return null
  }, [value, language, isStreaming, windowed, inView])

  // 纯文本回退：手工转义，避免把代码里的尖括号当成 HTML 注入
  const plainHtml = useMemo(
    () => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    [value]
  )

  const handleCopy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const langLabel = language || 'text'

  return (
    <div ref={rootRef} className={`chat-code-block ${collapsed ? 'collapsed' : ''}`}>
      {tipNode}
      <div className="chat-code-header">
        <div className="chat-code-head-left">
          <button
            className="chat-code-toggle"
            onClick={() => setCollapsed(v => !v)}
            {...tip(collapsed ? '展开代码' : '收起代码')}
            aria-label={collapsed ? '展开代码' : '收起代码'}
          >
            <ChevronDown size={13} className={`agent-tool-chev ${collapsed ? '' : 'open'}`} />
          </button>
          <span className="chat-code-lang">{langLabel}</span>
          {(showLineNumbers || windowedAny) && (
            <span className="chat-code-line-count">
              {lineCount} 行{windowed ? ' · 窗口渲染，已省略语法高亮' : streamingWindowed ? ' · 流式窗口渲染' : ''}
            </span>
          )}
        </div>
        <button className="chat-code-copy" onClick={handleCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className={`chat-code-body ${showLineNumbers && !windowedAny ? 'with-lines' : ''} ${collapsed ? 'hidden' : ''}`}>
        {windowedAny ? (
          <WindowedText
            text={value}
            lineNumbers
            followTail={streamingWindowed}
            rowHeight={CODE_WINDOW_ROW_HEIGHT}
            viewHeight={CODE_WINDOW_VIEW_HEIGHT}
            className="agent-window chat-code-window"
            rowAttr="data-code-row"
            ariaLabel={`代码块（${streamingWindowed ? '流式' : ''}窗口渲染，共 ${lineCount} 行）`}
          />
        ) : (
          <>
            {showLineNumbers && (
              <pre className="chat-code-line-nums" aria-hidden="true">
                {codeLines.map((_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </pre>
            )}
            <pre className="chat-code-pre">
              {isStreaming ? (
                <code className={`code-streaming language-${langLabel}`}>
                  {codeLines.map((ln, i) => {
                    // 只取「已定型」行的高亮快照：最后一行仍在增长，快照可能落后于当前文本，
                    // 用它会把陈旧的半行内容显示出来。i < 快照末行下标 即视为已定型。
                    const html = streamHtml && i < streamHtml.length - 1 ? streamHtml[i] : undefined
                    return html !== undefined
                      ? <span key={i} dangerouslySetInnerHTML={{ __html: html || '\u00A0' }} />
                      : <span key={i}>{ln || '\u00A0'}</span>
                  })}
                </code>
              ) : (
                <code
                  className={`hljs language-${langLabel}`}
                  dangerouslySetInnerHTML={{ __html: codeHtml ?? plainHtml }}
                />
              )}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
