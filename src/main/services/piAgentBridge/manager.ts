// pi-agent 会话管理器：管理多个 pi bridge 会话的生命周期 + 事件分发。
// 不依赖 Electron（可独立测试）；IPC 注册层（piAgentIpc.ts）只是薄包装。
import { get as httpGet } from 'node:http'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { Message } from '@earendil-works/pi-ai'
import { createPiAgentBridge, type PiAgentBridge } from './index'
import { createMainTools, type MainToolExecutors } from './tools/mainTools'
import { PLAIN_CHAT_TOOL_NAMES as CHAT_TOOL_NAMES } from '../../../shared/types'
import { appendTokenUsage } from '../../tokenLedger'
import { appendSessionEvent, writeTrajectoryHeader, appendLlmRequest, summarizeLlmRequest, appendUserEntry, appendLlmSystemMessages } from './trajectory'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel, TokenUsageEntry } from '../../../shared/types'
import { PI_TOOL_GUIDANCE, PI_CHART_ROUTING, PI_MERMAID_DSL_GUIDANCE, PI_CHART_FENCE_GUIDANCE, PI_SVG_GUIDANCE, PI_MERMAID_JSON_GUIDANCE, PLAIN_CHAT_SYSTEM_PROMPT } from '../../../shared/agentGuidance'

/** llama-studio 会话历史消息（pi 模式注入用，与 shared/types 的 AgentMessage 结构对应） */
export interface PiHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ id: string; name: string; args: string; result?: string }>
  attachments?: Array<{ type: string; dataUrl?: string; content?: string }>
}

export interface PiAgentSessionOptions {
  sessionId: string
  /** 模型端口（llama-server 监听端口；IPC 不能传函数，会话创建时固定） */
  port: number
  /** agent 工作目录（会同步给 ipc.ts 的 agentWorkspaceRoot，供 Read/Bash 相对路径解析） */
  cwd: string
  /** 模型上下文窗口 token 数（供 pi 的 auto-compaction 阈值计算；默认 128000） */
  contextWindow?: number
  /** 额外自定义工具（pi ToolDefinition 格式） */
  customTools?: ToolDefinition[]
  /** 项目开关：Write/Edit 额外要求人工确认 */
  approveWriteEdit?: boolean
  /** pi 配置目录（默认 <userData>/pi-agent，避免污染用户 ~/.pi） */
  agentDir?: string
  /** 已有会话历史（首次创建时注入 pi session，避免历史丢失） */
  history?: PiHistoryMessage[]
  /** 项目绑定的知识库 id（提供时注册 knowledge_search 工具） */
  knowledgeBaseId?: string
  /** 网络搜索开关（默认开启）。关闭后两个搜索工具都不激活。 */
  searchEnabled?: boolean
  /** 纯聊天模式：不注册任何工具，也不注入任何编码 agent 的提示词，只保留对话本身。
      缺省 = 原来的 agent 模式。要关的提示词有三处，缺一处模型就会以为自己能调工具：
        ① appendSystemPrompt —— 本文件注入的工具 / 图表指引（约 4.5k tokens）
        ② systemPrompt —— pi 自带的默认提示词，里面写着「你是 pi 里的编码助手」和
           「你还可能有其它自定义工具」；必须整段替换，光清 ① 清不掉它
        ③ contextFiles —— AGENTS.md 等逐级发现的项目规则，普通对话用不上
      工具侧则是 toolNames 传空数组。 */
  plainChat?: boolean
  /** 纯聊天模式下启用的工具名（只认 CHAT_TOOL_NAMES 里那四个，其余一律忽略）。
      与 plainChat 配套：只影响纯聊天模式，工作台模式的工具白名单不受影响。 */
  chatTools?: string[]
  /** 搜索引擎：'bing'（国内版，默认）| 'ddg'（DuckDuckGo）。互斥，同时只激活一个。 */
  searchProvider?: 'ddg' | 'bing'
  /** 项目自定义系统提示词（渲染层「提示词」卡片保存的内容，用户手写） */
  projectSystemPrompt?: string
  /** 项目记忆：跨会话长期携带的结论 / 约定（渲染层「项目记忆」文本域，用户手写） */
  projectMemoryNotes?: string
  /** 长期记忆注入文本。由渲染层调 memstore-inject 生成后传下来 —— 不能在这里直接
      调 memoryStore：本 manager 跑在 utilityProcess 里，而 memoryStore 依赖 ipcMain /
      app 等主进程 API，且它在主进程侧才有注册好的 memoryDir。 */
  memoryInjection?: string
  /** 会话事件回调（由 IPC 层转推 renderer） */
  onEvent: (sessionId: string, event: AgentSessionEvent) => void
}

