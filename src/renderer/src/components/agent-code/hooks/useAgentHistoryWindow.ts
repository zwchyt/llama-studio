import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const HISTORY_PAGE_SIZE = 100

/** 渐进挂载，不裁剪会话数据；追加消息时保留当前已加载的起点。 */
export function useAgentHistoryWindow(
  sessionId: string | undefined,
  messages: readonly { id: string }[],
  viewportRef: RefObject<HTMLDivElement | null>,
  pauseFollow: () => void,
) {
  const initialId = messages[Math.max(0, messages.length - HISTORY_PAGE_SIZE)]?.id
  const [window, setWindow] = useState({ sessionId, firstId: initialId })
  // 切换会话时在本次 render 立即复位，不先挂载上一会话的历史范围。
  if (window.sessionId !== sessionId) setWindow({ sessionId, firstId: initialId })
  const firstId = window.sessionId === sessionId ? window.firstId : initialId
  const found = firstId ? messages.findIndex(msg => msg.id === firstId) : 0
  const startIndex = Math.max(0, found)
  const pending = useRef<{
    sessionId: string | undefined
    anchor: HTMLElement | null
    top: number
    scrollTop: number
    scrollHeight: number
  } | null>(null)

  const loadEarlier = () => {
    const viewport = viewportRef.current
    if (!viewport || startIndex === 0 || pending.current) return
    pauseFollow()
    const anchor = viewport.querySelector<HTMLElement>('[data-slot="message"]')
    pending.current = {
      sessionId, anchor, top: anchor?.getBoundingClientRect().top ?? 0,
      scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
    }
    setWindow({ sessionId, firstId: messages[Math.max(0, startIndex - HISTORY_PAGE_SIZE)]?.id })
  }

  useLayoutEffect(() => {
    const saved = pending.current
    pending.current = null
    const viewport = viewportRef.current
    if (!saved || saved.sessionId !== sessionId || !viewport) return
    // 使用旧节点的实际位置修正，浏览器已完成的 scroll anchoring 不会被重复补偿。
    if (saved.anchor?.isConnected) {
      viewport.scrollTop += saved.anchor.getBoundingClientRect().top - saved.top
    } else {
      viewport.scrollTop = saved.scrollTop + viewport.scrollHeight - saved.scrollHeight
    }
  }, [sessionId, startIndex, viewportRef])

  return { historyStartIndex: startIndex, loadEarlierMessages: loadEarlier }
}
