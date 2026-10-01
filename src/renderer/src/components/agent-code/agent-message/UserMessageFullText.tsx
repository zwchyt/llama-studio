// 用户长消息的全文弹窗：气泡里被高度封顶截断的那条，点击后在会话界面正中看完整原文。
// 必须 createPortal 挂到 body：消息行祖先带 transform/动画，会把 position:fixed 的
// 包含块从视口改成那一层，遮罩就只盖住会话区、点外面也关不掉（同 CustomSelect 的理由）。
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from '@animateicons/react/lucide'

export function UserMessageFullText({ text, onClose }: {
  text: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="msg-full-mask"
      onClick={onClose}
      // 右键同样关：卡片没拦 contextmenu 冒泡，所以整层（含正文）右键都收，顺带压掉 Electron 那圈默认菜单
      onContextMenu={(e) => { e.preventDefault(); onClose() }}
    >
      {/* 左键在卡片内不关：选正文、点标题不该顺手关掉整层 */}
      <div className="msg-full" onClick={e => e.stopPropagation()}>
        <div className="msg-full-head">
          <span className="msg-full-title">完整消息</span>
          <button type="button" className="msg-full-close" onClick={onClose} title="关闭（Esc）"><XIcon size={16} /></button>
        </div>
        <pre className="msg-full-body">{text}</pre>
      </div>
    </div>,
    document.body
  )
}
