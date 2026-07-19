import type { Question } from '../tools/AskUserQuestionTool/types'

interface PendingQuestions {
  questions: Question[]
  resolve: (result: string) => void
  reject: (error: string) => void
}

let pending: PendingQuestions | null = null
const listeners = new Set<() => void>()

// 跨轮次内容去重：记录本轮 agent 会话中已问过的所有问题文本。
// 当模型在后续轮次再次问同一问题时，直接拦截，避免重复弹窗。
// 每次 agent 会话开始时由调用方 reset() 清空。
const askedQuestions = new Set<string>()

function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

function notify(): void {
  listeners.forEach(fn => fn())
}

export const askUserQuestionRegistry = {
  getPending(): PendingQuestions | null {
    return pending
  },

  /** 注册一组问题并弹出询问面板。
   *  如果此前已有未处理的 pending（同一批中连续调两次 AskUserQuestion），
   *  先 reject 旧 pending 防止死锁（孤儿 Promise）。*/
  ask(questions: Question[]): Promise<string> {
    // 拒绝上一组 pending（fix 孤儿 Promise 死锁）
    if (pending) {
      pending.reject('上一个问题被新提问替换，请忽略')
    }
    // 记录已问问题（内容去重用）
    for (const q of questions) {
      askedQuestions.add(normalizeQuestion(q.question))
    }
    return new Promise((resolve, reject) => {
      pending = { questions, resolve, reject }
      notify()
    })
  },

  /** 判断某问题是否已在本次 agent 会话中被问过（跨轮次内容去重） */
  wasAsked(question: string): boolean {
    return askedQuestions.has(normalizeQuestion(question))
  },

  /** 检查 questions 数组中是否有任一问题已被问过 */
  anyAsked(questions: Question[]): boolean {
    return questions.some(q => askedQuestions.has(normalizeQuestion(q.question)))
  },

  /** 清空已问记录，每次 agent 会话开始前调用 */
  reset(): void {
    askedQuestions.clear()
  },

  resolve(result: string): void {
    const r = pending?.resolve
    pending = null
    notify()
    if (r) r(result)
  },

  cancel(): void {
    const r = pending?.resolve
    pending = null
    notify()
    if (r) r('User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.')
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }
}
