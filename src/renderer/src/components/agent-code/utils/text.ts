// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文本处理（思考链剥离、消息预览标题/描述生成）                            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

// 发送给模型的历史消息中剥离思考链（闭合的 <think>…</think> 与未闭合的尾部）：
// 推理模型的历史轮思考链回传既白耗本地小上下文预算，也不符合 chat 模板惯例。
// 仅影响 api 消息，UI 展示的 displayMsgs 仍保留原文。
export function stripThinkForApi(s: string): string {
  if (!s || !s.includes('<think>')) return s
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim()
}

// 展示用：剥离思考链与【…】标注，并压平空白
export function stripThinkContent(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/【\d+.*?】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const PREVIEW_TITLE_LENGTH = 56
export const PREVIEW_DESCRIPTION_LENGTH = 88

export function truncateMessageText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const excerpt = text.slice(0, limit)
  const boundary = excerpt.lastIndexOf(' ')
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trimEnd()}…`
}

// 侧栏 rail 条目的标题 / 描述：标题取本条消息，描述优先取下一条助手回复，
// 否则回落到本条消息的剩余文本。
export function getMessagePreview(
  message: { role: string; content?: string },
  messages: { role: string; content?: string }[],
  index: number,
): { label: string; description: string | undefined } {
  const rawText = (message.content ?? '').replace(/\s+/g, ' ').trim()
  const text = message.role === 'assistant' ? stripThinkContent(rawText) : rawText
  if (!text) {
    return { label: message.role === 'user' ? 'User' : 'Assistant', description: undefined }
  }

  if (text.length <= PREVIEW_TITLE_LENGTH) {
    const next = messages[index + 1]
    const responseText = next?.role === 'assistant' ? stripThinkContent((next.content ?? '').replace(/\s+/g, ' ').trim()) : ''
    return {
      label: text,
      description: responseText ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH) : undefined,
    }
  }

  const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH)
  const titleBoundary = titleExcerpt.lastIndexOf(' ')
  const titleEnd = titleBoundary > PREVIEW_TITLE_LENGTH * 0.65 ? titleBoundary : PREVIEW_TITLE_LENGTH
  const label = `${text.slice(0, titleEnd).trimEnd()}…`
  const next = messages[index + 1]
  const responseText = next?.role === 'assistant' ? stripThinkContent((next.content ?? '').replace(/\s+/g, ' ').trim()) : ''
  const description = responseText
    ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
    : truncateMessageText(text.slice(titleEnd).trimStart(), PREVIEW_DESCRIPTION_LENGTH)
  return { label, description }
}
