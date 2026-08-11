// pi-agent 事件客户端（renderer）：订阅 main 推送的 pi-agent-event，
// 翻译成 UI 可消费的回调（流式文本 / 工具卡片 / 完成信号）。
// 与 AgentCodeView 解耦：本模块只做「pi 事件 → 语义回调」翻译。

export interface PiToolCallUI {
  id: string
  name: string
  /** 参数 JSON 字符串（toolcall_end 时完整给出） */
  args: string
}

export interface PiAgentCallbacks {
  /** 模型生成的文本增量（含 <think> 原始标记，由渲染层解析） */
  onTextDelta: (delta: string) => void
  /** 模型完成一次工具调用声明（参数已完整） */
  onToolCall: (tc: PiToolCallUI) => void
  /** 工具开始执行 */
  onToolExecutionStart: (id: string, name: string) => void
  /** 工具执行结束（result 为 pi 的工具结果，翻译成文本；backupId 供撤销按钮用） */
  onToolExecutionEnd: (id: string, name: string, resultText: string, isError: boolean, backupId?: string) => void
  /** 一轮 agent 运行结束（agent_end / agent_settled） */
  onEnd: () => void
}

/** 把 pi 工具结果对象翻译成展示文本 */
export function extractPiResultText(result: unknown): string {
  if (result == null) return '(无输出)'
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(extractPiResultText).join('\n')
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    // AgentToolResult: { content: [{type:'text',text}], details }
    if (Array.isArray(r.content)) {
      const parts: string[] = []
      for (const c of r.content as Array<Record<string, unknown>>) {
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      }
      if (parts.length > 0) return parts.join('\n')
    }
    if (typeof r.text === 'string') return r.text
    try {
      return JSON.stringify(r, null, 2)
    } catch {
      return String(result)
    }
  }
  return String(result)
}

interface RawPiEvent {
  type: string
  [k: string]: unknown
}

export class PiAgentClient {
  private readonly callbacks: PiAgentCallbacks
  private sessionId: string | null = null
  /**
   * 推理通道处理。pi 的事件顺序可能是 text_delta（正文）先于 thinking_end 到达，
   * 若把正文直接拼在思考增量后面，正文会被拼进 <think> 里被 parseThinkSegments 吞掉。
   * 策略：
   *  - thinking_delta 实时直推（思考链流式显示，不等 thinking_end）
   *  - thinking 未闭合期间到达的正文（text_delta）进 deferredText 缓冲，
   *    等思考闭合（thinking_end / 整轮兜底）后再按序输出 → 正文不会被吞
   */
  private thinkingOpen = false
  private thinkTagPushed = false
  private deferredText: string[] = []

  /** 思考闭合：补闭合标签（若已推过开头）并输出缓冲的正文 */
  private closeThinking(): void {
    if (this.thinkTagPushed) this.callbacks.onTextDelta('</think>')
    this.thinkTagPushed = false
    this.thinkingOpen = false
    const deferred = this.deferredText
    this.deferredText = []
    for (const d of deferred) this.callbacks.onTextDelta(d)
  }

  private readonly handler = (_sid: string, event: unknown): void => {
    if (this.sessionId === null || _sid !== this.sessionId) return
    this.translate(event as RawPiEvent)
  }

  constructor(callbacks: PiAgentCallbacks) {
    this.callbacks = callbacks
  }

  /** 订阅事件流（仅处理指定 sessionId 的事件） */
  attach(sessionId: string): void {
    this.sessionId = sessionId
    window.api.piAgent.onEvent(this.handler)
  }

  detach(): void {
    this.sessionId = null
  }

  private translate(ev: RawPiEvent): void {
    switch (ev.type) {
      case 'message_update': {
        const msg = ev.assistantMessageEvent as RawPiEvent | undefined
        if (!msg) return
        if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
          // 正文出现 = 该轮思考已结束：立即闭合思考段（补 </think>），正文实时输出，
          // 不必等 thinking_end（pi 的顺序是 text_delta 先于 thinking_end）。
          // 空串 text_delta（pi 的段落占位）不闭合思考，避免"思考到一半被截断"。
          if (this.thinkingOpen && msg.delta.trim().length > 0) this.closeThinking()
          this.callbacks.onTextDelta(msg.delta)
        } else if (msg.type === 'thinking_start') {
          this.thinkingOpen = true
          this.thinkTagPushed = false
          this.deferredText = []
        } else if (msg.type === 'thinking_delta' && typeof msg.delta === 'string') {
          // 思考增量实时直推：首个增量先开 <think> 标签（避免空思考产生空标签）。
          // 若思考段已被正文闭合（thinkingOpen=false）而思考仍在继续（模型思考
          // 中途输出过正文片段），重新打开思考段——思考内容不混入正文、不错乱。
          if (!this.thinkTagPushed) {
            this.thinkTagPushed = true
            this.thinkingOpen = true
            this.callbacks.onTextDelta('\n<think>')
          }
          this.callbacks.onTextDelta(msg.delta)
        } else if (msg.type === 'thinking_end') {
          // 部分实现只在 end 携带完整内容（无 delta 流）：若思考段仍开启则补发完整思考文本；
          // 已被正文闭合（thinkingOpen=false）时忽略，避免在正文之后插入思考造成错序
          if (this.thinkingOpen && !this.thinkTagPushed && typeof msg.content === 'string' && msg.content) {
            this.thinkTagPushed = true
            this.callbacks.onTextDelta(`\n<think>${msg.content}`)
          }
          this.closeThinking()
        } else if (msg.type === 'toolcall_start') {
          // 工具参数开始流式生成：立即发出工具卡信号（args 为空，卡片先显示「参数生成中」），
          // 不等 toolcall_end（参数可能很长，如 Write 大文件内容，生成期间 UI 必须有反馈，
          // 参考项目同款：partial dispatch 即显示「接收参数」卡）
          const partial = msg.partial as { content?: Array<{ type?: string; id?: string; name?: string }> } | undefined
          const block = partial?.content?.[(msg as { contentIndex?: number }).contentIndex ?? -1]
          if (block?.name) {
            this.callbacks.onToolCall({ id: block.id || '', name: block.name, args: '' })
          }
        } else if (msg.type === 'toolcall_end') {
          const tc = msg.toolCall as { id?: string; name?: string; arguments?: unknown } | undefined
          if (tc?.name) {
            this.callbacks.onToolCall({
              // 注意用 || 而非 ??：pi 解析时 id 可能为空串 ""，空串必须回退，
              // 否则工具卡会以 "" 为 id，与 tool_execution_start 的真实 id 永远匹配不上
              id: tc.id || `call-${Date.now()}`,
              name: tc.name,
              args: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {})
            })
          }
        }
        return
      }
      case 'tool_execution_start': {
        this.callbacks.onToolExecutionStart(String(ev.toolCallId ?? ''), String(ev.toolName ?? ''))
        return
      }
      case 'tool_execution_end': {
        const r = ev.result as { details?: { backupId?: string } } | undefined
        this.callbacks.onToolExecutionEnd(
          String(ev.toolCallId ?? ''),
          String(ev.toolName ?? ''),
          extractPiResultText(ev.result),
          ev.isError === true,
          typeof r?.details?.backupId === 'string' ? r.details.backupId : undefined
        )
        return
      }
      case 'agent_end':
      case 'agent_settled': {
        // 兜底：整轮结束仍未收到 thinking_end 时强制闭合（防止正文被吞）
        if (this.thinkingOpen) this.closeThinking()
        this.callbacks.onEnd()
        return
      }
      default:
        return
    }
  }
}
