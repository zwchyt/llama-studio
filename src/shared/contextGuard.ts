// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：contextGuard —— 发请求前的机械兜底（不经 LLM，不丢消息）                 ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// 这里是「上下文一定会超」的那条底线：LLM 压缩（pi 原生 compaction，按真实 usage 触发）
// 负责把早期整段历史换成一条摘要，但它管不到一轮之内的膨胀 —— 一个 turn 里可以连打
// 几十个工具结果，那段增长既没到压缩水位、也没人裁它。没有兜底，结局就是 400 且本轮丢失。
//
// 挂接点是 pi 的 agent.transformContext（每次请求都会调，且排在 pi 自己的投影之后、
// convertToLlm 之前），见 piAgentBridge/index.ts。
//
// 三条不变量：
//   1. 只截断，绝不删除消息 —— toolCall 与它的结果必须成对存在，删一条就会让
//      OpenAI 兼容端点报 400。
//   2. 幂等 —— pi 的会话状态始终是原文，本函数每次请求都从原文重新裁剪，结果只取决于
//      输入与预算，不会因为「上一轮已经裁过」而越裁越短。
//   3. 从最旧的开始裁，最新的工具结果保全 —— 模型正在用的东西不该被削。
//
// 纯函数、无 Electron / 无 DOM 依赖：渲染进程与 pi worker 都能 import。

/** 守卫需要的消息结构子集（兼容 pi 的 AgentMessage，避免在这里绑死 pi 的类型）。
    刻意不写索引签名：带 `[k: string]: unknown` 时 pi 的 Message 接口无法隐式匹配，
    结构性赋值反而不成立。 */
export interface GuardableMessage {
  role: string
  content?: unknown
  /** 仅工具结果消息有：llama-studio 侧的 Read/Grep/Bash 等工具名 */
  toolName?: string
  /** 仅系统消息有：本会话新增的工具声明，参与 prompt 体积 */
  toolsAdded?: unknown
}

/** 图片的固定 token 记账（与 pi 的 ESTIMATED_IMAGE_CHARS=4800 / 4 对齐；本地视觉塔
    的 patch 数与像素相关而非 base64 长度，按字符算会严重失真，所以用常量估） */
export const GUARD_IMAGE_TOKENS = 1200
/** 非 Read 工具结果（Bash / Grep / 搜索等）压缩后的最小保留字符 */
export const GUARD_FLOOR_OTHER = 120
/** Read 结果压缩后的最小保留字符：够放「File: 路径 + Lines: 区间 + 若干行正文」，
    模型至少还能看见自己读过哪里，不会退化成「读过但内容是空」那种误导 */
export const GUARD_FLOOR_READ = 2000
/** 本守卫认识的读取工具名（llama-studio 用大写 Read，pi 内置是小写 read） */
const READ_TOOL_NAMES = new Set(['Read', 'read'])

/**
 * CJK 加权的字符→token 估算。
 * 为什么不直接用 pi 的 chars/4：那是按英文标点的经验值，中文大致是 1 字 ≈ 1 token，
 * chars/4 会把中文内容低估 3-5 倍 —— 本项目的模型与对话都是中文的，用它当水位会
 * 系统性晚触发，等到发现时已经 400 了。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) ascii++
    else if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else ascii += 0.5
  }
  return Math.ceil(ascii * 0.3 + cjk * 1.6) + 2
}

/** 一条消息里的全部文本（字符串 content 与 text 块两种写法都要顾） */
function messageText(m: GuardableMessage): string {
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    let out = ''
    for (const b of c) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        out += String((b as { text?: unknown }).text ?? '')
      }
    }
    return out
  }
  return ''
}

/** 一条消息的 token 占用（文本 + 思考 + 工具调用参数 + 图片 + 系统消息的工具声明） */
export function estimateMessageTokens(m: GuardableMessage): number {
  let tok = 0
  const c = m.content
  if (typeof c === 'string') tok = estimateTextTokens(c)
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      const type = (b as { type?: string }).type
      if (type === 'text') tok += estimateTextTokens(String((b as { text?: unknown }).text ?? ''))
      else if (type === 'thinking') tok += estimateTextTokens(String((b as { thinking?: unknown }).thinking ?? ''))
      else if (type === 'toolCall') {
        tok += estimateTextTokens(String((b as { name?: unknown }).name ?? ''))
        tok += estimateTextTokens(JSON.stringify((b as { arguments?: unknown }).arguments ?? {}))
      } else if (type === 'image') tok += GUARD_IMAGE_TOKENS
    }
  }
  if (m.role === 'system' && m.toolsAdded) {
    const decl = JSON.stringify(m.toolsAdded)
    tok += estimateTextTokens(decl)
  }
  return tok + 4 // 每条消息的角色/分隔开销
}

export function totalContextTokens(messages: GuardableMessage[]): number {
  return messages.reduce((s, m) => s + estimateMessageTokens(m), 0)
}

/** 解析 Read 结果开头（mainTools.ts 的输出格式：`File: p\nLines: s-e of n`）。
    没有 Lines 行视为全文读取，区间取满。 */
function parseReadHead(text: string): { path: string; s: number; e: number } | null {
  const fm = /^"?File: ([^\n"]+)/.exec(text)
  if (!fm) return null
  const lm = /\nLines: (\d+)-(\d+) of \d+/.exec(text)
  return { path: fm[1]!, s: lm ? +lm[1]! : 1, e: lm ? +lm[2]! : Number.MAX_SAFE_INTEGER }
}

