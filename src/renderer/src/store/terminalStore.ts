import { createWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import { disposeTerminal } from '../utils/terminalRegistry'
import { useStore } from './useStore'
import { notify } from './notificationStore'

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
  updateTitle: (id: string, title: string) => void
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
    const save = sessions.map(({ id, title, cwd }) => ({ id, title, cwd }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch { /* ignore */ }
}

export const useTerminalStore = createWithEqualityFn<TerminalStore>(
  (set) => ({
    sessions: loadPersistedSessions(),
    activeId: null,

    open: async (cwd?: string) => {
      let result: { success: boolean; id?: string; shell?: string; error?: string }
      try {
        result = await window.api.terminalCreate({ cwd })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        notify(`打开终端失败：${msg}`, 'error')
        return
      }
      if (!result.success) { notify(`打开终端失败：${result.error ?? '未知错误'}`, 'error'); return }
      const id = result.id
      if (!id) { notify('打开终端失败：未返回终端 ID', 'error'); return }
      set((s) => {
        const title = makeTitle(s.sessions)
        const meta: TerminalMeta = { id, title, cwd: cwd || '', exited: false }
        const sessions = [...s.sessions, meta]
        persistSessions(sessions)
        return { sessions, activeId: id }
      })
      useStore.getState().setView('terminal')
    },

    close: (id: string) => {
      window.api.terminalKill(id).catch(() => {})
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
