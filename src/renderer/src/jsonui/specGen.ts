import type { Spec } from '@json-render/core'

const COMPONENT_WHITELIST: Array<{ type: string; props: string; desc: string }> = [
  { type: 'MessageCard', props: 'variant: "info"|"warning"|"critical", title, message', desc: '通用提示卡片，纯展示' },
  { type: 'GpuUsagePanel', props: 'engine, utilization? : number(0-100), memoryUsedMb?, memoryTotalMb?, temperature?', desc: 'GPU 状态面板，带利用率进度条' },
  { type: 'Chart', props: 'type: "line"|"bar"|"pie", title?, data: [{...}], xKey, yKey', desc: '简单图表（折线/柱状/饼图）；data 需为对象数组，xKey/yKey 指定字段名' },
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

function extractJson(text: string): string | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const fence = /```(?:json|jsonl)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) return fence[1].trim()
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
        if (depth === 0) return t.slice(start, i + 1)
      }
    }
  }
  return null
}

function parseSpec(text: string): { spec: Spec; raw: string } | null {
  const candidate = extractJson(text)
  if (!candidate) return null
  try {
    const spec = JSON.parse(candidate) as Spec
    return { spec, raw: candidate }
  } catch {
    return null
  }
}

export function tryExtractSpec(text: string): string | null {
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
  return err ? null : JSON.stringify(spec)
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
