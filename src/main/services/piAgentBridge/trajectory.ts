// 轨迹台账（阶段 1）：pi 会话事件流完整落盘 —— "Model-visible means logged"。
// 架构思想移植自 deepseek-harness 的单一追加式事件流：所有到达模型/由模型产生的
// 事件按序写入 <root>/trajectory/<sessionId>.jsonl，每行一个信封：
//   { seq, ts, type, src, payload }
// src 分类：flow(生命周期) | assistant(消息) | tool(工具执行) | user(用户输入) | system(其余)
// 体积控制：message_update 只记 assistantMessageEvent.type + deltaLen（流式 partial 全量内容
// 随输出增长可达数十 KB，完整内容已在 message_end 落盘）；任意字符串 >32KB 截断并标记。
// 单文件超过 4MB 轮转为 .1（与 Agent session/traces 同策略）；seq 内存计数，进程重启时
// 读文件末行续号。本模块不依赖 Electron：根目录由 IPC 层注入（保持 manager 可独立测试）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export type TrajectorySrc = 'flow' | 'assistant' | 'tool' | 'user' | 'system' | 'llm'

/** 单条轨迹记录信封 */
export interface TrajectoryEntry {
  seq: number
  ts: number
  type: string
  src: TrajectorySrc
  payload: unknown
}

const MAX_BYTES = 4 * 1024 * 1024 // 与 traces 相同的轮转阈值
const MAX_STR = 32 * 1024 // 单字符串截断阈值

let rootDir = ''

/** 注入轨迹存储根目录（IPC 层启动时调用一次；未注入时回退 cwd，保证可独立测试） */
export function setTrajectoryRoot(agentSessionDir: string): void {
  rootDir = agentSessionDir
}

function trajDir(): string {
  return rootDir || join(process.cwd(), 'Agent session')
}

function isValidId(sessionId: string): boolean {
  return !!sessionId && !/[\\/]/.test(sessionId) && !sessionId.includes('..')
}

function fileFor(sessionId: string): string {
  return join(trajDir(), 'trajectory', `${sessionId}.jsonl`)
}

// ── seq 计数器：内存缓存 + 重启时读文件末行续号 ──
const seqCounters = new Map<string, number>()

function lastSeqInFile(path: string): number | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf-8')
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as { seq?: unknown }
        if (typeof obj?.seq === 'number') return obj.seq
      } catch {
        /* 尾部半行（崩溃残留）跳过，继续向前找 */
      }
    }
  } catch {
    /* 读失败当作无历史 */
  }
  return null
}

function nextSeq(sessionId: string): number {
  const cur = seqCounters.get(sessionId)
  if (cur !== undefined) {
    seqCounters.set(sessionId, cur + 1)
    return cur + 1
  }
  const file = fileFor(sessionId)
  // 主文件优先；被轮转走的主文件内容在 .1 里也扫一下（覆盖刚轮转后重启的边界情况）
  const resumed = lastSeqInFile(file) ?? lastSeqInFile(file + '.1') ?? -1
  const n = resumed + 1
  seqCounters.set(sessionId, n)
  return n
}

// ── turnIndex 计数器：pi subscribe 流的 turn_start 不携带轮次序号（仅扩展 API 分支带），
// 面板分组标签因此显示「Turn ?」。此处自行计数并注入 payload.turnIndex（0 基，与 pi 扩展
// 事件语义一致：首个 turn_start → 0）。进程重启后从既有台账统计历史轮数续号。
const turnCounters = new Map<string, number>()

function countTurnStartsInFile(path: string): number {
  try {
    if (!existsSync(path)) return 0
    const text = readFileSync(path, 'utf-8')
    let n = 0
    for (const line of text.split('\n')) {
      if (line.includes('"type":"turn_start"')) n++
    }
    return n
  } catch {
    return 0
  }
}

function turnIndexFor(sessionId: string): number {
  const cur = turnCounters.get(sessionId)
  if (cur !== undefined) {
    turnCounters.set(sessionId, cur + 1)
    return cur + 1
  }
  const file = fileFor(sessionId)
  const n = countTurnStartsInFile(file) + countTurnStartsInFile(file + '.1')
  turnCounters.set(sessionId, n)
  return n
}

// ── 体积控制 ──

/** 深度遍历：超长字符串替换为截断标记对象（保留长度与前 32KB 预览） */
function truncateDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_STR) return value
    return { __trunc: true, len: value.length, preview: value.slice(0, MAX_STR) }
  }
  if (Array.isArray(value)) return value.map(truncateDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v)
    return out
  }
  return value
}

/** 事件来源分类（台账筛选维度） */
function classify(type: string, event: Record<string, unknown>): TrajectorySrc {
  switch (type) {
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_end':
    case 'agent_settled':
      return 'flow'
    case 'message_start':
    case 'message_update':
    case 'message_end':
      return 'assistant'
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return 'tool'
    case 'entry_appended': {
      const entry = event.entry as { message?: { role?: string } } | undefined
      return entry?.message?.role === 'user' ? 'user' : 'system'
    }
    case 'llm_request':
    case 'llm_response':
      return 'llm'
    default:
      return 'system'
  }
}

