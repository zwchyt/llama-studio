// pi-agent 事件客户端（renderer）：订阅 main 推送的 pi-agent-event，
// 经 piAgentAdapter 翻译成结构化 WorkspaceEvent，再派发到 UI 可消费的回调
// （流式文本 / 工具卡片 / 完成信号）。与 AgentCodeView 解耦：本模块只做「pi 事件 → 语义回调」。

import { PiEventAdapter, extractPiResultText } from '../agent/piAgentAdapter'
import type { WorkspaceEvent, WorkspaceEventSink } from '../agent/workspaceEvents'

export { extractPiResultText }
export type { WorkspaceEvent, WorkspaceEventSink }

export interface PiToolCallUI {
  id: string
  name: string
  /** 参数 JSON 字符串（toolcall_end 时完整给出；toolcall_start 时为空） */
  args: string
}

export interface PiAgentCallbacks {
  /** 模型生成的文本增量（纯正文，不含 <think> 标签——思考由独立回调下发） */
  onTextDelta: (delta: string) => void
  /** 模型开始推理（thinking_start）；openThinking 由首个 thinking_delta 触发以对齐原行为 */
  onThinkingStart?: () => void
  /** 模型推理链增量（思考内容，单独通道，不混入正文） */
  onThinkingDelta?: (delta: string) => void
  /** 模型推理链结束 */
  onThinkingEnd?: () => void
  /** 模型完成一次工具调用声明（参数已完整） */
  onToolCall: (tc: PiToolCallUI) => void
  /** 工具开始执行 */
  onToolExecutionStart: (id: string, name: string) => void
  /** 工具执行结束（resultText 为 pi 的工具结果，翻译成文本；backupId 供撤销按钮用） */
  onToolExecutionEnd: (id: string, name: string, resultText: string, isError: boolean, backupId?: string) => void
  /** 一轮 LLM turn 结束（usage：input/output tokens；durationMs 从 turn_start 计时） */
  onTurnEnd?: (info: { turnIndex: number; promptTokens: number; completionTokens: number; durationMs: number }) => void
  /** 一轮 agent 运行结束（agent_end / agent_settled） */
  onEnd?: () => void
}

/**
 * 把 WorkspaceEvent 映射回 PiAgentCallbacks（回调式兼容层）。
 * turn_start/turn_end 的 durationMs 在此维护 turnStartAt 计算后下发。
 */
class ClientSink implements WorkspaceEventSink {
  constructor(
    private readonly cb: PiAgentCallbacks,
    private readonly getTurnStartAt: () => number | null,
    private readonly setTurnStartAt: (v: number | null) => void
  ) {}

  emit(e: WorkspaceEvent): void {
    switch (e.type) {
      case 'text_delta':
        this.cb.onTextDelta(e.delta)
        return
      case 'thinking_start':
        this.cb.onThinkingStart?.()
        return
      case 'thinking_delta':
        this.cb.onThinkingDelta?.(e.delta)
        return
      case 'thinking_end':
        this.cb.onThinkingEnd?.()
        return
      case 'tool_call_start':
        // 与旧实现一致：toolcall_start 即发出空参工具卡（显示「参数生成中」）
        this.cb.onToolCall({ id: e.id, name: e.name, args: '' })
        return
      case 'tool_call_end':
        this.cb.onToolCall({ id: e.id, name: e.name, args: e.args })
        return
      case 'tool_exec_start':
        this.cb.onToolExecutionStart(e.id, e.name)
        return
      case 'tool_exec_end':
        this.cb.onToolExecutionEnd(e.id, e.name, e.resultText, e.isError, e.backupId)
        return
      case 'turn_start':
        this.setTurnStartAt(Date.now())
        return
      case 'turn_end': {
        const started = this.getTurnStartAt()
        this.setTurnStartAt(null)
        this.cb.onTurnEnd?.({
          turnIndex: e.turnIndex,
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          durationMs: started ? Date.now() - started : 0
        })
        return
      }
      case 'run_end':
        this.cb.onEnd?.()
        return
      case 'error':
        return
    }
  }
}

export class PiAgentClient {
  private sessionId: string | null = null
  /** 当前 turn 的开始时间（turn_start 置位，turn_end 取差后清空） */
  private turnStartAt: number | null = null
  private readonly sink: WorkspaceEventSink
  private readonly adapter = new PiEventAdapter()

  private readonly handler = (_sid: string, event: unknown): void => {
    if (this.sessionId === null || _sid !== this.sessionId) return
    this.adapter.adapt(event, this.sink)
  }

  constructor(callbacks: PiAgentCallbacks) {
    this.sink = new ClientSink(
      callbacks,
      () => this.turnStartAt,
      (v) => { this.turnStartAt = v }
    )
  }

  /** 订阅事件流（仅处理指定 sessionId 的事件） */
  attach(sessionId: string): void {
    this.sessionId = sessionId
    window.api.piAgent.onEvent(this.handler)
  }

  detach(): void {
    this.sessionId = null
  }
}
