import type { Spec } from '@json-render/core'

const COMPONENT_WHITELIST: Array<{ type: string; props: string; desc: string }> = [
  { type: 'MessageCard', props: 'variant: "info" | "warning" | "critical", title, message', desc: '通用提示卡片，纯展示' },
  { type: 'GpuUsagePanel', props: 'engine, utilization?: number(0-100), memoryUsedMb?, memoryTotalMb?, temperature?', desc: 'GPU 状态面板，带利用率进度条' },
  { type: 'Chart', props: 'type: "line"|"bar"|"area"|"pie"|"scatter"|"radar", title?, data: [{...}], xKey, yKey?, series?: ["a","b"] | [{key,name?,color?}], stacked?, height?: number(120-720), unit?, colors?', desc: 'SVG 数据图表（折线/柱状/面积/饼图/散点/雷达）；结构类图形（流程图/时序图等）请用 MermaidCard' },
  { type: 'MermaidCard', props: 'title?: string, code: string', desc: 'Mermaid 图形卡片' },
  // 补充所有 Mermaid 图表类型别名，防止 validateSpec 拦截
  { type: 'flowchart', props: 'code, title?', desc: '流程图' },
  { type: 'sequence', props: 'code, title?', desc: '时序图' },
  { type: 'class', props: 'code, title?', desc: '类图' },
  { type: 'state', props: 'code, title?', desc: '状态图' },
  { type: 'gantt', props: 'code, title?, dateFormat?, section?, data?, children?', desc: '甘特图' },
  { type: 'er', props: 'code, title?', desc: 'ER图' },
  { type: 'journey', props: 'code, title?', desc: '用户旅程图' },
  { type: 'git', props: 'code, title?', desc: 'Git图' },
  { type: 'mindmap', props: 'code, title?', desc: '思维导图' },
  { type: 'timeline', props: 'code, title?', desc: '时间线图' },
  { type: 'pie', props: 'code, title?, data?, labels?, values?', desc: '饼图' },
  { type: 'sankey', props: 'code, title?', desc: '桑基图' },
  { type: 'xychart', props: 'code, title?', desc: 'XY图表' },
  { type: 'quadrant', props: 'code, title?', desc: '象限图' },
  { type: 'requirement', props: 'code, title?', desc: '需求图' },
  { type: 'architecture', props: 'code, title?', desc: '架构图' },
  { type: 'block', props: 'code, title?', desc: '块图' },
  { type: 'packet', props: 'code, title?', desc: '数据包图' },
  { type: 'kanban', props: 'code, title?', desc: '看板图' },
  { type: 'swimlane', props: 'code, title?', desc: '泳道图' },
  { type: 'usecase', props: 'code, title?', desc: '用例图' },
  { type: 'c4', props: 'code, title?', desc: 'C4架构图' },
  { type: 'c4context', props: 'code, title?', desc: 'C4 Context图' },
  { type: 'c4container', props: 'code, title?', desc: 'C4 Container图' },
  { type: 'c4component', props: 'code, title?', desc: 'C4 Component图' },
  { type: 'c4dynamic', props: 'code, title?', desc: 'C4 Dynamic图' },
  { type: 'c4deployment', props: 'code, title?', desc: 'C4 Deployment图' },
  { type: 'zenuml', props: 'code, title?', desc: 'ZenUML时序图' },
  { type: 'radar', props: 'code, title?', desc: '雷达图' },
  { type: 'treemap', props: 'code, title?', desc: '树状图' },
  { type: 'venn', props: 'code, title?', desc: '韦恩图' },
  { type: 'ishikawa', props: 'code, title?', desc: '鱼骨图' },
  { type: 'wardley', props: 'code, title?', desc: 'Wardley地图' },
  { type: 'cynefin', props: 'code, title?', desc: 'Cynefin框架图' },
  { type: 'treeview', props: 'code, title?', desc: '树视图' },
  { type: 'eventmodeling', props: 'code, title?', desc: '事件建模图' },
]

const DYNAMIC_PATHS = [
  { path: '/metrics/gpuUtilization', desc: 'GPU 利用率（百分比）' },
  { path: '/metrics/vramUsedMb', desc: '显存已用（MB）' },
  { path: '/metrics/vramTotalMb', desc: '显存总量（MB）' },
  { path: '/metrics/gpuTemperature', desc: 'GPU 温度（℃）' },
  { path: '/metrics/decodeTokS', desc: '解码速度数组（tok/s 采样）' },
  { path: '/metrics/nCtx', desc: '上下文窗口大小' },
  { path: '/metrics/nDecoded', desc: '已解码 token 数' },
  { path: '/metrics/isProcessing', desc: '是否正在生成（布尔）' },
]

