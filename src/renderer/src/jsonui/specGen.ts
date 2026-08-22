import type { Spec } from '@json-render/core'

const COMPONENT_WHITELIST: Array<{ type: string; props: string; desc: string }> = [
  { type: 'MessageCard', props: 'variant: "info"|"warning"|"critical", title, message', desc: '通用提示卡片，纯展示' },
  { type: 'ErrorDiagnosisCard', props: 'severity: "info"|"warning"|"critical", title, cause, recommendations: string[]', desc: '错误诊断卡片，含原因与修复建议列表；可包含 children 子元素，自带复制/重试/关闭按钮' },
  { type: 'InferenceMetrics', props: 'status: "pending"|"running"|"success"|"failed", promptTokensPerSec?, generationTokensPerSec?, ctxTokens?, ctxLimit?, kvCacheMb?, gpuMemMb?', desc: '推理指标卡：tokens/s、上下文占用、KV cache' },
  { type: 'GpuUsagePanel', props: 'engine, utilization? : number(0-100), memoryUsedMb?, memoryTotalMb?, temperature?', desc: 'GPU 状态面板，带利用率进度条' },
  { type: 'ModelRuntimeStatus', props: 'modelName, engine, status: "pending"|"running"|"success"|"failed", port?, uptimeSec?, contextLength?', desc: '模型运行状态卡' },
  { type: 'TaskTimeline', props: 'title?, steps: [{ title, status: "pending"|"running"|"success"|"failed", detail? }]', desc: '任务步骤时间线' },
  { type: 'AgentStepCard', props: 'title, status, description?, durationMs?', desc: '单步执行状态卡' },
  { type: 'ConfigurationDiff', props: 'title?, changes: [{ key, from, to }]', desc: '参数修改对照表，自带「应用建议」按钮（触发 apply 事件）' },
  { type: 'ConfirmDangerousAction', props: 'title, message, dangerLevel: "danger"|"warning", confirmLabel?', desc: '危险操作确认卡，自带确认/取消按钮（触发 confirm/cancel 事件）' },
  { type: 'DownloadProgressCard', props: 'fileName, progress: number(0-100), speedMbPerSec?, sizeMb?, status: "downloading"|"success"|"failed"|"pending"', desc: '下载进度卡' },
  { type: 'LogExcerpt', props: 'title, level: "info"|"warning"|"error", start: number(行号), lines: string[], errorLine?: number(错误行下标)', desc: '日志片段展示' },
]

const DYNAMIC_PATHS = [
  { path: '/metrics/gpuUtilization', desc: 'GPU 利用率（百分比）' },
  { path: '/metrics/vramUsedMb', desc: '显存已用（MB）' },
  { path: '/metrics/vramTotalMb', desc: '显存总量（MB）' },
  { path: '/metrics/gpuTemperature', desc: 'GPU 温度（℃）' },
  { path: '/metrics/cpuUsage', desc: '进程 CPU 占用（百分比）' },
  { path: '/metrics/decodeTokS', desc: '解码速度数组（tok/s 采样）' },
  { path: '/metrics/reqPerSec', desc: '每秒请求数数组' },
  { path: '/metrics/ttftMs', desc: '首 token 延迟（ms）' },
  { path: '/metrics/prefillTokS', desc: '预填充速度（tok/s）' },
  { path: '/metrics/nCtx', desc: '上下文窗口大小' },
  { path: '/metrics/nDecoded', desc: '已解码 token 数' },
  { path: '/metrics/nPromptTokens', desc: '本次请求提示 token 数' },
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
