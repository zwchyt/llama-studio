import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const fullApi = {
  printToPDF: (html: string) => ipcRenderer.invoke('print-to-pdf', html),
  savePng: (dataUrl: string) => ipcRenderer.invoke('save-png', dataUrl),
  listModels: () => ipcRenderer.invoke('list-models'),
  listModelsRefresh: () => ipcRenderer.invoke('list-models-refresh'),
  deleteModel: (filePath: string) => ipcRenderer.invoke('delete-model', filePath),
  renameModel: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-model', oldPath, newName),
  startModelDownload: (opts: object) => ipcRenderer.invoke('start-model-download', opts),
  pauseModelDownload: (id: string) => ipcRenderer.invoke('pause-model-download', id),
  resumeModelDownload: (id: string) => ipcRenderer.invoke('resume-model-download', id),
  cancelModelDownload: (id: string) => ipcRenderer.invoke('cancel-model-download', id),
  listModelDownloads: () => ipcRenderer.invoke('list-model-downloads'),
  onModelDownloadProgress: (cb: (data: object) => void) => {
    ipcRenderer.removeAllListeners('model-download-progress')
    ipcRenderer.on('model-download-progress', (_e, data) => cb(data))
  },
  removeModelDownloadListener: () => ipcRenderer.removeAllListeners('model-download-progress'),
  listBackends: () => ipcRenderer.invoke('list-backends'),
  deleteBackend: (name: string) => ipcRenderer.invoke('delete-backend', name),
  getCommands: (backendName: string) => ipcRenderer.invoke('get-commands', backendName),
  saveBackendCommands: (backendName: string, schema: object) => ipcRenderer.invoke('save-backend-commands', backendName, schema),
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  saveTemplate: (template: object) => ipcRenderer.invoke('save-template', template),
  deleteTemplate: (id: string) => ipcRenderer.invoke('delete-template', id),
  importTemplate: () => ipcRenderer.invoke('import-template'),
  exportTemplate: (template: object) => ipcRenderer.invoke('export-template', template),
  checkFileExists: (filePath: string) => ipcRenderer.invoke('check-file-exists', filePath),
  pickModelFile: () => ipcRenderer.invoke('pick-model-file'),
  runModel: (opts: object) => ipcRenderer.invoke('run-model', opts),
  stopModel: (id: string) => ipcRenderer.invoke('stop-model', id),
  onModelError: (cb: (data: { id: string; error: string }) => void) => {
    ipcRenderer.removeAllListeners('model-error')
    ipcRenderer.on('model-error', (_e, data) => cb(data))
  },
  removeModelErrorListener: () => ipcRenderer.removeAllListeners('model-error'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadRelease: (opts: object) => ipcRenderer.invoke('download-release', opts),
  cancelBackendDownload: () => ipcRenderer.invoke('cancel-backend-download'),
  onDownloadProgress: (callback: (data: { percent: number; phase: string }) => void) => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.on('download-progress', (_event, data) => callback(data))
  },
  removeDownloadListener: () => ipcRenderer.removeAllListeners('download-progress'),
  // ── 应用自身更新 ──
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  downloadAppUpdate: (opts: { url: string; assetName: string }) => ipcRenderer.invoke('download-app-update', opts),
  cancelAppDownload: () => ipcRenderer.invoke('cancel-app-download'),
  installAppUpdate: (opts: { installerPath: string }) => ipcRenderer.invoke('install-app-update', opts),
  onAppDownloadProgress: (callback: (data: { percent: number; phase: string; received?: number; total?: number }) => void) => {
    ipcRenderer.removeAllListeners('app-download-progress')
    ipcRenderer.on('app-download-progress', (_event, data) => callback(data))
  },
  removeAppDownloadListener: () => ipcRenderer.removeAllListeners('app-download-progress'),
  hfSearch: (query: string) => ipcRenderer.invoke('hf-search', query),
  hfGetFiles: (repoId: string) => ipcRenderer.invoke('hf-get-files', repoId),
  hfDownloadModel: (opts: object) => ipcRenderer.invoke('hf-download-model', opts),
  hfOpenModelsDir: () => ipcRenderer.invoke('hf-open-models-dir'),
  msSearch: (query: string) => ipcRenderer.invoke('ms-search', query),
  msGetFiles: (repoId: string) => ipcRenderer.invoke('ms-get-files', repoId),
  msDownloadModel: (opts: object) => ipcRenderer.invoke('ms-download-model', opts),
  msOpenModelsDir: () => ipcRenderer.invoke('ms-open-models-dir'),
  onHfDownloadProgress: (callback: (data: { percent: number; phase: string; filename: string; destPath: string }) => void) => {
    ipcRenderer.removeAllListeners('hf-download-progress')
    ipcRenderer.on('hf-download-progress', (_event, data) => callback(data))
  },
  removeHfDownloadListener: () => ipcRenderer.removeAllListeners('hf-download-progress'),
  openFolder: (path: string) => ipcRenderer.invoke('open-folder', path),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  listExternalModelFolders: () => ipcRenderer.invoke('list-external-model-folders'),
  addExternalModelFolder: () => ipcRenderer.invoke('add-external-model-folder'),
  removeExternalModelFolder: (folder: string) => ipcRenderer.invoke('remove-external-model-folder', folder),
  // ── 图片模型 ──
  listImageModels: () => ipcRenderer.invoke('list-image-models'),
  listImageModelsRefresh: () => ipcRenderer.invoke('list-image-models-refresh'),
  listImageModelFolders: () => ipcRenderer.invoke('list-image-model-folders'),
  addImageModelFolder: () => ipcRenderer.invoke('add-image-model-folder'),
  removeImageModelFolder: (folder: string) => ipcRenderer.invoke('remove-image-model-folder', folder),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  checkPiWeb: () => ipcRenderer.invoke('check-pi-web'),
  downloadPiWeb: () => ipcRenderer.invoke('download-pi-web'),
  cancelPiWebDownload: () => ipcRenderer.invoke('cancel-pi-web-download'),
  onPiWebDownloadProgress: (cb: (data: { percent: number; phase: string }) => void) => {
    ipcRenderer.removeAllListeners('pi-web-download-progress')
    ipcRenderer.on('pi-web-download-progress', (_e, d) => cb(d))
  },
  removePiWebDownloadListener: () => ipcRenderer.removeAllListeners('pi-web-download-progress'),
  startPiWeb: () => ipcRenderer.invoke('start-pi-web'),
  stopPiWeb: () => ipcRenderer.invoke('stop-pi-web'),
  openPiWebWindow: () => ipcRenderer.invoke('open-pi-web-window'),
  getPiWebStatus: () => ipcRenderer.invoke('get-pi-web-status'),
  getMetricsPolling: () => ipcRenderer.invoke('get-metrics-polling'),
  setMetricsPolling: (enabled: boolean) => ipcRenderer.invoke('set-metrics-polling', enabled),
  openChatWindow: (port: number) => ipcRenderer.invoke('open-chat-window', port),
  waitForServer: (port: number) => ipcRenderer.invoke('wait-for-server', port),
  fetchServerEndpoint: (port: number, endpoint: string) => ipcRenderer.invoke('fetch-server-endpoint', port, endpoint),
  onModelLog: (cb: (data: { id: string; stream: string; text: string }) => void) => {
    ipcRenderer.removeAllListeners('model-log')
    ipcRenderer.on('model-log', (_e, data) => cb(data))
  },
  removeModelLogListener: () => ipcRenderer.removeAllListeners('model-log'),
  getMetrics: () => ipcRenderer.invoke('get-metrics'),
  onMetricsUpdate: (callback: (data: Record<string, unknown>) => void) => {
    ipcRenderer.removeAllListeners('metrics-update')
    ipcRenderer.on('metrics-update', (_event, data) => callback(data))
  },
  removeMetricsUpdateListener: () => ipcRenderer.removeAllListeners('metrics-update'),
  listGlobalAgents: () => ipcRenderer.invoke('list-global-agents'),
  launchAgent: (cmd: string, cwd: string) => ipcRenderer.invoke('launch-agent', { cmd, cwd }),
  installAgent: (pkg: string) => ipcRenderer.invoke('install-agent', { pkg }),
  updateAgent: (pkg: string) => ipcRenderer.invoke('update-agent', { pkg }),
  checkAgentUpdates: (installed: { pkg: string; version: string }[]) => ipcRenderer.invoke('check-agent-updates', installed),
  // ── 原生聊天 ──
  listChatSessions: () => ipcRenderer.invoke('list-chat-sessions'),
  saveChatSession: (session: object) => ipcRenderer.invoke('save-chat-session', session),
  deleteChatSession: (id: string) => ipcRenderer.invoke('delete-chat-session', id),
  chatStream: (opts: { streamId: string; port: number; body: object }) => ipcRenderer.invoke('chat-completion-stream', opts),
  chatMultimodalStream: (opts: { streamId: string; port: number; messages: object[]; images: string[] }) => ipcRenderer.invoke('chat-multimodal-stream', opts),
  abortChatStream: (streamId: string) => ipcRenderer.invoke('chat-stream-abort', streamId),
  onChatStreamChunk: (callback: (data: { streamId: string; delta?: string; done: boolean; error?: string; usage?: { promptTokens: number; completionTokens: number }; msFirstToken?: number; decodeTokS?: number; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>; finishReason?: string }) => void) => {
    ipcRenderer.removeAllListeners('chat-stream-chunk')
    ipcRenderer.on('chat-stream-chunk', (_event, data) => callback(data))
  },
  removeChatStreamListener: () => ipcRenderer.removeAllListeners('chat-stream-chunk'),
  // ── 工具调用（网络搜索）──
  webSearch: (query: string) => ipcRenderer.invoke('web-search', query),
  fetchWebpage: (url: string) => ipcRenderer.invoke('fetch-webpage', url),

  // ── 终端控制台 ──
  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number }) => ipcRenderer.invoke('terminal:create', opts),
  terminalInput: (id: string, data: string) => ipcRenderer.invoke('terminal:input', { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  terminalKill: (id: string) => ipcRenderer.invoke('terminal:kill', { id }),
  onTerminalData: (cb: (d: { id: string; data: string }) => void) => {
    ipcRenderer.removeAllListeners('terminal:data')
    ipcRenderer.on('terminal:data', (_e, d) => cb(d))
  },
  onTerminalExited: (cb: (d: { id: string; exitCode: number }) => void) => {
    ipcRenderer.removeAllListeners('terminal:exited')
    ipcRenderer.on('terminal:exited', (_e, d) => cb(d))
  },
  onTerminalTitle: (cb: (d: { id: string; title: string }) => void) => {
    ipcRenderer.removeAllListeners('terminal:title')
    ipcRenderer.on('terminal:title', (_e, d) => cb(d))
  },
  removeTerminalListeners: () => {
    ipcRenderer.removeAllListeners('terminal:data')
    ipcRenderer.removeAllListeners('terminal:exited')
    ipcRenderer.removeAllListeners('terminal:title')
  },
  // ── OCR ──
  ocrStream: (opts: { streamId: string; port: number; image: string }) => ipcRenderer.invoke('ocr-stream', opts),
  abortOcrStream: (streamId: string) => ipcRenderer.invoke('ocr-stream-abort', streamId),
  onOcrChunk: (cb: (data: { streamId: string; delta?: string; done: boolean; error?: string }) => void) => {
    ipcRenderer.removeAllListeners('ocr-chunk')
    ipcRenderer.on('ocr-chunk', (_e, data) => cb(data))
  },
  removeOcrListeners: () => {
    ipcRenderer.removeAllListeners('ocr-chunk')
  },
  // ── 性能测试 ──
  runBenchmark: (opts: { id: string; backendPath: string; exe: string; args: string[] }) => ipcRenderer.invoke('run-benchmark', opts),
  stopBenchmark: (id: string) => ipcRenderer.invoke('stop-benchmark', id),
  onBenchmarkLog: (cb: (data: { id: string; stream: string; text: string }) => void) => {
    ipcRenderer.removeAllListeners('benchmark-log')
    ipcRenderer.on('benchmark-log', (_e, data) => cb(data))
  },
  removeBenchmarkLogListener: () => ipcRenderer.removeAllListeners('benchmark-log'),
  onBenchmarkDone: (cb: (data: { id: string; code: number | null }) => void) => {
    ipcRenderer.removeAllListeners('benchmark-done')
    ipcRenderer.on('benchmark-done', (_e, data) => cb(data))
  },
  removeBenchmarkDoneListener: () => ipcRenderer.removeAllListeners('benchmark-done'),
  onBenchmarkError: (cb: (data: { id: string; error: string }) => void) => {
    ipcRenderer.removeAllListeners('benchmark-error')
    ipcRenderer.on('benchmark-error', (_e, data) => cb(data))
  },
  removeBenchmarkErrorListener: () => ipcRenderer.removeAllListeners('benchmark-error'),
}

const chatApi = {
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  waitForServer: (port: number) => ipcRenderer.invoke('wait-for-server', port),
}

const isChatWindow = process.argv.includes('--window-mode=chat')
const isPiWebWindow = process.argv.includes('--window-mode=piweb')

const api = isPiWebWindow ? {} : isChatWindow ? chatApi : fullApi

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    if (!isPiWebWindow) {
      contextBridge.exposeInMainWorld('api', api)
    }
  } catch (error) {
    console.error('[preload] contextBridge.exposeInMainWorld 失败:', error,
      'isChatWindow=', isChatWindow, 'isPiWebWindow=', isPiWebWindow)
  }
} else {
  ;(window as any).electron = electronAPI
  if (!isPiWebWindow) {
    ;(window as any).api = api
  }
}
