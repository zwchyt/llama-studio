// 统一工作区事件协议（renderer）：Pi SDK 的事件流被适配（见 piAgentAdapter.ts）
// 成此结构化的 WorkspaceEvent，渲染层/AgentCodeView 直接消费，传输层不再搬运 <think> 文本标签。

export type WorkspaceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_end'; id: string; name: string; args: string }
  | { type: 'tool_exec_start'; id: string; name: string }
  | { type: 'tool_exec_end'; id: string; name: string; resultText: string; isError: boolean; backupId?: string }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; promptTokens: number; completionTokens: number }
  | { type: 'run_end' }
  | { type: 'error'; message: string }

export interface WorkspaceEventSink {
  emit: (e: WorkspaceEvent) => void
}
