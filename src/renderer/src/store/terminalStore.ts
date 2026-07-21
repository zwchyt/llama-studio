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
  open: (cwd?: string) => Promise<void>
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
    const save = sessions
      .filter(s => !s.pending)
      .map(({ id, ownerKey, title, cwd, fallback }) => ({ id, ownerKey, title, cwd, fallback }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch { /* ignore */ }
}

export const useTerminalStore = createWithEqualityFn<TerminalStore>(
  (set, get) => ({
    sessions: loadPersistedSessions(),
    activeId: null,

    open: async (cwd?: string) => {
      const ownerKey = `terminal:${crypto.randomUUID()}`
      const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const fallback = !window.api.terminalCreate
      set((s) => {
        const title = makeTitle(s.sessions)
        const meta: TerminalMeta = { id, ownerKey, title, cwd: cwd || '', pending: !fallback, fallback }
        const sessions = [...s.sessions, meta]
        persistSessions(sessions)
        return { sessions, activeId: id }
      })
      useStore.getState().setView('terminal')
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
        persistSessions(next)
        return { sessions: next, activeId: nextActiveId }
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

    setPtyReady: (id: string) => {
      set((s) => {
        const sessions = s.sessions.map((x) => x.id === id ? { ...x, pending: false } : x)
        persistSessions(sessions)
        return { sessions }
      })
    },

    setFallback: (id: string) => {
      set((s) => {
        const sessions = s.sessions.map((x) => x.id === id ? { ...x, pending: false, fallback: true } : x)
        persistSessions(sessions)
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
        persistSessions(sessions)
        return { sessions }
      })
    },
  }),
  shallow,
)