/**
 * 把「用户可编辑的项目级提示词」拼成 appendSystemPrompt 的尾部段落。
 * 这三段都来自渲染层，主进程只做拼装。与 PI_TOOL_GUIDANCE 那批静态常量分开，
 * 是因为纯聊天模式要清掉编码 agent 指引、但不该连用户自己写的指令一起清掉 ——
 * 用户手写的提示词被静默忽略，正是这次要修的问题之一。
 */
function buildUserPromptSections(opts: PiAgentSessionOptions): string[] {
  const out: string[] = []
  const sys = (opts.projectSystemPrompt || '').trim()
  if (sys) out.push(`## 项目自定义指令\n${sys}`)
  const mem = (opts.projectMemoryNotes || '').trim()
  if (mem) out.push(`## 项目记忆（跨会话，人工维护）\n${mem}`)
  const inj = (opts.memoryInjection || '').trim()
  if (inj) out.push(`## 跨会话长期记忆\n${inj}`)
  return out
}

export class PiAgentManager {
  private readonly bridges = new Map<string, PiAgentBridge>()
  private readonly executors: MainToolExecutors
  /** 撤销备份存储：toolCallId → 原文件内容（null = 原文件不存在，撤销时删除） */
  private readonly undoStore = new Map<string, { path: string; content: string | null }>()
  /** 会话 → 模型端口（Token 记账用） */
  private readonly ports = new Map<string, number>()
  /** 工具白名单（pi 只激活这些工具） */
  private readonly toolNames: string[]

