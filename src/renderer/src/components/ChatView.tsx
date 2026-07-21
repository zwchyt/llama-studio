import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import {
  Plus, Send, Square, Trash2, Pencil, MessageSquare,
  ChevronDown, Bot, PanelLeftClose, PanelLeftOpen, Brain, RefreshCw,
  Copy, Check, RotateCcw, ArrowDown, X, Eye, SlidersHorizontal, List, Play, Wrench,
  Paperclip, FileText, GitBranch, Search, Download, Volume2, ImageDown, Star
} from 'lucide-react'
import { useChatStore, buildOpenAiMessages, DEFAULT_PARAMS } from '../store/chatStore'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import { playNotificationSound } from '../utils/sound'
import { useTts } from '../utils/useTts'
import html2canvas from 'html2canvas'

import type { ChatSession, ChatMessage, ChatParams, ToolCallInfo, Attachment } from '../../../shared/types'
import { getToolDefinitions, executeToolCall } from '../utils/tools'
import type { ToolDefinition } from '../utils/tools'
import { getDocument } from 'pdfjs-dist'
import mammoth from 'mammoth'
import CodeBlock from './CodeBlock'
import ConfirmModal from './ConfirmModal'
// ── Markdown 文件预览 rehype-sanitize schema（同 AgentCodeView 配置）──
const FILE_PREVIEW_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), 'align', 'style'],
    p: [...(defaultSchema.attributes?.p || []), 'align', 'style'],
    span: [...(defaultSchema.attributes?.span || []), 'style'],
    img: [...(defaultSchema.attributes?.img || []), 'width', 'height', 'style', 'loading'],
    table: [...(defaultSchema.attributes?.table || []), 'style'],
    td: [...(defaultSchema.attributes?.td || []), 'style', 'colspan', 'rowspan'],
    th: [...(defaultSchema.attributes?.th || []), 'style', 'colspan', 'rowspan'],
    '*': [...(defaultSchema.attributes?.['*'] || []), 'style'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || ['http', 'https']), 'data'],
  },
}
import CustomSelect from './CustomSelect'

// 导入 worker 模块使其注册 globalThis.pdfjsWorker，pdfjs 的 fake worker 回退自动使用它
import 'pdfjs-dist/build/pdf.worker.js'
import '../styles/chat.css'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKatex as any, { throwOnError: false })
  .use(rehypeStringify, { allowDangerousHtml: true })

function markdownToHtml(text: string): string {
  try {
    const result = markdownProcessor.processSync(text)
    return String(result)
  } catch {
    return escapeHtml(text)
  }
}

// 流式文本缓冲区（模块级，不经过 React 状态，避免重渲染卡顿）
const streamingBuffer: Record<string, string> = {}
// 轻量同步：每 100ms 同步一次缓冲区到 store（仅用于思考链渲染，不频繁）
const streamSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
function lightStreamSync(sessionId: string, streamId: string): void {
  if (streamSyncTimers.has(streamId)) return
  streamSyncTimers.set(streamId, setTimeout(() => {
    streamSyncTimers.delete(streamId)
    const st = useChatStore.getState()
    const s = st.sessions.find(s => s.id === sessionId)
    if (!s) return
    const buf = streamingBuffer[streamId]
    if (buf) {
      const msgs = s.messages.map(m => m.id === streamId ? { ...m, content: buf } : m)
      st.replaceMessages(sessionId, msgs)
    }
  }, 50))
}

// 原生聊天仅允许使用 3 个只读/联网工具，绝不暴露 Agent Code 的文件/命令类工具
// （Write/Edit/Read/Bash 等）。白名单写死，确保无论全局注册了什么工具都不会泄露。
const CHAT_ALLOWED_TOOLS = ['get_datetime', 'web_search', 'fetch_webpage']

// 根据工具开关配置 + 原生聊天白名单过滤工具定义列表
function getEnabledToolDefinitions(): ToolDefinition[] {
  const all = getToolDefinitions()
  const cfg = useStore.getState().toolConfig
  if (!cfg.enabled) return []
  return all.filter(
    d => CHAT_ALLOWED_TOOLS.includes(d.function.name) && cfg.tools[d.function.name] !== false
  )
}

