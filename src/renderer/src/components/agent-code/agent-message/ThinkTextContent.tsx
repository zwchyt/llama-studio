import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getThinkPreview } from '../utils/thinkText'
import { WindowedText, WINDOW_VIEW_HEIGHT } from '../WindowedText'

export const ThinkTextContent = React.memo(function ThinkTextContent({ text, streaming, mounted = true, renderMarkdown }: {
  text: string
  streaming?: boolean
  /** 折叠块展开态：完整窗口仅在展开时挂载，手动收起后释放重型内容（默认挂载） */
  mounted?: boolean
  renderMarkdown: (text: string) => React.ReactNode
}) {
  const preview = useMemo(() => getThinkPreview(text, !!streaming), [text, streaming])
  const [full, setFull] = useState(false)
  // 复制反馈：成功 2s 后复位（与 CodeBlock 同一节奏），避免文案永久停在「已复制」；
  // 失败文案不自动复位（见 copy 内的说明）
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'fail'>('idle')
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('done')
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      // 失败文案常驻不自动复位：2s 就消失的错误提示等于没提示，下次点击会重新尝试
      setCopyState('fail')
    }
  }
  // 完整窗口（重型内容）只在展开态挂载；未挂载时回退到预览，避免出现空白帧
  // （折叠块展开与挂载门之间存在一次提交的间隔，用户可能已点开「完整思考」）。
  const showWindow = !!(preview.truncated && full && mounted)
  const showPreview = !showWindow && (!!streaming || preview.truncated)
  // 短思考（未截断）的复制按钮：只在流式结束后出现 —— 流式期间内容还在长，复制半截思考没有意义，
  // 而多出来的控件行会在「思考中」这个最受注视的时刻反复占版面。
  const showCopyOnly = !preview.truncated && !streaming
  // 短思考（未截断）也提供复制入口：整组控件原来只在 truncated 时才渲染，用户无法复制短思考
  const copyLabel = copyState === 'done'
    ? (preview.truncated ? '已复制完整思考' : '已复制')
    : copyState === 'fail'
      ? '复制失败，请重试'
      : (preview.truncated ? '复制完整思考' : '复制思考')
  return (
    <div>
      {preview.truncated ? (
        <div className="agent-think-text-controls">
          <span>{full ? '纯文本窗口 · 长行分段显示' : streaming ? '仅预览末尾思考' : '仅预览开头思考'}</span>
          <button type="button" className="btn btn-ghost btn-xs" aria-expanded={full} onClick={() => setFull(v => !v)}>
            {full ? '收起完整思考' : '查看完整思考'}
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>{copyLabel}</button>
        </div>
      ) : showCopyOnly ? (
        <div className="agent-think-text-controls agent-think-text-controls--copy-only">
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>{copyLabel}</button>
        </div>
      ) : null}
      {showWindow ? (
        <WindowedText
          text={text}
          followTail={streaming}
          viewHeight={WINDOW_VIEW_HEIGHT}
          className="agent-window agent-think-window"
          rowAttr="data-think-row"
          ariaLabel="完整思考文本（窗口渲染）"
        />
      ) : showPreview ? (
        <div className="agent-think-stream" data-think-preview={streaming ? undefined : true}>{preview.text}</div>
      ) : renderMarkdown(text)}
    </div>
  )
})
