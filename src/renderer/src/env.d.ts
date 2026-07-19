import type { Template, BackendVersion, CommandsSchema, ReleaseInfo, ModelMetrics, ChatSession, ChatStreamChunk, AgentProject, AgentTask, TodoItem, TodoUpdate } from '../../shared/types'
// 共享给 HuggingFaceView.tsx 的类型（HfFileResult 也被 MS 复用）
interface ModelFileInfo {
  name: string
  path: string
  size: number
  folder: string
  external?: boolean
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
  downloads: number; likes: number; tags: string[]; lastModified: string
}
interface HfFileResult { name: string; size: number; downloadUrl: string }
interface MsModelResult {
  id: string; author: string; name: string
  downloads: number; likes: number; tags: string[]; lastModified: string
}
interface LlamaCppApi {
  listModels: () => Promise<ModelFileInfo[]>
  listModelsRefresh: () => Promise<ModelFileInfo[]>
  deleteModel: (filePath: string) => Promise<{ success: boolean; error?: string }>
  renameModel: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
  startModelDownload: (opts: { url: string; filename: string; repoId?: string; modelFolder?: string }) => Promise<{ success: boolean; id?: string; error?: string }>
  pauseModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  resumeModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  cancelModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  listModelDownloads: () => Promise<ModelDownloadInfo[]>
  onModelDownloadProgress: (cb: (data: ModelDownloadInfo) => void) => void
  removeModelDownloadListener: () => void
  listBackends: () => Promise<BackendVersion[]>
  deleteBackend: (name: string) => Promise<{ success: boolean; error?: string }>
  getCommands: (backendName: string) => Promise<CommandsSchema | null>
  saveBackendCommands: (backendName: string, schema: object) => Promise<{ success: boolean; error?: string }>
  listTemplates: () => Promise<Template[]>
  saveTemplate: (template: object) => Promise<{ success: boolean; id: string }>
  deleteTemplate: (id: string) => Promise<{ success: boolean }>
  importTemplate: () => Promise<Template | null>
  exportTemplate: (template: object) => Promise<{ success: boolean }>
  checkFileExists: (filePath: string) => Promise<boolean>
  pickModelFile: () => Promise<{ name: string; path: string } | null>
  selectDirectory: () => Promise<{ path: string | null }>
  runModel: (opts: { id: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number }) => Promise<{ success: boolean; pid?: number; error?: string }>
  stopModel: (id: string) => Promise<{ success: boolean; error?: string }>
  onModelError: (cb: (data: { id: string; error: string }) => void) => void
  removeModelErrorListener: () => void
  checkUpdates: () => Promise<ReleaseInfo>
  downloadRelease: (opts: { url: string; version: string; assetName: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  cancelBackendDownload: () => Promise<{ success: boolean }>
  onDownloadProgress: (callback: (data: { percent: number; phase: string; received?: number; total?: number }) => void) => void
  removeDownloadListener: () => void
  // ── 应用自身更新 ──
  checkAppUpdate: () => Promise<AppUpdateInfo>
  downloadAppUpdate: (opts: { url: string; assetName: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  cancelAppDownload: () => Promise<{ success: boolean }>
  installAppUpdate: (opts: { installerPath: string }) => Promise<{ success: boolean; error?: string }>
  onAppDownloadProgress: (callback: (data: { percent: number; phase: string; received?: number; total?: number }) => void) => void
  removeAppDownloadListener: () => void
  hfSearch: (query: string) => Promise<HfModelResult[] | { error: string }>
  hfGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
  hfDownloadModel: (opts: { repoId: string; filename: string; downloadUrl: string }) => Promise<{ success: boolean; error?: string }>
  hfOpenModelsDir: () => Promise<void>
  msSearch: (query: string) => Promise<MsModelResult[] | { error: string }>
  msGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
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
  listChatTemplates: () => Promise<ModelFileInfo[]>
  listChatTemplatesRefresh: () => Promise<ModelFileInfo[]>
  openExternal: (url: string) => Promise<void>
  openChatWindow: (port: number) => Promise<void>
  waitForServer: (port: number) => Promise<boolean>
  fetchServerEndpoint: (port: number, endpoint: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>
  onModelLog: (cb: (data: { id: string; stream: string; text: string }) => void) => void
  removeModelLogListener: () => void
  onModelReady: (cb: (data: { id: string; url: string }) => void) => void
  removeModelReadyListener: () => void
  getMetrics: () => Promise<{ metrics: Record<string, Partial<ModelMetrics>> }>
  onMetricsUpdate: (cb: (data: Partial<ModelMetrics> & { id: string }) => void) => void
  removeMetricsUpdateListener: () => void
  getMetricsPolling: () => Promise<boolean>
  setMetricsPolling: (enabled: boolean) => Promise<{ success: boolean }>
  getRunningProcesses: () => Promise<string[]>
  getUiSettings: () => Promise<{ splashEnabled?: boolean; soundEnabled?: boolean; chatSidebarCollapsed?: boolean; agentToolCardsExpanded?: boolean }>
  setUiSetting: (key: string, value: boolean) => Promise<void>
  listGlobalAgents: () => Promise<{ name: string; pkg: string; cmd: string; installed: boolean; version: string | null; website?: string }[]>
  launchAgent: (cmd: string, cwd: string) => Promise<{ success: boolean; error?: string }>
  installAgent: (pkg: string) => Promise<{ success: boolean; error?: string }>
  updateAgent: (pkg: string) => Promise<{ success: boolean; error?: string }>
  checkAgentUpdates: (installed: { pkg: string; version: string }[]) => Promise<Record<string, { latest: string }>>
  // ── 原生聊天 ──
  listChatSessions: () => Promise<ChatSession[]>
  saveChatSession: (session: object) => Promise<{ success: boolean; id?: string; error?: string }>
  deleteChatSession: (id: string) => Promise<{ success: boolean }>
  chatStream: (opts: { streamId: string; port: number; body: object }) => Promise<{ success: boolean; error?: string }>
  chatCompletion: (opts: { port: number; body: object }) => Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>
  abortChatStream: (streamId: string) => Promise<{ success: boolean }>
  onChatStreamChunk: (cb: (data: ChatStreamChunk) => void) => void
  removeChatStreamListener: () => void
  // ── 工具调用（网络搜索）──
  webSearch: (query: string) => Promise<string>
  fetchWebpage: (url: string) => Promise<string>
  // ── 终端控制台 ──
  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number }) => Promise<{ success: boolean; id?: string; shell?: string; error?: string }>
  terminalInput: (id: string, data: string) => Promise<void>
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>
  terminalKill: (id: string) => Promise<void>
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
  // ── Agent Code 文件树 ──
  buildFileTree: (dir: string, maxDepth?: number) => Promise<{ success: boolean; tree?: { name: string; path: string; isDir: boolean; children?: any[] }; error?: string }>
  expandFileTree: (dir: string, limit?: number) => Promise<{ success: boolean; children?: { name: string; path: string; isDir: boolean }[]; truncated?: boolean; total?: number; error?: string }>
  listFlatFiles: (dir: string, opts?: { maxDepth?: number; maxFiles?: number }) => Promise<{ success: boolean; files?: { name: string; path: string; relPath: string }[]; truncated?: boolean; total?: number; error?: string }>
  // ── Agent Code 文件树自动刷新（目录监听）──
  startAgentFileWatch: (dir: string) => Promise<{ success: boolean; error?: string }>
  stopAgentFileWatch: () => Promise<{ success: boolean }>
  onAgentFileChanged: (cb: (data: { dir: string; filename: string }) => void) => void
  removeAgentFileListeners: () => void
  // ── Agent Code 目录操作 ──
  listDir: (dirPath: string) => Promise<{ success: boolean; entries?: { name: string; isDir: boolean; fileCount: number }[]; truncated?: boolean; total?: number; error?: string }>
  // ── Agent Code 文件操作 ──
  readFile: (filePath: string, opts?: { maxBytes?: number; offset?: number; limit?: number; raw?: boolean }) => Promise<{ success: boolean; content?: string; lines?: number; totalLines?: number; startLine?: number; truncated?: boolean; error?: string; errorType?: string; fileSize?: number; suggestedCommand?: string }>
  readFileBase64: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  getFilePath: (file: File) => string
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
  editFile: (filePath: string, oldString: string, newString: string, replaceAll?: boolean) => Promise<{ success: boolean; content?: string; error?: string }>
  glob: (opts: { pattern: string; path: string; limit?: number }) => Promise<{ success: boolean; filenames?: string[]; numFiles?: number; truncated?: boolean; error?: string }>
  grep: (opts: { pattern: string; path: string; glob?: string; output_mode?: string; head_limit?: number; '-i'?: boolean; context?: number; '-n'?: boolean; type?: string }) => Promise<{ success: boolean; content?: string; numFiles?: number; truncated?: boolean; timedOut?: boolean; error?: string }>
	  // ── Agent Code 工作台 项目持久化 ──
	  loadAgentProjects: () => Promise<AgentProject[]>
	  saveAgentProjects: (projects: AgentProject[]) => Promise<{ success: boolean; error?: string }>
		  // ── Agent Code Bash 执行 ──
		  executeCommand: (opts: { command: string; timeout?: number; isBackground?: boolean; maxOutputChars?: number; autoBackground?: boolean }) => Promise<{ stdout: string; stderr: string; code: number; truncated?: boolean; totalBytes?: number; outputFile?: string; autoBackgrounded?: boolean; taskId?: string }>
		  writeTempFile: (content: string, ext?: string) => Promise<{ success: boolean; path?: string; error?: string }>
		  setBashCwd: (dir: string) => Promise<{ success: boolean }>
		  getBackgroundTask: (taskId: string) => Promise<{ success: boolean; stdout?: string; stderr?: string; code?: number | null; status?: string; truncated?: boolean; totalBytes?: number; error?: string }>
		  listBackgroundTasks: () => Promise<Array<{ id: string; command: string; status: string; pid: number; startTime: number; autoBackgrounded: boolean }>>
		  killBackgroundTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
		  // ── Agent Code 文件删除 ──
		  deletePath: (targetPath: string, recursive: boolean) => Promise<{ success: boolean; message?: string; error?: string }>
		  setAgentWorkspace: (dir: string) => Promise<{ success: boolean }>
		  // ── Agent Code 任务清单（Todo / Task）──
		  agentTodoWrite: (sessionId: string, input: { merge: boolean; todos: TodoUpdate[] }) => Promise<{ success: boolean; tasks?: AgentTask[]; error?: string }>
		  agentTaskGet: (sessionId: string, taskId: string) => Promise<{ success: boolean; task?: AgentTask; error?: string }>
		  agentTaskList: (sessionId: string) => Promise<{ success: boolean; tasks: AgentTask[] }>
		  agentTaskOutput: (sessionId: string, taskId: string) => Promise<{ success: boolean; task?: AgentTask; output?: string; error?: string }>
	}
declare global {
  interface Window { api: LlamaCppApi }
}
