// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：ID 生成                                                                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

export function newMsgId() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

export function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
