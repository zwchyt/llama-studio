import { create } from 'zustand'
import type { ChatSession, ChatMessage, ChatParams, Attachment } from '../../../shared/types'
import { notify } from './notificationStore'

// 默认采样参数
export const DEFAULT_PARAMS: ChatParams = {
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  max_tokens: -1,
  repeat_penalty: 1.1,
  stream: true
}

function newId(): string {
  return crypto.randomUUID()
}

// 流式过程中的节流落盘：每个会话每 3 秒最多写一次，防止崩溃丢失已生成内容
const STREAM_PERSIST_INTERVAL = 3000
const streamPersistTimers = new Map<string, ReturnType<typeof setTimeout>>()

// 把会话里的消息组装成 OpenAI 格式（含 system prompt）
export function buildOpenAiMessages(session: ChatSession): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = []
  if (session.systemPrompt && session.systemPrompt.trim()) {
    out.push({ role: 'system', content: session.systemPrompt.trim() })
  }
  for (const m of session.messages) {
    if (m.role === 'system') continue // system 用 systemPrompt 统一管理
    if (!m.content && !m.error) continue
    out.push({ role: m.role, content: m.content })
  }
  return out
}

interface ChatStore {
  sessions: ChatSession[]
  activeSessionId: string | null
  streamingMap: Record<string, string>  // sessionId → streamId，支持多会话并发流式生成
  loaded: boolean
  errorStreamId: string | null    // 最近一次出错的流（用于 UI 提示）

  // 生命周期
  loadSessions: () => Promise<void>

  // 会话管理
  createSession: (templateId: string, port: number, templateName?: string) => string
  createEmptySession: () => string
  selectSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  deleteSession: (id: string) => Promise<void>
  setSystemPrompt: (id: string, prompt: string) => void
  setParams: (id: string, params: Partial<ChatParams>) => void
  setSessionModel: (id: string, templateId: string, port: number) => void

  // 消息
  appendMessage: (sessionId: string, msg: ChatMessage) => void
  appendUserMessage: (sessionId: string, content: string, attachments?: Attachment[]) => string
  // 流式：向最后一条 assistant 消息追加内容
  appendDeltaToLast: (sessionId: string, delta: string) => void
  // 标记最后一条 assistant 消息出错
  markLastMessageError: (sessionId: string, error: string) => void
  // 标记最后一条 assistant 消息被用户手动停止
  markLastMessageStopped: (sessionId: string) => void
  // 流式结束后回填 token 统计
  finalizeLastMessage: (sessionId: string, stats: { tokensDecoded?: number; msFirstToken?: number; decodeTokS?: number }) => void
  // 删除从某条消息开始到末尾的所有消息（用于重试/编辑）
  truncateAfter: (sessionId: string, messageId: string) => void
  // 替换会话的所有消息（用于回滚）
  replaceMessages: (sessionId: string, messages: ChatMessage[]) => void

  // 流状态
  setStreamForSession: (sessionId: string, streamId: string) => void
  clearStreamForSession: (sessionId: string) => void
  setErrorStreamId: (id: string | null) => void

  // 持久化
  persist: (id: string) => Promise<void>
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streamingMap: {},
  loaded: false,
  errorStreamId: null,

  loadSessions: async () => {
    try {
      const list = await window.api.listChatSessions()
      // 按更新时间倒序
      const sorted = (list || []).sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      set({ sessions: sorted, loaded: true })
    } catch (e) {
      console.error('[loadChatSessions]', e)
      set({ loaded: true })
    }
  },

