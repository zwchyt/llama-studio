import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildTextRows, getTextRowWindow } from './utils/textRows'
import { WINDOW_ROW_HEIGHT, WINDOW_VIEW_HEIGHT } from './utils/rowMetrics'

// 固定行高契约的唯一出处见 utils/rowMetrics.ts（数值须与 agent-code.css 末尾同名契约段一致）。
// 这里 re-export 保持既有导入路径可用。
export { WINDOW_ROW_HEIGHT, WINDOW_VIEW_HEIGHT }

/**
 * 行窗口的位置与范围计算：调用方只负责「一行怎么画」，滚动与挂载范围都由这里给出。
 *
 * 前提是行高固定、行内容不折行 —— 只有这样首行索引才能由 scrollTop 直接算出，
 * 不必逐行测量（逐行 getBoundingClientRect 在长内容上是 O(行数)，正是要避免的开销）。
 */
export function useRowWindow({ count, viewHeight, rowHeight, followTail, overscan = 4 }: {
  count: number
  viewHeight: number
  rowHeight: number
  /** 内容持续追加时贴底跟随（用户上滚即暂停，滚回底部自动恢复） */
  followTail?: boolean
  overscan?: number
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const following = useRef(!!followTail)
  const [scrollTop, setScrollTop] = useState(0)
  // 内容不足一屏时收窄到内容高度，避免留出一大块空白
  const height = Math.min(viewHeight, Math.max(rowHeight, count * rowHeight))
  const totalHeight = count * rowHeight
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const maxTop = Math.max(0, totalHeight - height)
    // 跟随中（流式追加）恒定位到底部；否则保留用户当前阅读位置并夹到合法范围
    const top = followTail && following.current ? maxTop : Math.min(el.scrollTop, maxTop)
    el.scrollTop = top
    setScrollTop(top)
  }, [count, totalHeight, height, followTail])
  const range = getTextRowWindow(count, scrollTop, height, rowHeight, overscan)
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
    setScrollTop(el.scrollTop)
  }, [])
  const onWheel = useCallback((e: React.WheelEvent) => { if (e.deltaY < 0) following.current = false }, [])
  const onTouchMove = useCallback(() => { following.current = false }, [])
  return { viewportRef, range, height, totalHeight, onScroll, onWheel, onTouchMove }
}

/**
 * 通用「行窗口」渲染器：只挂载视口附近的行片段（含 overscan），
 * 思考完整文本（ThinkTextContent）、工具结果（LinedPre）与 Diff（ToolEditDiff）共用。
 *
 * 行只挂载可视片段，但总高度用 spacer 撑住，滚动条长度与真实内容一致、不跳动。
 * 行的外层 div 由本组件统一提供（一行一节点、key 稳定），调用方通过 renderRow 决定
 * 行内内容，通过 rowClassName / rowStyle 决定行的外观。
 */
export const WindowedRows = React.memo(function WindowedRows({
  count,
  viewHeight,
  rowHeight,
  followTail,
  overscan,
  className = 'agent-window',
  ariaLabel,
  rowAttr = 'data-window-row',
  rowClassName,
  rowStyle,
  contentWidth = 'max-content',
  renderRow,
}: {
  count: number
  viewHeight: number
  rowHeight: number
  followTail?: boolean
  overscan?: number
  className?: string
  ariaLabel?: string
  rowAttr?: string
  /** 行外层类名；Diff 需要按行类型变化，故允许传函数 */
  rowClassName?: string | ((index: number) => string)
  rowStyle?: React.CSSProperties
  /** 行内容排布宽度：文本行用 max-content（超长行横向滚动）；栅格行（Diff）需 100% 才能等分列 */
  contentWidth?: string
  renderRow: (index: number) => React.ReactNode
}) {
  const { viewportRef, range, height, totalHeight, onScroll, onWheel, onTouchMove } =
    useRowWindow({ count, viewHeight, rowHeight, followTail, overscan })
  // 可见行下标数组：依赖收敛到首尾两个数字，避免每次渲染新建数组把 memo 冲掉
  const visible = useMemo(() => {
    const out: number[] = []
    for (let i = range.start; i < range.end; i += 1) out.push(i)
    return out
  }, [range.start, range.end])
  return (
    <div
      ref={viewportRef}
      className={className}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      style={{ height }}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      onScroll={onScroll}
    >
      <div style={{ height: totalHeight, position: 'relative', minWidth: '100%', width: contentWidth }}>
        <div style={{ paddingTop: range.start * rowHeight }}>
          {visible.map(i => (
            <div
              className={typeof rowClassName === 'function' ? rowClassName(i) : rowClassName}
              key={i}
              {...{ [rowAttr]: i }}
              style={{ height: rowHeight, ...rowStyle }}
            >
              {renderRow(i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})

/**
 * 纯文本长内容的行窗口：按原文偏移切片，只挂载视口附近的行。
 * rows 只记录原文偏移，不为每行复制字符串；单行文本节点长度上限 TEXT_ROW_CHARS。
 * 复制/导出使用外部完整原文，不依赖本组件挂载的 DOM。
 */
export const WindowedText = React.memo(function WindowedText({
  text,
  rowHeight = WINDOW_ROW_HEIGHT,
  viewHeight = WINDOW_VIEW_HEIGHT,
  followTail,
  lineNumbers,
  className = 'agent-window',
  ariaLabel,
  rowAttr = 'data-window-row',
}: {
  text: string
  rowHeight?: number
  /** 视口高度（px）；内容不足时自动收窄到内容高度 */
  viewHeight?: number
  /** 文本持续追加时贴底跟随（用户上滚即暂停，滚回底部自动恢复） */
  followTail?: boolean
  /** 左侧显示 1 起的展示行号（LinedPre 用） */
  lineNumbers?: boolean
  className?: string
  ariaLabel?: string
  /** 行的 data 属性名（测试与定位用，如 data-think-row / data-tool-row） */
  rowAttr?: string
}) {
  const rows = useMemo(() => buildTextRows(text), [text])
  // 行渲染回调固定引用：WindowedRows 是 memo 组件，内联箭头会让它每次都重渲染
  const renderRow = useCallback((i: number) => {
    const row = rows[i]!
    return (
      <>
        {lineNumbers && <span className="agent-window-num">{i + 1}</span>}
        {text.slice(row.start, row.end) || '\u00a0'}
      </>
    )
  }, [rows, lineNumbers, text])
  // 行样式对象也要固定引用：内联对象每次渲染都是新引用，同样会把 WindowedRows 的 memo 冲掉
  const rowStyle = useMemo(() => ({ lineHeight: `${rowHeight}px` }), [rowHeight])
  return (
    <WindowedRows
      count={rows.length}
      viewHeight={viewHeight}
      rowHeight={rowHeight}
      followTail={followTail}
      className={className}
      ariaLabel={ariaLabel}
      rowAttr={rowAttr}
      rowClassName="agent-window-row"
      rowStyle={rowStyle}
      renderRow={renderRow}
    />
  )
})
