// 注意：这里直接从 recharts/parseChartSpec 引，而不是引 recharts 的 barrel。
// barrel 会把 ChartCard 带进来，虽然 ChartCard 内部是懒加载、不会拉进 recharts 库，
// 但直接引具体文件能让依赖关系更明确、也避免以后有人往 barrel 里加静态重依赖时被误伤。
import { parseChartSpec } from '../recharts/parseChartSpec'
import { looksLikeSvg } from '../svg/parseSvg'
// 同上：直接引具体文件而不是 barrel。

export type ContentBlock =
  | { kind: 'text'; content: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'chart'; code: string }
  | { kind: 'svg'; code: string; streaming?: boolean }

const MERMAID_KEYWORDS = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram-v2', 'classDiagram',
  'stateDiagram-v2', 'stateDiagram', 'gantt', 'erDiagram', 'journey', 'gitGraph',
  'mindmap', 'timeline', 'pie', 'sankey-beta', 'xychart-beta', 'quadrantChart',
  'requirementDiagram', 'architecture-beta', 'block-beta', 'packet-beta', 'kanban',
  'swimlane-beta', 'usecase-beta', 'C4Context', 'C4Container', 'C4Component',
  'C4Dynamic', 'C4Deployment', 'zenuml', 'radar-beta', 'treemap-beta',
  'venn-beta', 'ishikawa-beta', 'wardley-beta', 'cynefin-beta', 'treeView-beta',
  'eventmodeling'
]
const kwPattern = MERMAID_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const kwRe = new RegExp(`^(${kwPattern})(\\s|;|:|$)`)
const isMermaidKw = (line: string) => kwRe.test(line)
const MERMAID_FENCE_RE = /^```\s*mermaid\b/i
const CHART_FENCE_RE = /^```\s*(chart|recharts|json|jsonc)\b/i
const SVG_FENCE_RE = /^```\s*svg\b/i
const FENCE_CLEAN_RE = /```[\s\S]*?```/g

/**
 * 把助手消息正文拆成「普通文本」与「Mermaid 图表」块。
 *
 * @param content   消息正文（可能仍在流式增长）
 * @param streaming 是否处于流式输出中。
 *
 * 流式语义（关键）：模型是逐 token 输出的，代码围栏 `` ```mermaid `` 的闭合标记
 * 往往要等整段代码吐完才出现。若在流式中就按「已完成的 mermaid 块」解析并交给
 * MermaidCard，会拿到**残缺代码**去渲染 —— mermaid.render 抛错 → 先渲染出一张
 * 「渲染失败」的错误卡；待后续 token 补全后才替换成正确的图。用户看到的时序就是
 * 「先错图、后对图」，非常突兀。
 *
 * 因此流式期间对「尚未闭合的 mermaid 围栏 / 裸 mermaid 关键字块」一律**不产出
 * mermaid 块**，而是作为普通文本原样保留（由 Markdown 渲染成代码块），等围栏闭合
 * （或消息流结束、streaming 转 false）后，才真正产出 mermaid 块交给图表组件渲染。
 * 这样图表只会在「代码已完整」时渲染一次，不存在错误态到正确态的闪替。
 *
 * 关键防线：即使围栏标记为 ```mermaid，也必须**首行确实是 mermaid 关键字**才
 * 产出 mermaid 块。模型常把普通代码（如「类语法结构示例」class ClassName {...}）
 * 错误地标成 ```mermaid，若不校验关键字，就会被送进图表组件渲染失败后仍以
 * 「图表代码块」形态展示，与用户预期（普通代码块）不符。
 *
 * ```chart / ```recharts / ```json 围栏（SVG 图表）走同一套规矩：
 *   ① 围栏未闭合 → 不产出（同 mermaid，避免拿半截 JSON 去渲染）；
 *   ② 围栏闭合后，必须能被 parseChartSpec 解析成合法 ChartSpec 才产出，
 *      否则原样留在文本里当普通代码块。
 *   ② 相当于 mermaid 那条「首行关键字校验」在 JSON 上的对应物：
 *      模型把一段普通 JSON 误标成 ```chart 时，不该给用户看一张空图表。
 *
 * ```svg 围栏同理：围栏未闭合 → 不产出；闭合后必须 looksLikeSvg 通过才产出。
 * 之所以要 ```svg 围栏这条路，是因为**内联写的 <svg> 根本渲染不出来**——
 * AgentCodeView 的 sanitize 白名单里没有任何 SVG 标签，会被整段剥掉。
  * 围栏内容由 SvgCard 包成 <img src="data:image/svg+xml,..."> 来渲染。
  */
