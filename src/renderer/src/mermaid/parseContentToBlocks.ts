// 注意：这里直接从 recharts/parseChartSpec 引，而不是引 recharts 的 barrel。
// barrel 会把 ChartCard 带进来，虽然 ChartCard 内部是懒加载、不会拉进 recharts 库，
// 但直接引具体文件能让依赖关系更明确、也避免以后有人往 barrel 里加静态重依赖时被误伤。
import { parseChartSpec } from '../recharts/parseChartSpec'
import { looksLikeSvg } from '../svg/parseSvg'
// 同上：直接引具体文件而不是 jsonui 的 barrel。specGen 只 `import type` 了
// @json-render/core，是纯逻辑，不会把 json-render 库或任何组件拖进依赖图。
import { findSpecSlice } from '../jsonui/specGen'

export type ContentBlock =
  | { kind: 'text'; content: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'chart'; code: string }
  | { kind: 'svg'; code: string }

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
 * ```chart / ```recharts 围栏（SVG 图表）走同一套规矩：
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
 *
 * 第四种是 json-render Spec（```json 里那段 { root, elements }）：它跟上面三种
 * 相反 —— 不是「把代码换成卡片」，而是「正文里干脆不再展示这段代码」。
 * AgentCodeView 的 AgentUiBlock 会在消息里单独把 Spec 渲染成组件，正文再留一份
 * 原文就是同一份信息显示两遍（而且它动辄几十行）。原文没丢：AgentUiBlock 上的
 * 「查看 Spec」开关能展开。
 */
export function parseContentToBlocks(content: string, streaming = false): ContentBlock[] {
  if (!content) return []

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

  // 判断一段「已取出的代码」首行是否为合法 mermaid 关键字。
  // 用于围栏 ```mermaid 的关键字校验（防模型误标语言）。
  const codeLooksLikeMermaid = (code: string): boolean => {
    const firstLine = code.split('\n').find(l => l.trim() !== '') ?? ''
    return isMermaidKw(firstLine.trim())
  }

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

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // ── 围栏代码块 ```mermaid ... ``` ──
    if (trimmed.startsWith('```')) {
      const isMermaidFence = /^```\s*mermaid\b/i.test(trimmed)
      const isChartFence = /^```\s*(chart|recharts)\b/i.test(trimmed)
      const isSvgFence = /^```\s*svg\b/i.test(trimmed)
      const codeBlockEnd = lines.findIndex((l, idx) => idx > i && l.trim().startsWith('```'))

      // 围栏未闭合（流式中最常见）：整段原样留在文本里，交给 Markdown 渲染成代码块；
      // 绝不能在此推出 mermaid 块，否则就是「半截代码去渲染」。
      if (codeBlockEnd === -1) {
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
      const code = lines.slice(i, end).join('\n').replace(/```[\s\S]*?```/g, '').trim()
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

  // ── 摘掉 json-render Spec 的原文（见文件头「第四种」）──
  //
  // 只在 !streaming 时摘，这是硬约束，不是优化：AgentUiBlock 的渲染前提就是
  // !isStreaming（见 AgentCodeView 里的 {!isStreaming && <AgentUiBlock …/>}）。
  // 两件事必须同步，否则流式期间会出现「正文被摘掉、卡片却还没渲染」的空窗——
  // 用户眼看着 JSON 打到一半突然消失，而上面什么都没有。
  //
  // 摘除判据与 AgentUiBlock 的渲染判据共用 findSpecSlice（内部走 tryExtractSpec），
  // 所以「会渲染成卡片」与「会被摘掉」永远一致：不会摘了不渲染导致内容凭空消失，
  // 也不会渲染了不摘导致同一份信息显示两遍。
  if (streaming) return blocks

  return (
    blocks
      .map((b) => {
        if (b.kind !== 'text') return b
        const slice = findSpecSlice(b.content)
        if (!slice) return b
        return {
          kind: 'text' as const,
          content: (b.content.slice(0, slice.start) + b.content.slice(slice.end)).trim()
        }
      })
      // 整条消息就是一个 Spec 时，摘完正文会变成空块 —— 丢掉，别留一个空气泡
      .filter((b) => b.kind !== 'text' || b.content !== '')
  )
}