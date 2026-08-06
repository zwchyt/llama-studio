export interface ModelFile {
  name: string
  path: string
}
/** 后端引擎类型：llama.cpp 系列 / TensorSharp 系列 / llama.cpp 分支系列 / stable-diffusion.cpp 图像引擎 */
export type EngineKind = 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'other'
export interface BackendVersion {
  name: string
  path: string
  hasCommands: boolean
  exe: string | null
  /** 引擎类型（按可执行文件名推断，如 TensorSharp.Server.exe → 'tensorsharp'） */
  kind?: EngineKind
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
  /** 参数集选择（参数设置里手动切换）：'llamacpp' → commands.json，'tensorsharp' → commands-tensorsharp.json；缺省 = llama.cpp */
  paramSet?: EngineKind
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
  assets: { name: string; downloadUrl: string; size: number; digest?: string }[]
  /** stable-diffusion.cpp 专用的 CUDA 运行时包（cudart/cublas），需额外下载合并进引擎目录（仅 Windows） */
  cudartAsset?: { name: string; downloadUrl: string; size: number; digest?: string }
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
  dataUrl?: string   // 图片缩略图 base64（仅图片类型，用于气泡展示）
  fullDataUrl?: string // 图片原图 base64（仅图片类型，持久化后用于多轮重发/重新生成）
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
  thinkDurations?: number[]   // 各思考链（<think>）的耗时（ms），按出现顺序，流结束后填充
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
  knowledgeBaseId?: string  // 附加的本地知识库 ID（空则不启用 RAG）
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
  | { kind: 'think'; content: string; durationMs?: number }
  | { kind: 'text'; content: string }
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
    // 结构化事实附录：压缩时机械提取的「不可转写」事实（文件操作清单 + 用户原话），
    // 逐字保留、不经 LLM 精炼；无此字段的旧会话不受影响。
    facts?: string
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
  // 跨会话项目记忆：用户沉淀的关键结论/约定，发送时注入系统提示，对该项目所有会话生效。
  memory?: {
    notes: string      // 跨会话项目记忆（用户可编辑的关键结论/约定）
    updatedAt: number
  }
}

// ── 长期记忆（模块二 · 阶段 2.3）──
// 跨会话分类记忆条目：由主进程 memoryStore 按工作区持久化。
export type AgentMemoryCategory =
  | 'correction'   // 用户纠正 / 审批拒绝归纳的偏好
  | 'convention'   // 项目约定（命名 / 格式 / 架构规则）
  | 'command'      // 已验证命令（构建 / 运行 / 测试）
  | 'error_fix'    // 错误指纹 → 已验证解法
  | 'decision'     // 决策记录（选定方案与理由）
  | 'file_role'    // 文件角色标注（生成物勿改 / 入口 / 热点）

export interface AgentMemoryEntry {
  id: string
  category: AgentMemoryCategory
  content: string          // 条目正文（单条精炼结论，非转储）
  confidence: number       // 置信度 0~1（矛盾降半，合并上调）
  source: 'user' | 'agent' // user=源自用户明确陈述（冲突时须用户裁决，不自动淘汰）
  origin: string           // 出处（触发点 + 会话 id）
  createdAt: number
  updatedAt: number
  lastUsedAt: number       // 注入即视为使用（LRU 淘汰依据）
  hits: number             // 被沉淀 / 确认次数（相似合并时 +1）
  contradictions: number   // 矛盾标记次数，累计达阈值自动归档
  archived?: boolean       // 软删除（留审计）
  anchorPath?: string      // 校验锚点：工作区相对路径（文件还在吗）
  anchorSymbol?: string    // 校验锚点：锚点文件内应存在的符号 / 子串
}

// 渲染层沉淀写入时的候选条目（id / 时间戳等由存储侧补全）
export interface AgentMemoryCandidate {
  category: AgentMemoryCategory
  content: string
  source: 'user' | 'agent'
  origin: string
  confidence?: number
  anchorPath?: string
  anchorSymbol?: string
}

export interface AgentMemoryUpsertResult { added: number; merged: number; evicted: number; total: number }

