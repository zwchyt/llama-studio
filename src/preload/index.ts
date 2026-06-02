import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const fullApi = {
  listModels: () => ipcRenderer.invoke('list-models'),
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
  hfSearch: (query: string) => ipcRenderer.invoke('hf-search', query),
  hfGetFiles: (repoId: string) => ipcRenderer.invoke('hf-get-files', repoId),
  hfDownloadModel: (opts: object) => ipcRenderer.invoke('hf-download-model', opts),
  hfOpenModelsDir: () => ipcRenderer.invoke('hf-open-models-dir'),
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
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  startPiWeb: () => ipcRenderer.invoke('start-pi-web'),
  stopPiWeb: () => ipcRenderer.invoke('stop-pi-web'),
  openPiWebWindow: () => ipcRenderer.invoke('open-pi-web-window'),
  getPiWebStatus: () => ipcRenderer.invoke('get-pi-web-status'),
  getMetricsPolling: () => ipcRenderer.invoke('get-metrics-polling'),
  setMetricsPolling: (enabled: boolean) => ipcRenderer.invoke('set-metrics-polling', enabled),
  openChatWindow: (port: number) => ipcRenderer.invoke('open-chat-window', port),
  waitForServer: (port: number) => ipcRenderer.invoke('wait-for-server', port),
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
    console.error(error)
  }
} else {
  ;(window as any).electron = electronAPI
  if (!isPiWebWindow) {
    ;(window as any).api = api
  }
}