/** 一段被识别出的 JSON，附带它在**原字符串**里的下标区间。 */
type JsonSlice = {
  /** 用来 JSON.parse 的内容 */
  value: string
  /** 该被删除的区间起点（含） */
  start: number
  /** 该被删除的区间终点（不含） */
  end: number
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g
const JSON_FENCE = /```(?:json|jsonl)?\s*([\s\S]*?)```/i

/**
 * 从正文里找出那段 JSON，并给出它在原字符串中的下标区间。
 *
 * 为什么要带下标：调用方除了「解析」还需要「把这段从正文里删掉」
 * （见 findSpecSlice）。只知道内容不知道位置就没法做切除。
 *
 * 为此这里把 <think> 段**等长替换成空格**而不是删掉：删除会让其后所有下标前移，
 * 算出来的位置对不回原文；而空格不影响正则与括号配对的结果（它们只关心
 * ` { } " 这几个字符），却能保证下标一一对应。行为与「先删除再匹配」等价。
 *
 * 返回的区间是「整段该删的东西」：命中围栏时**包含 ``` 标记本身**，否则摘完
 * 会在正文里留下一对空围栏；命中裸 JSON 时就是那对大括号。
 */
function extractJsonSlice(text: string): JsonSlice | null {
  const t = text.replace(THINK_BLOCK, (m) => ' '.repeat(m.length))

  const fence = JSON_FENCE.exec(t)
  if (fence) {
    const value = fence[1].trim()
    if (!value) return null
    return { value, start: fence.index, end: fence.index + fence[0].length }
  }

  const start = t.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else {
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return { value: t.slice(start, i + 1), start, end: i + 1 }
      }
    }
  }
  return null
}

function parseSpec(text: string): { spec: Spec; raw: string; start: number; end: number } | null {
  const slice = extractJsonSlice(text)
  if (!slice) return null
  try {
    const spec = JSON.parse(slice.value) as Spec
    return { spec, raw: slice.value, start: slice.start, end: slice.end }
  } catch {
    return null
  }
}

/**
 * 提取 + 校验 + 归一化（含 root 兜底修正）。
 *
 * tryExtractSpec 与 findSpecSlice 都走这一个函数，这是刻意的：
 * 「会不会被渲染成卡片」和「会不会被从正文里摘掉」必须是同一个判断，
 * 否则一旦两边判据漂移，就会出现「摘了却没渲染 → 内容凭空消失」
 * 或者「渲染了却没摘 → 同一份信息显示两遍」。
 */
function normalizeSpec(text: string): { raw: string; start: number; end: number } | null {
  const parsed = parseSpec(text)
  if (!parsed) return null
  let spec = parsed.spec
  let err = validateSpec(spec)
  if (
    err &&
    typeof spec.root === 'string' &&
    spec.elements && typeof spec.elements === 'object' &&
    !(spec.root in spec.elements)
  ) {
    const keys = Object.keys(spec.elements)
    if (keys.length > 0) {
      spec = { ...spec, root: keys[0]! }
      err = validateSpec(spec)
    }
  }
  if (err) return null
  return { raw: JSON.stringify(spec), start: parsed.start, end: parsed.end }
}

export function tryExtractSpec(text: string): string | null {
  return normalizeSpec(text)?.raw ?? null
}

/**
 * 找出正文里那段 UI Spec 的原始区间，供调用方把它从正文中摘掉
 * （parseContentToBlocks 用它把重复的 JSON 从消息正文里去掉）。
 *
 * 返回 null 表示正文里没有可渲染的 Spec，调用方应原样保留正文。
 */
export function findSpecSlice(text: string): { start: number; end: number } | null {
  const n = normalizeSpec(text)
  return n ? { start: n.start, end: n.end } : null
}

function validateSpec(spec: Spec): string | null {
  const known = new Set(COMPONENT_WHITELIST.map((c) => c.type))
  const allowedPaths = new Set(DYNAMIC_PATHS.map((d) => d.path))
  if (!spec || typeof spec !== 'object') return 'Spec 不是对象'
  if (typeof spec.root !== 'string') return '缺少 root 字段（必须为字符串）'
  if (!spec.elements || typeof spec.elements !== 'object') return '缺少 elements 字段（必须为对象）'
  if (!(spec.root in spec.elements)) return `root 指向的 "${spec.root}" 不存在于 elements`
  for (const [id, el] of Object.entries(spec.elements)) {
    const node = el as { type?: string; props?: unknown; children?: string[] }
    if (!node || typeof node !== 'object') return `元素 "${id}" 不是对象`
    if (typeof node.type !== 'string') return `元素 "${id}" 缺少 type`
    if (!known.has(node.type)) return `元素 "${id}" 的 type "${node.type}" 不在白名单内`
    if (node.props !== undefined && (typeof node.props !== 'object' || node.props === null)) return `元素 "${id}" 的 props 必须是对象`
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) return `元素 "${id}" 的 children 必须是数组`
      for (const cid of node.children) {
        if (typeof cid !== 'string' || !(cid in spec.elements)) return `元素 "${id}" 引用了不存在的子元素 "${cid}"`
      }
    }
    if (node.props) {
      const stack: Array<{ v: unknown }> = [{ v: node.props }]
      while (stack.length > 0) {
        const { v } = stack.pop()!
        if (v === null || typeof v !== 'object') continue
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k === '$state') {
            if (typeof val !== 'string' || !allowedPaths.has(val)) return `元素 "${id}" 引用了不存在的动态路径 "$state: ${String(val)}"`
          } else {
            stack.push({ v: val })
          }
        }
      }
    }
  }
  return null
}
