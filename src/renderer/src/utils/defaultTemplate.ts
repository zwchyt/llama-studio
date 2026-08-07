import type { EngineKind, Template, TemplateArgs } from '../../../shared/types'
function cleanName(filename: string): string {
  return filename
    .replace(/\.gguf$/i, '')
    .replace(/\.ggml$/i, '')
    .replace(/\.safetensors$/i, '')
    .replace(/\.ckpt$/i, '')
    .replace(/\.pth$/i, '')
    .replace(/\.pt$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(Q\d[_KMS]*|IQ\d[_KMS]*|F16|F32|BF16|GGUF|GGML)\b/gi, '') 
    .replace(/\s+/g, ' ')
    .trim()
}
function detectQuant(filename: string): string {
  const u = filename.toUpperCase()
  if (/IQ1|Q1/.test(u)) return 'q1'
  if (/IQ2|Q2/.test(u)) return 'q2'
  if (/Q3/.test(u)) return 'q3'
  if (/Q4/.test(u)) return 'q4'
  if (/Q5/.test(u)) return 'q5'
  if (/Q6/.test(u)) return 'q6'
  if (/Q8/.test(u)) return 'q8'
  if (/F16|BF16/.test(u)) return 'f16'
  if (/F32/.test(u)) return 'f32'
  return 'q4' 
}
function detectSize(filename: string): string {
  const m = filename.match(/(\d+(\.\d+)?)\s*[Bb]/i)
  if (!m) return 'unknown'
  const b = parseFloat(m[1])
  if (b >= 65) return '70b'
  if (b >= 30) return '34b'
  if (b >= 20) return '24b'
  if (b >= 12) return '13b'
  if (b >= 7) return '7b'
  if (b >= 3) return '3b'
  if (b >= 1) return '1b'
  return 'unknown'
}
function detectFamily(filename: string): string {
  const u = filename.toLowerCase()
  if (u.includes('llama')) return 'Llama'
  if (u.includes('mistral') || u.includes('mixtral')) return 'Mistral'
  if (u.includes('phi')) return 'Phi'
  if (u.includes('gemma')) return 'Gemma'
  if (u.includes('qwen')) return 'Qwen'
  if (u.includes('deepseek')) return 'DeepSeek'
  if (u.includes('falcon')) return 'Falcon'
  if (u.includes('vicuna')) return 'Vicuna'
  if (u.includes('wizard')) return 'WizardLM'
  if (u.includes('dolphin')) return 'Dolphin'
  if (u.includes('openhermes') || u.includes('hermes')) return 'Hermes'
  if (u.includes('orca')) return 'Orca'
  if (u.includes('stablelm')) return 'StableLM'
  return 'LLM'
}
interface RecommendedSettings {
  ctxSize: number
  threads: number
  batchSize: number
  gpuLayers: number
  temp: number
  repeatPenalty: number
  description: string
}
function getRecommendedSettings(filename: string): RecommendedSettings {
  const quant = detectQuant(filename)
  const size = detectSize(filename)
  const family = detectFamily(filename)
  const ctxMap: Record<string, number> = {
    q1: 1024, q2: 2048, q3: 2048, q4: 4096,
    q5: 4096, q6: 8192, q8: 8192, f16: 16384, f32: 16384
  }
  const ctxSize = ctxMap[quant] ?? 4096
  const threadMap: Record<string, number> = {
    '1b': 2, '3b': 4, '7b': 4, '13b': 6, '24b': 6, '34b': 8, '70b': 8, unknown: 4
  }
  const threads = threadMap[size] ?? 4
  const batchMap: Record<string, number> = {
    '1b': 256, '3b': 256, '7b': 512, '13b': 512, '24b': 512, '34b': 1024, '70b': 1024, unknown: 512
  }
  const batchSize = batchMap[size] ?? 512
  const quantLabel = quant.toUpperCase()
  const sizeLabel = size === 'unknown' ? '' : ` ${size.toUpperCase()}`
  return {
    ctxSize,
    threads,
    batchSize,
    gpuLayers: 0,
    temp: 0.7,
    repeatPenalty: 1.1,
    description: `${family}${sizeLabel} ${quantLabel} — ctx ${ctxSize.toLocaleString()}, ${threads} threads (auto-configured)`
  }
}
/**
 * 按引擎/参数集返回该引擎的一套默认启动参数
 * （切换引擎时替换模板 args，避免残留其他引擎的参数）
 */
