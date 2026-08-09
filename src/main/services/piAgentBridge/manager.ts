// pi-agent 会话管理器：管理多个 pi bridge 会话的生命周期 + 事件分发。
// 不依赖 Electron（可独立测试）；IPC 注册层（piAgentIpc.ts）只是薄包装。
import { get as httpGet } from 'node:http'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { Message } from '@earendil-works/pi-ai'
import { createPiAgentBridge, type PiAgentBridge } from './index'
import { createMainTools, type MainToolExecutors } from './tools/mainTools'
import { appendTokenUsage, type TokenUsageEntry } from '../../tokenLedger'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

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
  /** 会话事件回调（由 IPC 层转推 renderer） */
  onEvent: (sessionId: string, event: AgentSessionEvent) => void
}

const PI_TOOL_GUIDANCE = [
  '## 任务计划工具（重要）',
  '- 需要规划或跟踪多步任务时，务必使用 TodoWrite 建立任务清单（merge:true 增量更新，保持任务 id 稳定）。',
  '- 用 TaskList 查看当前任务清单，用 TaskGet 查看单个任务详情。',
  '- 每完成一步，用 TodoWrite 把对应任务状态更新为 completed；遇到阻塞更新为 in_progress 并补充 notes。',
  '- 不要用文本罗列代替任务清单——任务清单是跨轮次追踪进度的唯一来源。'
]

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
      'get_datetime', 'Read', 'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'ListDir', 'Delete',
      'TodoWrite', 'TaskGet', 'TaskList', 'GetBackgroundTaskOutput', 'ListBackgroundTasks',
      'AskUserQuestion', 'Reflect', 'CodeSearch', 'AnalyzeDir'
    ]
  ) {
    // 撤销备份由 manager 统一管理（注入 recordUndo/undo 到工具执行器）
    this.executors = {
      ...executors,
      recordUndo: (toolCallId, filePath, content) => {
        this.undoStore.set(toolCallId, { path: filePath, content })
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
    const mainTools = await createMainTools(this.executors, {
      sessionId: opts.sessionId.replace(/^pi-/, ''),
      approveWriteEdit: opts.approveWriteEdit,
      workspaceDir: opts.cwd
    })
    const bridge = await createPiAgentBridge({
      getPort: () => opts.port,
      getContextWindow: () => opts.contextWindow ?? 128000,
      cwd: opts.cwd,
      agentDir: opts.agentDir,
      appendSystemPrompt: PI_TOOL_GUIDANCE,
      toolNames: this.toolNames,
      customTools: [...mainTools, ...(opts.customTools ?? [])]
    })
    // 注入已有会话历史（llama-studio AgentMessage → pi Message）
    if (opts.history && opts.history.length > 0) {
      bridge.session.agent.state.messages = convertHistory(opts.history)
    }
    bridge.session.subscribe((event) => {
      // Token 记账：pi 每轮 LLM 响应结束（turn_end 携带 message.usage）时入账。
      // pi 模式不经过 chat-completion-stream（原入账点在 ipc.ts 聊天流 handler），
      // 必须在此补记，否则导航栏 Token 统计永远只有旧模型（legacy/ChatView）的记录。
      if (event.type === 'turn_end' && event.message?.role === 'assistant') {
        this.recordUsage(opts.sessionId, event.message.usage)
      }
      opts.onEvent(opts.sessionId, event)
    })
    this.bridges.set(opts.sessionId, bridge)
  }

  /** pi 请求结束入账：usage（pi 格式 input/output）→ tokenLedger（llama-studio 记账簿） */
  private recordUsage(sessionId: string, usage: { input?: number; output?: number } | undefined): void {
    if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') return
    if (usage.input < 0 || usage.output < 0) return
    const port = this.ports.get(sessionId)
    if (!port) return
    const info = ipcInternal.getPortModelInfo?.(port)
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
    // 同步工作区根 + bash cwd 到 ipc.ts（Read/Write/Bash 的相对路径解析依赖；会话切换每轮同步最稳）
    const cwd = bridge.session.sessionManager.getCwd()
    ipcInternal.handleSetAgentWorkspace?.(cwd)
    ipcInternal.handleSetBashCwd?.(cwd)
    await bridge.session.prompt(text, images && images.length > 0 ? { images } : undefined)
  }

  async abort(sessionId: string): Promise<void> {
    const bridge = this.getBridge(sessionId)
    await bridge.session.abort()
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

// ── 生产执行器：ipc.ts 提取的 handler 直调（registerIpcHandlers 后可用）──
import { ipcInternal } from '../../ipc'
import { handleCodeSearchQuery } from '../retrievalService'

export function createIpcExecutors(): MainToolExecutors {
  const requireInternal = (name: keyof typeof ipcInternal): void => {
    if (!ipcInternal[name]) throw new Error(`${name} 未注册（registerIpcHandlers 未调用）`)
  }
  return {
    readFile: (filePath, opts) => {
      requireInternal('handleReadFile')
      return ipcInternal.handleReadFile!(filePath, opts)
    },
    executeCommand: (opts) => {
      requireInternal('handleExecuteCommand')
      return ipcInternal.handleExecuteCommand!(opts)
    },
    writeFile: (filePath, content) => {
      requireInternal('handleWriteFile')
      return ipcInternal.handleWriteFile!(filePath, content)
    },
    editFile: (filePath, oldString, newString, replaceAll) => {
      requireInternal('handleEditFile')
      return ipcInternal.handleEditFile!(filePath, oldString, newString, replaceAll)
    },
    glob: (opts) => {
      requireInternal('handleGlob')
      return ipcInternal.handleGlob!(opts)
    },
    listDir: (dirPath) => {
      requireInternal('handleListDir')
      return ipcInternal.handleListDir!(dirPath)
    },
    grep: (opts) => {
      requireInternal('handleGrep')
      return ipcInternal.handleGrep!(opts)
    },
    deletePath: (path, recursive) => {
      requireInternal('handleDeletePath')
      return ipcInternal.handleDeletePath!(path, recursive)
    },
    todoWrite: (sessionId, input) => {
      requireInternal('handleAgentTodoWrite')
      return ipcInternal.handleAgentTodoWrite!(sessionId, input)
    },
    taskGet: (sessionId, taskId) => {
      requireInternal('handleAgentTaskGet')
      return ipcInternal.handleAgentTaskGet!(sessionId, taskId)
    },
    taskList: (sessionId) => {
      requireInternal('handleAgentTaskList')
      return ipcInternal.handleAgentTaskList!(sessionId)
    },
    getBackgroundTask: (taskId) => {
      requireInternal('handleGetBackgroundTask')
      return ipcInternal.handleGetBackgroundTask!(taskId)
    },
    listBackgroundTasks: () => {
      requireInternal('handleListBackgroundTasks')
      return ipcInternal.handleListBackgroundTasks!()
    },
    codesearchQuery: (dir, query, limit) => handleCodeSearchQuery(dir, query, limit),
    // 默认实现：无窗口通道时由 piAgentIpc 覆写为跨进程弹窗
    askUser: async (questions) =>
      JSON.stringify({
        answers: questions.map((q) => ({ question: q.question, answer: '' })),
        note: '用户不可用，请基于最佳判断继续。'
      }),
    // recordUndo/undo 由 PiAgentManager 构造时包装覆盖（统一管理撤销备份）
    recordUndo: () => {},
    undo: async () => ({ success: false, error: '撤销未启用' })
  }
}

// ── 模型名获取：llama.cpp /props 返回实际加载的 model_path ──
// 比 run-model 启动参数登记（portModelInfos）更可靠：用户切换模型、进程残留、
// 端口复用等情况下依然返回 llama.cpp 真正加载的模型文件。
function fetchModelPathFromProps(port: number, timeoutMs = 800): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/props`, (res) => {
      let body = ''
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