export function parseContentToBlocks(content: string, streaming = false): ContentBlock[] {
  if (!content) return []

  const lines = content.split('\n')
  const blocks: ContentBlock[] = []
  let currentText = ''
  let i = 0

  // 把累积的正文刷成一个文本块（保持既有行为：仅在有内容时产出）
  const flushText = () => {
    if (currentText.trim()) {
      blocks.push({ kind: 'text', content: currentText })
      currentText = ''
    }
  }

  // 判断一段「已取出的代码」首行是否为合法 mermaid 关键字。
  // 用于围栏 ```mermaid 的关键字校验（防模型误标语言）。
  const codeLooksLikeMermaid = (code: string): boolean => {
    const firstLine = code.split('\n').find(l => l.trim() !== '') ?? ''
    return isMermaidKw(firstLine.trim())
  }

  // 从 i 往后找下一行围栏的闭合位置；找不到返回 -1
  const findFenceEnd = (start: number): number => {
    for (let j = start + 1; j < lines.length; j++) {
      if (lines[j].trim().startsWith('```')) return j
    }
    return -1
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // ── 围栏代码块 ```mermaid ... ``` ──
    if (trimmed.startsWith('```')) {
      const isMermaidFence = MERMAID_FENCE_RE.test(trimmed)
      const isChartFence = CHART_FENCE_RE.test(trimmed)
      const isSvgFence = SVG_FENCE_RE.test(trimmed)
      const codeBlockEnd = findFenceEnd(i)

      // 围栏未闭合（流式中最常见）：
      //  · chart/recharts 围栏：JSON 是「合法 JSON 的前缀」，可以容错修复出部分
      //    spec（data 几个点画几个点）→ 产出 streaming 图表块实时渲染。recharts
      //    是数据驱动的，天然支持边输出边生长；修复不出（数据行还没成形）时保持
      //    普通代码块，等下个 commit 再试 —— 不存在「拿残码渲染报错」的问题。
      //  · mermaid / 其它：整段原样留在文本里，交给 Markdown 渲染成代码块；
      //    绝不能推出 mermaid 块，否则就是「半截代码去渲染」（mermaid 语法解析
      //    遇到残码会抛错，先错图后对图的闪替不可避免，详见文件头）。
      if (codeBlockEnd === -1) {
        // 流式期间的 svg 围栏：**围栏一打开就立即产出 streaming svg 块**——
        // 卡片框架先亮出来（不再等 <svg 标签写完才出现，消除框架闪烁），
        // SVG 是浏览器容错解析的标签树，半截代码 innerHTML 注入即可渐进渲染，
        // 随输出逐步成形。finalize 后 looksLikeSvg 不过的仍会降级回普通代码块。
        // chart/mermaid 不做实时渲染（JSON 半截解析/乐观渲染效果不合适，已移除）。
        if (streaming && isSvgFence) {
          flushText()
          blocks.push({ kind: 'svg', code: lines.slice(i + 1).join('\n').trim(), streaming: true })
          i = lines.length
          break
        }
        currentText += lines.slice(i).join('\n') + '\n'
        i = lines.length
        break
      }

      if (isMermaidFence) {
        // 围栏已闭合：取出代码后**再校验首行确实是 mermaid 关键字**。
        // 模型常把普通代码（如「类语法结构示例」）误标成 ```mermaid，此时应按
        // 普通代码块处理，不能进图表组件（否则降级后仍以「图表代码块」形态展示）。
        const mermaidCode = lines.slice(i + 1, codeBlockEnd).join('\n').trim()
        if (mermaidCode.length > 5 && codeLooksLikeMermaid(mermaidCode)) {
          flushText()
          blocks.push({ kind: 'mermaid', code: mermaidCode })
          i = codeBlockEnd + 1
          continue
        }
        // 首行不是 mermaid 关键字（或代码过短）：原样保留为普通代码块
        currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
        i = codeBlockEnd + 1
        continue
      }

      if (isChartFence) {
        // 围栏已闭合：取出 JSON 后必须**真的能解析成 ChartSpec** 才产出图表块。
        // 校验放在这里而不是 ChartCard 里，是为了让「误标的普通 JSON」退化回
        // 普通代码块，而不是变成一张空的图表卡。
        //
        // 围栏语言包括 ```json / ```jsonc，不只是 ```chart —— 模型经常直接甩一段
        // ```json 出来当图表（形状见 parseChartSpec 里 CHART_COMPONENT_ALIASES 那段
        // 注释）。围栏语言本来也不该决定「这段 JSON 是不是图表」，内容说了算。
        const chartCode = lines.slice(i + 1, codeBlockEnd).join('\n').trim()
        if (parseChartSpec(chartCode)) {
          flushText()
          blocks.push({ kind: 'chart', code: chartCode })
          i = codeBlockEnd + 1
          continue
        }
        // 解析不出合法图表：原样保留为普通代码块
        currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
        i = codeBlockEnd + 1
        continue
      }

      if (isSvgFence) {
        // 围栏已闭合：取出源码后必须**真的像 SVG** 才产出图形块。
        // 模型把普通 XML / HTML 误标成 ```svg 时，退回普通代码块，
        // 而不是塞进 <img> 让用户看到一张破图。
        const svgCode = lines.slice(i + 1, codeBlockEnd).join('\n').trim()
        if (looksLikeSvg(svgCode)) {
          flushText()
          blocks.push({ kind: 'svg', code: svgCode })
          i = codeBlockEnd + 1
          continue
        }
        // 不是 SVG：原样保留为普通代码块
        currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
        i = codeBlockEnd + 1
        continue
      }

      // 普通代码块：原样保留
      currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
      i = codeBlockEnd + 1
      continue
    }

    // ── 裸 Mermaid 关键字块（无围栏写法：graph TD / flowchart ... ）──
    if (trimmed && !trimmed.startsWith('#') && isMermaidKw(trimmed)) {
      // 查找块的结束：空行、围栏行或下一个关键字
      let end = i + 1
      while (end < lines.length) {
        const next = lines[end].trim()
        if (next === '' || next.startsWith('```') || isMermaidKw(next)) break
        end++
      }

      // 流式期间：裸写法**无法判断是否已输出完**（没有闭合标记，只能靠空行/下一个
      // 关键字来界定，而这两者都可能还没到）。若此刻就产出 mermaid 块，等价于拿
      // 残码渲染。因此流式中一律不产出，等流结束（streaming=false）再解析。
      if (streaming) {
        currentText += line + '\n'
        i++
        continue
      }

      flushText()
      const code = lines.slice(i, end).join('\n').replace(FENCE_CLEAN_RE, '').trim()
      if (code.length > 5) {
        blocks.push({ kind: 'mermaid', code })
        i = end
        continue
      }
    }

    // 普通文本行
    currentText += line + '\n'
    i++
  }

  flushText()

  return blocks
}