export function defaultArgsForParamSet(paramSet: EngineKind, filename = ''): TemplateArgs {
  switch (paramSet) {
    case 'tensorsharp':
      return { '--temperature': 0.7, '--repeat-penalty': 1.1, '--max-tokens': 20000 }
    case 'sdcpp':
      return { '--steps': 20, '--cfg-scale': 7 }
    default:
      const settings = getRecommendedSettings(filename)
      return {
        '--ctx-size': settings.ctxSize,
        '--threads': settings.threads,
        '--n-gpu-layers': settings.gpuLayers,
        '--batch-size': settings.batchSize,
        '--temp': settings.temp,
        '--repeat-penalty': settings.repeatPenalty
      }
  }
}

type ParamSetKey = Exclude<EngineKind, 'other'>
type ArgsByParamSet = Partial<Record<ParamSetKey, TemplateArgs>>

/**
 * 切换引擎时计算新的 args + argsByParamSet：
 * 先把当前引擎的自定义 args 存入 argsByParamSet[当前引擎]，再取出目标引擎已保存的参数
 * （没有则用该引擎默认值）。这样来回切换不会丢失各引擎各自调过的参数。
 */
export function switchParamSetArgs(
  currentParamSet: ParamSetKey,
  currentArgs: TemplateArgs,
  argsByParamSet: ArgsByParamSet | undefined,
  nextParamSet: ParamSetKey,
  filename = ''
): { args: TemplateArgs; argsByParamSet: ArgsByParamSet } {
  const nextByParamSet: ArgsByParamSet = { ...(argsByParamSet ?? {}) }
  nextByParamSet[currentParamSet] = { ...currentArgs }
  const args = nextByParamSet[nextParamSet] ?? defaultArgsForParamSet(nextParamSet, filename)
  return { args, argsByParamSet: nextByParamSet }
}

/**
 * 把用户编辑后的当前引擎参数同步写入 argsByParamSet（保持 argsByParamSet[paramSet] === args）
 */
export function syncArgsByParamSet(
  currentParamSet: ParamSetKey,
  currentArgs: TemplateArgs,
  argsByParamSet: ArgsByParamSet | undefined
): ArgsByParamSet {
  return { ...(argsByParamSet ?? {}), [currentParamSet]: { ...currentArgs } }
}
export function getNextPort(existingTemplates: Template[]): number {
  const usedPorts = new Set(existingTemplates.map(t => t.serverPort))
  let port = 8080
  while (usedPorts.has(port) && port <= 65535) port++
  return port
}
export function buildDefaultTemplate(
  filename: string,
  modelPath: string,
  existingTemplates: Template[] = [],
  backendName = '',
  kind: EngineKind = 'llamacpp'
): Template {
  const port = getNextPort(existingTemplates)
  const base = {
    id: crypto.randomUUID(),
    name: cleanName(filename) || filename,
    modelPath,
    serverPort: port,
    backendVersion: backendName,
    launchMode: 'chat' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  // TensorSharp 引擎：采样参数与 llama.cpp 预设不同（无 --ctx-size/--threads/--n-gpu-layers；
  // --backend 留空让引擎自动选择，本机有 NVIDIA GPU 时运行时自动注入 ggml_cuda）
  if (kind === 'tensorsharp') {
    const args = { '--temperature': 0.7, '--repeat-penalty': 1.1, '--max-tokens': 20000 }
    return {
      ...base,
      description: `${detectFamily(filename)} — TensorSharp 引擎，采样参数自动配置`,
      args,
      argsByParamSet: { tensorsharp: args }
    }
  }
  // stable-diffusion.cpp 引擎：sd-server 为图像推理服务（无聊天 UI），
  // 预填常用生成默认值；端口参数由 sd-server 的 --listen-port 管理（默认 1234）
  if (kind === 'sdcpp') {
    const args = { '--steps': 20, '--cfg-scale': 7 }
    return {
      ...base,
      launchMode: 'api' as const,
      description: `stable-diffusion.cpp — 扩散模型，默认 ${20} 步 / CFG ${7}`,
      args,
      argsByParamSet: { sdcpp: args }
    }
  }
  const settings = getRecommendedSettings(filename)
  const args = {
    '--ctx-size': settings.ctxSize,
    '--threads': settings.threads,
    '--n-gpu-layers': settings.gpuLayers,
    '--batch-size': settings.batchSize,
    '--temp': settings.temp,
    '--repeat-penalty': settings.repeatPenalty
  }
  return {
    ...base,
    description: settings.description,
    args,
    argsByParamSet: { llamacpp: args }
  }
}