  createSession: (templateId, port, _templateName) => {
    const id = newId()
    const now = new Date().toISOString()
    const session: ChatSession = {
      id,
      title: '新对话',
      templateId,
      port,
      systemPrompt: '',
      params: { ...DEFAULT_PARAMS },
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: id }))
    get().persist(id)
    return id
  },

  createEmptySession: () => {
    const id = newId()
    const now = new Date().toISOString()
    const session: ChatSession = {
      id,
      title: '新对话',
      templateId: '',
      port: 0,
      systemPrompt: '',
      params: { ...DEFAULT_PARAMS },
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: id }))
    get().persist(id)
    return id
  },

  selectSession: (id) => set({ activeSessionId: id }),

  renameSession: (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, title: title || '未命名对话', updatedAt: new Date().toISOString() } : x
      )
    }))
    get().persist(id)
  },

  deleteSession: async (id) => {
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId
    }))
    try { await window.api.deleteChatSession(id) } catch (e) { console.error('[deleteChatSession]', e) }
  },

  setSystemPrompt: (id, prompt) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, systemPrompt: prompt, updatedAt: new Date().toISOString() } : x
      )
    }))
    get().persist(id)
  },

  setParams: (id, params) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, params: { ...x.params, ...params }, updatedAt: new Date().toISOString() } : x
      )
    }))
    get().persist(id)
  },

  setSessionModel: (id, templateId, port) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, templateId, port, updatedAt: new Date().toISOString() } : x
      )
    }))
    get().persist(id)
  },

  appendMessage: (sessionId, msg) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId
          ? { ...x, messages: [...x.messages, msg], updatedAt: new Date().toISOString() }
          : x
      )
    }))
    get().persist(sessionId)
  },

  appendUserMessage: (sessionId, content, attachments) => {
    const id = newId()
    const msg: ChatMessage = {
      id,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    }
    const isFirst = !get().sessions.find((x) => x.id === sessionId)?.messages.some((m) => m.role === 'user')
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        // 首条用户消息自动设为会话标题
        const title = isFirst ? content.slice(0, 30) + (content.length > 30 ? '…' : '') : x.title
        return { ...x, messages: [...x.messages, msg], title, updatedAt: new Date().toISOString() }
      })
    }))
    get().persist(sessionId)
    return id
  },

  appendDeltaToLast: (sessionId, delta) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        const msgs = [...x.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: last.content + delta }
        }
        return { ...x, messages: msgs }
      })
    }))
    // 节流落盘：每 3 秒最多 persist 一次，防止崩溃/断电丢失已生成内容
    if (!streamPersistTimers.has(sessionId)) {
      streamPersistTimers.set(sessionId, setTimeout(() => {
        streamPersistTimers.delete(sessionId)
        get().persist(sessionId)
      }, STREAM_PERSIST_INTERVAL))
    }
  },

  markLastMessageError: (sessionId, error) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        const msgs = [...x.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && !last.stopped) {
          const prefix = last.content ? last.content + '\n\n' : ''
          msgs[msgs.length - 1] = {
            ...last,
            content: prefix + `⚠️ ${error}`,
            error: true
          }
        }
        return { ...x, messages: msgs, updatedAt: new Date().toISOString() }
      })
    }))
    get().persist(sessionId)
  },

  markLastMessageStopped: (sessionId) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        const msgs = [...x.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, stopped: true }
        }
        return { ...x, messages: msgs, updatedAt: new Date().toISOString() }
      })
    }))
  },

  finalizeLastMessage: (sessionId, stats) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        const msgs = [...x.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = {
            ...last,
            tokensDecoded: stats.tokensDecoded,
            msFirstToken: stats.msFirstToken,
            decodeTokS: stats.decodeTokS
          }
        }
        return { ...x, messages: msgs, updatedAt: new Date().toISOString() }
      })
    }))
  },

  truncateAfter: (sessionId, messageId) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x
        const idx = x.messages.findIndex((m) => m.id === messageId)
        if (idx < 0) return x
        return { ...x, messages: x.messages.slice(0, idx) }
      })
    }))
    get().persist(sessionId)
  },

  replaceMessages: (sessionId, messages) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, messages, updatedAt: new Date().toISOString() } : x
      )
    }))
    get().persist(sessionId)
  },

  setStreamForSession: (sessionId, streamId) => set((s) => ({
    streamingMap: { ...s.streamingMap, [sessionId]: streamId }
  })),

  clearStreamForSession: (sessionId) => {
    // 流结束：取消待执行的节流落盘定时器（最终 persist 由调用方负责）
    const timer = streamPersistTimers.get(sessionId)
    if (timer) { clearTimeout(timer); streamPersistTimers.delete(sessionId) }
    set((s) => {
      const { [sessionId]: _, ...rest } = s.streamingMap
      return { streamingMap: rest }
    })
  },

  setErrorStreamId: (id) => set({ errorStreamId: id }),

  persist: async (id) => {
    const session = get().sessions.find((x) => x.id === id)
    if (!session) return
    try {
      await window.api.saveChatSession(session)
    } catch (e) {
      console.error('[persistChatSession]', e)
      notify('保存会话失败', 'error')
    }
  }
}))
