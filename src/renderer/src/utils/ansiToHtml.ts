// ANSI → HTML 转换（从 TerminalView 抽出的纯函数，供单元测试回归锁定转义行为）。
// 安全约定：先做完整 HTML 实体转义，再用正则把 \x1b[..m 替换为自建 <span>（属性固定）——
// 原始 HTML 无法存活，tests/audit/ansi.escape.test.ts 锁定该顺序不被改坏。

const ANSI_MAP: Record<string, string> = {
  '0': '',
  '1': 'font-weight:bold',
  '30': 'color:#363636', '31': 'color:#f67576', '32': 'color:#85df7b',
  '33': 'color:#fa994c', '34': 'color:#3d8dff', '35': 'color:#b06dff',
  '36': 'color:#6dcbf4', '37': 'color:#d4d4d4',
  '90': 'color:#747474', '91': 'color:#f99', '92': 'color:#87d9a4',
  '93': 'color:#ffb26b', '94': 'color:#55a2ff', '95': 'color:#a888f2',
  '96': 'color:#8ee5e5', '97': 'color:#f8f8f8',
}

/** 简易 ANSI 转 HTML（仅支持颜色/加粗/重置） */
export function ansiToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.replace(/\x1b\[([\d;]+)m/g, (_, codes) => {
    const styles = (codes as string).split(';').map((c) => ANSI_MAP[c] || '').filter(Boolean)
    return styles.length ? `<span style="${styles.join(';')}">` : '</span>'
  })
}
