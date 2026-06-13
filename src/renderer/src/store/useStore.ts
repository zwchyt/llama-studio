import { create } from 'zustand'
import type { Template, BackendVersion, CommandsSchema, ReleaseInfo, RunningStatus, ModelMetrics } from '../../../shared/types'
interface CardState {
  template: Template
  status: RunningStatus
  pid?: number
  expanded: boolean
  monitorExpanded: boolean
}
export interface ModelFileInfo {
  name: string; path: string; size: number; folder: string; external?: boolean
}
export interface ModelDownloadInfo {
  id: string; url: string; filename: string; destPath: string
  receivedBytes: number; totalBytes: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  percent: number; repoId?: string; speed?: number
}
export interface AgentStatus {
  name: string
  pkg: string
  cmd: string
  installed: boolean
  version: string | null
  logo?: string
  website?: string
}
export const MAX_LOG_LINES = 5000
function logClass(text: string): string {
  if (/\berror\b/i.test(text)) return 'log-error'
  if (/\bwarn(ing)?\b/i.test(text)) return 'log-warn'
  return 'log-stdout'
}
interface AppStore {
  cards: CardState[]
  backends: BackendVersion[]
  models: ModelFileInfo[]
  activeBackend: BackendVersion | null
  commandsSchema: CommandsSchema | null
  releaseInfo: ReleaseInfo | null
  paths: { models: string; templates: string; backend: string } | null
  view: 'welcome' | 'cards' | 'settings' | 'hub' | 'models' | 'about' | 'monitoring' | 'piweb' | 'llama' | 'agents'
  showCreateModal: boolean
  editingTemplate: Template | null
  updateDismissed: boolean
  checkingUpdate: boolean
  downloadProgress: { percent: number; phase: string } | null
  templateSearch: string
  modelDownloads: Record<string, ModelDownloadInfo>
  hfDownloads: { repoId: string; filename: string; percent: number; phase: 'downloading' | 'paused' | 'saving' | 'creating_template' | 'done' | 'error' | 'starting' | 'cancelled'; speed?: number }[]
  hubQuery: string
  hubResults: import('../../../shared/types').HubResultItem[]
  hubSelectedModelId: string | null
  modelLogs: Record<string, { stream: string; text: string; className: string }[]>
  modelMetrics: Record<string, ModelMetrics>
  appendModelLog: (id: string, stream: string, text: string) => void
  clearModelLogs: (id: string) => void
  updateModelMetric: (id: string, partial: Partial<ModelMetrics>) => void
  clearModelMetrics: (id: string) => void
  setView: (v: AppStore['view']) => void
  setShowCreateModal: (show: boolean, template?: Template | null) => void
  setActiveBackend: (b: BackendVersion) => void
  setCommandsSchema: (s: CommandsSchema) => void
  setBackends: (b: BackendVersion[]) => void
  setModels: (m: ModelFileInfo[]) => void
  setCards: (c: CardState[]) => void
  setReleaseInfo: (r: ReleaseInfo | null) => void
  setPaths: (p: { models: string; templates: string; backend: string }) => void
  setUpdateDismissed: (v: boolean) => void
  setCheckingUpdate: (v: boolean) => void
  setDownloadProgress: (data: { percent: number; phase: string } | null) => void
  setTemplateSearch: (q: string) => void
  upsertModelDownload: (d: ModelDownloadInfo) => void
  removeModelDownload: (id: string) => void
  setHfDownload: (d: { repoId: string; filename: string; percent: number; phase: 'downloading' | 'paused' | 'saving' | 'creating_template' | 'done' | 'error' | 'starting' | 'cancelled'; speed?: number }) => void
  removeHfDownload: (filename: string) => void
  setHubQuery: (q: string) => void
  setHubResults: (r: import('../../../shared/types').HubResultItem[]) => void
  setHubSelectedModelId: (id: string | null) => void
  addCard: (template: Template) => void
  updateCard: (id: string, template: Partial<Template>) => void
  removeCard: (id: string) => void
  setCardStatus: (id: string, status: RunningStatus, pid?: number) => void
  toggleCardExpanded: (id: string) => void
  toggleMonitorExpanded: (id: string) => void
  collapseAllCards: () => void
  activeChatUrl: string | null
  activeChatPort: number | null
  setActiveChat: (url: string, port: number) => void
  clearActiveChat: () => void
  piWebUrl: string | null
  setPiWebUrl: (url: string | null) => void
  agentStatuses: AgentStatus[]
  agentsLoading: boolean
  agentCwd: string | null
  agentUpdates: Record<string, { latest: string }>
  agentUpdatesLoading: boolean
  setAgentStatuses: (a: AgentStatus[]) => void
  setAgentsLoading: (v: boolean) => void
  setAgentCwd: (cwd: string | null) => void
  setAgentUpdates: (u: Record<string, { latest: string }>) => void
  setAgentUpdatesLoading: (v: boolean) => void
}
export const useStore = create<AppStore>((set) => ({
  cards: [], backends: [], models: [], activeBackend: null,
  commandsSchema: null, releaseInfo: null, paths: null,
  view: 'welcome', showCreateModal: false, editingTemplate: null,
  updateDismissed: false, checkingUpdate: false, downloadProgress: null,
  templateSearch: '', modelDownloads: {}, hfDownloads: [],
  hubQuery: '', hubResults: [], hubSelectedModelId: null,
  modelLogs: {},
  modelMetrics: {},
  activeChatUrl: null,
  activeChatPort: null,
  piWebUrl: null,
  agentStatuses: [],
  agentsLoading: false,
  agentCwd: null,
  agentUpdates: {},
  agentUpdatesLoading: false,
  setView: (v) => set({ view: v }),
  setAgentStatuses: (a) => set({ agentStatuses: a }),
  setAgentsLoading: (v) => set({ agentsLoading: v }),
  setAgentCwd: (cwd) => set({ agentCwd: cwd }),
  setAgentUpdates: (u) => set({ agentUpdates: u }),
  setAgentUpdatesLoading: (v) => set({ agentUpdatesLoading: v }),
  setShowCreateModal: (show, template = null) => set({ showCreateModal: show, editingTemplate: template }),
  setActiveBackend: (b) => set({ activeBackend: b }),
  setCommandsSchema: (s) => set({ commandsSchema: s }),
  setBackends: (b) => set({ backends: b }),
  setModels: (m) => set({ models: m }),
  setCards: (c) => set({ cards: c }),
  setReleaseInfo: (r) => set({ releaseInfo: r }),
  setPaths: (p) => set({ paths: p }),
  setUpdateDismissed: (v) => set({ updateDismissed: v }),
  setCheckingUpdate: (v) => set({ checkingUpdate: v }),
  setDownloadProgress: (data) => set({ downloadProgress: data }),
  setTemplateSearch: (q) => set({ templateSearch: q }),
  upsertModelDownload: (d) => set((s) => {
    const existing = s.modelDownloads[d.id]
    if (existing && existing.percent === d.percent && existing.phase === d.phase) return s
    return { modelDownloads: { ...s.modelDownloads, [d.id]: d } }
  }),
  removeModelDownload: (id) => set((s) => {
    if (!(id in s.modelDownloads)) return s
    const next = { ...s.modelDownloads }; delete next[id]; return { modelDownloads: next }
  }),
  setHfDownload: (d) => set((s) => {
    const idx = s.hfDownloads.findIndex(x => x.filename === d.filename)
    if (idx >= 0 && s.hfDownloads[idx].percent === d.percent && s.hfDownloads[idx].phase === d.phase) return s
    const arr = [...s.hfDownloads]
    if (idx >= 0) arr[idx] = d; else arr.push(d)
    return { hfDownloads: arr }
  }),
  removeHfDownload: (filename) => set((s) => {
    if (!s.hfDownloads.some(x => x.filename === filename)) return s
    return { hfDownloads: s.hfDownloads.filter(x => x.filename !== filename) }
  }),
  setHubQuery: (q) => set({ hubQuery: q }),
  setHubResults: (r) => set({ hubResults: r }),
  setHubSelectedModelId: (id) => set({ hubSelectedModelId: id }),
  appendModelLog: (id, stream, text) => set((s) => {
    const existing = s.modelLogs[id] || []
    const lines = text.split('\n')
    const newEntries = lines
      .filter(line => line.length > 0 || lines.length === 1)
      .map(line => ({ stream, text: line, className: logClass(line) }))
    if (existing.length + newEntries.length <= MAX_LOG_LINES) {
      return { modelLogs: { ...s.modelLogs, [id]: [...existing, ...newEntries] } }
    }
    return { modelLogs: { ...s.modelLogs, [id]: [...existing, ...newEntries].slice(-MAX_LOG_LINES) } }
  }),
  clearModelLogs: (id) => set((s) => {
    const next = { ...s.modelLogs }
    delete next[id]
    return { modelLogs: next }
  }),
  updateModelMetric: (id, partial) => set((s) => {
    const existing = s.modelMetrics[id]
    if (!existing) {
      return { modelMetrics: { ...s.modelMetrics, [id]: {
        id,
        templateName: partial.templateName || id,
        pid: partial.pid,
        decodeTokS: partial.decodeTokS ?? [],
        ttftMs: partial.ttftMs ?? null,
        prefillTokS: partial.prefillTokS ?? null,
        reqPerSec: partial.reqPerSec ?? [],
        vramUsedMb: partial.vramUsedMb ?? null,
        vramTotalMb: partial.vramTotalMb ?? 0,
        gpuTemperature: partial.gpuTemperature ?? null,
        gpuUtilization: partial.gpuUtilization ?? null,
        gpuName: partial.gpuName ?? '',
        gpuPowerDraw: partial.gpuPowerDraw ?? null,
        cpuUsage: partial.cpuUsage ?? null,
        nPromptTokens: partial.nPromptTokens ?? 0,
        nPromptTokensCache: partial.nPromptTokensCache ?? 0,
        nPromptTokensProcessed: partial.nPromptTokensProcessed ?? 0,
        nDecoded: partial.nDecoded ?? 0,
        isProcessing: partial.isProcessing ?? false,
        prefillProgress: partial.prefillProgress ?? null,
        nPredict: partial.nPredict ?? -1,
        nCtx: partial.nCtx ?? 0,
        lastUpdated: Date.now(),
      } } }
    }
    for (const k in partial) {
      const key = k as keyof ModelMetrics
      const pv = partial[key]
      const ev = existing[key]
      const next = (key === 'nPromptTokensCache' || key === 'nPromptTokensProcessed') ? (pv ?? ev) : pv
      if (next !== ev) {
        return { modelMetrics: { ...s.modelMetrics, [id]: {
          ...existing,
          ...partial,
          nPromptTokensCache: partial.nPromptTokensCache ?? existing.nPromptTokensCache,
          nPromptTokensProcessed: partial.nPromptTokensProcessed ?? existing.nPromptTokensProcessed,
          lastUpdated: Date.now(),
        } } }
      }
    }
    return s
  }),
  clearModelMetrics: (id) => set((s) => {
    const next = { ...s.modelMetrics }
    delete next[id]
    return { modelMetrics: next }
  }),
  addCard: (template) => set((s) => ({ cards: [...s.cards, { template, status: 'idle', expanded: false, monitorExpanded: true }] })),
  updateCard: (id, partial) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, template: { ...c.template, ...partial, updatedAt: new Date().toISOString() } } : c)
  })),
  removeCard: (id) => set((s) => ({ cards: s.cards.filter(c => c.template.id !== id) })),
  setCardStatus: (id, status, pid) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, status, pid: pid ?? (status === 'idle' || status === 'error' ? undefined : c.pid) } : c)
  })),
  toggleCardExpanded: (id) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, expanded: !c.expanded } : c)
  })),
  toggleMonitorExpanded: (id) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, monitorExpanded: !c.monitorExpanded } : c)
  })),
  collapseAllCards: () => set((s) => ({ cards: s.cards.map(c => ({ ...c, expanded: false })) })),
  setActiveChat: (url, port) => set({ activeChatUrl: url, activeChatPort: port }),
  clearActiveChat: () => set({ activeChatUrl: null, activeChatPort: null }),
  setPiWebUrl: (url) => set({ piWebUrl: url })
}))
