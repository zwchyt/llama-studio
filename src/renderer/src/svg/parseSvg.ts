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
