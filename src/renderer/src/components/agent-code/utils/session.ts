// 会话「最后活跃」时间的唯一实现：消息 id 内嵌十进制 Date.now()（msg-<ts>-…），
// 取不到再退回会话 id 的 base36 时间戳（sess-<base36>-…）。
// 侧栏排序与工作区指针 / 空白会话收敛共用这一份 —— id 格式一变两边落点必须一致。
// 返回 null = 两种格式都对不上（外部导入的会话），由调用方决定怎么兜底。
import type { AgentSession } from '../../../../../shared/types'

export function sessionLastActive(s: AgentSession): number | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = /^msg-(\d+)-/.exec(s.messages[i]!.id)
    if (m) return Number(m[1])
  }
  const sess = /^sess-([0-9a-z]+)-/.exec(s.id)
  if (sess) {
    const ms = parseInt(sess[1]!, 36)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return null
}