// ── LLM 请求快照（阶段 2：request-header）──
// pi 的 Agent.onPayload 在每次 LLM HTTP 请求前收到完整 chat completions 请求体。
// 全量落盘会让文件暴涨（每轮重复携带全部历史），因此只记结构摘要：
// 模型、采样参数、消息概要（role+字符数+短预览）、工具清单；工具签名变更时打标。

/** 工具签名缓存（跨请求对比，检测 tools 变更 —— harness request-header 的核心能力） */
const lastToolsSig = new Map<string, string>()

interface LlmMessageLike {
  role?: unknown
  content?: unknown
}

function textLenOf(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const b of content) {
      if (b && typeof b === 'object') {
        const o = b as { text?: unknown; thinking?: unknown }
        if (typeof o.text === 'string') n += o.text.length
        else if (typeof o.thinking === 'string') n += o.thinking.length
      }
    }
    return n
  }
  return 0
}

function previewTextOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 160)
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object') {
        const t = (b as { text?: unknown }).text
        if (typeof t === 'string' && t.trim()) return t.slice(0, 160)
      }
    }
  }
  return ''
}

/** 把 chat completions 请求体瘦身为可读快照（消息全文不落盘，只留 role+长度+预览） */
export function summarizeLlmRequest(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>
  const messages = Array.isArray(p.messages) ? (p.messages as LlmMessageLike[]) : []
  let promptChars = 0
  const msgSummaries = messages.map((m) => {
    const len = textLenOf(m?.content)
    promptChars += len
    return {
      role: typeof m?.role === 'string' ? m.role : '?',
      chars: len,
      preview: previewTextOf(m?.content)
    }
  })
  const toolNames = Array.isArray(p.tools)
    ? (p.tools as Array<{ function?: { name?: unknown }; name?: unknown }>).map((t) =>
        typeof t?.function?.name === 'string' ? t.function.name : typeof t?.name === 'string' ? t.name : '?'
      )
    : []
  const params: Record<string, unknown> = {}
  for (const k of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'reasoning_effort']) {
    if (p[k] !== undefined) params[k] = p[k]
  }
  return {
    model: typeof p.model === 'string' ? p.model : undefined,
    stream: p.stream === true,
    params,
    messageCount: messages.length,
    promptChars,
    messages: truncateDeep(msgSummaries),
    toolCount: toolNames.length,
    tools: toolNames.length ? toolNames : undefined
  }
}

/** 记录一次 LLM 请求快照（manager 从 Agent.onPayload 钩子调用）；返回是否发生工具集变更 */
export function appendLlmRequest(sessionId: string, summary: Record<string, unknown>): boolean {
  const sig = Array.isArray(summary.tools) ? (summary.tools as string[]).join(',') : ''
  const prev = lastToolsSig.get(sessionId)
  const changed = prev !== undefined && sig !== prev
  lastToolsSig.set(sessionId, sig)
  appendEntry(sessionId, {
    ts: Date.now(),
    type: 'llm_request',
    src: 'llm',
    payload: changed ? { ...summary, toolsChanged: true } : summary
  })
  return changed
}

/** message_update 瘦身：丢弃全量 partial，只留类型与文本进度（完整内容在 message_end） */
function slimMessageUpdate(event: Record<string, unknown>): unknown {
  const ame = event.assistantMessageEvent as
    | { type?: string; partial?: { content?: Array<{ text?: unknown }> } }
    | undefined
  let deltaLen = 0
  const blocks = ame?.partial?.content
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b && typeof b.text === 'string') deltaLen += b.text.length
    }
  }
  return { assistantMessageEvent: { type: ame?.type, deltaLen } }
}

function appendEntry(sessionId: string, entry: Omit<TrajectoryEntry, 'seq'>): void {
  if (!isValidId(sessionId)) return
  try {
    const file = fileFor(sessionId)
    if (!existsSync(file)) mkdirSync(join(trajDir(), 'trajectory'), { recursive: true })
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* 轮转失败则直接追加 */
    }
    const seq = nextSeq(sessionId)
    writeFileSync(file, JSON.stringify({ ...entry, seq }) + '\n', { flag: 'a' })
  } catch {
    /* 落盘失败静默：轨迹是旁路观测，绝不影响主事件流 */
  }
}

// ── 写入 API（manager 在 subscribe 回调里同步调用）──

/** 追加一条 pi 会话事件到轨迹台账 */
export function appendSessionEvent(sessionId: string, event: unknown): void {
  if (!event || typeof event !== 'object') return
  const ev = event as Record<string, unknown>
  const type = typeof ev.type === 'string' ? ev.type : 'unknown'
  let payload = type === 'message_update' ? slimMessageUpdate(ev) : truncateDeep(ev)
  if (type === 'turn_start') {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    if (typeof p.turnIndex !== 'number') {
      payload = { ...p, turnIndex: turnIndexFor(sessionId) }
    }
  }
  appendEntry(sessionId, { ts: Date.now(), type, src: classify(type, ev), payload })
}

