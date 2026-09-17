import React, { useMemo, useState } from 'react'
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
  const [copyState, setCopyState] = useState('复制完整思考')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('已复制完整思考')
    } catch {
      setCopyState('复制失败，请重试')
    }
  }
  // 完整窗口（重型内容）只在展开态挂载；未挂载时回退到预览，避免出现空白帧
  // （折叠块展开与挂载门之间存在一次提交的间隔，用户可能已点开「完整思考」）。
  const showWindow = !!(preview.truncated && full && mounted)
  const showPreview = !showWindow && (!!streaming || preview.truncated)
  return (
    <div>
      {preview.truncated && (
        <div className="agent-think-text-controls">
          <span>{full ? '纯文本窗口 · 长行分段显示' : streaming ? '仅预览末尾思考' : '仅预览开头思考'}</span>
          <button type="button" className="btn btn-ghost btn-xs" aria-expanded={full} onClick={() => setFull(v => !v)}>
            {full ? '收起完整思考' : '查看完整思考'}
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>{copyState}</button>
        </div>
      )}
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
