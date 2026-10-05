// Pi SDK 事件 → WorkspaceEvent 适配器。
// 把 main 推送的原始 pi 事件翻译成结构化 WorkspaceEvent（见 workspaceEvents.ts）。
// 关键修复（R7）：思考链不再以 <think> 文本标签混进正文流；thinking 以独立事件下发，
// 渲染层据此直接构建 think 段，但仍会在 content 里重构成 <think> 以兼容 parseThinkSegments。
//
// 与 AgentCodeView 解耦：本模块只做「pi 事件 → 语义事件」翻译，不触碰任何 UI 状态。

import type { WorkspaceEventSink } from './workspaceEvents'

interface RawPiEvent {
  type: string
  [k: string]: unknown
}

/** 把 pi 工具结果对象翻译成展示文本（从 piAgentClient 迁来，单一出处） */
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

/**
 * Pi 事件 → WorkspaceEvent 适配器（有状态：跨事件维护思考段去重标记）。
 * 每条 pi 会话用独立实例（PiAgentClient 持有一个），避免多会话状态串扰。
 */
export class PiEventAdapter {
  /** 当前思考段是否已通过 thinking_delta 下发过内容（用于 thinking_end 去重） */
  private thinkingDeltaSeen = false

  /** 把一条原始 pi 事件翻译成 0~N 个 WorkspaceEvent，通过 sink 下发 */
  adapt(raw: unknown, sink: WorkspaceEventSink): void {
    const ev = raw as RawPiEvent
    switch (ev.type) {
      case 'message_update': {
        const msg = ev.assistantMessageEvent as RawPiEvent | undefined
        if (!msg) return
        if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
          sink.emit({ type: 'text_delta', delta: msg.delta })
        } else if (msg.type === 'thinking_start') {
          // 新思考段开始：重置去重标记
          this.thinkingDeltaSeen = false
          sink.emit({ type: 'thinking_start' })
        } else if (msg.type === 'thinking_delta' && typeof msg.delta === 'string') {
          this.thinkingDeltaSeen = true
          sink.emit({ type: 'thinking_delta', delta: msg.delta })
        } else if (msg.type === 'thinking_end') {
          // 仅当本段思考从未通过 delta 流下发过内容时，才在 end 补发完整思考文本，
          // 避免与已流式下发的 delta 重复（对齐旧 piAgentClient 的 !thinkTagPushed 守卫）
          if (!this.thinkingDeltaSeen && typeof msg.content === 'string' && msg.content) {
            sink.emit({ type: 'thinking_delta', delta: msg.content })
          }
          sink.emit({ type: 'thinking_end' })
        } else if (msg.type === 'toolcall_start') {
        // 工具参数开始流式生成：立即发工具卡信号（args 为空，卡片先显示「参数生成中」），
        // 不等 toolcall_end（参数可能很长，生成期间 UI 必须有反馈）
        const partial = msg.partial as { content?: Array<{ type?: string; id?: string; name?: string }> } | undefined
        const block = partial?.content?.[(msg as { contentIndex?: number }).contentIndex ?? -1]
        if (block?.name) {
          sink.emit({ type: 'tool_call_start', id: block.id || '', name: block.name })
        }
      } else if (msg.type === 'toolcall_end') {
        const tc = msg.toolCall as { id?: string; name?: string; arguments?: unknown } | undefined
        if (tc?.name) {
          sink.emit({
            type: 'tool_call_end',
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
      sink.emit({ type: 'tool_exec_start', id: String(ev.toolCallId ?? ''), name: String(ev.toolName ?? '') })
      return
    }
    case 'toolcall_args': {
      // 主进程合帧后自定义的事件形状（非 pi 原生）：参数流式生成中的最新快照
      sink.emit({ type: 'tool_call_args', id: String(ev.id ?? ''), name: String(ev.name ?? ''), args: String(ev.args ?? '') })
      return
    }
    case 'toolcall_stat': {
      // 主进程合帧后自定义的事件形状（非 pi 原生）：Write/Edit 参数生成中的改动统计，只传数字
      sink.emit({ type: 'tool_call_stat', id: String(ev.id ?? ''), name: String(ev.name ?? ''), added: Number(ev.added ?? 0), removed: Number(ev.removed ?? 0) })
      return
    }
    case 'tool_execution_end': {
      const r = ev.result as { details?: { backupId?: string; tasks?: unknown[] } } | undefined
      sink.emit({
        type: 'tool_exec_end',
        id: String(ev.toolCallId ?? ''),
        name: String(ev.toolName ?? ''),
        resultText: extractPiResultText(ev.result),
        isError: ev.isError === true,
        ...(typeof r?.details?.backupId === 'string' ? { backupId: r.details.backupId } : {}),
        // 待办工具回传后端权威清单，渲染端据此校准卡片（不依赖模型参数里的 id 是否稳定）
        ...(Array.isArray(r?.details?.tasks) ? { tasks: r.details!.tasks! } : {})
      })
      return
    }
    case 'turn_start': {
      sink.emit({ type: 'turn_start', turnIndex: Number(ev.turnIndex ?? 0) })
      return
    }
    case 'turn_end': {
      const msg = ev.message as { usage?: { input?: number; output?: number } } | undefined
      const usage = msg?.usage
      sink.emit({
        type: 'turn_end',
        turnIndex: Number(ev.turnIndex ?? 0),
        promptTokens: typeof usage?.input === 'number' ? usage.input : 0,
        completionTokens: typeof usage?.output === 'number' ? usage.output : 0
      })
      return
    }
    case 'agent_end':
    case 'agent_settled': {
      // 兜底：整轮结束强制闭合思考并输出缓冲正文（无论 thinking_end 是否到达）
      sink.emit({ type: 'run_end' })
      return
    }
    case 'compaction_start': {
      // pi 原生压缩开始（手动 / 自动都会发，见 agent-session.js 的两处 _emit）。
      // 原先这里落在 default 被丢掉，所以自动压缩全程没有任何界面反馈。
      const extra = raw as Record<string, unknown>
      sink.emit({ type: 'compaction_start', reason: typeof extra.reason === 'string' ? extra.reason : '' })
      return
    }
    case 'compaction_end': {
      // pi 原生压缩完成。lsCoveredCount 是主进程换算出来的「渲染层前缀被摘要替代多少条」
      // （pi 只认条目 id，而渲染层的消息数组没有条目概念），这里原样透传。
      // reason / tokensBefore / estimatedTokensAfter 一并带下去：渲染层要把每次压缩
      // 落成一条记录（触发来源、压掉多少 token、成败），失败信息尤其要留痕 ——
      // 原先它只出现在一个瞬时弹层里，关掉就查不到。
      const r = ev.result as { summary?: unknown; tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined
      const extra = raw as Record<string, unknown>
      const summary = typeof r?.summary === 'string' ? r.summary : ''
      sink.emit({
        type: 'compaction',
        summary,
        coveredCount: Number(extra.lsCoveredCount ?? 0),
        aborted: ev.aborted === true,
        reason: typeof extra.reason === 'string' ? extra.reason : '',
        ...(typeof r?.tokensBefore === 'number' ? { tokensBefore: r.tokensBefore } : {}),
        ...(typeof r?.estimatedTokensAfter === 'number' ? { tokensAfter: r.estimatedTokensAfter } : {}),
        ...(typeof extra.errorMessage === 'string' ? { errorMessage: extra.errorMessage } : {})
      })
      return
    }
    default:
      return
  }
  }
}