/** 会话创建头信息（cwd / 工具清单 / 提示词长度 / 历史条数等元数据） */
export function writeTrajectoryHeader(sessionId: string, header: Record<string, unknown>): void {
  appendEntry(sessionId, { ts: Date.now(), type: 'session_header', src: 'system', payload: truncateDeep(header) })
}

// pi 的 AgentSessionEvent 仅在扩展 API appendEntry（自定义条目）时才发 entry_appended，
// 普通 user 消息入账与 system/developer 提示词不产生任何事件 —— 台账若只依赖 subscribe
// 将永远缺失「用户输入」与「系统信息」两类行。以下两个函数由 manager 在对应时机主动补记，
// 事件形状与 pi 原生 entry_appended 保持一致（{ entry: { message: { role, content } } }），
// 面板渲染分支无需特判。

/** 记录用户输入（manager.prompt 入口调用；imageCount>0 时在正文追加占位说明） */
export function appendUserEntry(sessionId: string, text: string, imageCount?: number): void {
  const content = typeof imageCount === 'number' && imageCount > 0 ? `${text || ''}\n[图片 ×${imageCount}]` : (text || '')
  appendEntry(sessionId, {
    ts: Date.now(),
    type: 'entry_appended',
    src: 'user',
    payload: truncateDeep({ entry: { message: { role: 'user', content } } })
  })
}

const systemMsgRecorded = new Set<string>()

/**
 * 记录发往模型的 system/developer 消息（即「系统信息」的真实来源）。
 * 在首次 LLM 请求时从请求体提取，每会话只记一次（提示词内容在会话期内不变；
 * clearTrajectory 重置防重标记）。文本超长由 truncateDeep 按 32KB 截断保底。
 */
export function appendLlmSystemMessages(sessionId: string, messages: unknown): void {
  if (!Array.isArray(messages)) return
  const sys = messages.filter(
    (m) => m && typeof m === 'object' && ((m as { role?: unknown }).role === 'system' || (m as { role?: unknown }).role === 'developer')
  )
  if (sys.length === 0) return
  if (systemMsgRecorded.has(sessionId)) return
  systemMsgRecorded.add(sessionId)
  for (const m of sys) {
    appendEntry(sessionId, {
      ts: Date.now(),
      type: 'entry_appended',
      src: 'system',
      payload: truncateDeep({ entry: { message: m } })
    })
  }
}

// ── 查询 API（IPC 层转发 renderer）──

export interface TrajectorySummary {
  sessionId: string
  bytes: number
  mtimeMs: number
}

/** 列出全部轨迹文件（按最近更新倒序） */
export function listTrajectories(): TrajectorySummary[] {
  const dir = join(trajDir(), 'trajectory')
  try {
    if (!existsSync(dir)) return []
    const out: TrajectorySummary[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        out.push({ sessionId: name.slice(0, -'.jsonl'.length), bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* 单个文件统计失败跳过 */
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

/**
 * 读取轨迹（fromSeq 增量）：返回 seq > fromSeq 的条目与当前最大 seq，
 * renderer 以 nextSeq 作为下次拉取游标（面板打开期间轮询增量，避免重复传输整文件）。
 */
export function readTrajectory(sessionId: string, fromSeq: number): { entries: TrajectoryEntry[]; nextSeq: number } {
  if (!isValidId(sessionId)) return { entries: [], nextSeq: Math.max(0, fromSeq || 0) }
  try {
    const file = fileFor(sessionId)
    if (!existsSync(file)) return { entries: [], nextSeq: Math.max(0, fromSeq || 0) }
    const text = readFileSync(file, 'utf-8')
    const entries: TrajectoryEntry[] = []
    let maxSeq = Math.max(0, fromSeq || 0)
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as TrajectoryEntry
        if (typeof e.seq !== 'number') continue
        if (e.seq > maxSeq) maxSeq = e.seq
        if (e.seq > (fromSeq || 0)) entries.push(e)
      } catch {
        /* 半行跳过 */
      }
    }
    return { entries, nextSeq: maxSeq }
  } catch {
    return { entries: [], nextSeq: Math.max(0, fromSeq || 0) }
  }
}

/** 清空某会话轨迹（删除主文件与轮转残留；seq 归零重新计数） */
export function clearTrajectory(sessionId: string): { success: boolean; error?: string } {
  if (!isValidId(sessionId)) return { success: false, error: '无效的 sessionId' }
  try {
    const wipe = (p: string): void => {
      try {
        if (existsSync(p)) writeFileSync(p, '', { flag: 'w' }) // 清空（保留文件句柄友好）而非删除
      } catch {
        /* 失败忽略 */
      }
    }
    const file = fileFor(sessionId)
    wipe(file)
    wipe(file + '.1')
    seqCounters.delete(sessionId)
    turnCounters.delete(sessionId)
    lastToolsSig.delete(sessionId)
    systemMsgRecorded.delete(sessionId)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
