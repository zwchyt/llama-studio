// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：ID 生成                                                                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

export function newMsgId() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

export function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 会话 id = 文件名：用可读的创建时间开头（sess-YYYYMMDD-HHMMSS-xxxx），末尾随机串防撞。
    这样在 Agent session/chat、code 目录里按文件名就能看出会话创建日期。 */
export function newSessionId(now: number = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `sess-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}
