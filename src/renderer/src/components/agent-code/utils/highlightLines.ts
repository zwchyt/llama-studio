// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：按行语法高亮（hljs）                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 供「Write/Edit 工具卡的内容预览」与「CodeBlock 代码块」共用。
// 让代码块在**流式期间**也能带语法高亮（旧实现流式一律退化为纯文本）。

import hljs from 'highlight.js/lib/common'

/** 扩展名 → hljs 语言名。刻意不做自动探测：highlightAuto 会逐个试全部内置语法，
 *  实测比指定语言慢 10~20 倍，流式期间每帧调用不可接受。
 *  映射里出现 hljs 不认识的键无妨 —— highlightLines 会先过 getLanguage 守卫。 */
const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python',
  rb: 'ruby', go: 'go', rs: 'rust', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl',
  r: 'r', swift: 'swift', kt: 'kotlin', kts: 'kotlin', java: 'java',
  cs: 'csharp', vb: 'vbnet',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  m: 'objectivec', mm: 'objectivec',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  mk: 'makefile',
  diff: 'diff', patch: 'diff',
}

/** 无扩展名但可判定的特殊文件名 */
const BASENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
}

/** 从文件路径推断 hljs 语言名；无法判定时返回 null（调用方退回纯文本）。 */
export function langFromPath(path: string): string | null {
  if (!path) return null
  // 只取最后一段，同时兼容 / 与 \（工具参数里的路径两种分隔符都可能出现）
  const base = path.split(/[\\/]/).pop() ?? ''
  if (!base) return null
  const lower = base.toLowerCase()
  const byName = BASENAME_LANG[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return null
  return EXT_LANG[lower.slice(dot + 1)] ?? null
}

/** 高亮结果的行缓存（键 = 语言 + \0 + 源码）。流式期间每帧源码都是新的、缓存不命中，
 *  所以流式态由调用方传 cacheable=false；缓存主要服务完成态与滚动回来重新挂载。 */
const CACHE_MAX = 24
const cache = new Map<string, string[]>()

/** 把 hljs 的整块 HTML 切成「自洽的逐行片段」。
 *
 * 不能直接 split('\n')：hljs 的 span **会跨行开合**（块注释 / 模板串），切出来的片段 HTML 不平衡，
 * 末行那个孤立的 `</span>` 会被解析器丢弃 → 该行丢失颜色。
 * 这里逐行维护「未闭合 span」栈，为每行补前缀（重开）与后缀（补闭合）。 */
function splitBalancedLines(html: string): string[] {
  const out: string[] = []
  const stack: string[] = []
  for (const line of html.split('\n')) {
    // 前缀取「进入本行前」的栈快照，后缀闭合「本行结束后」仍开着的标签
    const prefix = stack.join('')
    const tagRe = /<span\b[^>]*>|<\/span>/g
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0] === '</span>') stack.pop()
      else stack.push(m[0])
    }
    out.push(prefix + line + '</span>'.repeat(stack.length))
  }
  return out
}

/** 把代码高亮成「按行自洽的 HTML 片段数组」；语言未知或高亮失败返回 null。
 *
 * 必须**整体高亮一次**再按行切分：块注释 / 模板串的词法状态跨行，逐行单独调用 hljs
 * 会让行边界的状态丢失、整段错色 —— 那正是旧实现放弃流式高亮的原因。
 * 返回的 HTML 已由 hljs 转义过实体，可直接交给 dangerouslySetInnerHTML。 */
export function highlightLines(code: string, language: string | null, cacheable = true): string[] | null {
  if (!code || !language) return null
  if (!hljs.getLanguage(language)) return null
  const key = `${language}\u0000${code}`
  if (cacheable) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  let lines: string[]
  try {
    lines = splitBalancedLines(hljs.highlight(code, { language }).value)
  } catch {
    return null
  }
  if (cacheable) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, lines)
  }
  return lines
}
