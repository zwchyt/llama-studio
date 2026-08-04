import { createWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import { disposeTerminal } from '../utils/terminalRegistry'
import { useStore } from './useStore'

export interface TerminalMeta {
  id: string
  ownerKey?: string
  title: string
  cwd: string
  exited?: boolean
  fallback?: boolean // 无 PTY 时使用 API 回退模式
  pending?: boolean // PTY 尚未创建，等待 TermScreen mount + fit 后创建
}

interface TerminalStore {
  sessions: TerminalMeta[]
  activeId: string | null
  open: (cwd?: string, opts?: { navigate?: boolean }) => Promise<void>
  close: (id: string) => void
  setActive: (id: string) => void
  markExited: (id: string) => void
  updateTitle: (id: string, title: string) => void
  setPtyReady: (id: string) => void
  setFallback: (id: string) => void
}

/** 根据当前会话列表生成带序号的标题：终端 1、终端 2 … */
function makeTitle(sessions: TerminalMeta[]): string {
  const usedNums = new Set(
    sessions.map(s => {
      const m = s.title.match(/^终端\s(\d+)$/)
      return m ? parseInt(m[1], 10) : 0
    })
  )
  let n = 1
  while (usedNums.has(n)) n++
  return `终端 ${n}`
}

function loadPersistedSessions(storageKey: string): TerminalMeta[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed: TerminalMeta[] = JSON.parse(raw)
    return parsed.map(s => ({ ...s, exited: true }))
  } catch {
    return []
  }
}

function persistSessions(sessions: TerminalMeta[], storageKey: string): void {
  try {
    const save = sessions
      .filter(s => !s.pending)
      .map(({ id, ownerKey, title, cwd, fallback }) => ({ id, ownerKey, title, cwd, fallback }))
    localStorage.setItem(storageKey, JSON.stringify(save))
  } catch { /* ignore */ }
}

/**
 * 创建一组独立终端会话（标签、PTY、持久化互不干扰）。
 * 主组：导航栏「终端」视图（useTerminalStore）
 * Agent 组：Agent Code 工作台内嵌终端（useAgentTerminalStore）
 */
function createTerminalStore(idPrefix: string, storageKey: string) {
  return createWithEqualityFn<TerminalStore>(
    (set, get) => ({
      sessions: loadPersistedSessions(storageKey),
      activeId: null,

      open: async (cwd?: string, opts?: { navigate?: boolean }) => {
        const ownerKey = `${idPrefix}:${crypto.randomUUID()}`
        const id = `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const fallback = !window.api.terminalCreate
        set((s) => {
          const title = makeTitle(s.sessions)
          const meta: TerminalMeta = { id, ownerKey, title, cwd: cwd || '', pending: !fallback, fallback }
          const sessions = [...s.sessions, meta]
          persistSessions(sessions, storageKey)
          return { sessions, activeId: id }
        })
        // 默认跳转到独立终端视图；内嵌终端（如 Agent Code 工作台）新建时传 navigate:false 原地使用
        if (opts?.navigate !== false) {
          useStore.getState().setView('terminal')
        }
      },

      close: (id: string) => {
        const session = get().sessions.find(s => s.id === id)
        // pending 或 fallback 的终端无 PTY，不发送 kill
        if (session && !session.pending && !session.fallback) {
          window.api.terminalKill(id).catch(() => { })
        }
        disposeTerminal(id)
        set((s) => {
          const next = s.sessions.filter((x) => x.id !== id)
          const nextActiveId = s.activeId === id
            ? (next.length > 0 ? next[next.length - 1].id : null)
            : s.activeId
          persistSessions(next, storageKey)
          return { sessions: next, activeId: nextActiveId }
        })
      },

      setActive: (id: string) => set({ activeId: id }),

      markExited: (id: string) => {
        set((s) => {
          const sessions = s.sessions.map((x) => x.id === id ? { ...x, exited: true } : x)
          persistSessions(sessions, storageKey)
          return { sessions }
        })
      },

      setPtyReady: (id: string) => {
        set((s) => {
          const sessions = s.sessions.map((x) => x.id === id ? { ...x, pending: false } : x)
          persistSessions(sessions, storageKey)
          return { sessions }
        })
      },

      setFallback: (id: string) => {
        set((s) => {
          const sessions = s.sessions.map((x) => x.id === id ? { ...x, pending: false, fallback: true } : x)
          persistSessions(sessions, storageKey)
          return { sessions }
        })
      },

      updateTitle: (id: string, title: string) => {
        set((s) => {
          const sessions = s.sessions.map((x) => {
            if (x.id !== id || x.exited) return x
            // 跳过 OSC 序列改名，保留终端 1、终端 2 等序号标题
            if (/^终端\s\d+$/.test(x.title)) return x
            return { ...x, title }
          })
          persistSessions(sessions, storageKey)
          return { sessions }
        })
      },
    }),
    shallow,
  )
}

export type TerminalStoreHook = ReturnType<typeof createTerminalStore>

/** 导航栏「终端」视图的终端组 */
export const useTerminalStore = createTerminalStore('term', 'terminal-sessions')
/** Agent Code 工作台内嵌终端的终端组（独立会话，与导航栏终端互不干扰） */
export const useAgentTerminalStore = createTerminalStore('agentterm', 'agent-terminal-sessions')
