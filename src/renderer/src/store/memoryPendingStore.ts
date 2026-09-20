// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 待确认记忆队列（memoryPendingStore）—— 长期记忆「写入前确认」模式的缓冲          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 为什么是队列而不是弹窗：六个沉淀触发点里有四个发生在「不该被打断」的时刻 ——
//   · noteUserCorrection 在 handleSend 里、发消息**之前**，弹窗会卡住用户的发送；
//   · noteCondenseFacts 在后台压缩进行中，模型正在输出；
//   · noteSessionEnd 在切换会话/项目的瞬间，用户正在导航离开；
//   · noteMilestone 在计划收束时，时刻不可预期。
// 阻塞式模态会把这些流程全都变成「等用户回答」。队列则把「什么时候决定」还给用户。
//
// 持久化到 localStorage：关掉应用不该静默丢掉还没裁决的候选。
import { create } from 'zustand'
import type { AgentMemoryCandidate } from '../../../shared/types'

/** 一条待裁决的记忆候选（附所属工作区，采纳时要按 dir 写入） */
export interface PendingMemory {
  id: string
  /** 所属工作区目录（memoryStore 按工作区分库） */
  dir: string
  candidate: AgentMemoryCandidate
  createdAt: number
}

/** 队列上限：用户长期不处理时不至于无限增长，超出丢弃最旧的 */
const MAX_PENDING = 50
const STORAGE_KEY = 'agentMemoryPending'

function load(): PendingMemory[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is PendingMemory => {
      const p = x as Partial<PendingMemory> | null
      return !!p && typeof p.id === 'string' && typeof p.dir === 'string' && !!p.candidate
    })
  } catch {
    return []
  }
}

function save(items: PendingMemory[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)) } catch { /* 存储不可用时仅本次运行生效 */ }
}

/** 去重键：同一工作区、同类别、同正文视为同一条候选 */
function dedupKey(dir: string, c: AgentMemoryCandidate): string {
  return `${dir}|${c.category}|${c.content}`
}

interface MemoryPendingState {
  items: PendingMemory[]
  /** 入队（自动去重）。返回实际新增条数，0 表示全是重复项 */
  enqueue: (dir: string, candidates: AgentMemoryCandidate[]) => number
  remove: (id: string) => void
  /** 清空某工作区的待确认项（卡片头部「清空」时一并调用） */
  clearForDir: (dir: string) => void
}

export const useMemoryPendingStore = create<MemoryPendingState>((set, get) => ({
  items: load(),
  enqueue: (dir, candidates) => {
    const cur = get().items
    const seen = new Set(cur.map(i => dedupKey(i.dir, i.candidate)))
    const added: PendingMemory[] = []
    for (const c of candidates) {
      const key = dedupKey(dir, c)
      if (seen.has(key)) continue
      seen.add(key)
      added.push({ id: crypto.randomUUID(), dir, candidate: c, createdAt: Date.now() })
    }
    if (added.length === 0) return 0
    const next = [...cur, ...added].slice(-MAX_PENDING)
    set({ items: next })
    save(next)
    return added.length
  },
  remove: (id) => {
    const next = get().items.filter(i => i.id !== id)
    set({ items: next })
    save(next)
  },
  clearForDir: (dir) => {
    const next = get().items.filter(i => i.dir !== dir)
    if (next.length === get().items.length) return
    set({ items: next })
    save(next)
  },
}))
