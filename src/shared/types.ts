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
}

// ── 下载状态 Phase 联合类型 ──

/** 模型文件下载阶段（modelDownloads） */
export type ModelDownloadPhase = 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

/** HuggingFace 模型下载阶段（hfDownloads），含额外的保存/模板创建阶段 */
export type HfDownloadPhase = ModelDownloadPhase | 'saving' | 'creating_template' | 'starting'

/** 所有下载阶段的超集 */
export type DownloadPhase = HfDownloadPhase
