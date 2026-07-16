import React, { useEffect, useState } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { askUserQuestionRegistry } from '../utils/askUserQuestionRegistry'
import type { Question } from '../tools/AskUserQuestionTool/types'

export default function AskUserQuestionModal() {
  const [pending, setPending] = useState<Question[] | null>(null)

  useEffect(() => {
    return askUserQuestionRegistry.subscribe(() => {
      setPending(askUserQuestionRegistry.getPending()?.questions ?? null)
    })
  }, [])

  const [selected, setSelected] = useState<Map<number, string[]>>(new Map())
  const [notes, setNotes] = useState<Map<number, string>>(new Map())
  const [focusedPreview, setFocusedPreview] = useState<string | null>(null)

  useEffect(() => {
    if (pending) {
      setSelected(new Map())
      setNotes(new Map())
      setFocusedPreview(null)
    }
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
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal ask-user-question-modal" style={{ width: 520, maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <HelpCircle size={20} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span className="modal-title">需要你回答一些问题{questionCount > 1 ? `（${questionCount} 个）` : ''}</span>
          <button className="btn btn-ghost modal-close-btn" onClick={handleCancel} title="取消"><X size={16} /></button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto', maxHeight: 'calc(80vh - 100px)' }}>
          {pending.map((q, qIdx) => (
            <div key={qIdx} className="ask-question-block">
              <div className="ask-question-text">{q.question}</div>
              <div className="ask-question-options">
                {q.options.map((opt) => {
                  const sel = isSelected(qIdx, opt.label)
                  const inputType = q.multi_select ? 'checkbox' : 'radio'
                  const name = `q_${qIdx}`
                  return (
                    <label key={opt.label} className={`ask-question-option ${sel ? 'selected' : ''}`}
                      onMouseEnter={() => setFocusedPreview(opt.preview ?? null)}
                      onMouseLeave={() => setFocusedPreview(prev => prev === opt.preview ? null : prev)}
                    >
                      <input
                        type={inputType}
                        name={name}
                        checked={sel}
                        onChange={() => toggleOption(qIdx, opt.label, !!q.multi_select)}
                      />
                      <div className="ask-question-option-content">
                        <span className="ask-question-option-label">{opt.label}</span>
                        <span className="ask-question-option-desc">{opt.description}</span>
                      </div>
                    </label>
                  )
                })}
                <div className="ask-question-other">
                  <span className="ask-question-option-label">其他（自由输入）</span>
                  <textarea
                    className="ask-question-other-input"
                    rows={2}
                    placeholder="输入你的答案…"
                    value={notes.get(qIdx) ?? ''}
                    onChange={e => handleCustom(qIdx, e.target.value)}
                  />
                </div>
              </div>
              {focusedPreview && (
                <div className="ask-question-preview">
                  <pre>{focusedPreview}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={handleCancel}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}>提交答案</button>
        </div>
      </div>
    </div>
  )
}
