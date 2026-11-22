// 会话「最后活跃」时间的唯一实现：消息 id 内嵌十进制 Date.now()（msg-<ts>-…），
// 取不到再退回会话 id 的创建时间。会话 id 有两代格式：
//   现行 sess-YYYYMMDD-HHMMSS-xxxx（可读本地时间）→ 用年月日时分秒拼回时间戳；
//   早期 sess-<base36>-xxxx → 按 36 进制解析。
// 侧栏排序与工作区指针 / 空白会话收敛共用这一份 —— id 格式一变两边落点必须一致。
// 返回 null = 两种格式都对不上（外部导入的会话），由调用方决定怎么兜底。
import type { AgentSession } from '../../../../../shared/types'

export function sessionLastActive(s: AgentSession): number | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = /^msg-(\d+)-/.exec(s.messages[i]!.id)
    if (m) return Number(m[1])
  }
  // 现行格式 sess-20261122-183045-a1b2：必须按本地时间拼回。
  // 不能把 8 位日期当 36 进制数 —— 那样只有真实值的十分之一，且同一天全部相同。
  const stamp = /^sess-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(s.id)
  if (stamp) {
    const ms = new Date(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]).getTime()
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  // 早期格式兜底：sess-<base36>-xxxx
  const legacy = /^sess-([0-9a-z]+)-/.exec(s.id)
  if (legacy) {
    const ms = parseInt(legacy[1]!, 36)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return null
}
