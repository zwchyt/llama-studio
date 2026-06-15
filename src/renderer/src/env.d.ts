import type { Template, BackendVersion, CommandsSchema, ReleaseInfo, ModelMetrics, ChatSession, ChatStreamChunk } from '../../shared/types'
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
  onDownloadProgress: (callback: (data: { percent: number; phase: string }) => void) => void
  removeDownloadListener: () => void
  hfSearch: (query: string) => Promise<HfModelResult[] | { error: string }>
  hfGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
  hfDownloadModel: (opts: { repoId: string; filename: string; downloadUrl: string }) => Promise<{ success: boolean; error?: string }>
  hfOpenModelsDir: () => Promise<void>
  onHfDownloadProgress: (callback: (data: {
    id: string; percent: number; phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
    filename: string; destPath: string; speed: number; receivedBytes: number; totalBytes: number
    repoId: string
  }) => void) => void
  removeHfDownloadListener: () => void
  openFolder: (path: string) => Promise<void>
  getPaths: () => Promise<{ models: string; templates: string; backend: string; chats: string }>
  listExternalModelFolders: () => Promise<string[]>
  addExternalModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeExternalModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  openExternal: (url: string) => Promise<void>
  startPiWeb: () => Promise<{ success: boolean; url: string; error?: string }>
  stopPiWeb: () => Promise<void>
  openPiWebWindow: () => Promise<void>
  getPiWebStatus: () => Promise<{ running: boolean; url: string }>
  openChatWindow: (port: number) => Promise<void>
  waitForServer: (port: number) => Promise<boolean>
  fetchServerEndpoint: (port: number, endpoint: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>
  onModelLog: (cb: (data: { id: string; stream: string; text: string }) => void) => void
  removeModelLogListener: () => void
  getMetrics: () => Promise<{ metrics: Record<string, Partial<ModelMetrics>> }>
  onMetricsUpdate: (cb: (data: Partial<ModelMetrics> & { id: string }) => void) => void
  removeMetricsUpdateListener: () => void
  getMetricsPolling: () => Promise<boolean>
  setMetricsPolling: (enabled: boolean) => Promise<{ success: boolean }>
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
  abortChatStream: (streamId: string) => Promise<{ success: boolean }>
  onChatStreamChunk: (cb: (data: ChatStreamChunk) => void) => void
  removeChatStreamListener: () => void
}
declare global {
  interface Window { api: LlamaCppApi }
}
