import type { Template, BackendVersion, CommandsSchema, ReleaseInfo, ModelMetrics, ChatSession, TokenUsageEntry, ChatStreamChunk, AgentProject, AgentTask, TodoItem, TodoUpdate, CodeMapStatus, CodeMapSymbolHit, CodeMapFileSkeleton, CodeMapNeighbors, CodeSearchResponse, AgentMemoryEntry, AgentMemoryCandidate, AgentMemoryUpsertResult, AgentMemoryInjection, GgufMetadata, TokenizeResult, FitParamsResult, KnowledgeBaseMeta, KnowledgeDoc, KnowledgeHit } from '../../shared/types'
// 共享给 HuggingFaceView.tsx 的类型（HfFileResult 也被 MS 复用）
interface ImagePromptPresetPayload {
  id: string; tag: string; cn: string; group: string
}
interface ModelFileInfo {
  name: string
  path: string
  size: number
  folder: string
  external?: boolean
  tts?: boolean
  ocr?: boolean
  /** stable-diffusion.cpp 图像生成组件角色：model=扩散模型 / vae / llm=LLM 文本编码器 */
  sdRole?: 'model' | 'vae' | 'llm'
}
interface ModelDownloadInfo {
  id: string
  url: string
  filename: string
  destPath: string
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  percent: number
  speed?: number
  repoId?: string
}
interface HfModelResult {
  id: string; author: string; name: string
  downloads: number; likes: number; tags: string[]; lastModified: string; avatar?: string
}
interface HfFileResult { name: string; size: number; downloadUrl: string }
interface MsModelResult {
  id: string; author: string; name: string
  downloads: number; likes: number; tags: string[]; lastModified: string; avatar?: string
}
interface HfSearchResult { items: HfModelResult[]; hasMore: boolean }
interface LlamaCppApi {
  listModels: () => Promise<ModelFileInfo[]>
  listModelsRefresh: () => Promise<ModelFileInfo[]>
  deleteModel: (filePath: string) => Promise<{ success: boolean; error?: string }>
  renameModel: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
  startModelDownload: (opts: { url: string; filename: string; repoId?: string; modelFolder?: string }) => Promise<{ success: boolean; id?: string; error?: string }>
  pauseModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  resumeModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  cancelModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  retryModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  listModelDownloads: () => Promise<ModelDownloadInfo[]>
  onModelDownloadProgress: (cb: (data: ModelDownloadInfo) => void) => void
  removeModelDownloadListener: () => void
  listBackends: () => Promise<BackendVersion[]>
  onBackendsUpdated: (cb: (backends: BackendVersion[]) => void) => void
  deleteBackend: (name: string) => Promise<{ success: boolean; error?: string }>
  getCommands: (backendName: string, paramSet?: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp') => Promise<CommandsSchema | null>
  saveBackendCommands: (backendName: string, schema: object, paramSet?: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp') => Promise<{ success: boolean; error?: string }>
  listTemplates: () => Promise<Template[]>
  saveTemplate: (template: object) => Promise<{ success: boolean; id: string }>
  deleteTemplate: (id: string) => Promise<{ success: boolean }>
  importTemplate: () => Promise<Template | null>
  exportTemplate: (template: object) => Promise<{ success: boolean }>
  checkFileExists: (filePath: string) => Promise<boolean>
  pickModelFile: () => Promise<{ name: string; path: string } | null>
  selectDirectory: () => Promise<{ path: string | null }>
  selectFiles: () => Promise<{ paths: string[] }>
  listDrives: () => Promise<{ drives: string[] }>
  runModel: (opts: { id: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number; paramSet?: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp'; kind?: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp' }) => Promise<{ success: boolean; pid?: number; error?: string }>
  stopModel: (id: string) => Promise<{ success: boolean; error?: string }>
  onModelError: (cb: (data: { id: string; error: string }) => void) => void
  removeModelErrorListener: () => void
  onModelDiagnosis: (cb: (data: { id: string; code: number | null; severity: 'info' | 'warning' | 'critical'; title: string; cause: string; recommendations: string[]; evidence: string; logExcerpt?: { lines: string[]; start: number; errorLine: number } }) => void) => void
  removeModelDiagnosisListener: () => void
  checkUpdates: (repo?: string) => Promise<ReleaseInfo>
  downloadRelease: (opts: { url: string; version: string; assetName: string; digest?: string }) => Promise<{ success: boolean; path?: string; cancelled?: boolean; paused?: boolean; error?: string }>
  installSdCudart: (opts: { url: string; assetName: string; backendName: string; digest?: string }) => Promise<{ success: boolean; installed?: string[]; error?: string }>
  onSdCudartProgress: (cb: (data: { phase: string; percent: number; received?: number; total?: number; speed?: number }) => void) => void
  removeSdCudartProgressListener: () => void
  cancelBackendDownload: () => Promise<{ success: boolean }>
  pauseBackendDownload: () => Promise<{ success: boolean; error?: string }>
  resumeBackendDownload: () => Promise<{ success: boolean; path?: string; cancelled?: boolean; paused?: boolean; error?: string }>
  onDownloadProgress: (callback: (data: { percent: number; phase: string; received?: number; total?: number; engine?: 'tensorsharp' | 'llamacpp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp'; name?: string; speed?: number; note?: string; chunks?: Array<'idle' | 'active' | 'done'> }) => void) => void
  removeDownloadListener: () => void
  // ── 应用自身更新 ──
  checkAppUpdate: () => Promise<AppUpdateInfo>
  downloadAppUpdate: (opts: { url: string; assetName: string; digest?: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  cancelAppDownload: () => Promise<{ success: boolean }>
  installAppUpdate: (opts: { installerPath: string }) => Promise<{ success: boolean; error?: string }>
  onAppDownloadProgress: (callback: (data: { percent: number; phase: string; received?: number; total?: number }) => void) => void
  removeAppDownloadListener: () => void
  hfSearch: (query: string, opts?: { sort?: string; library?: string; limit?: number; offset?: number }) => Promise<HfSearchResult | { error: string }>
  hfGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
  hfModelInfo: (repoId: string) => Promise<{ description: string; readme: string; isHtml: boolean }>
  hfDownloadModel: (opts: { repoId: string; filename: string; downloadUrl: string }) => Promise<{ success: boolean; error?: string }>
  hfOpenModelsDir: () => Promise<void>
  msSearch: (query: string, opts?: { sort?: string; library?: string; limit?: number; page?: number }) => Promise<HfSearchResult | { error: string }>
  msGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
  msModelInfo: (repoId: string) => Promise<{ description: string; readme: string; isHtml: boolean }>
  msModelAvatar: (repoId: string) => Promise<string | null>
  hfModelAvatar: (author: string) => Promise<string | null>
  msDownloadModel: (opts: { repoId: string; filename: string; downloadUrl: string }) => Promise<{ success: boolean; error?: string }>
  msOpenModelsDir: () => Promise<void>
  onHfDownloadProgress: (callback: (data: {
    id: string; percent: number; phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
    filename: string; destPath: string; speed: number; receivedBytes: number; totalBytes: number
    repoId: string
  }) => void) => void
  removeHfDownloadListener: () => void
  openFolder: (path: string) => Promise<void>
  getPaths: () => Promise<{ models: string; templates: string; backend: string; chats: string; chatImages: string; chatPdfExports: string; chatTemplates: string }>
  listExternalModelFolders: () => Promise<string[]>
  addExternalModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeExternalModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  // ── 图片模型 ──
  listImageModels: () => Promise<ModelFileInfo[]>
  listImageModelsRefresh: () => Promise<ModelFileInfo[]>
  listImageModelFolders: () => Promise<string[]>
  addImageModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeImageModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  // ── 语音合成模型 ──
  listTtsModelFolders: () => Promise<string[]>
  addTtsModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeTtsModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  listAsrModelFolders: () => Promise<string[]>
  addAsrModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeAsrModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  // ── OCR 模型 ──
  listOcrModelFolders: () => Promise<string[]>
  addOcrModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeOcrModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  // ── stable-diffusion.cpp 模型文件夹（扩散模型 / VAE / LLM 文本编码器）──
  listSdModelFolders: () => Promise<{ model: string[]; vae: string[]; llm: string[] }>
  addSdModelFolder: (kind: 'model' | 'vae' | 'llm') => Promise<{ success: boolean; folders?: string[] }>
  removeSdModelFolder: (kind: 'model' | 'vae' | 'llm', folder: string) => Promise<{ success: boolean; folders?: string[] }>
  listChatTemplates: () => Promise<ModelFileInfo[]>
  listChatTemplatesRefresh: () => Promise<ModelFileInfo[]>
  openExternal: (url: string) => Promise<void>
  openChatWindow: (port: number) => Promise<void>
  waitForServer: (port: number) => Promise<boolean>
  fetchServerEndpoint: (port: number, endpoint: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>
  sdapiRequest: (opts: { port: number; path: string; method?: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>
  onModelLog: (cb: (data: { id: string; stream: string; text: string }) => void) => void
  removeModelLogListener: () => void
  onModelReady: (cb: (data: { id: string; url: string }) => void) => void
  removeModelReadyListener: () => void
  getMetrics: () => Promise<{ metrics: Record<string, Partial<ModelMetrics>> }>
  onMetricsUpdate: (cb: (data: Partial<ModelMetrics> & { id: string }) => void) => void
  removeMetricsUpdateListener: () => void
  queryMetricsNow: (id: string) => Promise<number | null>
  getMetricsPolling: () => Promise<boolean>
  setMetricsPolling: (enabled: boolean) => Promise<{ success: boolean }>
  getRunningProcesses: () => Promise<string[]>
  getModelLogs: (id: string) => Promise<{ stream: string; text: string }[]>
  getUiSettings: () => Promise<{ splashEnabled?: boolean; soundEnabled?: boolean; notificationSound?: string; chatSidebarCollapsed?: boolean; agentToolCardsExpanded?: boolean; ttsEngine?: string; ttsModelPath?: string; ttsVocoderPath?: string; ttsMode?: 'qwen3' | 'outetts'; ttsLang?: string; ttsMmprojPath?: string; ttsSpeakerFile?: string; sttModelPath?: string; sttMmprojPath?: string; sttPrompt?: string; sttResult?: string }>
  setUiSetting: (key: string, value: boolean | string) => Promise<void>
  listGlobalAgents: () => Promise<{ name: string; pkg: string; cmd: string; installed: boolean; version: string | null; website?: string }[]>
  launchAgent: (cmd: string, cwd: string) => Promise<{ success: boolean; error?: string }>
  installAgent: (pkg: string) => Promise<{ success: boolean; error?: string }>
  updateAgent: (pkg: string) => Promise<{ success: boolean; error?: string }>
  checkAgentUpdates: (installed: { pkg: string; version: string }[]) => Promise<Record<string, { latest: string }>>
  // ── 原生聊天 ──
  listChatSessions: () => Promise<ChatSession[]>
  saveChatSession: (session: object) => Promise<{ success: boolean; id?: string; error?: string }>
  deleteChatSession: (id: string) => Promise<{ success: boolean }>
  listTokenUsage: () => Promise<TokenUsageEntry[]>
  clearTokenUsage: () => Promise<{ success: boolean }>
  chatStream: (opts: { streamId: string; port: number; body: object }) => Promise<{ success: boolean; error?: string }>
  chatCompletion: (opts: { port: number; body: object }) => Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>
  getServerProps: (port: number) => Promise<{ ok: boolean; modalities?: { vision?: boolean; audio?: boolean }; error?: string }>
  saveChatImage: (dataUrl: string) => Promise<{ ok: boolean; ref?: string; error?: string }>
  readChatImage: (ref: string) => Promise<string | null>
  saveImages: (opts: { images: string[]; mode?: string; seed?: number; steps?: number; cfg?: number; width?: number; height?: number; prompt?: string; negativePrompt?: string; sampler?: string; scheduler?: string; model?: string }) => Promise<{ ok: boolean; files?: string[]; error?: string }>
  readImagegenImage: (name: string) => Promise<string | null>
  loadImagegenHistory: () => Promise<unknown[]>
  saveImagegenHistory: (items: unknown[]) => Promise<boolean>
  loadImagegenPresets: () => Promise<{ pos: ImagePromptPresetPayload[]; neg: ImagePromptPresetPayload[] }>
  saveImagegenPresets: (data: { pos?: ImagePromptPresetPayload[]; neg?: ImagePromptPresetPayload[] }) => Promise<boolean>
  deleteImagegenImages: (names: string[]) => Promise<boolean>
  abortChatStream: (streamId: string) => Promise<{ success: boolean }>
  onChatStreamChunk: (cb: (data: ChatStreamChunk) => void) => void
  removeChatStreamListener: () => void
  // ── 工具调用（网络搜索）──
  webSearch: (query: string) => Promise<string>
  fetchWebpage: (url: string) => Promise<string>
  // ── 终端控制台 ──
  terminalCreate: (opts: { id?: string; cwd?: string; cols?: number; rows?: number; ownerKey?: string }) => Promise<{ success: boolean; id?: string; shell?: string; error?: string; replay?: string; reused?: boolean }>
  terminalInput: (id: string, data: string) => Promise<void>
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>
  terminalKill: (id: string) => Promise<void>
  terminalExec: (opts: { command: string; cwd?: string }) => Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number | null; error?: string }>
  onTerminalData: (cb: (d: { id: string; data: string }) => void) => void
  onTerminalExited: (cb: (d: { id: string; exitCode: number }) => void) => void
  onTerminalTitle: (cb: (d: { id: string; title: string }) => void) => void
  removeTerminalListeners: () => void
  // ── PDF 导出 ──
  printToPDF: (html: string) => Promise<string>
  savePng: (dataUrl: string) => Promise<string>
  // ── OCR ──
  ocrStream: (opts: { streamId: string; port: number; image: string; prompt: string; templateArgs?: Record<string, string | number | boolean | null> }) => Promise<{ success: boolean; error?: string }>
  abortOcrStream: (streamId: string) => Promise<{ success: boolean }>
  onOcrChunk: (cb: (data: { streamId: string; delta?: string; done: boolean; error?: string }) => void) => void
  removeOcrListeners: () => void
  // ── 性能测试 ──
  runBenchmark: (opts: { id: string; backendPath: string; exe: string; args: string[] }) => Promise<{ success: boolean; pid?: number; error?: string }>
  stopBenchmark: (id: string) => Promise<{ success: boolean; error?: string }>
  onBenchmarkLog: (cb: (data: { id: string; stream: string; text: string }) => void) => void
  removeBenchmarkLogListener: () => void
  onBenchmarkDone: (cb: (data: { id: string; code: number | null }) => void) => void
  removeBenchmarkDoneListener: () => void
  onBenchmarkError: (cb: (data: { id: string; error: string }) => void) => void
  removeBenchmarkErrorListener: () => void
  // ── 模型工具（GGUF 检查器 / Token 可视化 / 显存计算器）──
  readGgufMeta: (path: string) => Promise<GgufMetadata | { error: string }>
  // ── 模型自定义 Logo（Agent Code 模型列表；图片存 logos/ 目录，记录存 logos.json）──
  setModelLogo: (templateId: string) => Promise<{ success: boolean; fileName?: string; error?: string }>
  getModelLogos: () => Promise<Record<string, string>>
  getModelLogoImage: (fileName: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  removeModelLogo: (templateId: string) => Promise<{ success: boolean; error?: string }>
  getModelCapabilities: () => Promise<Record<string, { thinking: boolean; tools: boolean; vision: boolean }>>
  saveModelCapabilities: (templateId: string, caps: { thinking: boolean; tools: boolean; vision: boolean }) => Promise<void>
  tokenizeText: (opts: { port?: number; backendPath?: string; modelPath?: string; text: string }) => Promise<TokenizeResult>
  fitParams: (opts: { backendPath: string; modelPath: string; ctxSize?: number }) => Promise<FitParamsResult>
  getGpuVram: () => Promise<{ name: string; totalMiB: number; usedMiB: number } | null>
  analyzeTemplate: (opts: { backendPath: string; template: string }) => Promise<{ success: boolean; error?: string; report?: string }>
  // ── 本地 TTS ──
  ttsGenerate: (opts: { id: string; backendPath: string; modelPath: string; vocoderPath?: string; text: string; lang?: string; speakerFile?: string; mmprojPath?: string; qwen3?: boolean }) => Promise<{ success: boolean; wavBase64?: string; error?: string }>
  ttsStop: (id: string) => Promise<{ success: boolean; error?: string }>
  // ── 本地语音转写（llama-mtmd-cli，无需 whisper.cpp）──
  sttTranscribe: (opts: { id: string; backendPath: string; modelPath: string; mmprojPath: string; audioPath: string; prompt?: string }) => Promise<{ success: boolean; text?: string; error?: string }>
  sttStop: (id: string) => Promise<{ success: boolean; error?: string }>
  // ── Agent Code 文件树 ──
  buildFileTree: (dir: string, maxDepth?: number) => Promise<{ success: boolean; tree?: { name: string; path: string; isDir: boolean; children?: any[] }; error?: string }>
  expandFileTree: (dir: string, limit?: number) => Promise<{ success: boolean; children?: { name: string; path: string; isDir: boolean; size?: number }[]; truncated?: boolean; total?: number; error?: string }>
  listFlatFiles: (dir: string, opts?: { maxDepth?: number; maxFiles?: number }) => Promise<{ success: boolean; files?: { name: string; path: string; relPath: string }[]; truncated?: boolean; total?: number; error?: string }>
  // ── Agent Code 文件树自动刷新（目录监听）──
  startAgentFileWatch: (dir: string) => Promise<{ success: boolean; error?: string }>
  stopAgentFileWatch: () => Promise<{ success: boolean }>
  onAgentFileChanged: (cb: (data: { dir: string; filename: string }) => void) => void
  removeAgentFileListeners: () => void
  // ── Agent Code 目录操作 ──
  listDir: (dirPath: string) => Promise<{ success: boolean; entries?: { name: string; isDir: boolean; fileCount: number; size?: number }[]; truncated?: boolean; total?: number; error?: string }>
  // ── Agent Code 文件操作 ──
  readFile: (filePath: string, opts?: { maxBytes?: number; offset?: number; limit?: number; raw?: boolean }) => Promise<{ success: boolean; content?: string; lines?: number; totalLines?: number; startLine?: number; truncated?: boolean; error?: string; errorType?: string; fileSize?: number; suggestedCommand?: string }>
  readFileBase64: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  getFilePath: (file: File) => string
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
  writeTempFile: (fileName: string, base64: string) => Promise<{ success: boolean; path?: string; error?: string }>
  glob: (opts: { pattern: string; path: string; limit?: number }) => Promise<{ success: boolean; filenames?: string[]; numFiles?: number; truncated?: boolean; timedOut?: boolean; error?: string }>
  grep: (opts: { pattern: string; path: string; glob?: string; output_mode?: string; head_limit?: number; '-i'?: boolean; context?: number; '-n'?: boolean; type?: string; timeout_seconds?: number }) => Promise<{ success: boolean; content?: string; numFiles?: number; truncated?: boolean; timedOut?: boolean; error?: string }>
	  // ── Agent Code 工作台项目持久化 ──
	  loadAgentProjects: () => Promise<AgentProject[]>
	  saveAgentProjects: (projects: AgentProject[]) => Promise<{ success: boolean; error?: string }>
	  // ── Agent Tracing 落盘 ──
	  agentTraceAppend: (sessionId: string, entry: object) => Promise<{ success: boolean; error?: string }>
		  // ── Agent Code 文件删除 ──
		  deletePath: (targetPath: string, recursive: boolean) => Promise<{ success: boolean; message?: string; error?: string }>
		  gitChanges: (dir: string) => Promise<{ isRepo: boolean; staged: Array<{ path: string; status: string; staged: boolean; untracked: boolean; binary: boolean; diff: string; content?: string }>; unstaged: Array<{ path: string; status: string; staged: boolean; untracked: boolean; binary: boolean; diff: string; content?: string }>; error?: string }>
		  gitStageFile: (dir: string, path: string) => Promise<{ success: boolean; error?: string }>
		  gitUnstageFile: (dir: string, path: string) => Promise<{ success: boolean; error?: string }>
		  setAgentWorkspace: (dir: string) => Promise<{ success: boolean }>
		  // ── 认知地图（codeMapService）──
		  codemapBuild: (dir: string) => Promise<CodeMapStatus | { error: string }>
		  codemapStatus: (dir: string) => Promise<CodeMapStatus>
		  codemapSymbol: (dir: string, name: string, limit?: number) => Promise<CodeMapSymbolHit[]>
		  codemapSkeleton: (dir: string, relPath: string) => Promise<CodeMapFileSkeleton | null>
		  codemapNeighbors: (dir: string, relPath: string) => Promise<CodeMapNeighbors>
		  codemapInvalidate: (dir: string, absPaths: string[]) => Promise<{ success: boolean }>
		  // ── 代码混合检索（retrievalService）──
		  codesearchQuery: (dir: string, query: string, limit?: number) => Promise<CodeSearchResponse>
		  // ── 长期记忆（memoryStore）──
		  memstoreUpsert: (dir: string, candidates: AgentMemoryCandidate[]) => Promise<AgentMemoryUpsertResult>
		  memstoreInject: (dir: string, capChars: number) => Promise<AgentMemoryInjection>
		  memstoreContradict: (dir: string, probeText: string) => Promise<{ marked: number; archived: number }>
		  memstoreList: (dir: string) => Promise<AgentMemoryEntry[]>
		  memstoreArchive: (dir: string, id: string) => Promise<{ success: boolean }>
		  // ── 本地知识库 RAG（knowledgeService）──
		  knowledgeList: () => Promise<KnowledgeBaseMeta[]>
		  knowledgeCreate: (name: string) => Promise<{ success: boolean; meta?: KnowledgeBaseMeta; error?: string }>
		  knowledgeDelete: (id: string) => Promise<{ success: boolean; error?: string }>
		  knowledgeGet: (kbId: string) => Promise<{ id: string; name: string; createdAt: string; docs: KnowledgeDoc[] } | null>
		  knowledgeAddDoc: (kbId: string, doc: { name: string; text: string }) => Promise<{ success: boolean; chunkCount?: number; meta?: KnowledgeBaseMeta; error?: string }>
		  knowledgeDeleteDoc: (kbId: string, docId: string) => Promise<{ success: boolean; meta?: KnowledgeBaseMeta; error?: string }>
		  knowledgeQuery: (kbId: string, query: string, limit?: number) => Promise<{ hits: KnowledgeHit[]; lowConfidence: boolean }>
		  // ── Agent Code 任务清单（Todo / Task）──
		  agentTodoWrite: (sessionId: string, input: { merge: boolean; todos: TodoUpdate[] }) => Promise<{ success: boolean; tasks?: AgentTask[]; error?: string }>
		  agentTaskGet: (sessionId: string, taskId: string) => Promise<{ success: boolean; task?: AgentTask; error?: string }>
		  agentTaskList: (sessionId: string) => Promise<{ success: boolean; tasks: AgentTask[] }>
		  // ── 窗口控制 ──
		  windowMinimize: () => Promise<void>
		  windowMaximize: () => Promise<void>
		  windowClose: () => Promise<void>
		  // ── pi-agent（pi SDK 驱动的 agent 会话）──
		  piAgent: {
		    create: (opts: { sessionId: string; port: number; cwd: string; approveWriteEdit?: boolean; contextWindow?: number; history?: Array<{ role: 'user' | 'assistant'; content: string; toolCalls?: Array<{ id: string; name: string; args: string; result?: string }>; attachments?: Array<{ type: string; dataUrl?: string; content?: string }> }> }) => Promise<{ success: boolean }>
		    warmup: () => Promise<{ success: boolean }>
		    prompt: (sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => Promise<{ success: boolean }>
		    abort: (sessionId: string) => Promise<{ success: boolean }>
		    dispose: (sessionId: string) => Promise<{ success: boolean }>
		    list: () => Promise<{ sessionIds: string[] }>
		    onEvent: (cb: (sessionId: string, event: unknown) => void) => void
		    onAsk: (cb: (id: number, questions: Array<{ question: string; options?: string[]; allowFreeform?: boolean }>) => void) => void
		    askResolve: (id: number, result: string) => Promise<{ success: boolean }>
	    onApprove: (cb: (id: number, req: { toolName: string; args: Record<string, unknown> }) => void) => void
	    approveResolve: (id: number, approved: boolean) => Promise<{ success: boolean }>
	    undo: (sessionId: string, toolCallId: string) => Promise<{ success: boolean; path?: string; error?: string }>
	    // ── 轨迹台账（事件流落盘的查询侧；read 支持 fromSeq 增量）──
	    trajectoryList: () => Promise<Array<{ sessionId: string; bytes: number; mtimeMs: number }>>
	    trajectoryRead: (sessionId: string, fromSeq: number) => Promise<{ entries: Array<{ seq: number; ts: number; type: string; src: 'flow' | 'assistant' | 'tool' | 'user' | 'system'; payload: unknown }>; nextSeq: number }>
	    trajectoryClear: (sessionId: string) => Promise<{ success: boolean; error?: string }>
	  }
	}
declare global {
  interface Window { api: LlamaCppApi }
}
