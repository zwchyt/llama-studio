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

/** 从 shell 路径提取可读名称，如 C:\Windows\System32\cmd.exe → cmd */
function shellLabel(shell?: string): string {
  if (!shell) return '终端'
  const base = shell.replace(/[\\/]/g, '/').split('/').pop() || shell
  return base.replace(/\.exe$/i, '')
}

/** 根据当前会话列表生成带序号的标题 */
function makeTitle(shell: string | undefined, sessions: TerminalMeta[]): string {
  const label = shellLabel(shell)
  // 统计已有同名标题数量（含序号前缀），决定是否追加序号
  const samePrefix = sessions.filter(s =>
    s.title === label || /^.+\s\d+$/.test(s.title) && s.title.startsWith(label + ' ')
  ).length
  return samePrefix > 0 ? `${label} ${samePrefix + 1}` : label
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
      let result: { success: boolean; id?: string; shell?: string }
      try {
        result = await window.api.terminalCreate({ cwd })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        notify(`打开终端失败：${msg}`, 'error')
        return
      }
      if (!result.success) { notify('打开终端失败', 'error'); return }
      const id = result.id
      if (!id) { notify('打开终端失败：未返回终端 ID', 'error'); return }
      const shell = result.shell
      set((s) => {
        const title = makeTitle(shell, s.sessions)
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
        const sessions = s.sessions.map((x) => x.id === id && !x.exited ? { ...x, title } : x)
        persistSessions(sessions)
        return { sessions }
      })
    },
  }),
  shallow,
)
