/**
 * 图形卡片的共用工具：序列化 / 编码 / 下载 / 复制。
 *
 * 这个文件是**纯工具层**，不含 React、不含任何 UI——所以 `svg/parseSvg` 和
 * `recharts/ChartCard` 都能安全地引它，不会把组件拖进彼此的依赖图。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XML_DECL = /^<\?xml[^>]*\?>\s*/i
const LEADING_COMMENT = /^<!--[\s\S]*?-->\s*/

/**
 * 给根 <svg> 补上 xmlns（已有则原样返回）。
 *
 * 这是**必须**的一步，而且只在「脱离 HTML 文档」时才暴露出来：
 *   · 内联在 HTML 里的 <svg>（含 innerHTML 注入）由 HTML 解析器负责命名空间，
 *     写不写 xmlns 都能画出来 —— 所以流式实时预览从来不需要它；
 *   · 一旦包成 data URI 交给 <img>，payload 是按**独立 XML 文档**解析的，
 *     根元素没有 xmlns 就不会被认作 SVG，浏览器直接判加载失败（触发 onError）。
 *     模型写的 SVG 经常只有 width/height/viewBox，xmlns 是想不起来的。
 *
 * 与 parseSvg 的 looksLikeSvg 同构：都是「剥掉 XML 声明与前置注释后再看根标签」，
 * 保证「校验通过」的东西这里也一定补得上。
 */
export function ensureSvgNamespace(svg: string): string {
  const src = svg.trim()
  if (!src) return src
  let offset = 0
  const decl = XML_DECL.exec(src)
  if (decl) offset += decl[0].length
  const comment = LEADING_COMMENT.exec(src.slice(offset))
  if (comment) offset += comment[0].length
  const rest = src.slice(offset)
  const open = /^<svg\b[^>]*>/i.exec(rest)
  if (!open) return src
  const tag = open[0]
  if (/\sxmlns\s*=/i.test(tag)) return src
  return src.slice(0, offset) + tag.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`) + rest.slice(tag.length)
}

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
 *
 * 补 xmlns 在这里做而不是在调用方：本函数是「把源码变成一张能显示的图」的
 * 唯一出口（卡片画布与放大层都走它），缺了命名空间的源码对两者同样是破图。
 */
export function toSvgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ensureSvgNamespace(svg))}`
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
  // 同样要补 xmlns：存成 .svg 文件后它就是独立文档，缺命名空间的根元素双击打不开。
  // （ChartCard 那条路 serializeSvg 已经补过了，这里是给 SvgCard 的「模型原文」兜底。）
  const blob = new Blob([ensureSvgNamespace(svgSource)], { type: 'image/svg+xml;charset=utf-8' })
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