// ── 工具调用展示块（与 ThinkBlock 同构，可折叠）────
function ToolCallBlock({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="chat-tool">
      <button className="chat-tool-toggle" onClick={() => setExpanded(v => !v)}>
        <span className="chat-tool-status">
          <Wrench size={12} />
          工具调用（{toolCalls.length}）
        </span>
        <ChevronDown size={13} className={`chat-tool-chevron ${expanded ? 'open' : ''}`} />
      </button>
      <div className={`chat-tool-body ${expanded ? 'open' : ''}`}>
        {toolCalls.map((tc, i) => {
          let argsStr = tc.function.arguments
          try { argsStr = JSON.stringify(JSON.parse(tc.function.arguments), null, 2) } catch { /* keep raw */ }
          let resultStr = tc.result
          if (resultStr) {
            try { resultStr = JSON.stringify(JSON.parse(resultStr), null, 2) } catch { /* keep raw */ }
          }
          return (
            <div key={i} className="chat-tool-call">
              <div className="chat-tool-call-name">
                <Wrench size={11} />
                <span>{tc.function.name}</span>
              </div>
              {argsStr && argsStr !== '{}' && (
                <div className="chat-tool-call-args">{argsStr}</div>
              )}
              {resultStr && (
                <div className="chat-tool-call-result">{resultStr}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 工具开关卡片（控制工具调用是否可用，以及单个工具的开关）────
const TOOL_LABELS: Record<string, string> = {
  get_datetime: '获取当前时间',
  web_search: '搜索网页',
  fetch_webpage: '抓取网页内容',
}
const TOOL_ORDER = ['get_datetime', 'web_search', 'fetch_webpage']

function ToolToggleCard({ config, anchorRect, onClose, onChange }: {
  config: { enabled: boolean; tools: Record<string, boolean> }
  anchorRect: DOMRect | null
  onClose: () => void
  onChange: (config: { enabled: boolean; tools: Record<string, boolean> }) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const style: React.CSSProperties = { position: 'fixed', zIndex: 1100 }
  if (anchorRect) {
    style.top = anchorRect.bottom + 6
    style.right = window.innerWidth - anchorRect.right
  }

  const toggleMaster = () => onChange({ ...config, enabled: !config.enabled })
  const toggleTool = (name: string) => onChange({
    ...config,
    tools: { ...config.tools, [name]: !config.tools[name] }
  })

  const enabledCount = TOOL_ORDER.filter(k => config.tools[k]).length

  return (
    <div className="chat-tools-card" ref={cardRef} style={style}>
      <div className="chat-tools-card-header">
        <span className="chat-tools-card-title">工具调用</span>
      </div>

      {/* 总开关 */}
      <div className="chat-tools-master">
        <span className="chat-tools-master-label">启用工具调用</span>
        <label className="chat-tools-switch">
          <input type="checkbox" checked={config.enabled} onChange={toggleMaster} />
          <span className="chat-tools-switch-slider" />
        </label>
      </div>

      {config.enabled && (
        <div className="chat-tools-divider" />
      )}

      {/* 单个工具开关 */}
      {config.enabled && TOOL_ORDER.map(name => (
        <div key={name} className="chat-tools-item">
          <span className="chat-tools-item-label">{TOOL_LABELS[name] || name}</span>
          <label className="chat-tools-switch chat-tools-switch-sm">
            <input type="checkbox" checked={!!config.tools[name]} onChange={() => toggleTool(name)} />
            <span className="chat-tools-switch-slider" />
          </label>
        </div>
      ))}

      <div className="chat-tools-footer">
        <span className="chat-tools-footer-text">
          {config.enabled
            ? `已启用 ${enabledCount} 个工具`
            : '工具调用已关闭'}
        </span>
      </div>
    </div>
  )
}

// ── 会话时间格式化 ───────────────────────────────────────
function formatSessionTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sessionDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.floor((today.getTime() - sessionDay.getTime()) / 86400000)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diffDays === 0) return hhmm
  if (diffDays === 1) return `昨天 ${hhmm}`
  if (diffDays < 7) return `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]} ${hhmm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Markdown code 组件 ─────────────────────────────────────
// react-markdown v10 不再传 inline prop，用 className 是否含 language- 区分块级/行内
function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '')
  const match = /language-(\w+)/.exec(className || '')
  if (match) {
    return <CodeBlock language={match[1]} value={text} />
  }
  // 无 language class：若含换行则按块处理，否则按行内
  if (text.includes('\n')) {
    return <CodeBlock language="" value={text} />
  }
  return <code className="chat-code-in-line">{text}</code>
}

// 块级代码容器：直接透传 children，丢弃默认的 <pre> 包裹，
// 避免 CodeBlock 的 <div> 被非法嵌套进 <pre> 导致代码块错位。
function MarkdownPre({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

// 文件预览图片渲染器：处理相对路径图片（通过 ref 读取 fileBaseDirs）
let _fileBaseDirs = new Map<number, string>()
let _previewFileIdx = 0
function setPreviewFileBaseDirs(dirs: Map<number, string>, idx: number) {
  _fileBaseDirs = dirs
  _previewFileIdx = idx
}
function PreviewMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [dataSrc, setDataSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!src || /^(https?:|data:|file:\/\/|\/)/.test(src)) { setDataSrc(src); return }
    const dir = _fileBaseDirs.get(_previewFileIdx)
    if (!dir) { setDataSrc(src); return }
    const abs = (dir + '/' + src).replace(/\\/g, '/').replace(/\/+/g, '/')
    window.api.readFileBase64(abs).then(r => {
      setDataSrc(r.success ? r.dataUrl : src)
    }).catch(() => setDataSrc(src))
  }, [src])
  return <img src={dataSrc || src || ''} alt={alt || ''} style={{ maxWidth: '100%', height: 'auto' }} />
}

// ── 思考链（reasoning）解析 ─────────────────────────────────
// 把含 <think>...</think> 的内容切分成「普通文本 / 思考内容」片段序列。
// 支持流式中思考未闭合（只有 <think> 没有 </think>）的情况。
type ContentSegment = { type: 'text'; value: string } | { type: 'think'; value: string; closed: boolean }
function parseThinkSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  let rest = content
  while (rest.length > 0) {
    const openIdx = rest.indexOf('<think>')
    if (openIdx === -1) {
      // 没有更多 think 标签，剩余全是正文
      if (rest.trim()) segments.push({ type: 'text', value: rest })
      break
    }
    // openIdx 之前的正文
    if (openIdx > 0 && rest.slice(0, openIdx).trim()) {
      segments.push({ type: 'text', value: rest.slice(0, openIdx) })
    }
    rest = rest.slice(openIdx + '<think>'.length)
    const closeIdx = rest.indexOf('</think>')
    if (closeIdx === -1) {
      // 思考尚未闭合（流式进行中）
      segments.push({ type: 'think', value: rest, closed: false })
      break
    }
    segments.push({ type: 'think', value: rest.slice(0, closeIdx), closed: true })
    rest = rest.slice(closeIdx + '</think>'.length)
  }
  return segments
}

// ── 流式 Markdown 半截保护（借鉴 DeepSeek-Reasonix 的 flushableMarkdownPrefix）──
// 流式输出时，正文可能以「未闭合的 Markdown」结尾（如未闭合的 ``` 代码块、
// 未完成的表格行），直接交给 ReactMarkdown 会渲染出残缺/闪烁的样式。
// 这里把内容切成「已安全闭合的前缀」+「末尾未闭合的残留」，残留部分用纯文本暂显，
// 待流结束（isStreaming=false）再由原 renderSegments 用完整 ReactMarkdown 渲染。
type SafeSplit = { safe: string; pending: string }

// 判断文本中是否包含未闭合的围栏代码块（``` 出现奇数次）
function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/^```/gm)?.length ?? 0
  return fences % 2 === 1
}

// 在最后一个「完整块边界」处切分：优先在空行边界切，若末尾处于未闭合代码块内则回退到代码块起点。
function splitMarkdownAtSafeBoundary(text: string): SafeSplit {
  if (!text) return { safe: '', pending: '' }
  // 没有未闭合代码块时，整段都是安全的（段落/列表在 ReactMarkdown 中增量渲染也稳定）
  if (!hasUnclosedFence(text)) {
    return { safe: text, pending: '' }
  }
  // 有未闭合代码块：找到最后一个 ``` 起始位置，把之前的完整内容作为 safe
  const lastFence = text.lastIndexOf('```')
  // 该 ``` 是未闭合的开围栏，其后的内容全部视为 pending
  const safe = text.slice(0, lastFence)
  const pending = text.slice(lastFence)
  // 若 safe 末尾不洁净（紧接代码块），仍保留；safe 部分不含未闭合围栏，可安全渲染
  return { safe, pending }
}

// 流式正文渲染：已闭合部分用 ReactMarkdown，未闭合残留用 <pre> 暂显，避免闪烁。
const SafeStreamMarkdown = React.memo(function SafeStreamMarkdown({ text }: { text: string }) {
  const { safe, pending } = useMemo(() => splitMarkdownAtSafeBoundary(text), [text])
  return (
    <>
      {safe ? (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: MarkdownCode as any, pre: MarkdownPre as any }}>
          {safe}
        </ReactMarkdown>
      ) : null}
      {pending ? (
        <pre className="streaming-raw" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
          {pending}
        </pre>
      ) : null}
    </>
  )
})

// 思考块：可折叠（流式时自动展开，完成后自动折叠）
const THINK_THROTTLE_MS = 120 // 流式文本节流间隔，避免每个 delta 都重渲染长文本

const ThinkBlock = React.memo(function ThinkBlock({ value, closed, isStreaming, autoExpand }: { value: string; closed: boolean; isStreaming?: boolean; autoExpand?: boolean }) {
  const [expanded, setExpanded] = useState(autoExpand ?? false)
  const [visible, setVisible] = useState(autoExpand ?? false)
  const userToggledRef = useRef(false)
  const thinking = !closed || isStreaming
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 节流显示文本：流式时按固定间隔更新，避免每个 token 都触发长文本重排
  const [displayValue, setDisplayValue] = useState(value)
  useEffect(() => {
    if (!thinking) {
      setDisplayValue(value)
      return
    }
    setDisplayValue(value)
    const timer = setInterval(() => {
      setDisplayValue(value)
    }, THINK_THROTTLE_MS)
    return () => clearInterval(timer)
  }, [value, thinking])

  // 流式思考时自动滚动到底部
  useEffect(() => {
    if (thinking && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [displayValue, thinking, expanded])

  // 展开/折叠动画：展开时先设 visible=true 再设 expanded=true；
  // 折叠时先设 expanded=false 触发 CSS 过渡，等动画结束后再设 visible=false 移除 DOM
  useEffect(() => {
    if (userToggledRef.current) return
    if (thinking) {
      clearTimeout(collapseTimerRef.current)
      setVisible(true)
      requestAnimationFrame(() => setExpanded(true))
    } else {
      setExpanded(false)
      collapseTimerRef.current = setTimeout(() => setVisible(false), 300)
    }
  }, [thinking])

  // 思考阶段结束时重置手动标记，下次可再次自动展开
  const prevThinkingRef = useRef(thinking)
  useEffect(() => {
    if (prevThinkingRef.current && !thinking) {
      userToggledRef.current = false
    }
    prevThinkingRef.current = thinking
  }, [thinking])

  const handleToggle = () => {
    userToggledRef.current = true
    if (expanded) {
      setExpanded(false)
      collapseTimerRef.current = setTimeout(() => setVisible(false), 300)
    } else {
      setVisible(true)
      requestAnimationFrame(() => setExpanded(true))
    }
  }

  // 停止生成但思考链未闭合 → 显示"已停止"
  const wasStopped = !thinking && !closed

  return (
    <div className={`chat-think ${thinking ? 'thinking' : ''} ${expanded ? 'expanded' : ''} ${wasStopped ? 'stopped' : ''}`}>
      <button className="chat-think-toggle" onClick={handleToggle}>
        {thinking ? (
          <span className="chat-think-status">
            <RefreshCw size={12} className="spin" />
            思考中
          </span>
        ) : wasStopped ? (
          <span className="chat-think-status">
            <Brain size={12} />
            思考已中断
          </span>
        ) : (
          <span className="chat-think-status">
            <Brain size={12} />
            思考过程
          </span>
        )}
        <ChevronDown size={13} className={`chat-think-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {visible && (
        <div className={`chat-think-body chat-msg-markdown ${expanded ? 'open' : ''}`} ref={bodyRef}>
          {displayValue ? (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: MarkdownCode as any, pre: MarkdownPre as any }}>
              {displayValue}
            </ReactMarkdown>
          ) : '（空）'}
        </div>
      )}
    </div>
  )
})

// ── 用户消息内容解析（代码块 + 行内代码 + 纯文本）──────────
type UserBlock =
  | { type: 'code'; lang: string; code: string }
  | { type: 'text'; text: string }

// 缩进代码块检测：连续 2+ 行以 4 空格或 Tab 开头，自动识别为代码块
function parseIndentedBlocks(text: string): UserBlock[] {
  const lines = text.split('\n')
  const blocks: UserBlock[] = []
  let textBuf: string[] = []
  let codeBuf: string[] = []
  let inCode = false

  const flushText = () => {
    if (textBuf.length > 0) {
      blocks.push({ type: 'text', text: textBuf.join('\n') })
      textBuf = []
    }
  }
  const flushCode = () => {
    if (codeBuf.length > 0) {
      const code = codeBuf.map(l => l.replace(/^( {4}|\t)/, '')).join('\n').replace(/^\n+|\n+$/g, '')
      blocks.push({ type: 'code', lang: '', code })
      codeBuf = []
    }
    inCode = false
  }

  for (const line of lines) {
    const indented = /^( {4,}|\t)/.test(line)
    if (indented) {
      codeBuf.push(line)
      if (!inCode && codeBuf.length >= 2) {
        flushText()
        inCode = true
      }
    } else {
      if (inCode) {
        flushCode()
      } else {
        // 未确认代码块前，缩进行先归入文本缓冲区
        if (codeBuf.length > 0) {
          textBuf.push(...codeBuf)
          codeBuf = []
        }
        textBuf.push(line)
      }
    }
  }
  if (inCode) flushCode()
  else {
    if (codeBuf.length > 0) textBuf.push(...codeBuf)
    flushText()
  }
  return blocks
}

// ── 预处理：让粘贴/输入的代码内容自动变成缩进代码块 ──────
const codePatterns = [
  /^(#include|#define|#ifndef|#ifdef|#endif)/,
  /^(import\s|from\s+\S+\s+import|export\s)/,
  /^(using\s+namespace|package\s)/,
  /^(public\s+class|private\s+class|class\s+\w+)/,
  /^(def\s+\w+\s*\(|function\s+\w+\s*\()/,
  /^(int|void|char|float|double|bool|auto|string|var|let|const)\s+\w+/,
  /[{};]\s*(\/\/.*)?$/,
  /(<<|>>|::|&&|\|\||=>|->)/
]

function preprocessInput(raw: string): string {
  // 已有围栏代码块 → 不动
  if (/(?:^|\n)```/.test(raw)) return raw

  const lines = raw.split('\n')

  // 已有缩进代码块（连续 2+ 行缩进）且所有内容都已缩进 → 不动
  // 但如果存在混合缩进（部分行有缩进、部分没有），仍需给所有行加缩进
  let indentRun = 0
  let hasIndent = false
  let hasNonIndent = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue // 空行不参与判断
    if (/^( {4,}|\t)/.test(line)) {
      hasIndent = true
      indentRun++
    } else {
      hasNonIndent = true
      indentRun = 0
    }
  }
  // 只有全部非空行都已缩进时才跳过
  if (hasIndent && !hasNonIndent) return raw
  // 已有连续缩进且没有未缩进行 → 跳过
  if (indentRun >= 2 && !hasNonIndent) return raw

  // 少于 2 行非空行 → 不动
  const nonEmpty = lines.filter(l => l.trim() !== '')
  if (nonEmpty.length < 2) return raw

  // 检测代码特征命中比例
  let matchCount = 0
  for (const line of nonEmpty) {
    const trimmed = line.trim()
    if (codePatterns.some(p => p.test(trimmed))) matchCount++
  }

  // 超过 30% 非空行命中代码特征 → 自动加 4 空格缩进
  if (matchCount / nonEmpty.length > 0.3) {
    return lines.map(l => '    ' + l).join('\n')
  }

  return raw
}

function parseUserContent(content: string): UserBlock[] {
  // 第一步：用已闭合的围栏代码块（```...```）切分
  const fenceRe = /```(\w*)\s*\r?\n([\s\S]*?)```/g
  const rawSegments: UserBlock[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(content)) !== null) {
    if (m.index > lastIdx) {
      rawSegments.push({ type: 'text', text: content.slice(lastIdx, m.index) })
    }
    rawSegments.push({ type: 'code', lang: m[1] || '', code: m[2] })
    lastIdx = m.index + m[0].length
  }

  // 检查剩余内容中是否存在未闭合的围栏（有 opening ``` 但无 closing）
  // 支持用户刚打完 ```lang 尚未按回车的场景
  if (lastIdx < content.length) {
    const remaining = content.slice(lastIdx)
    const openMatch = remaining.match(/```(\w*)\s*(?:\r?\n|$)/)
    if (openMatch) {
      const openIdx = openMatch.index!
      // opening 之前的文本
      if (openIdx > 0) {
        rawSegments.push({ type: 'text', text: remaining.slice(0, openIdx) })
      }
      // opening 之后的内容全部视为未闭合的代码块
      const afterOpen = remaining.slice(openIdx + openMatch[0].length)
      rawSegments.push({ type: 'code', lang: openMatch[1] || '', code: afterOpen })
    } else {
      rawSegments.push({ type: 'text', text: remaining })
    }
  }

  // 第二步：在每个纯文本片段内检测缩进代码块
  const result: UserBlock[] = []
  for (const seg of rawSegments) {
    if (seg.type === 'code') {
      result.push(seg)
    } else {
      result.push(...parseIndentedBlocks(seg.text))
    }
  }
  return result
}

// 将纯文本片段切分为「普通文本 / 行内代码」序列
function renderTextWithInlineCode(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const inlineRe = /`([^`\n]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<code key={m.index} className="chat-code-inline">{m[1]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const UserMessageContent = React.memo(function UserMessageContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseUserContent(content), [content])
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <CodeBlock key={i} language={block.lang} value={block.code} />
        }
        return <span key={i} className="user-text">{renderTextWithInlineCode(block.text)}</span>
      })}
    </>
  )
})

// ── 单条消息 ───────────────────────────────────────────────
const MessageBubble = React.memo(function MessageBubble({ msg, isStreaming, onCopy, onEdit, onRegenerate, regenDisabled, onContinue, continueDisabled, onDelete, deleteDisabled, onImageClick, onBranch, serverPort, speakingId, onSpeak, onStopTts }: {
  msg: ChatMessage
  isStreaming?: boolean
  onCopy?: () => void
  onEdit?: () => void
  onRegenerate?: () => void
  regenDisabled?: boolean
  onContinue?: () => void
  continueDisabled?: boolean
  onDelete?: () => void
  deleteDisabled?: boolean
  onImageClick?: (url: string) => void
  onBranch?: () => void
  serverPort?: number
  speakingId?: string | null
  onSpeak?: (id: string, text: string) => void
  onStopTts?: () => void
}) {
  const isUser = msg.role === 'user'
  const [copied, setCopied] = useState(false)

  // 助手消息解析思考链片段（含 <think>...</think>）
  const segments = useMemo(
    () => (!isUser ? parseThinkSegments(msg.content) : []),
    [isUser, msg.content]
  )

  const handleCopy = () => {
    // 助手消息只复制正文，排除思考链内容
    const text = isUser
      ? msg.content
      : parseThinkSegments(msg.content)
        .filter(s => s.type === 'text')
        .map(s => s.value)
        .join('\n\n')
        .trim()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    onCopy?.()
  }

  // 共享：渲染思考链 + 正文片段序列
  const renderSegments = (streaming: boolean) => (
    segments.map((seg, i) => {
      if (seg.type === 'think') {
        // 流已中断时，未闭合的思考链视为已结束
        const effectiveClosed = streaming ? seg.closed : true
        return <ThinkBlock key={i} value={seg.value} closed={effectiveClosed} isStreaming={streaming && !seg.closed} />
      }
      if (streaming) {
        // 流式阶段：用 SafeStreamMarkdown 保护未闭合的 Markdown（如半截代码块）
        return (
          <div key={i} className="chat-msg-markdown">
            <SafeStreamMarkdown text={seg.value} />
          </div>
        )
      }
      return (
        <div key={i} className="chat-msg-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: MarkdownCode as any, pre: MarkdownPre as any }}>
            {seg.value}
          </ReactMarkdown>
        </div>
      )
    })
  )

  // 流式中不显示操作栏
  if (isStreaming) {
    return (
      <>
        <div className="chat-msg chat-msg-assistant" data-msg-id={msg.id}>
          <div className="chat-msg-avatar"><Bot size={14} /></div>
          <div className="chat-msg-body">
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <ToolCallBlock toolCalls={msg.toolCalls} />
            )}
            {msg.content ? (
              <>
                {renderSegments(true)}
                {segments.length > 0 && segments[segments.length - 1].type === 'text' && <span className="chat-cursor" />}
              </>
            ) : (
              <div className="chat-msg-placeholder">
                <span className="chat-typing-dots" />
              </div>
            )}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className={`chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}`} data-msg-id={msg.id}>
        {!isUser && (
          <div className="chat-msg-avatar">
            <Bot size={14} />
          </div>
        )}
        <div className="chat-msg-body">
          {isUser ? (
            <>
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="chat-msg-attachments">
                  {msg.attachments.map((att, i) => (
                    att.type === 'image' ? (
                      <div key={i} className="chat-attachment-box chat-attachment-image" style={{ cursor: 'pointer' }} onClick={() => onImageClick?.(att.dataUrl!)}>
                        <img src={att.dataUrl} alt={att.name} className="chat-attachment-img" />
                        <span className="chat-attachment-name">{att.name}</span>
                      </div>
                    ) : (
                      <div key={i} className="chat-attachment-box">
                        <FileText size={14} />
                        <span className="chat-attachment-name">{att.name}</span>
                      </div>
                    )
                  ))}
                </div>
              )}
              <div className="chat-msg-bubble chat-msg-bubble-user"><UserMessageContent content={msg.content} /></div>
            </>
          ) : msg.error ? (
            <div className="chat-msg-error">{msg.content}</div>
          ) : msg.content || msg.toolCalls ? (
            <>
              {/* 工具调用块（显示在最上方） */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <ToolCallBlock toolCalls={msg.toolCalls} />
              )}
              {/* 工具调用后的内容（思考过程 + 模型回答），工具调用前的内容不显示 */}
              {msg.content && (
                msg.toolCalls && msg.preToolContentLen != null
                  ? (() => {
                    const postContent = msg.content.slice(msg.preToolContentLen)
                    if (!postContent) return null
                    const postSegs = parseThinkSegments(postContent)
                    return postSegs.map((seg, i) => {
                      if (seg.type === 'think') {
                        return <ThinkBlock key={`post-${i}`} value={seg.value} closed={true} isStreaming={false} />
                      }
                      return (
                        <div key={`post-${i}`} className="chat-msg-markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: MarkdownCode as any, pre: MarkdownPre as any }}>
                            {seg.value}
                          </ReactMarkdown>
                        </div>
                      )
                    })
                  })()
                  : renderSegments(false)
              )}
              {msg.stopped && (
                <div className="chat-msg-stopped-badge">
                  <Square size={10} />
                  <span>已停止生成</span>
                </div>
              )}
              {/* Token 统计信息 */}
              {!msg.error && msg.content && (msg.tokensDecoded != null || msg.msFirstToken != null || msg.decodeTokS != null) && (
                <div className="chat-msg-token-stats">
                  {msg.decodeTokS != null && <span>{typeof msg.decodeTokS === 'number' ? msg.decodeTokS.toFixed(1) : msg.decodeTokS} tok/s</span>}
                  {msg.tokensDecoded != null && <span>{msg.tokensDecoded} tokens</span>}
                  {msg.msFirstToken != null && <span>TTFT {msg.msFirstToken}ms</span>}
                  <ContextBar port={serverPort} />
                </div>
              )}
            </>
          ) : (
            <div className="chat-msg-placeholder">（空回复）</div>
          )}
          {/* 悬停操作栏 */}
          {(msg.content || (msg.attachments && msg.attachments.length > 0)) && !msg.error && (
            <div className="chat-msg-actions">
              {msg.content && (
                <button className="chat-msg-action-btn" onClick={handleCopy}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}
              {!isUser && msg.content && (
                <button
                  className="chat-msg-action-btn"
                  onClick={() => {
                    if (speakingId === msg.id) onStopTts?.()
                    else {
                      const text = parseThinkSegments(msg.content)
                        .filter(s => s.type === 'text')
                        .map(s => s.value)
                        .join('\n')
                        .trim()
                      if (text) onSpeak?.(msg.id, text)
                    }
                  }}
                >
                  <Volume2 size={13} />
                </button>
              )}
              {isUser && onEdit && (
                <button className="chat-msg-action-btn" onClick={onEdit}>
                  <Pencil size={13} />
                </button>
              )}
              {!isUser && onRegenerate && (
                <button
                  className="chat-msg-action-btn"
                  onClick={onRegenerate}
                  disabled={regenDisabled}
                  style={regenDisabled ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              {!isUser && onContinue && (
                <button
                  className="chat-msg-action-btn"
                  onClick={onContinue}
                  disabled={continueDisabled}
                  style={continueDisabled ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
                >
                  <Play size={13} />
                </button>
              )}
              {!isUser && onDelete && (
                <button
                  className="chat-msg-action-btn"
                  onClick={onDelete}
                  disabled={deleteDisabled}
                  style={deleteDisabled ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
                >
                  <Trash2 size={13} />
                </button>
              )}
              {!isUser && onBranch && (
                <button
                  className="chat-msg-action-btn"
                  onClick={onBranch}
                >
                  <GitBranch size={13} />
                </button>
              )}
            </div>
          )}
        </div>
        {isUser && (
          <div className="chat-msg-avatar chat-msg-avatar-user">
            <span style={{ fontSize: 12, fontWeight: 700 }}>我</span>
          </div>
        )}
      </div>
    </>
  )
})

// ── 左栏：会话列表 ─────────────────────────────────────────
function SessionList({ sessions, activeId, onSelect, onNew, onRename, onDeleteRequest, runningModels, streamingSessionIds, onToggleStar }: {
  sessions: ChatSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDeleteRequest: (session: ChatSession) => void
  runningModels: Array<{ id: string; name: string; port: number }>
  streamingSessionIds: string[]
  onToggleStar: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [exportMenuId, setExportMenuId] = useState<string | null>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭导出菜单
  useEffect(() => {
    if (!exportMenuId) return
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuId(null)
      }
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [exportMenuId])

  function exportSession(s: ChatSession, format: 'json' | 'md'): void {
    let content: string
    let ext: string
    let mime: string
    if (format === 'json') {
      content = JSON.stringify(s, null, 2)
      ext = 'json'
      mime = 'application/json'
    } else {
      const lines: string[] = [`# ${s.title}`, '', `导出时间: ${new Date().toLocaleString()}`, `模型: ${s.templateId || '未知'}`, '']
      for (const m of s.messages) {
        if (m.role === 'user') lines.push(`## 用户\n\n${m.content}\n`)
        else if (m.role === 'assistant') lines.push(`## 助手\n\n${m.content}\n`)
      }
      content = lines.join('\n')
      ext = 'md'
      mime = 'text/markdown'
    }
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${s.title || '会话'}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
    setExportMenuId(null)
  }

  const filteredSessions = useMemo(() => {
    let list = sessions
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = sessions.filter(s => {
        if (s.title.toLowerCase().includes(q)) return true
        return s.messages.some(m => m.content && m.content.toLowerCase().includes(q))
      })
    }
    return [...list].sort((a, b) => {
      if (a.starred && !b.starred) return -1
      if (!a.starred && b.starred) return 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  }, [sessions, searchQuery])

  const startEdit = (s: ChatSession) => {
    setEditingId(s.id)
    setEditValue(s.title)
  }
  const commitEdit = () => {
    if (editingId) onRename(editingId, editValue)
    setEditingId(null)
  }

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-title">会话</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={onNew}
        >
          <Plus size={13} /> 新建
        </button>
      </div>
      <div className="chat-sidebar-search">
        <Search size={13} className="chat-sidebar-search-icon" />
        <input
          className="chat-sidebar-search-input"
          type="text"
          placeholder="搜索会话…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="chat-sidebar-search-clear" onClick={() => setSearchQuery('')}>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="chat-session-list">
        {filteredSessions.length === 0 ? (
          <div className="chat-session-empty">
            {searchQuery ? '未找到匹配的会话' : '点击「新建」开始第一个对话。'}
          </div>
        ) : filteredSessions.map((s) => {
          const model = runningModels.find((m) => m.id === s.templateId)
          const isStreaming = streamingSessionIds.includes(s.id)
          const state = isStreaming ? 'streaming' : (model ? 'running' : 'stopped')
          return (
            <div
              key={s.id}
              className={`chat-session-item ${activeId === s.id ? 'active' : ''} ${state}`}
              onClick={() => onSelect(s.id)}
            >
              <div className={`chat-session-indicator ${state}`} />
              {editingId === s.id ? (
                <div className="chat-session-main">
                  <div className="chat-session-name">
                    {s.starred && <Star size={11} fill="#f5c518" color="#f5c518" style={{ marginRight: 4, flexShrink: 0 }} />}
                    <input
                      className="chat-session-edit"
                      value={editValue}
                      autoFocus
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                      onBlur={commitEdit}
                    />
                  </div>
                  <div className="chat-session-time">{formatSessionTime(s.updatedAt)}</div>
                </div>
              ) : (
                <>
                  <div className="chat-session-main">
                    <div className="chat-session-name">
                      {s.starred && <Star size={11} fill="#f5c518" color="#f5c518" style={{ marginRight: 4, flexShrink: 0 }} />}
                      {s.title}
                    </div>
                    <div className="chat-session-time">{formatSessionTime(s.updatedAt)}</div>
                  </div>
                  <div className="chat-session-actions">
                    <button
                      className="chat-session-btn"
                      onClick={(e) => { e.stopPropagation(); onToggleStar(s.id) }}
                    >
                      <Star size={12} fill={s.starred ? '#f5c518' : 'transparent'} color={s.starred ? '#f5c518' : '#888'} />
                    </button>
                    <button
                      className="chat-session-btn"
                      onClick={(e) => { e.stopPropagation(); setExportMenuId(exportMenuId === s.id ? null : s.id) }}
                    >
                      <Download size={12} />
                    </button>
                    {exportMenuId === s.id && (
                      <div className="chat-session-export-menu" ref={exportMenuRef}>
                        <button onClick={(e) => { e.stopPropagation(); exportSession(s, 'json') }}>导出 JSON</button>
                        <button onClick={(e) => { e.stopPropagation(); exportSession(s, 'md') }}>导出 Markdown</button>
                      </div>
                    )}
                    <button
                      className="chat-session-btn"
                      onClick={(e) => { e.stopPropagation(); startEdit(s) }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="chat-session-btn danger"
                      onClick={(e) => { e.stopPropagation(); onDeleteRequest(s) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 参数/系统提示词设置弹窗 ───────────────────────────────
const PARAM_CONFIG: Array<{
  key: keyof ChatParams
  label: string
  min: number
  max: number
  step: number
  defaultVal: number
}> = [
    { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, defaultVal: DEFAULT_PARAMS.temperature ?? 0.8 },
    { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05, defaultVal: DEFAULT_PARAMS.top_p ?? 0.95 },
    { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, defaultVal: DEFAULT_PARAMS.top_k ?? 40 },
    { key: 'max_tokens', label: 'Max Tokens', min: 0, max: 8192, step: 1, defaultVal: 0 },
    { key: 'repeat_penalty', label: 'Repeat Penalty', min: 0, max: 2, step: 0.1, defaultVal: DEFAULT_PARAMS.repeat_penalty ?? 1.1 },
  ]

function ChatSettingsCard({ session, anchorRect, onClose, onSetSystemPrompt, onSetParams }: {
  session: ChatSession | null
  anchorRect: DOMRect | null
  onClose: () => void
  onSetSystemPrompt: (prompt: string) => void
  onSetParams: (params: Partial<ChatParams>) => void
}) {
  const [sysPrompt, setSysPrompt] = useState(session?.systemPrompt || '')
  const [params, setLocalParams] = useState<ChatParams>(session ? { ...session.params } : { ...DEFAULT_PARAMS })
  const cardRef = useRef<HTMLDivElement>(null)

  const handleSysPromptBlur = () => {
    if (!session) return
    if (sysPrompt !== (session.systemPrompt || '')) {
      onSetSystemPrompt(sysPrompt)
    }
  }

  const handleParamChange = (key: keyof ChatParams, val: number) => {
    if (!session) return
    const next = { ...params, [key]: val }
    setLocalParams(next)
    onSetParams({ [key]: val })
  }

  const handleReset = () => {
    if (!session) return
    setLocalParams({ ...DEFAULT_PARAMS })
    onSetParams(DEFAULT_PARAMS)
  }

  const sysPromptRef = useRef(sysPrompt)
  useEffect(() => { sysPromptRef.current = sysPrompt }, [sysPrompt])

  const handleClose = useCallback(() => {
    if (session && sysPromptRef.current !== (session.systemPrompt || '')) {
      onSetSystemPrompt(sysPromptRef.current)
    }
    onClose()
  }, [session, onSetSystemPrompt, onClose])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }
    // 延迟注册避免触发当前 click
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [handleClose])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  // 计算卡片位置：在按钮下方，右对齐
  const style: React.CSSProperties = { position: 'fixed', zIndex: 1100 }
  if (anchorRect) {
    style.top = anchorRect.bottom + 6
    style.right = window.innerWidth - anchorRect.right
  }

  return (
    <div className="chat-settings-card" ref={cardRef} style={style}>
      {!session ? (
        <div className="chat-settings-empty">
          <SlidersHorizontal size={24} strokeWidth={1.2} style={{ opacity: 0.3 }} />
          <p>请先选择或创建一个会话</p>
        </div>
      ) : (
        <>
          <div className="chat-settings-card-header">
            <span className="chat-settings-card-title">会话参数</span>
            <button className="chat-settings-card-reset" onClick={handleReset}>恢复默认</button>
          </div>

          {/* System Prompt */}
          <div className="chat-settings-section">
            <label className="chat-settings-label">System Prompt</label>
            <textarea
              className="chat-settings-textarea"
              value={sysPrompt}
              onChange={(e) => setSysPrompt(e.target.value)}
              onBlur={handleSysPromptBlur}
              placeholder="设置系统提示词…"
              rows={3}
            />
          </div>

          {/* 参数滑块 */}
          {PARAM_CONFIG.map(({ key, label, min, max, step, defaultVal }) => {
            // max_tokens: UI 用 0 表示「无限」，内部存储 -1
            const rawVal = (params[key] ?? defaultVal) as number
            const val = key === 'max_tokens' && rawVal < 0 ? 0 : rawVal
            const displayVal = key === 'max_tokens' && val <= 0 ? '无限' : val
            return (
              <div className="chat-settings-param" key={String(key)}>
                <div className="chat-settings-param-header">
                  <span className="chat-settings-param-name">{label}</span>
                  <span className="chat-settings-param-value">{displayVal}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={val}
                  onChange={(e) => {
                    const decimals = (String(step).split('.')[1] || '').length
                    const factor = 10 ** decimals
                    let v = Math.round(parseFloat(e.target.value) * factor) / factor
                    // max_tokens: 0 → -1（无限）
                    if (key === 'max_tokens' && v <= 0) v = -1
                    handleParamChange(key, v)
                  }}
                />
              </div>
            )
          })}

          <div className="chat-settings-hint">参数在下次发送消息时生效，无需重启模型</div>
        </>
      )}
    </div>
  )
}

// ── 消息导航侧边栏（minimap 式竖椭圆导航）─────────────────
const MessageNav = React.memo(function MessageNav({
  messages, activeMsgId, containerRef
}: {
  messages: ChatMessage[]
  activeMsgId: string | null
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const [hovered, setHovered] = useState(false)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [viewportRatio, setViewportRatio] = useState(1)
  const [nodes, setNodes] = useState<{ topRatio: number; msg: ChatMessage }[]>([])
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const userMsgs = useMemo(() => messages.filter(m => m.role === 'user'), [messages])
  const userCount = userMsgs.length

  // 面板实际高度（同步测量）
  const [panelHeight, setPanelHeight] = useState(0)
  useLayoutEffect(() => {
    if (panelRef.current) setPanelHeight(panelRef.current.clientHeight)
  }, [hovered])

  // 跟踪滚动容器的滚动位置，计算各消息圆点位置
  useEffect(() => {
    const el = containerRef.current
    if (!el || userCount < 2) return
    const update = () => {
      const totalH = el.scrollHeight
      const clientH = el.clientHeight
      const scrollable = totalH - clientH
      setScrollRatio(scrollable > 0 ? el.scrollTop / scrollable : 0)
      setViewportRatio(clientH / totalH)
      if (totalH <= 0) { setNodes([]); return }
      const msgEls = el.querySelectorAll<HTMLElement>('[data-msg-id]')
      const msgMap = new Map(userMsgs.map(m => [m.id, m]))
      const newNodes: { topRatio: number; msg: ChatMessage }[] = []
      const containerRect = el.getBoundingClientRect()
      msgEls.forEach((msgEl) => {
        const msgId = msgEl.dataset.msgId
        const msg = msgId ? msgMap.get(msgId) : undefined
        if (!msg) return
        const rect = msgEl.getBoundingClientRect()
        const top = rect.top - containerRect.top + el.scrollTop
        newNodes.push({ topRatio: top / totalH, msg })
      })
      setNodes(newNodes)
    }
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    update()
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [containerRef, userMsgs, userCount])

  const handleEnter = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    setHovered(true)
  }, [])

  const handleLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => { setHovered(false) }, 600)
  }, [])

  const handleClick = useCallback((msgId: string) => {
    const el = containerRef.current?.querySelector(`[data-msg-id="${msgId}"]`)
    if (el && containerRef.current) {
      const top = (el as HTMLElement).offsetTop - containerRef.current.offsetTop - 20
      containerRef.current.scrollTop = top
    }
  }, [containerRef])

  if (userCount < 2) return null

  // 椭圆面板 border-radius=18px，节点需定位在圆角安全区内避免被裁切
  const ph = panelHeight || 400
  const safePad = Math.min(18, ph * 0.12)
  const safePct = (safePad / ph) * 100
  const toSafe = (r: number) => safePct + r * (100 - 2 * safePct)

  const viewportBoxTop = toSafe(scrollRatio * (1 - viewportRatio))
  const viewportBoxHeight = viewportRatio * (100 - 2 * safePct)

  return (
    <div className="chat-nav-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button className="chat-nav-trigger"><List size={14} /></button>
      {hovered && (
        <>
          <div className="chat-nav-panel" ref={panelRef}>
            <div className="nav-centerline" />
            <div className="nav-viewport" style={{ top: `${viewportBoxTop}%`, height: `${viewportBoxHeight}%` }} />
            {nodes.map((node) => {
              const isUser = node.msg.role === 'user'
              const isActive = activeMsgId === node.msg.id
              const isHovered = hoveredNodeId === node.msg.id
              return (
                <div
                  key={node.msg.id}
                  className="nav-node"
                  style={{ top: `${toSafe(node.topRatio)}%` }}
                  onClick={() => handleClick(node.msg.id)}
                  onMouseEnter={() => setHoveredNodeId(node.msg.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                >
                  <div
                    className={`nav-node-indicator ${isUser ? 'user' : 'assistant'} ${isActive ? 'active' : ''} ${isHovered ? 'bob' : ''}`}
                  />
                </div>
              )
            })}
          </div>
          {/* 所有节点标签浮动在面板左侧 */}
          {nodes.map((node) => (
            <div
              key={'lbl-' + node.msg.id}
              className="nav-node-label"
              style={{ top: `${toSafe(node.topRatio)}%` }}
            >
              {node.msg.content.slice(0, 30)}{node.msg.content.length > 30 ? '…' : ''}
            </div>
          ))}
        </>
      )}
    </div>
  )
})

// ── Token 用量指示器 ───────────────────────────────────────
function ContextBar({ port }: { port?: number }) {
  const metrics = useStore(s => {
    if (!port) return undefined
    const card = s.cards.find(c => c.template.serverPort === port && c.status === 'running')
    return card ? s.modelMetrics[card.template.id] : undefined
  })
  const nCtx = metrics?.nCtx ?? 0
  const nPromptTokens = metrics?.nPromptTokens ?? 0

  if (!port || !nCtx) return null
  const ratio = nPromptTokens / nCtx

  return (
    <span className="context-bar">
      <span className="context-bar-track">
        <span className="context-bar-fill" style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
      </span>
      <span className="context-bar-label">{nPromptTokens.toLocaleString()} / {nCtx.toLocaleString()}</span>
    </span>
  )
}

// ── 主视图 ─────────────────────────────────────────────────
export default function ChatView() {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMap = useChatStore((s) => s.streamingMap)
  const loaded = useChatStore((s) => s.loaded)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const createSession = useChatStore((s) => s.createSession)
  const createEmptySession = useChatStore((s) => s.createEmptySession)
  const selectSession = useChatStore((s) => s.selectSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const toggleSessionStar = useChatStore((s) => s.toggleSessionStar)
  const setSessionModel = useChatStore((s) => s.setSessionModel)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const markLastMessageError = useChatStore((s) => s.markLastMessageError)
  const setStreamForSession = useChatStore((s) => s.setStreamForSession)
  const clearStreamForSession = useChatStore((s) => s.clearStreamForSession)
  const persist = useChatStore((s) => s.persist)
  const truncateAfter = useChatStore((s) => s.truncateAfter)
  const replaceMessages = useChatStore((s) => s.replaceMessages)
  const branchSession = useChatStore((s) => s.branchSession)

  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt)
  const setParams = useChatStore((s) => s.setParams)
  const cards = useStore((s) => s.cards)
  const setView = useStore((s) => s.setView)
  const setCardStatus = useStore((s) => s.setCardStatus)
  const clearModelMetrics = useStore((s) => s.clearModelMetrics)
  const sidebarCollapsed = useStore((s) => s.chatSidebarCurrentCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setChatSidebarCurrentCollapsed)
  const runningModels = useMemo(
    () => cards.filter((c) => c.status === 'running')
      .map((c) => ({ id: c.template.id, name: c.template.name, port: c.template.serverPort || 8080 })),
    [cards]
  )

  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  // 输入框区域高度（含代码预览 / 附件托盘等）：用于把「回到底部」按钮
  // 精确悬浮在输入框正上方，而不遮挡输入框。
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const throttledScroll = useRef<(() => void) | null>(null)
  const lastScrollSessionRef = useRef<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const [activeNavMsgId, setActiveNavMsgId] = useState<string | null>(null)
  // 输入框代码预览：用户手动关闭后，任意输入变化即可重新触发
  const [inputPreviewDismissed, setInputPreviewDismissed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null)
  // 工具开关面板
  const [showTools, setShowTools] = useState(false)
  const toolsBtnRef = useRef<HTMLButtonElement>(null)
  const [toolsAnchor, setToolsAnchor] = useState<DOMRect | null>(null)
  const toolConfig = useStore(s => s.toolConfig)
  const setToolConfig = useStore(s => s.setToolConfig)
  const { speakingId, speak, stop: stopTts } = useTts()
  // 图片点击放大
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  useEffect(() => {
    if (!previewImage) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewImage(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewImage])
  // 文件上传
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<File[]>([])
  const [previewUrls, setPreviewUrls] = useState<Map<number, string>>(new Map())
  // 拖拽上传：计数器防止嵌套元素 flicker
  const [dragOverCount, setDragOverCount] = useState(0)
  // 右侧文件预览分屏
  const [filePanelOpen, setFilePanelOpen] = useState(false)
  const [filePreviewIndex, setFilePreviewIndex] = useState(0)
  const [uploadedFileTexts, setUploadedFileTexts] = useState<Map<number, string>>(new Map())
  const [fileBaseDirs, setFileBaseDirs] = useState<Map<number, string>>(new Map())
  const [filePanelWidth, setFilePanelWidth] = useState(45) // 文件预览面板宽度（%）
  // HTML 预览模式：false=源码, true=渲染
  const [htmlRenderMode, setHtmlRenderMode] = useState(false)
  // PDF 翻页
  const [pdfPageNum, setPdfPageNum] = useState<Map<number, number>>(new Map())
  const [pdfPagesCache, setPdfPagesCache] = useState<Map<number, string[]>>(new Map())



  // ── 文件上传 ───────────────────────────────────────────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const startIdx = attachedFiles.length
    setAttachedFiles(prev => [...prev, ...files])
    loadFilePreviews(files, startIdx, setPreviewUrls, setUploadedFileTexts, setPdfPagesCache, setPdfPageNum, setFileBaseDirs)
    // 清空 input 值，允许重复选同名文件
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [attachedFiles.length])

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles(prev => {
      const next = prev.filter((_, i) => i !== index)
      // 删除后修正 filePreviewIndex，防止越界
      setFilePreviewIndex(pi => Math.min(pi, Math.max(0, next.length - 1)))
      if (next.length === 0) setFilePanelOpen(false)
      return next
    })
    setPreviewUrls(prev => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
    setUploadedFileTexts(prev => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
    setPdfPagesCache(prev => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
    setPdfPageNum(prev => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
  }, [])

  // ── 拖拽上传 ───────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverCount(prev => prev + 1)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverCount(prev => Math.max(0, prev - 1))
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverCount(0)

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return

    const startIdx = attachedFiles.length
    setAttachedFiles(prev => [...prev, ...files])
    loadFilePreviews(files, startIdx, setPreviewUrls, setUploadedFileTexts, setPdfPagesCache, setPdfPageNum, setFileBaseDirs)
  }, [attachedFiles.length])

  // ── 文件预览面板宽度拖拽 ──────────────────────────────
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const parent = (e.currentTarget.closest('.chat-main') as HTMLElement)
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const parentW = rect.width
    const parentLeft = rect.left
    const onMove = (ev: MouseEvent) => {
      const xInParent = ev.clientX - parentLeft
      const newW = ((parentW - xInParent) / parentW) * 100
      if (newW < 10) { setFilePanelOpen(false); cleanup(); return }
      setFilePanelWidth(Math.min(Math.max(newW, 25), 70))
    }
    const onUp = () => cleanup()
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // 读取文件内容（文本用 readAsText，图片转 base64，PDF/DOCX 提取文本）
  function readFileContent(file: File): Promise<{ text: string; isImage: boolean; dataUrl?: string }> {
    return new Promise((resolve, reject) => {
      const isImage = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(file.name)
      if (isImage) {
        // 用 ArrayBuffer + 手动 base64 编码，避免 readAsDataURL 兼容问题
        const reader = new FileReader()
        reader.onload = () => {
          const buf = reader.result as ArrayBuffer
          const bytes = new Uint8Array(buf)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          const base64 = btoa(binary)
          const mime = file.type || 'image/png'
          resolve({ text: '', isImage: true, dataUrl: `data:${mime};base64,${base64}` })
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(file)
      } else if (isPdfFile(file.name)) {
        // PDF：提取所有页面文本
        (async () => {
          try {
            const buffer = await file.arrayBuffer()
            const pdf = await getDocument({ data: buffer }).promise
            const texts: string[] = []
            for (let p = 1; p <= pdf.numPages; p++) {
              const page = await pdf.getPage(p)
              const tc = await page.getTextContent()
              texts.push(tc.items.map((item: any) => item.str).join(' '))
            }
            resolve({ text: `[PDF: ${file.name}]\n${texts.join('\n---\n')}`, isImage: false })
          } catch {
            resolve({ text: `[PDF: ${file.name}]（文本提取失败）`, isImage: false })
          }
        })()
      } else if (isDocxFile(file.name)) {
        // DOCX：提取纯文本
        file.arrayBuffer()
          .then(async (buffer) => {
            try {
              const result = await mammoth.extractRawText({ arrayBuffer: buffer })
              resolve({ text: `[DOCX: ${file.name}]\n${result.value}`, isImage: false })
            } catch {
              resolve({ text: `[DOCX: ${file.name}]（文本提取失败）`, isImage: false })
            }
          })
          .catch(() => resolve({ text: `[DOCX: ${file.name}]（读取失败）`, isImage: false }))
      } else {
        const reader = new FileReader()
        reader.onload = () => resolve({ text: reader.result as string, isImage: false })
        reader.onerror = () => reject(reader.error)
        reader.readAsText(file)
      }
    })
  }

  // 将 base64 图片缩小为指定最大宽度（用于存储，减少切换卡顿）
  function makeThumbnail(dataUrl: string, maxW = 300): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        if (img.width <= maxW) { resolve(dataUrl); return }
        const ratio = maxW / img.width
        const w = maxW
        const h = Math.round(img.height * ratio)
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        resolve(c.toDataURL('image/jpeg', 0.7))
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    })
  }

  // ── 文件扩展名 → 语言/格式 映射（用于右侧预览面板渲染）────
  const CODE_EXT_MAP: Record<string, string> = {
    py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust',
    go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', css: 'css', html: 'html', xml: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    sql: 'sql', r: 'r', lua: 'lua', php: 'php', rb: 'ruby',
    swift: 'swift', kt: 'kotlin', scala: 'scala',
    tex: 'latex', svelte: 'svelte', vue: 'vue',
    ini: 'ini', cfg: 'ini', conf: 'ini',
    csv: 'plaintext', log: 'plaintext',
    bat: 'dosbatch', cmake: 'cmake', dockerfile: 'dockerfile',
    sqlite: 'sql', graphql: 'graphql', gql: 'graphql',
  }
  function getFileExtension(filename: string): string {
    const i = filename.lastIndexOf('.')
    return i > 0 ? filename.slice(i + 1).toLowerCase() : ''
  }
  function isMarkdownFile(filename: string): boolean {
    const ext = getFileExtension(filename)
    return ext === 'md' || ext === 'markdown'
  }
  function getCodeLanguage(filename: string): string | null {
    const ext = getFileExtension(filename)
    return CODE_EXT_MAP[ext] || null
  }
  function isPdfFile(filename: string): boolean {
    return /\.pdf$/i.test(filename)
  }
  function isDocxFile(filename: string): boolean {
    return /\.docx$/i.test(filename)
  }
  function isHtmlFile(filename: string): boolean {
    return /\.html?$/i.test(filename)
  }

  // 通用文件预览加载（handleFileSelect / handleDrop 共用）
  async function loadFilePreviews(
    files: File[], startIdx: number,
    _setPreviewUrls: typeof setPreviewUrls,
    _setUploadedFileTexts: typeof setUploadedFileTexts,
    _setPdfPagesCache: typeof setPdfPagesCache,
    _setPdfPageNum: typeof setPdfPageNum,
    _setFileBaseDirs: React.Dispatch<React.SetStateAction<Map<number, string>>>
  ): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const idx = startIdx + i
      const isImage = f.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(f.name)
      if (isImage) {
        const reader = new FileReader()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(f)
        })
        _setPreviewUrls(prev => { const n = new Map(prev); n.set(idx, dataUrl); return n })
      } else if (isPdfFile(f.name)) {
        try {
          const buffer = await f.arrayBuffer()
          const pdf = await getDocument({ data: buffer }).promise
          const numPages = pdf.numPages
          // 渲染所有页面并缓存
          const pages: string[] = []
          for (let p = 1; p <= numPages; p++) {
            const page = await pdf.getPage(p)
            const scale = Math.min(1.5, 800 / Math.max(page.view[2], page.view[3]))
            const vp = page.getViewport({ scale })
            const canvas = document.createElement('canvas')
            canvas.width = vp.width; canvas.height = vp.height
            const ctx = canvas.getContext('2d')!
            await page.render({ canvasContext: ctx, viewport: vp }).promise
            pages.push(canvas.toDataURL('image/jpeg', 0.85))
          }
          // 第一页用于 previewUrls（兼容已有逻辑）
          _setPreviewUrls(prev => { const n = new Map(prev); n.set(idx, pages[0]); return n })
          // 所有页缓存
          _setPdfPagesCache(prev => { const n = new Map(prev); n.set(idx, pages); return n })
          // 页码状态
          _setPdfPageNum(prev => { const n = new Map(prev); n.set(idx, 1); return n })
          // 提取文本（仅第一页，用于发送时拼入消息）
          const page1 = await pdf.getPage(1)
          const tc = await page1.getTextContent()
          const text = tc.items.map((item: any) => item.str).join(' ')
          _setUploadedFileTexts(prev => { const n = new Map(prev); n.set(idx, text); return n })
        } catch (e) {
          _setUploadedFileTexts(prev => { const n = new Map(prev); n.set(idx, `[PDF 预览失败: ${e}]`); return n })
        }
      } else if (isDocxFile(f.name)) {
        try {
          const buffer = await f.arrayBuffer()
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
          _setUploadedFileTexts(prev => { const n = new Map(prev); n.set(idx, result.value); return n })
        } catch (e) {
          _setUploadedFileTexts(prev => { const n = new Map(prev); n.set(idx, `[DOCX 预览失败]`); return n })
        }
      } else {
        // 普通文本文件
        const reader = new FileReader()
        const text = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsText(f)
        })
        // 对 Markdown 文件内联相对路径图片
        const isMdFile = /\.(md|markdown|mdx|mkd|mdwn|mkdn)$/i.test(f.name)
        let finalText = text
        // 尝试内联相对路径图片（使用 webUtils.getPathForFile 替代废弃的 File.path）
        const filePath = window.api.getFilePath(f)
        const hasFilePath = typeof filePath === 'string' && filePath.length > 0
        if (isMdFile && hasFilePath) {
          try {
            const dir = filePath.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')
              // 1) 处理 HTML <img src="相对路径">
              finalText = finalText.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
              const srcM = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
              const url = srcM ? (srcM[2] ?? srcM[3] ?? srcM[4] ?? '') : ''
              if (!url || /^(https?:|data:|file:\/\/|\/)/.test(url)) return full
              // 异步标记：暂时保留原文，后续统一替换
              return `__HIMGLOCAL__${url}__END__`
            })
            // 2) 处理 Markdown 图片 ![alt](相对路径)
            const mdImgs: { full: string; alt: string; url: string }[] = []
            const mdRe = /!\[([^\]]*)\]\(([^)]+)\)/g
            let mm: RegExpExecArray | null
            while ((mm = mdRe.exec(finalText)) !== null) {
              const url = mm[2]!.trim()
              if (/^(https?:|data:|file:\/\/|\/)/.test(url)) continue
              mdImgs.push({ full: mm[0], alt: mm[1]!, url })
            }
            // 3) 收集 HTML 本地图片
            const htmlLocals: { placeholder: string; url: string }[] = []
            const phRe = /__HIMGLOCAL__([^_]+)__END__/g
            while ((mm = phRe.exec(finalText)) !== null) {
              htmlLocals.push({ placeholder: mm[0], url: mm[1]! })
            }
            // 4) 异步读取所有图片并替换
            if (mdImgs.length > 0 || htmlLocals.length > 0) {
              const absPath = (path: string) => (dir + '/' + path).replace(/\\/g, '/').replace(/\/+/g, '/')
              // Markdown 图片
              for (const img of mdImgs) {
                try {
                  const abs = absPath(img.url)
                  console.log('[ChatView] inline md img:', img.url, '→', abs)
                  const r = await window.api.readFileBase64(abs)
                  if (r.success) finalText = finalText.replace(img.full, `![${img.alt}](${r.dataUrl})`)
                  else console.warn('[ChatView] inline md img failed:', r.error)
                } catch (e) { console.warn('[ChatView] inline md img error:', e) }
              }
              // HTML 图片
              for (const img of htmlLocals) {
                try {
                  const abs = absPath(img.url)
                  console.log('[ChatView] inline html img:', img.url, '→', abs)
                  const r = await window.api.readFileBase64(abs)
                  if (r.success) {
                    const newTag = `<img src="${r.dataUrl}" alt="" style="max-width:100%;height:auto" />`
                    finalText = finalText.replace(img.placeholder, newTag)
                  } else {
                    finalText = finalText.replace(img.placeholder, '')
                  }
                } catch {
                  finalText = finalText.replace(img.placeholder, '')
                }
              }
            }
          } catch { /* 内联失败不影响文本预览 */ }
        }
        // 存储文件基准目录，供 ReactMarkdown img 渲染器解析相对路径
        if (hasFilePath) {
          const dir = filePath.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')
          _setFileBaseDirs(prev => { const n = new Map(prev); n.set(idx, dir); return n })
        }
        _setUploadedFileTexts(prev => { const n = new Map(prev); n.set(idx, finalText); return n })
      }
    }
  }

  // ── 文件类型图标（用于预览标签页）────
  function getFileIcon(filename: string): string {
    const ext = getFileExtension(filename)
    if (!ext) return '📄'
    const iconMap: Record<string, string> = {
      md: '📝', markdown: '📝',
      pdf: '📄',
      docx: '📃',
      py: '🐍', js: '🟨', ts: '🔷', rs: '🦀', go: '🔵',
      java: '☕', c: '⚙️', cpp: '⚙️', h: '⚙️', hpp: '⚙️',
      cs: '🔷', css: '🎨', html: '🌐', xml: '📋',
      json: '📋', yaml: '📋', yml: '📋', toml: '⚙️',
      sh: '⚡', bash: '⚡', zsh: '⚡', ps1: '⚡',
      sql: '🗃️', csv: '📊',
      swift: '🍎', kt: '🟣', scala: '🔥',
      r: '📉', lua: '🌙', php: '🐘', rb: '💎',
      tex: '📐', svelte: '🔥', vue: '💚',
      bat: '⚡', cmake: '⚙️', dockerfile: '🐳',
      graphql: '◈', gql: '◈',
    }
    return iconMap[ext] || (ext.length <= 4 ? '📄' : '📄')
  }

  // 预处理：代码内容自动缩进（仅用于预览，发送时仍用原始 input）
  const processedInput = useMemo(() => preprocessInput(input), [input])

  // 只有实际存在代码块时才显示预览（避免空壳子）
  const hasCodeBlocks = useMemo(() => {
    // 围栏代码块：行首出现 ```
    if (/(?:^|\n)```/.test(processedInput)) return true
    // 缩进代码块：连续 2+ 行缩进
    const lines = processedInput.split('\n')
    let run = 0
    for (const line of lines) {
      run = /^( {4,}|\t)/.test(line) ? run + 1 : 0
      if (run >= 2) return true
    }
    return false
  }, [processedInput])

  const showInputPreview = hasCodeBlocks && !inputPreviewDismissed
  // 看门狗：防止流卡住导致输入框永久冻结（per-stream，支持多会话并发）
  const streamWatchdogsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const streamReceivedRef = useRef<Map<string, boolean>>(new Map())
  // 已被用户主动中止的流，用于屏蔽后续异步 chunk/done 事件
  const abortedStreamsRef = useRef<Set<string>>(new Set())
  // 工具调用后续流：followStreamId → 原始 streamId，用于将后续 chunk 路由到同一条消息
  const mergedFollowMap = useRef<Map<string, string>>(new Map())
  // 重新生成回滚备份：失败时恢复旧消息
  const regenerateRollbackRef = useRef<{ sessionId: string; messages: ChatMessage[]; streamId: string } | null>(null)
  // 引用追问：绕过闭包直接传文本给 handleSend
  const pendingSendTextRef = useRef<string | null>(null)
  // 引用追问弹出输入框
  const [quoteInput, setQuoteInput] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const quoteInputRef = useRef<HTMLInputElement>(null)
  const quotePopupRef = useRef<HTMLDivElement>(null)

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null
  const activeMessages = activeSession?.messages || []
  const activeModel = runningModels.find((m) => m.id === activeSession?.templateId)
  const activeStreamId = (activeSessionId && streamingMap[activeSessionId]) || null

  // 首次加载会话
  useEffect(() => { loadSessions() }, [loadSessions])

  // 加载完成后若无任何会话且模型运行中，自动创建首个会话
  useEffect(() => {
    if (!loaded) return
    if (sessions.length > 0) return
    if (runningModels.length === 0) return
    const m = runningModels[0]
    createSession(m.id, m.port, m.name)
  }, [loaded, sessions.length, runningModels, createSession])

  // 加载完成后若已有会话、但未选中任何会话，自动选中第一个会话
  useEffect(() => {
    if (!loaded) return
    if (activeSessionId) return
    if (sessions.length === 0) return
    selectSession(sessions[0].id)
  }, [loaded, activeSessionId, sessions, selectSession])

  // 选中会话时，若其模型未运行但存在其他运行中模型，自动切换
  useEffect(() => {
    if (!activeSessionId || !loaded) return
    if (activeModel) return
    if (runningModels.length === 0) return
    const m = runningModels[0]
    setSessionModel(activeSessionId, m.id, m.port)
  }, [activeSessionId, activeModel, runningModels, setSessionModel, loaded])

  // 全局监听流式 chunk
  useEffect(() => {
    // 清除可能残留的流状态（ChatView unmount 时流未结束导致卡死）
    const initSt = useChatStore.getState()
    for (const sid of Object.keys(initSt.streamingMap)) {
      initSt.clearStreamForSession(sid)
    }

    window.api.onChatStreamChunk(async (data) => {
      // 已中止的流：忽略所有后续事件（包括异步到达的 done）
      if (abortedStreamsRef.current.has(data.streamId)) {
        if (data.done) abortedStreamsRef.current.delete(data.streamId)
        return
      }
      // 工具调用后续流：将 followStreamId 映射回原始 streamId，使内容追加到同一条消息
      const originalStreamId = mergedFollowMap.current.get(data.streamId)
      if (originalStreamId) {
        const followId = data.streamId
        data = { ...data, streamId: originalStreamId }
        if (data.done) mergedFollowMap.current.delete(followId)
      }
      const st = useChatStore.getState()
      // chunk 通过 streamId 关联到会话：发起流时把 streamId 记在会话最后一条 assistant 消息上
      const targetSession = st.sessions.find((s) =>
        s.messages.some((m) => m.id === data.streamId)
      )
      if (!targetSession) return
      if (data.delta) {
        streamReceivedRef.current.set(data.streamId, true)
        // 写入模块级缓冲区，StreamingText 用 rAF 读取
        const prev = streamingBuffer[data.streamId] || ''
        streamingBuffer[data.streamId] = prev + data.delta
        // 轻量同步到 store（100ms 一次），触发思考链重新渲染
        lightStreamSync(targetSession.id, data.streamId)
      }
      // /metrics 补充事件（done 已先行发出，这里仅补充解码速度，不触发 finalize）
      if (data.metrics) {
        st.finalizeLastMessage(targetSession.id, { decodeTokS: data.metrics.decodeTokS })
      }
      if (data.done) {
        // 清理该流的看门狗定时器
        const wd = streamWatchdogsRef.current.get(data.streamId)
        if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(data.streamId) }
        streamReceivedRef.current.delete(data.streamId)

        if (data.error) {
          st.clearStreamForSession(targetSession.id)
          // 如果是重新生成失败，回滚恢复旧消息
          const rollback = regenerateRollbackRef.current
          if (rollback && rollback.streamId === data.streamId) {
            const st = useChatStore.getState()
            st.replaceMessages(rollback.sessionId, rollback.messages)
            regenerateRollbackRef.current = null
            notify(`重新生成失败：${data.error}，已恢复原回复`, 'error')
          } else {
            st.markLastMessageError(targetSession.id, data.error)
          }
          st.persist(targetSession.id)
          st.clearStreamForSession(targetSession.id)
          return
        }

        // 成功：流结束，同步缓冲区到 Zustand store
        const finalContent = streamingBuffer[data.streamId]
        delete streamingBuffer[data.streamId]
        if (finalContent != null) {
          const s = useChatStore.getState()
          const sess = s.sessions.find(s => s.id === targetSession.id)
          if (sess) {
            const msgs = sess.messages.map(m => m.id === data.streamId ? { ...m, content: finalContent } : m)
            s.replaceMessages(targetSession.id, msgs)
          }
        }

        regenerateRollbackRef.current = null
        if (data.usage != null || data.msFirstToken != null || data.decodeTokS != null) {
          st.finalizeLastMessage(targetSession.id, {
            tokensDecoded: data.usage?.completionTokens,
            msFirstToken: data.msFirstToken,
            decodeTokS: data.decodeTokS
          })
        }

        // ── 工具调用流程：模型发起 tool_calls → 执行工具 → 自动发起第二轮请求 ──
        const toolCalls = data.toolCalls as ToolCallInfo[] | undefined
        if (toolCalls && toolCalls.length > 0) {
          // 将 toolCalls 存储到当前助手消息上（用于 UI 渲染）
          const currentSt = useChatStore.getState()
          const currentSession = currentSt.sessions.find(s => s.id === targetSession.id)
          const toolMsg = currentSession?.messages.find(m => m.id === data.streamId)
          if (toolMsg) {
            // 更新消息：存储 toolCalls 和工具调用前的内容长度（用于区分前后思考链）
            const updatedMsgs = currentSession!.messages.map(m =>
              m.id === data.streamId ? { ...m, toolCalls, preToolContentLen: m.content.length } : m
            )
            currentSt.replaceMessages(targetSession.id, updatedMsgs)
          }

          // 执行所有工具调用（异步支持网络请求）
          const toolResults: Array<{ callId: string; name: string; result: string }> = []
          for (const tc of toolCalls) {
            let args: Record<string, unknown> = {}
            try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* keep empty */ }
            // 执行端兜底：原生聊天只允许白名单内的 3 个工具，
            // 其余（如 Write/Edit/Bash）即使模型发起也不执行，直接拒绝，避免误改本地文件。
            if (!CHAT_ALLOWED_TOOLS.includes(tc.function.name)) {
              const refused = JSON.stringify({
                error: `工具 "${tc.function.name}" 在原生聊天中不可用，仅支持：获取时间、搜索网页、抓取网页内容。请在 Agent Code 工作台中使用文件/命令类工具。`
              })
              toolResults.push({ callId: tc.id, name: tc.function.name, result: refused })
              tc.result = refused
              continue
            }
            const result = await executeToolCall(tc.function.name, args)
            toolResults.push({ callId: tc.id, name: tc.function.name, result })
            // 将执行结果回写到 toolCalls，用于 UI 展示
            tc.result = result
          }
          // 更新消息上的 toolCalls（带上结果）
          const updatedMsgs2 = currentSession!.messages.map(m =>
            m.id === data.streamId ? { ...m, toolCalls: toolCalls } : m
          )
          currentSt.replaceMessages(targetSession.id, updatedMsgs2)

          // 构建第二轮请求的消息数组（手动构建，避免 buildOpenAiMessages 重复包含工具调用消息）
          const followSession = useChatStore.getState().sessions.find(s => s.id === targetSession.id)!
          const followMessages: Array<Record<string, unknown>> = []
          if (followSession.systemPrompt?.trim()) {
            followMessages.push({ role: 'system', content: followSession.systemPrompt.trim() })
          }
          for (const m of followSession.messages) {
            if (m.role === 'system') continue
            if (m.id === data.streamId) {
              // 工具调用消息：带上 tool_calls 字段
              followMessages.push({
                role: 'assistant',
                content: m.content || '',
                tool_calls: toolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: tc.function.arguments }
                }))
              })
            } else {
              if (!m.content && !m.error) continue
              followMessages.push({ role: m.role, content: m.content })
            }
          }
          // 追加每个工具的结果
          for (const tr of toolResults) {
            followMessages.push({
              role: 'tool',
              tool_call_id: tr.callId,
              content: tr.result
            })
          }

          // 不创建新消息，复用原始消息（工具调用 + 回复合并显示）
          const followStreamId = (crypto as any).randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))
          mergedFollowMap.current.set(followStreamId, data.streamId)
          // 清除并重新设置流状态（同一 streamId，保持消息关联）
          const st2 = useChatStore.getState()
          queueMicrotask(() => {
            st2.clearStreamForSession(targetSession.id)
            st2.setStreamForSession(targetSession.id, data.streamId)
          })

          // 看门狗
          streamReceivedRef.current.set(followStreamId, false)
          const wdTimer2 = setTimeout(() => {
            const s = useChatStore.getState()
            if (s.streamingMap[targetSession.id] === data.streamId && !streamReceivedRef.current.get(followStreamId)) {
              s.markLastMessageError(targetSession.id, '工具调用后响应超时（90s）')
              s.clearStreamForSession(targetSession.id)
              streamReceivedRef.current.delete(followStreamId)
              mergedFollowMap.current.delete(followStreamId)
            }
            streamWatchdogsRef.current.delete(followStreamId)
          }, 90000)
          streamWatchdogsRef.current.set(followStreamId, wdTimer2)

          // 发送第二轮请求（含工具结果）
          const port = followSession.port
          window.api.chatStream({
            streamId: followStreamId,
            port,
            body: {
              messages: followMessages,
              temperature: followSession.params.temperature,
              top_p: followSession.params.top_p,
              top_k: followSession.params.top_k,
              max_tokens: followSession.params.max_tokens || -1,
              repeat_penalty: followSession.params.repeat_penalty,
              tools: getEnabledToolDefinitions(),
              stream: true
            }
          }).catch((e: any) => {
            const s = useChatStore.getState()
            s.markLastMessageError(targetSession.id, e?.message || '工具调用后续请求失败')
            if (s.streamingMap[targetSession.id] === data.streamId) {
              s.clearStreamForSession(targetSession.id)
            }
            mergedFollowMap.current.delete(followStreamId)
          })
          return // 不清除当前 stream，保持工具调用消息可见
        }

        // 无工具调用：正常结束流程
        if (useStore.getState().soundEnabled) playNotificationSound(useStore.getState().notificationSound)
        st.persist(targetSession.id)
        st.clearStreamForSession(targetSession.id)
      }
    })
    return () => {
      window.api.removeChatStreamListener()
      for (const [, timer] of streamWatchdogsRef.current) clearTimeout(timer)
      streamWatchdogsRef.current.clear()
      mergedFollowMap.current.clear()
    }
  }, [])

  // 自动滚动到底部
  const lastContentRef = useRef<string>('')
  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    if (!container || !activeSessionId) return

    const isSessionSwitch = lastScrollSessionRef.current !== activeSessionId
    if (isSessionSwitch) {
      lastScrollSessionRef.current = activeSessionId
      container.scrollTop = container.scrollHeight
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
      if (!autoScroll) setAutoScroll(true)
      setAtBottom(true)
      return
    }

    // 仅在内容增长且 autoScroll 开启时跟随滚动
    const currentContent = activeMessages[activeMessages.length - 1]?.content || ''
    if (!autoScroll || currentContent === lastContentRef.current) return
    lastContentRef.current = currentContent
    container.scrollTop = container.scrollHeight
  }, [activeSessionId, activeMessages.length, activeMessages[activeMessages.length - 1]?.content, autoScroll])

  // 测量输入框区域高度，写入 CSS 变量，使浮动按钮精确浮在输入框上方
  useEffect(() => {
    const el = chatInputWrapRef.current
    if (!el) return
    const root = el.closest('.chat-main-col') as HTMLElement | null
    if (!root) return
    const apply = () => root.style.setProperty('--chat-input-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 节流版：滚动时更新 autoScroll 和导航状态（限制到 vsync 频率）
  const handleScrollThrottled = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    if (!throttledScroll.current) {
      throttledScroll.current = () => {
        throttledScroll.current = null
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        setAtBottom(atBottom)
        if (!atBottom) setAutoScroll(false)
        const userEls = el.querySelectorAll('.chat-msg-user[data-msg-id]')
        const containerTop = el.scrollTop
        let visible: string | null = null
        userEls.forEach((node) => {
          const top = (node as HTMLElement).offsetTop
          if (top <= containerTop + 120) visible = (node as HTMLElement).dataset.msgId || null
        })
        if (visible) setActiveNavMsgId(visible)
      }
      requestAnimationFrame(throttledScroll.current!)
    }
  }, [])

  // 新建会话
  const handleNew = useCallback(() => {
    if (runningModels.length > 0) {
      const m = runningModels[0]
      createSession(m.id, m.port, m.name)
    } else {
      createEmptySession()
    }
    setInput('')
  }, [runningModels, createSession, createEmptySession])

  // 停止当前会话关联的模型
  const handleStopModel = useCallback(async () => {
    if (!activeModel) return
    const card = cards.find(c => c.template.id === activeModel.id && c.status === 'running')
    if (!card) return
    setCardStatus(activeModel.id, 'idle')
    clearModelMetrics(activeModel.id)
    try {
      const res = await window.api.stopModel(activeModel.id)
      if (res.success) {
        notify(`模型 ${activeModel.name} 已停止`, 'success', 1000)
      } else {
        notify(`停止失败：${res.error}`, 'error')
        setCardStatus(activeModel.id, 'running')
      }
    } catch (e: any) {
      notify(`停止失败：${e?.message || '未知错误'}`, 'error')
      setCardStatus(activeModel.id, 'running')
    }
  }, [activeModel, cards, setCardStatus, clearModelMetrics])

  // 导出当前会话为 PNG
  const handleExportPng = useCallback(async () => {
    const el = messagesContainerRef.current
    if (!el || !activeSession) return
    try {
      const canvas = await html2canvas(el, { useCORS: true, backgroundColor: '#fff' })
      const dataUrl = canvas.toDataURL('image/png')
      const filePath = await window.api.savePng(dataUrl)
      notify(`PNG 已保存: ${filePath}`, 'success')
    } catch (e) {
      notify('导出图片失败', 'error')
    }
  }, [activeSession])

  // 导出当前会话为 PDF（基于 Electron printToPDF，原生支持中文）
  const handleExportPdf = useCallback(async () => {
    if (!activeSession) return
    try {
      const stripThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim()
      const msgsHtml = activeSession.messages
        .filter(m => m.role !== 'system' && (m.content || m.error))
        .map(m => {
          const text = stripThink(m.content || '')
          if (!text) return ''
          const roleLabel = m.role === 'user' ? '用户' : '助手'
          const color = m.role === 'user' ? '#2563eb' : '#000'
          const textColor = m.role === 'user' ? '#333' : '#555'
          const body = markdownToHtml(text)
          return `<div class="msg"><span class="role" style="color:${color};font-weight:700">${roleLabel}</span><div style="color:${textColor}">${body}</div></div>`
        })
        .join('')

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; padding: 20mm; font-size: 11pt; line-height: 1.7; color: #222; }
  h1 { font-size: 18pt; margin-bottom: 6pt; }
  .meta { font-size: 9pt; color: #888; margin-bottom: 4pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 10pt 0; }
  .msg { margin-bottom: 10pt; }
  .role { font-size: 10pt; display: block; margin-bottom: 2pt; }
  .katex { font-size: 1.1em; }
  .katex-display { margin: 8pt 0; overflow-x: auto; overflow-y: hidden; }
  pre { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8pt; font-family: "Cascadia Code", "Fira Code", "Consolas", monospace; font-size: 9pt; line-height: 1.5; overflow-x: auto; margin: 6pt 0; }
  code { font-family: "Cascadia Code", "Fira Code", "Consolas", monospace; font-size: 9pt; }
  p code { background: #f0f0f0; padding: 1pt 4pt; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 4pt 8pt; text-align: left; }
  th { background: #f0f0f0; font-weight: 700; }
  tr:nth-child(even) { background: #fafafa; }
  @page { margin: 0; }
</style>
</head>
<body>
<h1>${escapeHtml(activeSession.title || '对话记录')}</h1>
<div class="meta">导出时间: ${new Date().toLocaleString()}</div>
${activeSession.templateId ? `<div class="meta">模型: ${escapeHtml(activeSession.templateId)}</div>` : ''}
<hr>
${msgsHtml}
</body>
</html>`

      const filePath = await window.api.printToPDF(html)
      notify(`PDF 已保存: ${filePath}`, 'success')
    } catch (e) {
      notify('导出 PDF 失败', 'error')
    }
  }, [activeSession])

  // 发送消息（发起流）
  const handleSend = useCallback(async () => {
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    // 引用追问：优先使用 ref 传递的文本绕过闭包过期问题
    let content: string
    if (pendingSendTextRef.current !== null) {
      content = pendingSendTextRef.current
      pendingSendTextRef.current = null
    } else {
      content = preprocessInput(input.trim())
    }
    if (!content && attachedFiles.length === 0) return
    // 如果当前会话有正在进行的流，先终止它再发送新消息
    if (activeStreamId) {
      const wd = streamWatchdogsRef.current.get(activeStreamId)
      if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(activeStreamId) }
      window.api.abortChatStream(activeStreamId)
      const prevSt = useChatStore.getState()
      prevSt.persist(activeSessionId!)
      prevSt.clearStreamForSession(activeSessionId!)
    }

    // 校验模型仍在运行
    const modelStillRunning = runningModels.find((m) => m.id === session.templateId)
    if (!modelStillRunning) {
      notify('该会话关联的模型未运行，请先启动或切换模型', 'error')
      return
    }

    setInput('')
    // 重置 textarea 高度
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
    setAutoScroll(true)

    // ── 处理文件附件 ──
    let finalContent = content
    let multimodalMessages: Array<Record<string, unknown>> | null = null
    const pendingFiles = [...attachedFiles]
    setAttachedFiles([])
    setPreviewUrls(new Map())
    setPdfPagesCache(new Map())
    setPdfPageNum(new Map())

    const attachments: Attachment[] = []
    const fullSizeMap: string[] = []

    if (pendingFiles.length > 0) {
      const fileContents = await Promise.all(pendingFiles.map(f => readFileContent(f)))
      const hasImages = fileContents.some(fc => fc.isImage)

      for (let i = 0; i < pendingFiles.length; i++) {
        const fc = fileContents[i]
        const f = pendingFiles[i]
        if (fc.isImage && fc.dataUrl) {
          fullSizeMap.push(fc.dataUrl)
          const thumb = await makeThumbnail(fc.dataUrl, 300)
          attachments.push({ name: f.name, type: 'image', dataUrl: thumb })
        } else {
          attachments.push({ name: f.name, type: 'file', content: fc.text })
        }
      }

      if (hasImages) {
        // 构建含图片的 contentParts
        const contentParts: Array<Record<string, unknown>> = []
        if (content) contentParts.push({ type: 'text', text: content })
        let imgIdx = 0
        for (const att of attachments) {
          if (att.type === 'image') {
            contentParts.push({ type: 'image_url', image_url: { url: fullSizeMap[imgIdx++] } })
          } else if (att.content) {
            finalContent += `\n\n=====\n${att.content}\n=====`
          }
        }

        // 关键！先追加用户消息到 store，再构建 multimodalMessages（这样新消息才在 store 里）
        appendUserMessage(session.id, content, attachments)
        multimodalMessages = []
        if (session.systemPrompt?.trim()) {
          multimodalMessages.push({ role: 'system', content: session.systemPrompt.trim() })
        }
        const sessionMessages = useChatStore.getState().sessions.find(s => s.id === session.id)?.messages || []
        for (const m of sessionMessages) {
          if (m.role === 'system') continue
          if (!m.content && !m.error && (!m.attachments || m.attachments.length === 0)) continue
          multimodalMessages.push({ role: m.role, content: m.content })
        }
        for (let i = multimodalMessages.length - 1; i >= 0; i--) {
          if (multimodalMessages[i].role === 'user') {
            multimodalMessages[i] = { role: 'user', content: contentParts }
            break
          }
        }
      } else {
        // 纯文本附件
        for (const att of attachments) {
          if (att.content) {
            finalContent += `\n\nName: ${att.name}\nContents:\n\n=====\n${att.content}\n=====`
          }
        }
      }
    }

    // 没有多模态时，普通追加用户消息
    if (!multimodalMessages) {
      appendUserMessage(session.id, content, attachments)
    }

    // 追加空的 assistant 占位消息
    const streamId = (crypto as any).randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))
    const assistantMsg: ChatMessage = {
      id: streamId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }
    appendMessage(session.id, assistantMsg)
    setStreamForSession(session.id, streamId)

    // 看门狗：若 90 秒内既没收到任何 chunk、流也没结束，强制恢复输入能力
    // （防止模型加载缓慢或 IPC 异常导致输入框永久冻结）
    streamReceivedRef.current.set(streamId, false)
    const wdTimer = setTimeout(() => {
      const st = useChatStore.getState()
      if (st.streamingMap[session.id] === streamId && !streamReceivedRef.current.get(streamId)) {
        st.markLastMessageError(session.id, '响应超时（90s 内无数据返回），可能是模型仍在加载中')
        st.clearStreamForSession(session.id)
        streamReceivedRef.current.delete(streamId)
        notify('响应超时，请确认模型已加载完成', 'error')
      }
      streamWatchdogsRef.current.delete(streamId)
    }, 90000)
    streamWatchdogsRef.current.set(streamId, wdTimer)

    // 组装 OpenAI 请求
    const updatedSession = { ...useChatStore.getState().sessions.find((s) => s.id === session.id)! }
    updatedSession.messages = [...updatedSession.messages] // 已含刚追加的两条
    const messages = multimodalMessages || buildOpenAiMessages(updatedSession)

    try {
      let res
      if (multimodalMessages) {
        // 多模态：走 /v1/chat/completions，去掉 tools（多模态 + tools 冲突）
        res = await window.api.chatStream({
          streamId,
          port: session.port,
          body: {
            messages: multimodalMessages,
            temperature: session.params.temperature,
            top_p: session.params.top_p,
            top_k: session.params.top_k,
            max_tokens: session.params.max_tokens || -1,
            repeat_penalty: session.params.repeat_penalty,
            stream: true
          }
        })
      } else {
        res = await window.api.chatStream({
          streamId,
          port: session.port,
          body: {
            messages,
            temperature: session.params.temperature,
            top_p: session.params.top_p,
            top_k: session.params.top_k,
            max_tokens: session.params.max_tokens || -1,
            repeat_penalty: session.params.repeat_penalty,
            tools: getEnabledToolDefinitions(),
            stream: true
          }
        })
      }
      if (!res.success && res.error) {
        // 错误已在 chunk 回调里处理；这里兜底
        const st = useChatStore.getState()
        const wd = streamWatchdogsRef.current.get(streamId)
        if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(streamId) }
        if (st.streamingMap[session.id] === streamId) {
          st.clearStreamForSession(session.id)
        }
      }
    } catch (e: any) {
      const wd = streamWatchdogsRef.current.get(streamId)
      if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(streamId) }
      const st = useChatStore.getState()
      st.markLastMessageError(session.id, e?.message || '请求失败')
      if (st.streamingMap[session.id] === streamId) {
        st.clearStreamForSession(session.id)
      }
    }
  }, [activeSessionId, input, activeStreamId, appendUserMessage, appendMessage, setStreamForSession, clearStreamForSession, markLastMessageError, runningModels, attachedFiles])

  // 停止生成（仅停止当前会话的流）
  const handleStop = useCallback(() => {
    if (activeStreamId && activeSessionId) {
      abortedStreamsRef.current.add(activeStreamId)
      const wd = streamWatchdogsRef.current.get(activeStreamId)
      if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(activeStreamId) }
      window.api.abortChatStream(activeStreamId)
      const st = useChatStore.getState()
      st.markLastMessageStopped(activeSessionId)
      st.clearStreamForSession(activeSessionId)
    }
  }, [activeStreamId, activeSessionId])

  // 删除助手回复：截断该消息及其之后的所有消息
  const [deletingMsgId, setDeletingMsgId] = useState<string | null>(null)
  const handleDeleteReply = useCallback((msgId: string) => {
    if (!activeSessionId || activeStreamId) return
    setDeletingMsgId(msgId)
  }, [activeSessionId, activeStreamId])

  // ── 全局右键上下文菜单 ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    // 只在点击外部时关闭，不用 contextmenu 避免与右键弹出冲突
    document.addEventListener('click', handler)
    return () => {
      document.removeEventListener('click', handler)
    }
  }, [ctxMenu])

  // 引用追问弹出框：点击外部关闭
  useEffect(() => {
    if (!quoteInput) return
    const handler = (e: MouseEvent) => {
      if (quotePopupRef.current && !quotePopupRef.current.contains(e.target as Node)) {
        setQuoteInput(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [quoteInput])

  const handleChatContextMenu = useCallback((e: React.MouseEvent) => {
    // 只在模型输出的消息气泡中触发
    const target = e.target as HTMLElement
    const msgEl = target.closest('.chat-msg-assistant')
    if (!msgEl) return

    e.preventDefault()
    e.stopPropagation()
    const sel = window.getSelection()?.toString().trim() || ''
    setCtxMenu({ x: e.clientX, y: e.clientY, selectedText: sel })
  }, [])

  const handleCtxCopy = useCallback(() => {
    if (ctxMenu?.selectedText) {
      navigator.clipboard.writeText(ctxMenu.selectedText)
    }
    setCtxMenu(null)
  }, [ctxMenu])

  const handleCtxAddToInput = useCallback(() => {
    if (ctxMenu?.selectedText) {
      setInput(prev => prev ? prev + '\n' + ctxMenu.selectedText : ctxMenu.selectedText)
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.style.height = 'auto'
          inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px'
        }
      })
    }
    setCtxMenu(null)
  }, [ctxMenu])

  // 引用追问：弹出小输入框让用户输入问题，回车后组合发送
  const handleCtxQuoteAsk = useCallback(() => {
    if (!ctxMenu?.selectedText) { setCtxMenu(null); return }
    const pos = { x: ctxMenu.x, y: ctxMenu.y, selectedText: ctxMenu.selectedText }
    setCtxMenu(null)
    // 延迟一下等 ctxMenu 关闭后再弹出，避免 React 批处理冲突
    requestAnimationFrame(() => setQuoteInput(pos))
  }, [ctxMenu])

  const handleQuoteSubmit = useCallback((e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()
    if (!quoteInput) return
    const question = quoteInputRef.current?.value.trim()
    if (!question) return
    // 组合：引用文本 + 用户问题
    const formatted = `**📎 引用内容**\n> ${quoteInput.selectedText.replace(/\n/g, '\n> ')}\n\n---\n\n**💬 我的提问：**\n${question}`
    pendingSendTextRef.current = formatted
    setInput(formatted)
    setQuoteInput(null)
    // 等 React 重新渲染后，input 已更新，handleSend 会优先读 pendingSendTextRef
    setTimeout(() => handleSend(), 0)
  }, [quoteInput, handleSend])

  const handleQuoteKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuoteInput(null)
    }
  }, [])

  // 切换会话绑定的模型
  const handleSwitchModel = useCallback((templateId: string) => {
    if (!activeSessionId) return
    const m = runningModels.find((x) => x.id === templateId)
    if (m) setSessionModel(activeSessionId, m.id, m.port)
  }, [activeSessionId, runningModels, setSessionModel])

  // textarea 自适应高度 + Enter 发送
  const PASTE_THRESHOLD = 2500
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // 任意输入变化（包括空格）均可重新触发代码预览
    setInputPreviewDismissed(false)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // 优先级1：检查剪贴板中的图片（Ctrl+V 粘贴截图/复制图片）
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItems = items.filter((item) => item.type.startsWith('image/'))
    if (imageItems.length > 0) {
      e.preventDefault()
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null)
      if (files.length === 0) return
      const startIdx = attachedFiles.length
      setAttachedFiles(prev => [...prev, ...files])
      // 为粘贴的图片生成预览 data URL
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        if (f.type.startsWith('image/')) {
          const reader = new FileReader()
          const idx = startIdx + i
          reader.onload = () => {
            setPreviewUrls(prev => {
              const next = new Map(prev)
              next.set(idx, reader.result as string)
              return next
            })
          }
          reader.readAsDataURL(f)
        }
      }
      return
    }

    // 优先级2：长文本粘贴为文件附件（>2500 字符自动转为文本文件）
    const text = e.clipboardData.getData('text')
    if (text && text.length > PASTE_THRESHOLD) {
      e.preventDefault()
      const file = new File([text], 'pasted_text.txt', { type: 'text/plain' })
      setAttachedFiles(prev => [...prev, file])
    }
  }, [attachedFiles.length])
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      handleSend()
    }
    // Alt+Enter: 继续生成
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault()
      const lastAssistant = [...activeMessages].reverse().find(m => m.role === 'assistant')
      if (lastAssistant) handleContinue(lastAssistant.id)
    }
  }

  // 编辑用户消息：将内容回填到输入框，截断该消息及之后的所有消息
  const handleEditMessage = useCallback((msgId: string, content: string, attachments?: Attachment[]) => {
    if (!activeSessionId) return
    setInput(content)
    // 恢复附件
    if (attachments && attachments.length > 0) {
      // 图片附件用 dataUrl 生成 File 对象用于预览
      const files: File[] = []
      const urlMap = new Map<number, string>()
      let fileIdx = 0
      for (const att of attachments) {
        if (att.type === 'image' && att.dataUrl) {
          // 从 dataUrl 创建 File 用于显示在 chips 中
          const blob = dataUrlToBlob(att.dataUrl)
          const f = new File([blob], att.name, { type: blob.type })
          files.push(f)
          urlMap.set(fileIdx, att.dataUrl)
          fileIdx++
        } else {
          // 文本文件：创建一个虚拟 File，内容从 attachment 恢复
          const f = new File([att.content || ''], att.name, { type: 'text/plain' })
          files.push(f)
          fileIdx++
        }
      }
      setAttachedFiles(files)
      setPreviewUrls(urlMap)
    }
    truncateAfter(activeSessionId, msgId)
    persist(activeSessionId)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
        el.focus()
      }
    })
  }, [activeSessionId, truncateAfter, persist])

  // 分支：从指定消息处创建新对话
  const handleBranch = useCallback((msgId: string) => {
    if (!activeSessionId) return
    const newId = branchSession(activeSessionId, msgId)
    if (newId) notify('已创建分支对话', 'success')
  }, [activeSessionId, branchSession])

  // dataUrl → Blob
  function dataUrlToBlob(dataUrl: string): Blob {
    const [meta, b64] = dataUrl.split(',', 2)
    const mime = meta?.split(':')[1]?.split(';')[0] || 'image/png'
    const bin = atob(b64 || '')
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return new Blob([buf], { type: mime })
  }

  // 重新生成：找到该助手消息前面的用户消息，截断后重新发送（失败自动回滚）
  const handleRegenerate = useCallback(async (assistantMsgId: string) => {
    if (!activeSessionId || activeStreamId || runningModels.length === 0) return
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    const idx = session.messages.findIndex((m) => m.id === assistantMsgId)
    if (idx <= 0) return
    // 找到前一条用户消息
    let userMsgIdx = idx - 1
    while (userMsgIdx >= 0 && session.messages[userMsgIdx].role !== 'user') userMsgIdx--
    if (userMsgIdx < 0) return
    const userMsg = session.messages[userMsgIdx]

    // 备份旧消息（用于失败回滚）
    const savedMessages = [...session.messages]

    // 截断：从该用户消息之后全部删除
    truncateAfter(activeSessionId, userMsg.id)
    // 重新添加用户消息（truncateAfter 删掉了它）
    appendMessage(activeSessionId, userMsg)
    // 重新走发送流程
    setInput('')
    setAutoScroll(true)
    const streamId = (crypto as any).randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))

    // 设置回滚备份
    regenerateRollbackRef.current = { sessionId: activeSessionId, messages: savedMessages, streamId }

    const assistantMsg: ChatMessage = {
      id: streamId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }
    appendMessage(activeSessionId, assistantMsg)
    setStreamForSession(activeSessionId, streamId)

    const updatedSession = { ...useChatStore.getState().sessions.find((s) => s.id === activeSessionId)! }
    updatedSession.messages = [...updatedSession.messages]
    const messages = buildOpenAiMessages(updatedSession)

    try {
      await window.api.chatStream({
        streamId,
        port: session.port,
        body: {
          messages,
          temperature: session.params.temperature,
          top_p: session.params.top_p,
          top_k: session.params.top_k,
          max_tokens: session.params.max_tokens || -1,
          repeat_penalty: session.params.repeat_penalty,
          stream: true
        }
      })
    } catch (e: any) {
      // 请求异常：回滚恢复旧消息
      regenerateRollbackRef.current = null
      const st = useChatStore.getState()
      st.replaceMessages(activeSessionId, savedMessages)
      st.clearStreamForSession(activeSessionId)
      notify(`重新生成失败：${e?.message || '请求失败'}，已恢复原回复`, 'error')
    }
  }, [activeSessionId, activeStreamId, truncateAfter, appendMessage, setStreamForSession, clearStreamForSession, runningModels])

  // 继续生成：让模型从最后一条助手消息的内容继续补全
  const handleContinue = useCallback(async (assistantMsgId: string) => {
    if (!activeSessionId || activeStreamId || runningModels.length === 0) return
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return

    // 确认最后一条助手消息就是要继续的那条
    const idx = session.messages.findIndex((m) => m.id === assistantMsgId)
    if (idx < 0 || idx !== session.messages.length - 1) return
    const lastMsg = session.messages[idx]
    if (lastMsg.role !== 'assistant' || !lastMsg.content) return

    setAutoScroll(true)
    // 复用原消息 id 作为 streamId，避免 React key 变化导致 MessageBubble 卸载重装（丢失 ThinkBlock 状态）
    const streamId = assistantMsgId

    // 后续 delta 通过 streamId 路由追加到这条消息
    const continuedMsg: ChatMessage = {
      ...lastMsg,
      id: streamId,
      stopped: undefined,
      error: undefined,
      toolCalls: undefined,
      preToolContentLen: undefined,
      tokensDecoded: undefined,
      msFirstToken: undefined,
      decodeTokS: undefined,
    }
    const newMessages = [...session.messages.slice(0, idx), continuedMsg]
    replaceMessages(activeSessionId, newMessages)
    setStreamForSession(activeSessionId, streamId)

    // 预填缓冲区：保留原始内容，流结束时 deltas 追加其后而非替换
    streamingBuffer[streamId] = lastMsg.content

    // 看门狗：90 秒无响应超时
    streamReceivedRef.current.set(streamId, false)
    const wdTimer = setTimeout(() => {
      const st = useChatStore.getState()
      if (st.streamingMap[session.id] === streamId && !streamReceivedRef.current.get(streamId)) {
        st.markLastMessageError(session.id, '继续生成超时（90s 内无数据返回）')
        st.clearStreamForSession(session.id)
        streamReceivedRef.current.delete(streamId)
      }
      streamWatchdogsRef.current.delete(streamId)
    }, 90000)
    streamWatchdogsRef.current.set(streamId, wdTimer)

    // 手动构建消息数组，添加继续生成指令
    const currentSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)!
    const messages: Array<{ role: string; content: string }> = []
    if (currentSession.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: currentSession.systemPrompt.trim() })
    }
    // 剥离 <think> 标签（UI 专用格式，发给模型会干扰其推理启动逻辑）
    const stripThink = (text: string) =>
      text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim()
    let lastAsstHadText = false
    for (const m of currentSession.messages) {
      if (m.role === 'system') continue
      const content = stripThink(m.content || '')
      // 助手消息即使内容为空也保留（纯 think 块/工具调用场景）
      // 用户消息为空则跳过
      if (m.role === 'assistant') {
        messages.push({ role: m.role, content: content || '' })
        if (content) lastAsstHadText = true
      } else {
        if (!content && !m.error) continue
        messages.push({ role: m.role, content })
      }
    }
    // 注入接续指令（用 user 角色，因为大多数模板要求 system 只能在开头）
    messages.push({
      role: 'user',
      content: lastAsstHadText
        ? '请从助手消息被中断的位置继续往后写。直接续写，不要重复任何已有内容（包括用户的问题），不要加开场白或过渡语。'
        : '助手在推理过程中被中断了，还没有产出可见的回答。请继续推理并直接给出最终答案。不要重复用户的问题。'
    })

    try {
      await window.api.chatStream({
        streamId,
        port: session.port,
        body: {
          messages,
          temperature: session.params.temperature,
          top_p: session.params.top_p,
          top_k: session.params.top_k,
          max_tokens: session.params.max_tokens || -1,
          repeat_penalty: session.params.repeat_penalty,
          stream: true,
          // add_generation_prompt: false  // 部分后端不支持此参数，注释掉
        }
      })
    } catch (e: any) {
      const st = useChatStore.getState()
      st.markLastMessageError(session.id, e?.message || '继续生成失败')
      // 清理看门狗
      const wd = streamWatchdogsRef.current.get(streamId)
      if (wd) { clearTimeout(wd); streamWatchdogsRef.current.delete(streamId) }
      if (st.streamingMap[session.id] === streamId) {
        st.clearStreamForSession(session.id)
      }
    }
  }, [activeSessionId, activeStreamId, runningModels, replaceMessages, setStreamForSession])

  return (
    <div className={`chat-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className={`chat-sidebar-collapser ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={selectSession}
          onNew={handleNew}
          onRename={renameSession}
          onDeleteRequest={(s) => deleteSession(s.id)}
          runningModels={runningModels}
          streamingSessionIds={Object.keys(streamingMap)}
          onToggleStar={toggleSessionStar}
        />
      </div>

      <div
        className="chat-main"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="chat-main-col">
          {/* 拖拽上传遮罩 */}
          {dragOverCount > 0 && (
            <div className="chat-drop-overlay">
              <div className="chat-drop-overlay-inner">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>释放文件以上传</span>
                <span className="chat-drop-overlay-hint">支持图片、文本、PDF、代码文件等</span>
              </div>
            </div>
          )}
          <div className="chat-header">
            <button
              className="chat-collapse-btn"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <div className="chat-header-info">
              <span className="chat-header-title">{activeSession?.title || '聊天'}</span>
              <CustomSelect
                className="chat-model-select"
                value={activeSession && runningModels.length > 0 ? activeSession.templateId : ''}
                onChange={(v) => handleSwitchModel(v)}
                options={runningModels.map(m => ({ value: m.id, label: `${m.name} (:${m.port})` }))}
                placeholder="模型未运行"
                disabled={runningModels.length === 0}
              />
            </div>
            {activeModel && (
              <button
                className="chat-settings-btn chat-stop-model-btn"
                onClick={handleStopModel}
              >
                <Square size={14} />
              </button>
            )}
            <button
              ref={settingsBtnRef}
              className="chat-settings-btn"
              onClick={() => {
                if (settingsBtnRef.current) {
                  setSettingsAnchor(settingsBtnRef.current.getBoundingClientRect())
                }
                setShowSettings((v) => !v)
              }}
            >
              <SlidersHorizontal size={16} />
            </button>
            <button
              ref={toolsBtnRef}
              className="chat-settings-btn"
              onClick={() => {
                if (toolsBtnRef.current) {
                  setToolsAnchor(toolsBtnRef.current.getBoundingClientRect())
                }
                setShowTools((v) => !v)
              }}
            >
              <Wrench size={16} />
            </button>
            <button
              className="chat-settings-btn"
              onClick={handleExportPng}
            >
              <ImageDown size={16} />
            </button>
            <button
              className="chat-settings-btn"
              onClick={handleExportPdf}
            >
              <FileText size={16} />
            </button>
            <button
              className={`chat-settings-btn ${filePanelOpen ? 'preview-active' : ''}`}
              onClick={() => {
                const next = !filePanelOpen
                setFilePanelOpen(next)
                setSidebarCollapsed(next ? true : false)
              }}
            >
              <Eye size={14} />
            </button>
          </div>

          <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScrollThrottled} onContextMenu={handleChatContextMenu}>
            {activeSession ? (
              activeMessages.length === 0 ? (
                <div className="chat-welcome">
                  <Bot size={40} style={{ opacity: 0.3 }} />
                  {activeModel ? (
                    <>
                      <p>向 {activeModel.name} 提个问题吧</p>
                      <div className="chat-welcome-suggestions">
                        <span className="chat-welcome-suggestions-label">试试这些提问</span>
                        <div className="chat-welcome-suggestions-grid">
                          {[
                            '用简单的语言解释一下量子计算',
                            '帮我写一段 Python 快速排序',
                            '给我讲一个有趣的冷知识',
                            '帮我总结今天的要点',
                          ].map((q) => (
                            <button
                              key={q}
                              className="chat-welcome-suggestion-btn"
                              onClick={() => { setInput(q); inputRef.current?.focus() }}
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <p>该会话的模型未运行，无法发送消息</p>
                      <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setView('cards')}>
                        前往「我的模板」启动模型
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                activeMessages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    isStreaming={activeStreamId === m.id}
                    serverPort={activeModel?.port}
                    onImageClick={setPreviewImage}
                    onEdit={m.role === 'user' ? () => handleEditMessage(m.id, m.content, m.attachments) : undefined}
                    onRegenerate={m.role === 'assistant' ? () => handleRegenerate(m.id) : undefined}
                    regenDisabled={!!activeStreamId}
                    onContinue={m.role === 'assistant' && m.id === activeMessages[activeMessages.length - 1]?.id
                      ? () => handleContinue(m.id) : undefined}
                    continueDisabled={!!activeStreamId}
                    onDelete={m.role === 'assistant' ? () => handleDeleteReply(m.id) : undefined}
                    deleteDisabled={!!activeStreamId}
                    onBranch={m.role === 'assistant' ? () => handleBranch(m.id) : undefined}
                    speakingId={speakingId}
                    onSpeak={speak}
                    onStopTts={stopTts}
                  />
                ))
              )
            ) : (
              <div className="chat-welcome">
                <div className="chat-welcome-brand">
                  <MessageSquare size={56} strokeWidth={1.2} />
                </div>
                <h2 className="chat-welcome-title">开始对话</h2>
                <p className="chat-welcome-subtitle">
                  从左侧选择一个已有会话，或点击「新建」开始新的对话。
                </p>
                <div className="chat-welcome-tips">
                  <div className="chat-welcome-tip">
                    <Plus size={16} />
                    <span>点击「新建」创建会话</span>
                  </div>
                  <div className="chat-welcome-tip">
                    <Pencil size={16} />
                    <span>点铅笔图标可重命名</span>
                  </div>
                  <div className="chat-welcome-tip">
                    <Trash2 size={16} />
                    <span>悬停会话可删除</span>
                  </div>
                </div>
                {runningModels.length > 0 && (
                  <div className="chat-welcome-suggestions">
                    <span className="chat-welcome-suggestions-label">试试这些提问</span>
                    <div className="chat-welcome-suggestions-grid">
                      {[
                        '用简单的语言解释一下量子计算',
                        '帮我写一段 Python 快速排序',
                        '给我讲一个有趣的冷知识',
                        '帮我总结今天的要点',
                      ].map((q) => (
                        <button
                          key={q}
                          className="chat-welcome-suggestion-btn"
                          onClick={() => { setInput(q); inputRef.current?.focus() }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 回到底部浮动按钮：锚定在 chat-main-col（非滚动容器）内，
              精确悬浮在输入框正上方；仅当用户已向上滚动（非贴底）时显示 */}
          {!atBottom && activeMessages.length > 0 && (
            <button
              className="chat-scroll-bottom-btn"
              onClick={() => {
                setAutoScroll(true)
                const c = messagesContainerRef.current
                if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' })
              }}
            >
              <ArrowDown size={16} />
            </button>
          )}

          {/* 消息导航侧边栏 */}
          {activeMessages.length >= 2 && (
            <MessageNav
              messages={activeMessages}
              activeMsgId={activeNavMsgId}
              containerRef={messagesContainerRef}
            />
          )}

          {/* 全局右键菜单 */}
          {ctxMenu && (
            <div ref={ctxMenuRef} className="chat-msg-context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}>
              <button className="chat-msg-context-menu-item" onClick={handleCtxCopy}>
                <Copy size={13} />
                <span>复制</span>
              </button>
              {ctxMenu.selectedText && (
                <button className="chat-msg-context-menu-item" onClick={handleCtxAddToInput}>
                  <MessageSquare size={13} />
                  <span>添加到输入框</span>
                </button>
              )}
              {ctxMenu.selectedText && (
                <button className="chat-msg-context-menu-item" onClick={handleCtxQuoteAsk}>
                  <MessageSquare size={13} />
                  <span>引用追问</span>
                </button>
              )}
            </div>
          )}

          {/* 引用追问弹出输入框 */}
          {quoteInput && (
            <div ref={quotePopupRef} className="chat-quote-popup" style={{ left: quoteInput.x, top: quoteInput.y }}>
              <div className="chat-quote-popup-header">引用追问</div>
              <div className="chat-quote-popup-quote">{quoteInput.selectedText}</div>
              <form onSubmit={handleQuoteSubmit} className="chat-quote-popup-form">
                <input
                  ref={quoteInputRef}
                  className="chat-quote-input"
                  type="text"
                  placeholder="输入你的问题…"
                  autoFocus
                  onKeyDown={handleQuoteKeyDown}
                />
                <button type="submit" className="chat-quote-popup-send">
                  <Send size={14} />
                </button>
              </form>
            </div>
          )}

          {/* 输入代码预览：独立于输入框，置于其上方 */}
          {showInputPreview && (
            <div className="chat-input-preview">
              <div className="chat-input-preview-header">
                <Eye size={12} />
                <span>代码预览</span>
                <button
                  className="chat-input-preview-close"
                  onClick={() => setInputPreviewDismissed(true)}
                >
                  <X size={12} />
                </button>
              </div>
              <div className="chat-input-preview-body">
                <UserMessageContent content={processedInput} />
              </div>
            </div>
          )}

          <div className={`chat-input-wrap${activeStreamId ? ' streaming' : ''}`} ref={chatInputWrapRef}>
            {/* 隐藏的文件选择器 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.json,.js,.ts,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.css,.html,.xml,.yaml,.yml,.toml,.ini,.cfg,.csv,.log,.sh,.bat,.ps1,.sql,.r,.lua,.php,.rb,.swift,.kt,.scala,.tex,.srt,.vtt,.smi,.ass,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            {/* 附件 chips（图片缩略图预览，显示在输入框上方） */}
            {attachedFiles.length > 0 && (
              <div className="chat-attach-chips">
                {attachedFiles.map((f, i) => {
                  const isImg = f.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(f.name)
                  return (
                    <div key={i} className={`chat-attach-chip ${isImg ? 'chat-attach-chip-img' : ''}`}>
                      {isImg ? (
                        <div className="chat-attach-chip-img-box">
                          <img
                            src={previewUrls.get(i) || ''}
                            alt={f.name}
                            className="chat-attach-chip-thumb"
                          />
                          <button className="chat-attach-chip-img-remove" onClick={() => removeAttachedFile(i)}>
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <FileText size={12} />
                          <span className="chat-attach-chip-name">{f.name}</span>
                          <span className="chat-attach-chip-size">({formatFileSize(f.size)})</span>
                          <button className="chat-attach-chip-remove" onClick={() => removeAttachedFile(i)}>
                            <X size={11} />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="chat-input-row">
              <button
                className="chat-attach-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              <textarea
                ref={inputRef}
                className="chat-input"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                placeholder={
                  activeStreamId
                    ? '正在生成，可发送新消息（将自动停止当前流）…'
                    : activeModel
                      ? `给 ${activeModel.name} 发消息（Enter 发送，Shift+Enter 换行）`
                      : '请先启动模型，输入内容将在启动后可发送'
                }
                value={input}
                onChange={handleInputChange}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                rows={1}
              />
              {activeStreamId ? (
                <button className="btn btn-danger chat-send-btn" onClick={handleStop}>
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="btn btn-primary chat-send-btn"
                  onClick={handleSend}
                  disabled={!input.trim() && attachedFiles.length === 0 || !activeModel}
                >
                  <Send size={15} />
                </button>
              )}

            </div>
          </div>

        </div>

        {/* 右侧文件预览分屏面板 */}
        {filePanelOpen && (
          <>
            <div className="chat-file-divider" onMouseDown={handleDividerMouseDown} />
            <div className="chat-file-panel" style={{ width: filePanelWidth + '%', maxWidth: filePanelWidth + '%' }}>
              <div className="chat-file-panel-header">
                <FileText size={16} />
                <span>文件预览</span>
                <button
                  className="chat-file-panel-close"
                  onClick={() => { setFilePanelOpen(false); setSidebarCollapsed(false) }}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="chat-file-tabs">
                {attachedFiles.map((f, i) => (
                  <button
                    key={i}
                    className={`chat-file-tab${filePreviewIndex === i ? ' active' : ''}`}
                    onClick={() => { setFilePreviewIndex(i); setHtmlRenderMode(false) }}
                  >
                    <span className="chat-file-tab-icon">{getFileIcon(f.name)}</span>
                    <span className="chat-file-tab-name">{f.name}</span>
                    <span
                      className="chat-file-tab-close"
                      role="button"
                      title="关闭预览"
                      onClick={(e) => { e.stopPropagation(); removeAttachedFile(i) }}
                    >
                      <X size={11} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="chat-file-content">
                {attachedFiles.length > 0 && (() => {
                  const f = attachedFiles[filePreviewIndex]
                  if (!f) return <div className="chat-file-preview-loading">预览不可用</div>
                  const isImg = f.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(f.name)
                  const imgUrl = previewUrls.get(filePreviewIndex)
                  const textContent = uploadedFileTexts.get(filePreviewIndex)
                  if (isImg && imgUrl) {
                    return <img src={imgUrl} alt={f.name} className="chat-file-preview-img" />
                  }
                  // PDF 渲染：支持多页翻页
                  if (isPdfFile(f.name)) {
                    const pages = pdfPagesCache.get(filePreviewIndex)
                    const pageIdx = pdfPageNum.get(filePreviewIndex) || 1
                    const totalPages = pages?.length || 0
                    if (pages && pages.length > 0) {
                      const pageDataUrl = pages[pageIdx - 1]
                      return (
                        <div className="chat-file-preview-pdf">
                          <img src={pageDataUrl} alt={`${f.name} 第${pageIdx}页`} className="chat-file-preview-pdf-img" />
                          {totalPages > 1 ? (
                            <div className="chat-file-preview-pdf-nav">
                              <button
                                className="chat-file-preview-pdf-nav-btn"
                                disabled={pageIdx <= 1}
                                onClick={() => {
                                  setPdfPageNum(prev => {
                                    const n = new Map(prev)
                                    n.set(filePreviewIndex, Math.max(1, pageIdx - 1))
                                    return n
                                  })
                                }}
                              >‹ 上一页</button>
                              <span className="chat-file-preview-pdf-page">{pageIdx} / {totalPages}</span>
                              <button
                                className="chat-file-preview-pdf-nav-btn"
                                disabled={pageIdx >= totalPages}
                                onClick={() => {
                                  setPdfPageNum(prev => {
                                    const n = new Map(prev)
                                    n.set(filePreviewIndex, Math.min(totalPages, pageIdx + 1))
                                    return n
                                  })
                                }}
                              >下一页 ›</button>
                            </div>
                          ) : (
                            <div className="chat-file-preview-file-info">📄 {f.name}</div>
                          )}
                        </div>
                      )
                    }
                    if (textContent && textContent.startsWith('[PDF 预览失败')) {
                      return <div className="chat-file-preview-loading">{textContent}</div>
                    }
                    return <div className="chat-file-preview-loading">加载 PDF 中…</div>
                  }
                  // DOCX 渲染：mammoth 转换为 HTML
                  if (isDocxFile(f.name)) {
                    if (textContent != null) {
                      return (
                        <div
                          className="chat-file-preview-docx"
                          dangerouslySetInnerHTML={{ __html: textContent }}
                        />
                      )
                    }
                    return <div className="chat-file-preview-loading">加载 DOCX 中…</div>
                  }
                  if (textContent != null) {
                    // HTML 文件：可选渲染模式
                    if (isHtmlFile(f.name)) {
                      return (
                        <div className="chat-file-preview-html">
                          <div className="chat-file-preview-html-toolbar">
                            <button
                              className={`chat-file-preview-html-btn${!htmlRenderMode ? ' active' : ''}`}
                              onClick={() => setHtmlRenderMode(false)}
                            >
                              &lt;/&gt; 源码
                            </button>
                            <button
                              className={`chat-file-preview-html-btn${htmlRenderMode ? ' active' : ''}`}
                              onClick={() => setHtmlRenderMode(true)}
                            >
                              👁 预览
                            </button>
                          </div>
                          {htmlRenderMode ? (
                            <iframe
                              className="chat-file-preview-iframe"
                              sandbox=""
                              srcDoc={textContent}
                            />
                          ) : (
                            <div className="chat-code-body with-lines chat-file-preview-code">
                              <pre className="chat-file-preview-ln" aria-hidden="true">
                                {textContent.split('\n').map((_, i) => (
                                  <span key={i}>{i + 1}</span>
                                ))}
                              </pre>
                              <pre className="chat-file-preview-text">{textContent}</pre>
                            </div>
                          )}
                        </div>
                      )
                    }
                    // Markdown 文件 → ReactMarkdown 渲染
                    if (isMarkdownFile(f.name)) {
                      // 更新图片渲染器的 ref，使其能解析相对路径
                      setPreviewFileBaseDirs(fileBaseDirs, filePreviewIndex)
                      const previewComponents = {
                        img: PreviewMarkdownImage
                      }
                      return (
                        <div className="chat-file-preview-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex, rehypeRaw, [rehypeSanitize, FILE_PREVIEW_SANITIZE_SCHEMA]]}
                            remarkRehypeOptions={{ allowDangerousHtml: true }}
                            urlTransform={(url) => /^(https?:|mailto:|file:|data:)/i.test(url) ? url : defaultUrlTransform(url)}
                            components={previewComponents}
                          >
                            {textContent}
                          </ReactMarkdown>
                        </div>
                      )
                    }
                    // 代码/数据文件 → 带行号的原样显示（不复用 CodeBlock 的收起/复制 UI）
                    const lang = getCodeLanguage(f.name)
                    if (lang) {
                      return (
                        <div className="chat-code-body with-lines chat-file-preview-code">
                          <pre className="chat-file-preview-ln" aria-hidden="true">
                            {textContent.split('\n').map((_, i) => (
                              <span key={i}>{i + 1}</span>
                            ))}
                          </pre>
                          <pre className="chat-file-preview-text">{textContent}</pre>
                        </div>
                      )
                    }
                    // 纯文本文件 → <pre> 渲染
                    return <pre className="chat-file-preview-text">{textContent}</pre>
                  }
                  // 图片尚未加载完成的占位
                  if (isImg && !imgUrl) {
                    return <div className="chat-file-preview-loading">加载图片中…</div>
                  }
                  return <div className="chat-file-preview-loading">加载文件中…</div>
                })()}
              </div>
            </div>
          </>)}
      </div>

      {/* 参数/系统提示词设置卡片 */}
      {showSettings && (
        <ChatSettingsCard
          session={activeSession}
          anchorRect={settingsAnchor}
          onClose={() => setShowSettings(false)}
          onSetSystemPrompt={(prompt) => activeSession && setSystemPrompt(activeSession.id, prompt)}
          onSetParams={(params) => activeSession && setParams(activeSession.id, params)}
        />
      )}

      {showTools && (
        <ToolToggleCard
          config={toolConfig}
          anchorRect={toolsAnchor}
          onClose={() => setShowTools(false)}
          onChange={setToolConfig}
        />
      )}

      <ConfirmModal
        open={deletingMsgId !== null}
        title="删除消息"
        message="确定删除此回复及其后续消息？此操作不可撤销。"
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (deletingMsgId && activeSessionId) truncateAfter(activeSessionId, deletingMsgId)
          setDeletingMsgId(null)
        }}
        onCancel={() => setDeletingMsgId(null)}
      />

      {/* 图片点击放大遮罩 */}
      {previewImage && (
        <div className="chat-image-overlay" onClick={() => setPreviewImage(null)}>
          <button className="chat-image-overlay-close" onClick={() => setPreviewImage(null)}>
            <X size={20} />
          </button>
          <img src={previewImage} alt="preview" className="chat-image-overlay-img" />
        </div>
      )}
    </div>
  )
}
