// 统一工作区事件协议（renderer）：Pi SDK 的事件流被适配（见 piAgentAdapter.ts）
// 成此结构化的 WorkspaceEvent，渲染层/AgentCodeView 直接消费，传输层不再搬运 <think> 文本标签。

export type WorkspaceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call_start'; id: string; name: string }
  /** 参数流式生成中的最新快照（pi 已尽力解析半截 JSON；只保证「够用」，完整参数仍以 tool_call_end 为准） */
  | { type: 'tool_call_args'; id: string; name: string; args: string }
  // Write/Edit 参数生成期间的改动统计（主进程只数换行回传，精确值由渲染层在参数完整后覆盖）
  | { type: 'tool_call_stat'; id: string; name: string; added: number; removed: number }
  | { type: 'tool_call_end'; id: string; name: string; args: string }
  | { type: 'tool_exec_start'; id: string; name: string }
  | { type: 'tool_exec_end'; id: string; name: string; resultText: string; isError: boolean; backupId?: string; tasks?: unknown[] }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; promptTokens: number; completionTokens: number }
  | { type: 'run_end' }
  /** pi 原生压缩开始（compaction_start）。手动与自动（threshold / overflow）都会发，
      原先适配层只转发了 end，start 落在 default 被丢掉 —— 自动压缩因此全程静默。
      reason：'manual' | 'threshold' | 'overflow'。 */
  | { type: 'compaction_start'; reason: string }
  /** pi 原生压缩完成（compaction_end）。summary 是 pi 生成的结构化摘要；
      coveredCount 由主进程把 pi 的 firstKeptEntryId 换算成渲染层消息数组的下标
      （渲染层没有 pi 条目概念）；aborted/errorMessage 表示这次压缩没成功。 */
  | {
    type: 'compaction'
    summary: string
    coveredCount: number
    aborted: boolean
    /** 触发来源：manual / threshold / overflow（压缩记录日志要留档） */
    reason: string
    /** 压缩前后的上下文 token（失败时缺省） */
    tokensBefore?: number
    tokensAfter?: number
    errorMessage?: string
  }
  | { type: 'error'; message: string }

export interface WorkspaceEventSink {
  emit: (e: WorkspaceEvent) => void
}