  constructor(
    executors: MainToolExecutors,
    toolNames: string[] = [
      'get_datetime', 'Read', 'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Ripgrep', 'ListDir', 'Delete',
      'TodoWrite', 'TaskGet', 'TaskList',
      'AskUserQuestion', 'Reflect', 'CodeSearch', 'AnalyzeDir', 'web_search', 'fetch_webpage',
      // 知识库两工具：pi 的 tools 参数是「激活名单」——customTools 只进定义池，
      // 名字不在名单里的自定义工具不会出现在发给模型的请求里（实测 llm_request 验证）
      'knowledge_search', 'knowledge_read'
    ]
  ) {
    // 撤销备份由 manager 统一管理（注入 recordUndo/undo 到工具执行器）
    this.executors = {
      ...executors,
      recordUndo: (toolCallId, filePath, content) => {
        // 上限 200 条（FIFO，Map 首键即最旧）：条目含原文件全文，防长期会话无界累积
        if (this.undoStore.size >= 200) {
          const oldest = this.undoStore.keys().next().value
          if (oldest !== undefined) this.undoStore.delete(oldest)
        }
        this.undoStore.set(toolCallId, { path: filePath, content })
      },
      removeUndo: (toolCallId) => {
        this.undoStore.delete(toolCallId)
      },
      undo: async (toolCallId) => {
        const entry = this.undoStore.get(toolCallId)
        if (!entry) return { success: false, error: '备份不存在（可能已撤销或会话已重建）' }
        try {
          if (entry.content === null) {
            const del = await executors.deletePath(entry.path, true)
            if (!del.success) return { success: false, error: `删除失败：${del.error}` }
          } else {
            const wr = await executors.writeFile(entry.path, entry.content)
            if (!wr.success) return { success: false, error: `写回失败：${wr.error}` }
          }
          this.undoStore.delete(toolCallId)
          return { success: true, path: entry.path }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
    }
    this.toolNames = toolNames
  }

  /** 撤销一次工具修改（pi 模式工具卡片的"撤销"按钮） */
  async undo(toolCallId: string): Promise<{ success: boolean; path?: string; error?: string }> {
    return this.executors.undo(toolCallId)
  }

  get sessionIds(): string[] {
    return [...this.bridges.keys()]
  }

  async createSession(opts: PiAgentSessionOptions): Promise<void> {
    if (this.bridges.has(opts.sessionId)) this.disposeSession(opts.sessionId)
    this.ports.set(opts.sessionId, opts.port)
    // 纯聊天：默认工具与提示词一起关（见 PiAgentSessionOptions.plainChat 的说明）。
    // chatTools 允许按需开启原生聊天那四个工具，但默认是空 = 纯对话。
    // 关掉工具时 web_search 那套互斥白名单、知识库工具、自定义工具都不会被激活，
    // 所以下面仍照常创建 customTools——pi 的 tools 是「激活名单」，
    // 名字不在名单里的工具只进定义池、不会出现在发给模型的请求里。
    const plainChat = opts.plainChat === true
    // 网络搜索：互斥白名单（同时只激活一个引擎；关闭则都不激活）
    const baseToolNames = this.toolNames.filter(
      n => n !== 'web_search' && n !== 'web_search_bing'
    )
    const searchEnabled = opts.searchEnabled !== false
    const searchProvider = opts.searchProvider || 'bing'
    const searchToolNames = searchEnabled
      ? [searchProvider === 'bing' ? 'web_search_bing' : 'web_search']
      : []
    const effectiveToolNames = plainChat
      // 纯聊天模式：只认原生聊天那四个工具，且默认全关（chatTools 缺省 = 空）。
      // 搜索工具名要按 provider 映射成实际注册名（web_search_bing / web_search），
      // 与下面 agent 模式的处理保持一致；其余三个直接按名字取。
      ? (() => {
        const want = new Set(opts.chatTools ?? [])
        const out = this.toolNames.filter(n => (CHAT_TOOL_NAMES as readonly string[]).includes(n) && n !== 'web_search' && want.has(n))
        // knowledge_search 的返回里会指引模型用 knowledge_read 取其它条目正文，
        // 所以启用检索时把读取工具一起带上，否则模型只能看目录、读不到内容。
        if (want.has('knowledge_search')) out.push('knowledge_read')
        if (want.has('web_search') && searchEnabled) out.push(searchProvider === 'bing' ? 'web_search_bing' : 'web_search')
        return out
      })()
      : [...baseToolNames, ...searchToolNames]

    const mainTools = await createMainTools(this.executors, {
      sessionId: opts.sessionId.replace(/^pi-/, ''),
      approveWriteEdit: opts.approveWriteEdit,
      workspaceDir: opts.cwd,
      knowledgeBaseId: opts.knowledgeBaseId,
      knowledgeBases: await this.executors.listKb()
    })
    // 追加进 system prompt 的两批内容分开算：
    //   codingGuidance —— 静态的编码 agent 指引，纯聊天模式必须清掉（见 plainChat 说明）
    //   userPromptSections —— 用户可编辑的三段（项目指令 / 项目记忆 / 长期记忆注入），
    //     两种模式都追加。它们不是「编码 agent 指引」，纯聊天模式没有理由吞掉用户自己
    //     写的东西；此前这三段全都没有送达模型，用户在界面上编辑保存后毫无效果。
    const codingGuidance = plainChat
      ? []
      : [...PI_TOOL_GUIDANCE, ...PI_CHART_ROUTING, ...PI_MERMAID_DSL_GUIDANCE, ...PI_CHART_FENCE_GUIDANCE, ...PI_SVG_GUIDANCE, ...PI_MERMAID_JSON_GUIDANCE]
    const userPromptSections = buildUserPromptSections(opts)
    const bridge = await createPiAgentBridge({
      getPort: () => opts.port,
      getContextWindow: () => opts.contextWindow ?? 128000,
      cwd: opts.cwd,
      agentDir: opts.agentDir,
      systemPrompt: plainChat ? PLAIN_CHAT_SYSTEM_PROMPT : undefined,
      noContextFiles: plainChat,
      appendSystemPrompt: [...codingGuidance, ...userPromptSections],
      toolNames: effectiveToolNames,
      customTools: [...mainTools, ...(opts.customTools ?? [])]
    })
    // 注入已有会话历史（llama-studio AgentMessage → pi Message）
    if (opts.history && opts.history.length > 0) {
      bridge.session.agent.state.messages = convertHistory(opts.history)
    }
    bridge.session.subscribe((event) => {
      // 轨迹台账：全量事件流落盘（旁路观测，失败静默，不影响主流程）
      appendSessionEvent(opts.sessionId, event)
      // Token 记账：pi 每轮 LLM 响应结束（turn_end 携带 message.usage）时入账。
      // pi 模式不经过 chat-completion-stream（原入账点在 ipc.ts 聊天流 handler），
      // 必须在此补记，否则导航栏 Token 统计永远只有旧模型（legacy/ChatView）的记录。
      if (event.type === 'turn_end' && event.message?.role === 'assistant') {
        void this.recordUsage(opts.sessionId, event.message.usage)
      }
      opts.onEvent(opts.sessionId, event)
    })
    // 轨迹台账（阶段 2）：LLM 请求快照 —— 包装而非覆盖 Agent.onPayload，
    // 保留 pi 内部可能已注册的钩子；每次发往模型的完整请求体被瘦身后落盘。
    const prevOnPayload = bridge.session.agent.onPayload
    bridge.session.agent.onPayload = (payload, model) => {
      try {
        if (payload && typeof payload === 'object') {
          appendLlmRequest(opts.sessionId, summarizeLlmRequest(payload))
          // 台账补记「系统信息」：pi 不为 system/developer 消息发事件，从首次请求体
          // 提取落盘（内部防重，每会话仅一次），否则轨迹里看不到系统提示词来源。
          appendLlmSystemMessages(opts.sessionId, (payload as { messages?: unknown }).messages)
        }
      } catch {
        /* 快照失败静默：旁路观测不影响请求 */
      }
      return prevOnPayload?.(payload, model)
    }
    this.bridges.set(opts.sessionId, bridge)
    // 会话创建头信息（轨迹台账元数据：复现问题时的环境上下文）
    writeTrajectoryHeader(opts.sessionId, {
      cwd: opts.cwd,
      port: opts.port,
      contextWindow: opts.contextWindow ?? 128000,
      // 记录模型实际可见的全部工具名：pi 内置白名单 + 自研 customTools（诊断「模型
      // 为什么不用某工具」时的第一手证据）
      tools: [...effectiveToolNames, ...mainTools.map(t => t.name)],
      // 必须与实际下发的内容一致（含用户三段），否则轨迹台账里的字符数会低报，
      // 排查「提示词为什么这么长」时给出错误线索
      systemPromptChars: [...codingGuidance, ...userPromptSections].join('\n\n').length,
      historyCount: opts.history?.length ?? 0
    })
  }

  /** pi 请求结束入账：usage（pi 格式 input/output）→ tokenLedger（llama-studio 记账簿） */
  private async recordUsage(sessionId: string, usage: { input?: number; output?: number } | undefined): Promise<void> {
    if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') return
    if (usage.input < 0 || usage.output < 0) return
    const port = this.ports.get(sessionId)
    if (!port) return
    const info = await this.executors.getPortModelInfo(port)
    const base: TokenUsageEntry = {
      ts: Date.now(),
      port,
      templateId: info?.templateId,
      modelPath: info?.modelPath ?? null,
      promptTokens: usage.input,
      completionTokens: usage.output
    }
    // 模型名优先从 llama.cpp 的 /props 接口实时获取（返回实际加载的 model_path，
    // 用户切换模型/进程残留/端口复用时依然准确），失败回退启动参数登记值。
    // 异步入账，不阻塞事件流。
    void fetchModelPathFromProps(port).then((p) => {
      appendTokenUsage(p ? { ...base, modelPath: p } : base)
    })
  }

  async prompt(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void> {
    const bridge = this.getBridge(sessionId)
    const cwd = bridge.session.sessionManager.getCwd()
    await this.executors.setAgentWorkspace(cwd)
    appendUserEntry(sessionId, text, images?.length)
    await bridge.session.prompt(text, images && images.length > 0 ? { images } : undefined)
  }

  /** 流式中途插话：当前 assistant turn 结束后、下一 LLM 调用前注入。 */
  async steer(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void> {
    const bridge = this.getBridge(sessionId)
    appendUserEntry(sessionId, text, images?.length)
    await bridge.session.steer(text, images && images.length > 0 ? images : undefined)
  }

  /** 追加：仅当 agent 本应停止（idle）时再运行。 */
  async followUp(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void> {
    const bridge = this.getBridge(sessionId)
    appendUserEntry(sessionId, text, images?.length)
    await bridge.session.followUp(text, images && images.length > 0 ? images : undefined)
  }

  /** 清空 steer/followUp 队列（停止时调用，避免 abort 后自动续跑）。 */
  async clearQueue(sessionId: string): Promise<void> {
    const bridge = this.getBridge(sessionId)
    await bridge.session.clearQueue()
  }

  async abort(sessionId: string): Promise<void> {
    const bridge = this.getBridge(sessionId)
    await bridge.session.abort()
  }

  /** 动态设置会话级思考程度（发送前调用；会按当前模型能力自动 clamp）。 */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const bridge = this.getBridge(sessionId)
    bridge.session.setThinkingLevel(level)
  }

  disposeSession(sessionId: string): void {
    const bridge = this.bridges.get(sessionId)
    if (!bridge) return
    bridge.dispose()
    this.bridges.delete(sessionId)
    this.ports.delete(sessionId)
  }

  disposeAll(): void {
    for (const id of [...this.bridges.keys()]) this.disposeSession(id)
  }

  private getBridge(sessionId: string): PiAgentBridge {
    const bridge = this.bridges.get(sessionId)
    if (!bridge) throw new Error(`pi-agent 会话不存在: ${sessionId}`)
    return bridge
  }
}

// ── 历史消息转换：llama-studio AgentMessage → pi Message ──
// pi 的 AgentMessage 即 pi-ai 的 Message（UserMessage | AssistantMessage | ToolResultMessage）
import { LLAMA_STUDIO_MODEL_ID, LLAMA_STUDIO_PROVIDER_ID } from './index'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function convertHistory(history: PiHistoryMessage[]): Message[] {
  const out: Message[] = []
  // 历史回流前剥离思考链：持久化的 content 含 <think>…</think> 原文（UI 渲染依赖），
  // 但回注给模型会让它重复看到自己旧的思考过程，污染上下文（与 legacy stripThinkForApi 一致）。
  const stripThink = (s: string): string =>
    s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim()
  for (const m of history) {
    const ts = Date.now()
    if (m.role === 'user') {
      const images = (m.attachments ?? [])
        .filter((a) => a.type === 'image' && a.dataUrl)
        .map((a) => {
          const mime = /^data:([^;,]+)/.exec(a.dataUrl!)?.[1] ?? 'image/png'
          const base64 = a.dataUrl!.split(',')[1] ?? ''
          return { type: 'image' as const, data: base64, mimeType: mime }
        })
      out.push({
        role: 'user',
        content: images.length > 0 ? [{ type: 'text', text: m.content }, ...images] : m.content,
        timestamp: ts
      } as Message)
    } else {
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        type: 'toolCall' as const,
        id: tc.id,
        name: tc.name,
        arguments: safeParseArgs(tc.args)
      }))
      out.push({
        role: 'assistant',
        content: [...(m.content ? [{ type: 'text' as const, text: stripThink(m.content) }] : []), ...toolCalls],
        api: 'openai-completions',
        provider: LLAMA_STUDIO_PROVIDER_ID,
        model: LLAMA_STUDIO_MODEL_ID,
        usage: ZERO_USAGE,
        stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp: ts
      } as Message)
      for (const tc of m.toolCalls ?? []) {
        if (tc.result == null) continue
        out.push({
          role: 'toolResult',
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: 'text', text: tc.result }],
          isError: false,
          timestamp: Date.now()
        } as Message)
      }
    }
  }
  return out
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ── 模型名获取：llama.cpp /props 返回实际加载的 model_path ──
// 比 run-model 启动参数登记（portModelInfos）更可靠：用户切换模型、进程残留、
// 端口复用等情况下依然返回 llama.cpp 真正加载的模型文件。
function fetchModelPathFromProps(port: number, timeoutMs = 800): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/props`, (res) => {
      let body = ''
      res.on('error', () => resolve(null)) // 连接中断时 IncomingMessage 会发 error，无监听器会成未捕获异常
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          resolve(typeof j.model_path === 'string' && j.model_path ? j.model_path : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// utility process 模式：工具执行器经 RPC 回主进程执行（pi SDK 在 worker 里，
// 文件/搜索/知识库等真正动磁盘与内部服务的逻辑仍在主进程，行为与原先一致）。
// createWorkerExecutors 只组装一个 MainToolExecutors，每个方法把 (方法名, 参数)
// 通过 callTool 发给主进程，等 tool-result 回包后 resolve。
// ─────────────────────────────────────────────────────────────────────────────
export type WorkerToolCaller = <T = unknown>(name: string, args: unknown[]) => Promise<T>
export type WorkerToolEventCaller = <T = unknown>(event: Record<string, unknown>) => Promise<T>

export function createWorkerExecutors(
  callTool: WorkerToolCaller,
  callToolEvent: WorkerToolEventCaller
): MainToolExecutors {
  // callTool 返回 Promise<unknown>；这里按 MainToolExecutors 各方法的返回类型逐个断言。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = callTool as (name: string, args: unknown[]) => any
  return {
    readFile: (filePath, opts) => c('readFile', [filePath, opts]),
    writeFile: (filePath, content) => c('writeFile', [filePath, content]),
    glob: (opts) => c('glob', [opts]),
    listDir: (dirPath) => c('listDir', [dirPath]),
    grep: (opts) => c('grep', [opts]),
    ripgrep: (opts) => c('ripgrep', [opts]),
    deletePath: (path, recursive) => c('deletePath', [path, recursive]),
    todoWrite: (sessionId, input) => c('todoWrite', [sessionId, input]),
    taskGet: (sessionId, taskId) => c('taskGet', [sessionId, taskId]),
    taskList: (sessionId) => c('taskList', [sessionId]),
    codesearchQuery: (dir, query, limit) => c('codesearchQuery', [dir, query, limit]),
    webSearch: (query) => c('webSearch', [query]),
    webSearchBing: (query) => c('webSearchBing', [query]),
    fetchWebpage: (url) => c('fetchWebpage', [url]),
    knowledgeQuery: (kbId, query, limit) => c('knowledgeQuery', [kbId, query, limit]),
    knowledgeRead: (kbId, refs) => c('knowledgeRead', [kbId, refs]),
    describeKb: (kbId) => c('describeKb', [kbId]),
    listKb: () => c('listKb', []),
    getPortModelInfo: (port) => c('getPortModelInfo', [port]),
    setAgentWorkspace: (cwd) => c('setAgentWorkspace', [cwd]),
    // ask/approve 走独立通道：需要主进程弹窗等用户输入，可能长时间挂起
    askUser: (questions) => callToolEvent<string>({ type: 'ask', questions }),
    approve: (toolName, args) => callToolEvent<boolean>({ type: 'approve', toolName, args }),
    // recordUndo/removeUndo/undo 由 PiAgentManager 构造时在 worker 内包装（撤销备份存 worker 本地即可）
    recordUndo: () => {},
    removeUndo: () => {},
    undo: async () => ({ success: false, error: '撤销未启用' })
  }
}
