/**
 * SVG 围栏的纯解析逻辑（无 React 依赖）。
 *
 * 单独成文件的原因和 recharts/parseChartSpec 一样：parseContentToBlocks 需要
 * 校验围栏内容，而它跑在消息切分阶段——不能因为校验就把 React 组件拖进依赖图。
 *
 * 编码 / 下载 / 复制等工具不在这里，统一放在 `figure/serializeSvg`。
 * （曾经这里也有一份 `svgToDataUri`，与那边的 `toSvgDataUri` 实现完全相同，
 *   两份迟早会漂移，已合并到 figure 那一侧。）
 */

/** 上限：data URI 会把特殊字符编码成 3 倍长度，过大的 SVG 会撑爆属性值。 */
export const MAX_SVG_LEN = 120_000

const XML_DECL = /^<\?xml[^>]*\?>\s*/i
const LEADING_COMMENT = /^<!--[\s\S]*?-->\s*/

/**
 * 判断一段文本是否真的是 SVG 源码。
 *
 * 与 mermaid 那条「首行必须是关键字」的校验同构：模型会把任意 XML/HTML 误标成
 * ```svg，若不校验就塞进 <img>，用户会看到一张破图（而不是预期的代码块）。
 * 这里只认「剥掉 XML 声明与前置注释后，以 <svg 开头」。
 */
export function looksLikeSvg(code: string): boolean {
  if (!code || code.length > MAX_SVG_LEN) return false
  let s = code.trim()
  // 模型常带 <?xml version="1.0" encoding="UTF-8"?> 前缀，允许它
  s = s.replace(XML_DECL, '')
  // 也允许前面挂一段注释（版权/说明之类）
  s = s.replace(LEADING_COMMENT, '')
  return /^<svg[\s>]/i.test(s)
}

/** 离屏注入 SVG 用的净化：剥 <script> 与内联事件（注入的是活 DOM，事件属性会活）。 */
export function sanitizeLiveSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

/**
 * 量内容 bbox 用的离屏容器。位置挪出视口但**保持渲染** ——
 * display:none / visibility:hidden 下 getBBox() 会量出 0，那就白量了。
 */
const MEASURE_HOST = 'position:absolute;left:-99999px;top:0;width:800px;height:800px;pointer-events:none'

function readViewBox(svg: Element): { x: number; y: number; w: number; h: number } | null {
  const raw = svg.getAttribute('viewBox')
  if (!raw) return null
  const n = raw.trim().split(/[\s,]+/).map(Number)
  if (n.length !== 4) return null
  const [x, y, w, h] = n as [number, number, number, number]
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** 描边画在几何边界之外，而 getBBox() 不含描边 —— 留出最粗描边的一半做余量。 */
function strokePad(svg: Element): number {
  let max = 0
  svg.querySelectorAll('*').forEach((el) => {
    const v = parseFloat(el.getAttribute('stroke-width') || '')
    if (Number.isFinite(v)) max = Math.max(max, v)
  })
  return max > 0 ? max / 2 + 2 : 4
}

/**
 * 把 viewBox **撑到内容真实范围**（只扩不缩），返回新的 SVG 源码。
 *
 * 为什么需要：SVG 根元素默认 overflow: hidden，模型手算的 viewBox 经常偏小 ——
 * 只要有一段文字或图形越界，就会被直接裁掉。实测样例（饼图 + 右侧图例）：
 *   viewBox = "0 0 400 300"，内容 bbox 右边界 = 431.4
 *   → 图例文字"JavaScript 40%"的尾巴整段消失。图小的时候只切掉一两个字不容易发现，
 *     放大后同样的比例被放大就很扎眼（用户报的就是「放大后右边列表被遮挡」）。
 *
 * 只扩不缩是刻意的：viewBox 比内容大是正常（留白），比内容小一定是写错了。
 * 副作用：模型若**故意**用窄 viewBox 做裁切，这里会把它还原成完整图形 ——
 * 那种写法极罕见，而误裁文字太常见，取舍如此。
 *
 * 量不出来（getBBox 抛错、内容为空）就原样返回，绝不因为这次修正把图弄坏。
 */
export function fitSvgViewBox(code: string): string {
  if (!code) return code
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = MEASURE_HOST
  host.innerHTML = sanitizeLiveSvg(code)
  // 必须真的挂进 document 才能量：getBBox() 对游离节点返回全 0，
  // 漏了这一步的话整段修正会静默失效（踩过一次）。
  document.body.appendChild(host)
  const svg = host.querySelector('svg')
  if (!svg) {
    host.remove()
    return code
  }

  let out = code
  try {
    const bb = svg.getBBox()
    if (bb.width > 0 && bb.height > 0) {
      const pad = strokePad(svg)
      const cur = readViewBox(svg)
      const left = Math.min(cur?.x ?? Infinity, bb.x - pad)
      const top = Math.min(cur?.y ?? Infinity, bb.y - pad)
      const right = Math.max(cur ? cur.x + cur.w : -Infinity, bb.x + bb.width + pad)
      const bottom = Math.max(cur ? cur.y + cur.h : -Infinity, bb.y + bb.height + pad)
      const next = { x: left, y: top, w: right - left, h: bottom - top }
      const same =
        cur !== null &&
        Math.abs(cur.x - next.x) < 0.5 &&
        Math.abs(cur.y - next.y) < 0.5 &&
        Math.abs(cur.w - next.w) < 0.5 &&
        Math.abs(cur.h - next.h) < 0.5
      if (!same) {
        const r = (v: number) => Math.round(v * 100) / 100
        svg.setAttribute('viewBox', `${r(next.x)} ${r(next.y)} ${r(next.w)} ${r(next.h)}`)
        // 宽高必须一起丢掉：留着旧的宽高，<img> 的盒子比例会与新 viewBox 的比例不一致，
        // 浏览器按 preserveAspectRatio 居中 letterbox，图形四周就多出一圈空白。
        // 丢掉之后比例由 viewBox 决定，卡片那边的 width:100%/height:auto 正好接住。
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        out = new XMLSerializer().serializeToString(svg)
      }
    }
  } catch {
    /* 量不出来就原样返回 */
  }
  host.remove()
  return out
}
