/**
 * 图形卡片的共用工具：序列化 / 编码 / 下载 / 复制。
 *
 * 这个文件是**纯工具层**，不含 React、不含任何 UI——所以 `svg/parseSvg` 和
 * `recharts/ChartCard` 都能安全地引它，不会把组件拖进彼此的依赖图。
 */

/**
 * SVG 源码 → data URI。
 *
 * 为什么用 URL 编码而不是 base64：
 *   encodeURIComponent 天然按 UTF-8 处理，SVG 里写中文标签不会乱码；
 *   而且它会把 `#` 编成 `%23` —— 不编的话 `fill="#3b82f6"` 里的 # 会被浏览器
 *   当成 URL fragment，颜色整段被截掉，图形会变成黑色或透明。
 *
 * 为什么走 <img> 而不是内联渲染 <svg>：
 *   <img> 里的 SVG 运行在受限上下文——不执行 <script>、不加载外部资源、
 *   拿不到父文档。所以模型即使写出 <svg onload=...> 也是惰性的。
 *   这让「显示 SVG」不必以放宽 sanitizer 白名单为代价。
 */
export function toSvgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`
}

/**
 * 把 `var(--x)` / `var(--x, fallback)` 逐个替换成实时计算值。
 *
 * 手写括号配对扫描而不是正则：fallback 里可能自带括号
 * （如 `var(--shadow, 0 2px 4px rgba(0,0,0,.1))`），正则的 `[^)]*` 会在第一个
 * 右括号处截断，反而把值改坏。
 */
function replaceVars(value: string, lookup: (name: string) => string): string {
  let out = ''
  let i = 0
  while (i < value.length) {
    const start = value.indexOf('var(', i)
    if (start === -1) {
      out += value.slice(i)
      break
    }
    out += value.slice(i, start)
    let depth = 1
    let j = start + 4
    while (j < value.length && depth > 0) {
      const ch = value[j]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      j++
    }
    const inner = value.slice(start + 4, j - 1)
    const comma = inner.indexOf(',')
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim()
    out += lookup(name) || fallback
    i = j
  }
  return out
}

/**
 * 把页面里活着的 `<svg>` 序列化成可独立保存的源码。
 *
 * 两件必须做的事，否则导出的文件是坏的：
 *  ① 补 xmlns —— HTML 文档里的 svg 通常没有显式声明命名空间，脱离文档后
 *     浏览器无法解析，下载得到的 .svg 双击打不开。
 *  ② 解析 var(--x) —— ChartView 的整套配色都走 CSS 变量
 *     （fill="var(--rc-c1)"），导出成独立文件后这些变量不复存在，
 *     整张图会变成一片黑。这里逐元素用实时计算值替换掉。
 */
export function serializeSvg(root: Element | null | undefined): string | null {
  if (!root) return null
  const live =
    root.tagName?.toLowerCase() === 'svg'
      ? (root as SVGSVGElement)
      : root.querySelector('svg')
  if (!live) return null

  const clone = live.cloneNode(true) as SVGElement
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }

  // 只对「真的含 var(」的元素调 getComputedStyle：大图表有上千个节点，
  // 无条件逐个取计算样式会明显卡顿，而下载是用户主动触发的动作。
  const liveAll: Element[] = [live, ...Array.from(live.querySelectorAll('*'))]
  const cloneAll: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < cloneAll.length; i++) {
    const c = cloneAll[i]
    const l = liveAll[i]
    if (!l) continue
    const pending = Array.from(c.attributes).filter((a) => a.value.includes('var('))
    if (!pending.length) continue
    const cs = getComputedStyle(l)
    for (const attr of pending) {
      const fixed = replaceVars(attr.value, (n) => cs.getPropertyValue(n).trim())
      if (fixed !== attr.value) attr.value = fixed
    }
  }

  try {
    return new XMLSerializer().serializeToString(clone)
  } catch {
    return null
  }
}

/** 文件名清洗：去掉 Windows 非法字符，并留出长度余量。 */
function safeFileName(name: string): string {
  const cleaned = (name || 'figure')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'figure'
}

export function downloadSvg(fileName: string, svgSource: string): void {
  const blob = new Blob([svgSource], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileName(fileName)}.svg`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器中断下载，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 复制到剪贴板；navigator.clipboard 不可用（非安全上下文等）时降级到 execCommand。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的降级实现 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
