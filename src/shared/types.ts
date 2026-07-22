export interface ModelFile {
  name: string
  path: string
}
export interface BackendVersion {
  name: string
  path: string
  hasCommands: boolean
  exe: string | null
}
export interface CommandParam {
  arg: string
  short?: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'select' | 'text'
  default?: string | number | boolean | null
  options?: string[]
  min?: number
  max?: number
  placeholder?: string
  env?: string
  deprecated?: boolean
}
export interface CommandCategory {
  name: string
  icon: string
  commands: CommandParam[]
}
export interface CommandsSchema {
  version: string
  categories: CommandCategory[]
}
export type TemplateArgs = Record<string, string | number | boolean | null>
export interface Template {
  id: string
  name: string
  description?: string
  backendVersion?: string
  modelPath?: string
  serverPort: number
  args: TemplateArgs
  launchMode?: 'chat' | 'api'
  createdAt: string
  updatedAt: string
  _file?: string
}
export interface ReleaseInfo {
  tagName: string
  name: string
  url: string
  publishedAt: string
  isNewer?: boolean
  assets: { name: string; downloadUrl: string; size: number }[]
  error?: string
  /** GitHub 未返回发布信息（可能官方暂未发布或接口返回为空） */
  noRelease?: boolean
  /** 有发布但不存在匹配当前平台 / 架构的官方包 */
  noPackage?: boolean
}

/** 应用自身更新的信息 */
export interface AppUpdateInfo {
  available: boolean
  latestVersion: string
  currentVersion: string
  tagName: string
  releaseName: string
  releaseUrl: string
  publishedAt: string
  /** Windows 平台的 asset（NSIS 安装器） */
  assetName: string
  assetUrl: string
  assetSize: number
  error?: string
}
export interface IntervalSample {
  t: number  // unix timestamp ms
  v: number  // value
}
export interface ModelMetrics {
  id: string
  templateName: string
  pid?: number
  decodeTokS: number[]          // ring-buffer [0..29] of decode tok/s snapshots
  ttftMs: number | null         // time-to-first-token (ms), null until first token arrives
  prefillTokS: number | null    // prompt-eval tok/s read from timing log
  reqPerSec: number[]           // rolling window of req/s samples
  vramUsedMb: number | null     // GPU memory used
  vramTotalMb: number           // total adapter VRAM
  gpuTemperature: number | null // GPU temperature (°C)
  gpuUtilization: number | null // GPU utilization (%)
  gpuName: string               // GPU name (e.g. NVIDIA RTX 4090)
  gpuPowerDraw: number | null   // GPU power draw (W)
  cpuUsage: number | null        // process CPU usage (%)
  nPromptTokens: number         // current request prompt tokens from /slots
  nPromptTokensCache: number    // cached prompt tokens from /slots (computed: n_prompt_tokens - n_prompt_tokens_processed)
  nPromptTokensProcessed: number // processed prompt tokens from /slots (n_prompt_tokens_processed)
  nCtx: number                  // total context window size from /slots
  nDecoded: number              // tokens decoded so far from /slots (n_decoded)
  isProcessing: boolean         // whether slot is actively generating
  prefillProgress: number | null // prefill progress 0..1 from stderr log, null when not in prefill
  nPredict: number              // max tokens to predict from /slots (-1 = unlimited)
  lastUpdated: number           // timestamp of last update ms
}
export type RunningStatus = 'idle' | 'running' | 'error'
export interface HubResultItem {
  id: string
  author: string
  name: string
  downloads: number
  likes: number
  tags: string[]
  lastModified: string
}
export interface CardState {
  template: Template
  status: RunningStatus
  pid?: number
  startedAt?: number
  expanded: boolean
  monitorExpanded?: boolean
  ready?: boolean // 已监听到 llama_server 监听日志（服务就绪可对外提供服务）
}

