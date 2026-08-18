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

const SAMPLE_SPEC_JSON = `{
  "root": "summary",
  "elements": {
    "summary": {
      "type": "ErrorDiagnosisCard",
      "props": {
        "severity": "warning",
        "title": "显存不足，模型加载失败",
        "cause": "8GB 显存装不下该模型的 KV cache",
        "recommendations": ["降低 --ctx-size 至 4096", "减少 GPU offload 层数", "关闭其他占显存应用"]
      },
      "children": ["timeline"]
    },
    "timeline": {
      "type": "TaskTimeline",
      "props": {
        "title": "排查步骤",
        "steps": [
          { "title": "读取启动日志", "status": "success", "detail": "定位到 KV cache 分配失败" },
          { "title": "采样本机显存", "status": "success", "detail": "8GB 中 6.5GB 已被占用" },
          { "title": "生成修复建议", "status": "pending", "detail": null }
        ]
      },
      "children": []
    }
  },
  "state": {}
}`

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

function buildSystemPrompt(): string {
  const catalog = COMPONENT_WHITELIST.map(
    (c) => `- ${c.type}：${c.desc}\n  props: ${c.props}`
  ).join('\n')
  const dyn = DYNAMIC_PATHS.map((d) => `- ${d.path}：${d.desc}`).join('\n')
  return [
    '你是一个本地桌面应用内部的 UI 生成器。根据用户的自然语言需求，输出一个 json-render Spec 格式的 JSON 界面描述。',
    'Spec 结构：',
    '{',
    '  "root": "根元素id（必须与 elements 中某个 key 一致）",',
    '  "elements": { "元素id": { "type": "组件类型", "props": { ... }, "children": ["子元素id"], "on": { "事件名": { "action": "动作名" } } } },',
    '  "state": {}',
    '}',
    '可用组件（type 只能取以下之一，props 只能使用下列字段）：',
    catalog,
    '',
    '动态值：props 中的数值/字符串字段可以写成 { "$state": "路径" }，运行时自动绑定实时数据（选中的运行中模型）。',
    '可用动态路径：',
    dyn,
    '例如展示 GPU 利用率：{ "$state": "/metrics/gpuUtilization" }。',
    '规则：',
    '1. 你的回复中只能包含一个 ```json 代码块（第一行写 ```json，最后一行写 ```）。代码块内是完整的 Spec JSON，除此之外不要输出任何文字、解释、注释或代码。',
    '2. 如果你有思考过程，把它放在 <think> 和 </think> 标签之间，不要放在代码块里，也不要和 JSON 混在一起。',
    '3. 先写代码块，再写任何其他内容；不要在 JSON 结束后继续输出文字。',
    '4. props 的值只能是 JSON 原生类型或 { "$state": "..." } 动态值，禁止函数、变量、注释、尾逗号。',
    '5. children 只放需要组合的复杂场景；单一卡片场景可省略 children。',
    '6. children 中的元素id 必须出现在 elements 中；不要引用不存在的元素。',
    '7. 用户要求操作类的界面（按钮、确认）时，只描述界面，不要真的执行任何操作。',
    '8. 如果用户需求与界面无关或信息不足，输出一个 MessageCard，title 与 message 用于说明情况。',
    '9. 指标、状态、进度类信息（利用率、温度、token 数等）优先用动态值，不要写死数字。',
    '',
    '示例（供参考格式）：',
    '```json',
    SAMPLE_SPEC_JSON,
    '```',
  ].join('\n')
}

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

async function streamOnce(
  messages: Array<{ role: string; content: string }>,
  port: number,
  onDelta?: (fullText: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const streamId = `jsonui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<string>((resolve, reject) => {
    let acc = ''
    let settled = false
    const onAbort = () => {
      off()
      settled = true
      window.api.abortChatStream(streamId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const off = window.api.onJsonUIStreamChunk((chunk) => {
      if (chunk.streamId !== streamId) return
      if (chunk.delta) {
        acc += chunk.delta
        onDelta?.(acc)
      }
      if (chunk.error) {
        off()
        settled = true
        reject(new Error(chunk.error))
      } else if (chunk.done) {
        off()
        settled = true
        resolve(acc)
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    window.api.chatStreamJsonUI({ streamId, port, body: { messages, temperature: 0.3, max_tokens: -1, stream: true } })
      .then((res) => {
        if (settled) return
        if (!res.success) {
          off()
          settled = true
          reject(new Error(res.error || '流式请求失败'))
        }
      })
      .catch((e: unknown) => {
        if (settled) return
        off()
        settled = true
        reject(e instanceof Error ? e : new Error(String(e)))
      })
  })
}

export async function generateUiSpec(
  userPrompt: string,
  port: number,
  opts?: { retries?: number; onDelta?: (fullText: string) => void; signal?: AbortSignal }
): Promise<{ spec: Spec; raw: string; attempts: number }> {
  const retries = opts?.retries ?? 1
  const messages = (extra: string | null) => [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: extra ? `以下是对你上次输出的校验错误，请修正后重新输出 Spec：\n${extra}\n\n原需求：\n${userPrompt}` : userPrompt,
    },
  ]
  const retryMessages = (extra: string, original: string) => [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: `以下是你上次的输出（我已用 <OUTPUT_START> 和 <OUTPUT_END> 包裹）：\n<OUTPUT_START>\n${original.slice(0, 800)}${original.length > 800 ? '\n…(已截断)' : ''}\n<OUTPUT_END>\n\n校验错误：${extra}\n\n请只输出修正后的一个 \`\`\`json 代码块，不要任何其他文字。原需求：\n${userPrompt}`,
    },
  ]

  let lastError = '模型未返回可用结果'
  let lastRaw = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    let content: string
    try {
      content = await streamOnce(
        lastError.startsWith('校验') || lastRaw ? retryMessages(lastError, lastRaw) : messages(null),
        port,
        opts?.onDelta,
        opts?.signal
      )
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e
      lastError = `请求失败：${e?.message || String(e)}`
      lastRaw = ''
      continue
    }
    lastRaw = content
    if (!content.trim()) {
      lastError = '模型返回了空内容'
      continue
    }
    const parsed = parseSpec(content)
    if (!parsed) {
      lastError = '输出不是合法 JSON：你的回复中找不到完整的 JSON 对象（可能是没有 ```json 围栏、JSON 不完整、或混入了多余文字）。请重新输出：第一行 ```json，最后一行 ```，中间只放完整的 Spec JSON，前后不要有任何其他文字。'
      continue
    }
    const err = validateSpec(parsed.spec)
    if (err) {
      lastError = `校验失败：${err}`
      continue
    }
    return { spec: parsed.spec, raw: parsed.raw, attempts: attempt + 1 }
  }
  throw new Error(lastError)
}