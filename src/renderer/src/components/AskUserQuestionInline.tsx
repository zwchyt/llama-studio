import React, { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { askUserQuestionRegistry } from '../utils/askUserQuestionRegistry'
import type { Question } from '../tools/AskUserQuestionTool/types'

// 内联版 AskUserQuestion：仅用于 Agent Code 工作台。
// 订阅 askUserQuestionRegistry，渲染在输入框上方的「内联提问面板」，
// 而非覆盖式弹窗。
export default function AskUserQuestionInline() {
  const [pending, setPending] = useState<Question[] | null>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const submitBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    return askUserQuestionRegistry.subscribe(() => {
      setPending(askUserQuestionRegistry.getPending()?.questions ?? null)
    })
  }, [])

  const [selected, setSelected] = useState<Map<number, string[]>>(new Map())
  const [notes, setNotes] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    if (pending) {
      setSelected(new Map())
      setNotes(new Map())
    }
  }, [pending])

  // 键盘导航：与删除/Bash 审批面板一致——左右方向键在底部按钮间移动焦点，
  // Enter 触发聚焦按钮（原生），Escape 取消。
  useEffect(() => {
    if (!pending) return
    const btns = [cancelBtnRef.current, submitBtnRef.current].filter(Boolean) as HTMLButtonElement[]
    let idx = 1 // 默认聚焦「提交答案」按钮
    const focusIdx = (i: number) => {
      idx = (i + btns.length) % btns.length
      btns[idx]?.focus()
    }
    focusIdx(idx)
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); focusIdx(idx + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusIdx(idx - 1) }
      else if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pending])

  if (!pending) return null

  const isSelected = (qIdx: number, label: string): boolean => {
    return selected.get(qIdx)?.includes(label) ?? false
  }

  const toggleOption = (qIdx: number, label: string, multi: boolean): void => {
    setSelected(prev => {
      const next = new Map(prev)
      const current = next.get(qIdx) ?? []
      if (multi) {
        const idx = current.indexOf(label)
        if (idx >= 0) next.set(qIdx, current.filter(l => l !== label))
        else next.set(qIdx, [...current, label])
      } else {
        next.set(qIdx, [label])
      }
      return next
    })
  }

  const handleCustom = (qIdx: number, value: string): void => {
    setNotes(prev => {
      const next = new Map(prev)
      if (value.trim()) next.set(qIdx, value.trim())
      else next.delete(qIdx)
      return next
    })
    if (value.trim()) {
      setSelected(prev => {
        const next = new Map(prev)
        next.set(qIdx, ['Other'])
        return next
      })
    }
  }

  const handleSubmit = (): void => {
    const answers = new Map<string, string[]>()
    const answerNotes = new Map<string, string>()
    for (let i = 0; i < pending.length; i++) {
      const q = pending[i]
      const sel = selected.get(i)
      if (sel && sel.length > 0) answers.set(q.question, sel)
      const n = notes.get(i)
      if (n) answerNotes.set(q.question, n)
    }

    const entries: string[] = []
    for (const q of pending) {
      const sel = answers.get(q.question)
      if (!sel || sel.length === 0) continue
      const labels = sel.join(', ')
      let entry = `"${q.question}"="${labels}"`
      const n = answerNotes.get(q.question)
      if (n) entry += ` user notes: ${n}`
      entries.push(entry)
    }

    const result = entries.length > 0
      ? `User has answered your questions: ${entries.join(', ')}. You can now continue with the user's answers in mind.`
      : 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.'

    askUserQuestionRegistry.resolve(result)
  }

  const handleCancel = (): void => {
    askUserQuestionRegistry.cancel()
  }

  const questionCount = pending.length

  return (
    <div className="agent-ask-question">
      <div className="agent-ask-question-head">
        <HelpCircle size={15} className="agent-ask-question-icon" />
        <span className="agent-ask-question-title">
          需要你回答一些问题{questionCount > 1 ? `（${questionCount} 个）` : ''}
        </span>
      </div>
      <div className="agent-ask-question-body">
        {pending.map((q, qIdx) => (
          <div key={qIdx} className="agent-ask-question-block">
            <div className="agent-ask-question-text">{q.question}</div>
            <div className="agent-ask-question-options">
              {q.options.map((opt) => {
                const sel = isSelected(qIdx, opt.label)
                const inputType = q.multi_select ? 'checkbox' : 'radio'
                const name = `q_${qIdx}`
                return (
                  <label
                    key={opt.label}
                    className={`agent-ask-question-option ${sel ? 'selected' : ''}`}
                  >
                    <input
                      type={inputType}
                      name={name}
                      checked={sel}
                      onChange={() => toggleOption(qIdx, opt.label, !!q.multi_select)}
                    />
                    <div className="agent-ask-question-option-content">
                      <span className="agent-ask-question-option-label">{opt.label}</span>
                      <span className="agent-ask-question-option-desc">{opt.description}</span>
                    </div>
                  </label>
                )
              })}
              <div className="agent-ask-question-other">
                <span className="agent-ask-question-option-label">其他（自由输入）</span>
                <textarea
                  className="agent-ask-question-other-input"
                  rows={2}
                  placeholder="输入你的答案…"
                  value={notes.get(qIdx) ?? ''}
                  onChange={e => handleCustom(qIdx, e.target.value)}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="agent-ask-question-footer">
        <button ref={cancelBtnRef} className="agent-prompt-btn agent-prompt-btn-ghost" onClick={handleCancel}>取消</button>
        <button ref={submitBtnRef} className="agent-prompt-btn agent-prompt-btn-primary" onClick={handleSubmit}>提交答案</button>
      </div>
    </div>
  )
}
