import type { Question } from '../tools/AskUserQuestionTool/types'

interface PendingQuestions {
  questions: Question[]
  resolve: (result: string) => void
  reject: (error: string) => void
}

let pending: PendingQuestions | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach(fn => fn())
}

export const askUserQuestionRegistry = {
  getPending(): PendingQuestions | null {
    return pending
  },

  ask(questions: Question[]): Promise<string> {
    return new Promise((resolve, reject) => {
      pending = { questions, resolve, reject }
      notify()
    })
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