function isReadResult(m: GuardableMessage): boolean {
  if (m.role !== 'toolResult') return false
  if (m.toolName && READ_TOOL_NAMES.has(m.toolName)) return true
  // 工具名缺失时退回内容特征（旧存档 / 转换链路可能不带名字）
  return /^(?:")?File: /.test(messageText(m))
}

/** 把截断后的文本写回消息：文本块合并成一块，图片等非文本块原样保留在后面。 */
function withText(m: GuardableMessage, text: string): GuardableMessage {
  const c = m.content
  if (typeof c === 'string' || !Array.isArray(c)) return { ...m, content: text }
  const rest = c.filter(b => !(b && typeof b === 'object' && (b as { type?: string }).type === 'text'))
  return { ...m, content: [{ type: 'text', text }, ...rest] }
}

/**
 * 头尾保留式截断（取中间砍掉的写法）：Read 结果的头部是路径与行区间、尾部是「本文件
 * 已被改动 / 之前读过」这类提示，把尾巴全砍光会让模型失去定位能力。
 */
function clipKeepEnds(text: string, keep: number): string {
  if (text.length <= keep) return text
  const head = Math.max(0, Math.floor(keep * 2 / 3))
  const tail = Math.max(0, keep - head)
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}\n\n…（中间 ${dropped} 字符为节省上下文已省略）…\n\n${tail > 0 ? text.slice(text.length - tail) : ''}`
}

/** 同文件重复读取：只保最新的那一份，旧版折叠成占位说明。
    必须「后续读取覆盖了本区间」才折叠 —— 分段读取（1-200 与 201-400）互不包含，
    误折叠会把真实存在的信息丢掉，而且占位文案还会骗模型「后面有更新的内容」。 */
function foldSupersededReads(messages: GuardableMessage[]): GuardableMessage[] {
  const reads: { idx: number; path: string; s: number; e: number }[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (!isReadResult(m)) continue
    const h = parseReadHead(messageText(m))
    if (h) reads.push({ idx: i, ...h })
  }
  if (reads.length === 0) return messages
  return messages.map((m, i) => {
    if (!isReadResult(m)) return m
    const text = messageText(m)
    if (text.length <= 400) return m
    const h = parseReadHead(text)
    if (!h) return m
    const superseded = reads.some(r => r.idx > i && r.path === h.path && r.s <= h.s && r.e >= h.e)
    if (!superseded) return m
    const rangeNote = h.e === Number.MAX_SAFE_INTEGER ? '' : `（第 ${h.s}-${h.e} 行）`
    return withText(m, `File: ${h.path}${rangeNote}\n（该区间在后续轮次被再次读取，此旧版内容已省略以节省上下文；最新内容见后文的读取结果。）`)
  })
}

/**
 * 从最旧的工具结果起压缩，直到落回预算。两阶段，避免「读 → 被裁没 → 再读」的死循环：
 *   阶段一：先砍非 Read 的结果（Bash/Grep 这类，模型通常只需要结论）；
 *   阶段二：仍超预算才砍 Read 结果（保头尾，留 GUARD_FLOOR_READ 的底）。
 * 砍到位仍超预算就接受残余：每条结果都有保留下限（GUARD_FLOOR_*），而「条数 × 下限」之和
 * 本身就可能大于贫瘠模型的预算 —— 这时机械手段已经用尽，把条目数量降下来是压缩的职责
 * （pi 按真实 usage 触发，把早期整段换成一条摘要），不是这条底线兜得住的。
 * 宁可残余超限，也不靠删消息来凑数：删一条 toolResult 就让一个 toolCall 失去配对，请求直接 400。
 */
function clipToolResults(messages: GuardableMessage[], budget: number, floor: number, onlyRead: boolean): { messages: GuardableMessage[]; used: number } {
  const out = messages.slice()
  let used = totalContextTokens(out)
  for (let i = 0; i < out.length && used > budget; i++) {
    const m = out[i]!
    if (m.role !== 'toolResult' || !m.content) continue
    if (isReadResult(m) !== onlyRead) continue
    const text = messageText(m)
    if (text.length <= floor) continue
    const msgTok = estimateTextTokens(text)
    if (msgTok <= 0) continue
    // 按本条消息自身的字/token 比换算需要砍掉多少字符（全局比例对中英混排会算偏）。
    // 多砍 1.2 倍：换算只覆盖文本本身，不覆盖截断标记新增的字符。
    const needChars = Math.ceil((used - budget) / (msgTok / text.length) * 1.2)
    const next = clipKeepEnds(text, Math.max(floor, text.length - needChars))
    out[i] = withText(m, next)
    used = totalContextTokens(out)
  }
  return { messages: out, used }
}

/**
 * 兜底主入口：把送往模型的消息裁进预算内。
 * @param messages pi 投影后的消息（含系统消息），原对象不会被改写
 * @param budget   本次请求可用的 prompt token；<=0 视为「不约束」，原样返回
 * @param foldReads 是否启用同文件重复读取折叠（对应 agentConfig.ctxImportanceEnabled）
 */
export function guardContext<T extends GuardableMessage>(
  messages: readonly T[],
  budget: number,
  foldReads = true,
): T[] {
  if (messages.length === 0 || !Number.isFinite(budget) || budget <= 0) return messages as T[]
  let msgs = messages as T[]
  // 先按纯文本估一遍：没到预算就原样返回，这是绝大多数请求，不能为它付任何拷贝成本
  if (totalContextTokens(msgs) <= budget) return msgs
  if (foldReads) {
    msgs = foldSupersededReads(msgs) as T[]
    if (totalContextTokens(msgs) <= budget) return msgs
  }
  const first = clipToolResults(msgs, budget, GUARD_FLOOR_OTHER, false)
  if (first.used <= budget) return first.messages as T[]
  return clipToolResults(first.messages, budget, GUARD_FLOOR_READ, true).messages as T[]
}