// 注入结果：已完成锚点校验与预算裁剪的分类条目文本
export interface AgentMemoryInjection {
  text: string
  entries: number       // 实际注入条目数
  stale: number         // 带「需验证」标签（锚点失效）的条目数
  userConflicts: number // 其中源自用户陈述、需向用户呈现冲突的条目数
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

// ── Agent Code 认知地图（codeMapService，主进程 ↔ 渲染层 IPC 载荷）──
// 轻量级代码库认知地图：每文件只存「骨架」（符号签名 + import 清单），不存文件体。

/** 地图中单个符号（函数/类/接口等声明，仅签名级信息） */
export interface CodeMapSymbol {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'var' | 'section'
  line: number          // 1-based 行号
  exported: boolean
  signature?: string    // 声明行原文（截断），供预览定位
}

/** 单文件骨架记录：路径 + 指纹（mtime/size/hash）+ 符号清单 + import 清单 */
export interface CodeMapFileSkeleton {
  relPath: string       // 相对工作区根，统一 '/' 分隔
  lang: string          // 扩展名小写（如 '.ts'）
  size: number
  mtimeMs: number
  hash: string          // 内容 sha1，失效判定以此为准
  symbols: CodeMapSymbol[]
  imports: string[]     // 相对导入解析为地图内 relPath；解析不到则保留原始说明符
}

/** 地图构建状态（codemap-status 查询返回） */
export interface CodeMapStatus {
  workspaceDir: string
  state: 'idle' | 'building' | 'ready' | 'error'
  filesIndexed: number
  totalFiles: number
  symbolCount: number
  builtAt?: number
  fromSnapshot?: boolean  // 本次构建是否命中落盘快照（增量校验而非全量解析）
  error?: string
}

/** 符号查询命中项 */
export interface CodeMapSymbolHit {
  name: string
  kind: CodeMapSymbol['kind']
  relPath: string
  line: number
  signature?: string
}

/** 依赖邻居查询结果（影响域扩散的一跳数据） */
export interface CodeMapNeighbors {
  relPath: string
  dependsOn: string[]   // 正向：该文件 import 的地图内文件
  dependedBy: string[]  // 反向：import 了该文件的地图内文件
}

// ── 代码混合检索（retrievalService，BM25 词法 + 符号精确）──

/** 检索命中的代码块（逻辑单元分块：函数/类方法/模块段） */
export interface CodeSearchHit {
  relPath: string
  startLine: number     // 1-based，含
  endLine: number       // 1-based，含
  symbol: string        // 所属逻辑单元面包屑（符号名 / 模块头 / 分片标记）
  kind: string
  score: number
  snippet: string       // 块首部摘要（截断）
}

/** codesearch-query 返回：status 非 ready 时 results 为空，调用方按降级策略处理 */
export interface CodeSearchResponse {
  status: 'ready' | 'building' | 'no-map'
  results: CodeSearchHit[]
  lowConfidence: boolean   // 置信度低：建议降级到精确通道（Grep）或结构导航
  indexedChunks: number
}

// ── 模型工具（GGUF 检查器 / Token 可视化 / 显存计算器）──

/** GGUF 头部单个 KV 条目；数组类型只保留前若干项预览 + 总长度 */
export interface GgufKvEntry {
  key: string
  type: string
  value: string | number | boolean | null
  arrayLength?: number
  arrayPreview?: (string | number | boolean)[]
}

/** GGUF 头部元数据（便捷字段 + 完整 KV 表 + tensor 类型分布） */
export interface GgufMetadata {
  path: string
  fileSize: number
  version: number
  tensorCount: number
  kvCount: number
  paramCount: number        // 全部 tensor 元素数之和（≈ 参数量）
  architecture?: string
  modelName?: string
  fileTypeName?: string     // 量化类型（如 Q4_K_M）
  contextLength?: number
  blockCount?: number
  headCount?: number
  headCountKv?: number
  embeddingLength?: number
  expertCount?: number
  vocabSize?: number
  chatTemplate?: string
  kv: GgufKvEntry[]
  tensorTypes: { type: string; count: number; params: number }[]
}

/** tokenize-text 返回：服务模式（/tokenize）与二进制模式（llama-tokenize）统一结构 */
export interface TokenizeResult {
  success: boolean
  error?: string
  tokens: { id: number; piece: string }[]
}

/** fit-params 返回：拟合参数 + GPU 显存信息（nvidia-smi 不可用时 gpus 为 null） */
export interface FitParamsResult {
  success: boolean
  error?: string
  fittedArgs?: string       // stdout 末行原文，如 "-c 72448 -ngl -1"
  ctxSize?: number          // 从 fittedArgs 解析的 -c
  gpuLayers?: number        // 从 fittedArgs 解析的 -ngl
  log?: string              // 完整 stderr 日志
  gpus?: { name: string; totalMiB: number; usedMiB: number }[] | null
}

// ── 本地知识库 RAG（knowledgeService，BM25 关键词检索）──

/** 知识库元信息（列表展示，不含分块正文） */
export interface KnowledgeBaseMeta {
  id: string
  name: string
  createdAt: string
  docCount: number
  chunkCount: number
}

/** 知识库内单个文档（knowledge-get 返回） */
export interface KnowledgeDoc {
  id: string
  name: string
  chunkCount: number
}

/** knowledge-query 命中的文档段落 */
export interface KnowledgeHit {
  docName: string
  ordinal: number      // 该段在文档内的块序号
  text: string
  score: number
}