// ── 原生聊天 ───────────────────────────────────────────────
export interface Attachment {
  name: string       // 文件名（如 "pasted_text.txt"）
  type: 'image' | 'file'
  content?: string   // 文本内容（用于提示注入，图片时为 undefined）
  dataUrl?: string   // 图片 base64（仅图片类型）
}
export interface ToolCallInfo {
  id: string
  function: { name: string; arguments: string }
  result?: string  // 工具执行结果（执行后填充）
}
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  attachments?: Attachment[]  // 用户消息的附件
  // 仅 assistant 消息的推理统计（可选，流式结束后填充）
  tokensDecoded?: number
  msFirstToken?: number
  decodeTokS?: number  // 解码速度
  error?: boolean
  stopped?: boolean  // 用户手动停止生成，消息内容不完整
  toolCalls?: ToolCallInfo[]  // 模型发起的工具调用
  preToolContentLen?: number  // 工具调用前的内容长度
}
export interface ChatParams {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  repeat_penalty?: number
  stream?: boolean
}
export interface ChatSession {
  id: string
  title: string
  templateId: string   // 关联的模板（模型）
  port: number         // llama-server 端口
  systemPrompt?: string
  params: ChatParams
  messages: ChatMessage[]
  starred?: boolean  // 会话星标
  createdAt: string
  updatedAt: string
}
// 主进程流式代理推送到渲染层的 chunk
export interface ChatStreamChunk {
  streamId: string
  delta?: string        // 增量文本（生成中）
  done: boolean         // 是否结束
  error?: string        // 出错时的错误信息
  // 流结束时的统计信息（仅 done=true 时存在）
  usage?: {
    promptTokens: number
    completionTokens: number
  }
  msFirstToken?: number // 首 token 延迟（ms）
  decodeTokS?: number   // 解码速度（与监控面板同源）
  // 工具调用（模型在响应中发起 tool_calls 时）
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
  finishReason?: string // 停止原因（'stop' | 'tool_calls'）
  // /metrics 补充事件：done 已先行发送（不再阻塞工具调用展示），
  // 待 /metrics 请求返回后再以该事件补充解码速度，不触发二次 finalize
  metrics?: { decodeTokS?: number; completionTokens?: number }
}

// ── 下载状态 Phase 联合类型 ──

/** 模型文件下载阶段（modelDownloads） */
export type ModelDownloadPhase = 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

/** HuggingFace 模型下载阶段（hfDownloads），含额外的保存/模板创建阶段 */
export type HfDownloadPhase = ModelDownloadPhase | 'saving' | 'creating_template' | 'starting'

/** 所有下载阶段的超集 */
export type DownloadPhase = HfDownloadPhase

// ── Agent Code 工作台 ──
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: { id: string; name: string; args: string; status?: 'pending' | 'await_approval' | 'executing' | 'done'; result?: string; truncated?: boolean; resultTotal?: number; failed?: boolean; durationMs?: number; restored?: boolean; backupPath?: string }[]
  attachments?: Attachment[]  // 用户消息的附件（图片 / 文件）
  stopped?: boolean           // 用户手动停止生成，消息内容不完整
  // 按流式时间线切分的有序片段：思考段 / 正文段 / 工具批段交错排列，
  // 用于「工具栏 → 思考链 → 工具栏 → 思考链 → …」的交错渲染。
  // 旧消息（无此字段）回退到「工具卡片在顶部 + 思考链在下方」的传统布局。
  segments?: AgentSegment[]
}

// 助手消息的有序片段：严格按模型产生的先后顺序记录，
// 工具批之后接什么（思考链 or 下一批工具）完全由模型真实行为决定。
export type AgentSegment =
  | { kind: 'think' | 'text'; content: string }
  | { kind: 'tools'; toolCalls: NonNullable<AgentMessage['toolCalls']> }

export interface AgentSession {
  id: string
  title: string
  messages: AgentMessage[]
  // 上下文摘要/压缩记忆：超过预算高水位时，最早若干轮对话被模型压缩为摘要。
  // 发送时以摘要替代被覆盖的最早连续前缀消息，无此字段的旧会话不受影响。
  memory?: {
    summary: string          // 累积的历史摘要文本
    coveredMsgIds: string[]  // 已被摘要覆盖、发送时省略的消息 id（会话最早的连续前缀）
    updatedAt: number
  }
}

export interface AgentProject {
  id: string
  title: string
  workspaceDir: string
  expanded: boolean
  sessions: AgentSession[]
  systemPrompt?: string      // 自定义系统提示词（按项目）；为空则用默认工具指引
  approveWriteEdit?: boolean  // 是否对 Write / Edit 也要求人工确认（Delete / Bash 始终要求）
}

// ── Agent Code 任务清单（Todo / Task 工具）──
export type AgentTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'deleted'

export interface AgentTask {
  id: string
  subject: string
  description: string
  status: AgentTaskStatus
  activeForm?: string
  priority?: 'high' | 'medium' | 'low'
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface TodoItem {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: 'high' | 'medium' | 'low'
  activeForm?: string
}

export interface TodoUpdate {
  id?: string
  content?: string
  description?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: 'high' | 'medium' | 'low'
  activeForm?: string
  notes?: string
}
