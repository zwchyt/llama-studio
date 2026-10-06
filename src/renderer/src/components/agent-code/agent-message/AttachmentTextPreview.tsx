// 附件文本预览层：PDF / DOCX / 文本附件点开看「模型实际读到的内容」。
// 刻意不画 PDF 版面：项目里没有 PDF 渲染器，要画页面就得把原始字节随消息持久化进会话
// JSON（5MB 的 PDF ≈ 6.7MB base64），代价与收益不匹配。这里展示的是 extractText.ts
// 抽出来的那段文本，与注入给模型的内容逐字一致。

import React, { useEffect } from 'react'
import { FileTextIcon, XIcon } from '@animateicons/react/lucide'
import { useBubbleTip } from '../../useBubbleTip'

export type PreviewableAttachment = { name: string; content?: string }

export function AttachmentTextPreview({ att, onClose }: {
  att: PreviewableAttachment
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const text = (att.content ?? '').trim()
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  return (
    <div className="att-preview-mask" onClick={onClose} {...tip('点击任意处关闭')}>
      {tipNode}
      {/* 卡片自身拦下冒泡：选正文、点标题不该顺手关掉整层 */}
      <div className="att-preview" onClick={e => e.stopPropagation()}>
        <div className="att-preview-head">
          <FileTextIcon size={13} className="att-preview-icon" />
          <span className="att-preview-name" {...tip(att.name)}>{att.name}</span>
          <span className="att-preview-meta">{text ? `${text.length} 字符` : '无文本'}</span>
          <button type="button" className="att-preview-close" onClick={onClose} aria-label="关闭（Esc）" {...tip('关闭（Esc）')}><XIcon size={13} /></button>
        </div>
        <pre className="att-preview-body">
          {text || '这个附件没有可预览的文本——发送时只带了文件名，未抽取到内容。'}
        </pre>
      </div>
    </div>
  )
}
