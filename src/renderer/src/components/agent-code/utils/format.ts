// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：展示格式化（耗时、token 数、思考时长）                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

// 耗时格式化：亚秒保留 ms、整秒以上用 s（必要时一位小数），比原始的「1234ms」更柔和易读
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
}

// token 数紧凑格式化：18234 → 18.2k，1234567 → 1.23M（供顶栏内联上下文指示器用）
export function fmtCompactTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(2)}M`
}

// 思考时长格式化：毫秒 → 「3.2 秒」/「1 分 05 秒」（供思考块头部显示「思考了 X 秒」）
export function fmtThinkDur(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} 秒`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m} 分 ${String(rem).padStart(2, '0')} 秒`
}
