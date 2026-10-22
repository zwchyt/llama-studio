// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：PackedTextEditor —— 「已折叠 N 行」胶囊的编辑弹窗                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 为什么单独做一个弹窗：此前点胶囊是把折叠正文塞回输入框并清空胶囊，等于「一展开就回
// 不去了」——既丢了胶囊形态，又和输入框里已有的草稿混在一起。改成在弹窗里改：
// 输入框一个字符都不动，保存后仍是一颗胶囊（内容为空则整颗移除）。
//
// 复用 .msg-full-mask / .msg-full 那套遮罩与卡片（同 UserMessageFullText），
// 只把正文区换成 textarea + 底部按钮，键盘行为与其它弹层一致（Esc 关闭、Tab 层内循环）。

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from '@animateicons/react/lucide'
import { useModalFocus } from '../hooks/useModalFocus'
import { useBubbleTip } from '../../useBubbleTip'

export function PackedTextEditor({ text, title = '编辑折叠内容', onSave, onClose }: {
  text: string
  /** 弹窗标题：折叠胶囊与引用块共用这个编辑器，标题按类型区分 */
  title?: string
  /** 保存：回调里拿到编辑后的全文（可能为空串，由调用方决定是否移除胶囊） */
  onSave: (next: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(text)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 焦点进入 / 层内循环 / 关闭归还（见 useModalFocus）
  const dialogRef = useModalFocus<HTMLDivElement>()
  // 键盘监听只挂一次：draft 每敲一个字都变，若放进依赖就会每次按键都摘挂一次
  // document 监听（长文本编辑里这是实打实的开销）。用 ref 镜像最新值。
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { closeRef.current(); return }
      // Ctrl/Cmd+Enter 保存：长文本编辑的通用快捷手势
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveRef.current(draftRef.current) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 光标放到末尾：改完接着写比跳到开头更符合预期（useModalFocus 会先聚焦关闭按钮，
  // 这个 effect 在它之后执行，把焦点抢到正文）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const { tipHandlers: tip, tipNode } = useBubbleTip()

  return createPortal(
    <div className="msg-full-mask packed-edit-mask" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      {tipNode}
      <div className="msg-full msg-full--edit" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="msg-full-head">
          <span className="msg-full-title">{title}</span>
          <button type="button" className="msg-full-close" onClick={onClose} aria-label="关闭（Esc）" {...tip('关闭（Esc）')}><XIcon size={16} /></button>
        </div>
        <div className="packed-edit-body">
          <textarea
            ref={taRef}
            className="packed-edit-textarea"
            value={draft}
            spellCheck={false}
            onChange={e => setDraft(e.target.value)}
          />
        </div>
        <div className="packed-edit-foot">
          <span className="packed-edit-count">{draft.split('\n').length} 行 · {draft.length} 字符</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(draft)} {...tip('保存（Ctrl+Enter）')}>保存</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
