import { createWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import { disposeTerminal } from '../utils/terminalRegistry'
import { useStore } from './useStore'

export interface TerminalMeta {
  id: string
  title: string
  cwd: string
  exited?: boolean
}

interface TerminalStore {
  sessions: TerminalMeta[]
  activeId: string | null
  open: (cwd?: string) => Promise<void>
  close: (id: string) => void
  setActive: (id: string) => void
  markExited: (id: string) => void
}

const STORAGE_KEY = 'terminal-sessions'

function loadPersistedSessions(): TerminalMeta[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: TerminalMeta[] = JSON.parse(raw)
    return parsed.map(s => ({ ...s, exited: true }))
  } catch {
    return []
  }
}

function persistSessions(sessions: TerminalMeta[]): void {
  try {
    const save = sessions.map(({ id, title, cwd }) => ({ id, title, cwd }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch { /* ignore */ }
}

export const useTerminalStore = createWithEqualityFn<TerminalStore>(
  (set, get) => ({
    sessions: loadPersistedSessions(),
    activeId: null,

    open: async (cwd?: string) => {
      const result = await window.api.terminalCreate({ cwd })
      if (!result.success) return
      const id = result.id
      const meta: TerminalMeta = { id, title: '终端', cwd: cwd || '', exited: false }
      set((s) => {
        const sessions = [...s.sessions, meta]
        persistSessions(sessions)
        return { sessions, activeId: id }
      })
      useStore.getState().setView('terminal')
    },

    close: (id: string) => {
      window.api.terminalKill(id)
      disposeTerminal(id)
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id)
        const activeId = s.activeId === id
          ? (sessions.length > 0 ? sessions[sessions.length - 1].id : null)
          : s.activeId
        persistSessions(sessions)
        return { sessions, activeId }
      })
    },

    setActive: (id: string) => set({ activeId: id }),

    markExited: (id: string) => {
      set((s) => {
        const sessions = s.sessions.map((x) => x.id === id ? { ...x, exited: true } : x)
        persistSessions(sessions)
        return { sessions }
      })
    },
  }),
  shallow,
)
