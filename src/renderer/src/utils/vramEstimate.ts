// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 显存装载估算（vramEstimate）—— 纯函数，供「模型工具 → 显存计算器」使用        ║
// ║                                                                              ║
// ║ 思路：不再黑盒转发 llama-fit-params，而是用 GGUF 元数据 + 模型文件大小 +       ║
// ║       用户显卡的实际可用显存，透明地算出「权重 + KV 缓存 + 预留 = 总需求」，   ║
// ║       并求解在给定显存预算下能放几层（-ngl）。每一项都可见、随上下文实时变。   ║
// ║                                                                              ║
// ║ 说明：这是解析式估算，不含运行期碎片/CUDA context 的精确值，故「预留」为经验    ║
// ║       常数；结果用于「装不装得下 / 大致该给多少 ngl」的判断，非逐字节精确。     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

export const MIB = 1024 * 1024
export const GIB = 1024 * 1024 * 1024

// KV 缓存单元素字节数（近似）：F16=2、Q8_0≈1、Q4_0≈0.5
export type KvType = 'f16' | 'q8_0' | 'q4_0'
export const KV_TYPE_BYTES: Record<KvType, number> = { f16: 2, q8_0: 1, q4_0: 0.5 }
export const KV_TYPE_LABELS: Record<KvType, string> = { f16: 'F16（默认）', q8_0: 'Q8_0', q4_0: 'Q4_0' }

// 预留（计算缓冲 + CUDA context 等）经验值：仅在有 GPU 卸载时计入
const OVERHEAD_BASE_BYTES = 350 * MIB
// 计算缓冲随上下文/隐藏维度轻微增长的经验项（每 token 每维一个很小系数）
const OVERHEAD_CTX_COEF = 2

export interface VramEstimateInput {
  fileSizeBytes: number   // 模型文件大小 ≈ 量化后权重总量
  nLayer: number          // block_count
  nEmbd: number           // embedding_length
  nHead: number           // attention.head_count
  nHeadKv: number         // attention.head_count_kv（GQA；缺省回退 nHead）
  ctxSize: number         // 目标上下文长度（token）
  kvBytesPerElem: number  // KV 单元素字节（见 KV_TYPE_BYTES）
  nGpuLayers: number      // 拟卸载到 GPU 的层数；-1 表示全部
}

export interface VramEstimate {
  gpuLayers: number         // 实际用于计算的卸载层数（已 clamp）
  weightsTotalBytes: number // 全部权重
  weightsGpuBytes: number   // 卸载到 GPU 的权重
  kvTotalBytes: number      // 全部层 KV（@ctx）
  kvGpuBytes: number        // GPU 上的 KV（@ctx）
  overheadBytes: number     // 预留（估算）
  totalGpuBytes: number     // GPU 总需求 = 权重(GPU) + KV(GPU) + 预留
  perLayerWeightBytes: number
  perTokenKvBytes: number   // 全部层、每 token 的 KV 字节（不含 ctx）
}

/** 元数据是否足以估算（缺关键字段时无法算 KV） */
export function canEstimate(m: Partial<VramEstimateInput>): boolean {
  return !!(m.fileSizeBytes && m.nLayer && m.nEmbd && m.nHead)
}

export function estimateVram(input: VramEstimateInput): VramEstimate {
  const nLayer = Math.max(1, Math.floor(input.nLayer))
  const nGpu = input.nGpuLayers < 0 ? nLayer : Math.max(0, Math.min(Math.floor(input.nGpuLayers), nLayer))
  const gpuFrac = nGpu / nLayer

  // ── 权重：文件大小按层线性分摊（含非层张量的近似占比）──
  const weightsTotalBytes = input.fileSizeBytes
  const perLayerWeightBytes = weightsTotalBytes / nLayer
  const weightsGpuBytes = weightsTotalBytes * gpuFrac

  // ── KV 缓存：2(K+V) × 层 × KV头 × 头维 × 字节 × ctx ──
  const headDim = input.nHead > 0 ? input.nEmbd / input.nHead : 0
  const nKv = input.nHeadKv > 0 ? input.nHeadKv : input.nHead
  const perTokenKvBytes = 2 * nLayer * nKv * headDim * input.kvBytesPerElem
  const kvTotalBytes = perTokenKvBytes * Math.max(0, input.ctxSize)
  const kvGpuBytes = kvTotalBytes * gpuFrac

  // ── 预留：仅在有卸载时计入 ──
  const overheadBytes = nGpu > 0
    ? OVERHEAD_BASE_BYTES + OVERHEAD_CTX_COEF * Math.max(0, input.ctxSize) * input.nEmbd
    : 0

  const totalGpuBytes = weightsGpuBytes + kvGpuBytes + overheadBytes

  return {
    gpuLayers: nGpu,
    weightsTotalBytes,
    weightsGpuBytes,
    kvTotalBytes,
    kvGpuBytes,
    overheadBytes,
    totalGpuBytes,
    perLayerWeightBytes,
    perTokenKvBytes,
  }
}

/**
 * 在给定显存预算下能放的最大层数（-ngl）。
 * 权重与 KV 均随 ngl 近似线性增长，故从满层向下找到首个装得下的层数。
 * 返回 nLayer 表示可全量卸载；返回 0 表示连 1 层都放不下（应纯 CPU）。
 */
export function maxGpuLayers(input: Omit<VramEstimateInput, 'nGpuLayers'>, availBytes: number): number {
  const nLayer = Math.max(1, Math.floor(input.nLayer))
  for (let ngl = nLayer; ngl >= 1; ngl--) {
    const est = estimateVram({ ...input, nGpuLayers: ngl })
    if (est.totalGpuBytes <= availBytes) return ngl
  }
  return 0
}

/**
 * 反解：在给定显存预算与卸载层数下，能开的最大上下文（token）。
 * 总需求对 ctx 是线性函数（KV + 预留的 ctx 项），直接解析求解：
 *   avail = fixed(ctx=0) + ctx × (perTokenKv×gpuFrac + 预留ctx系数×nEmbd)
 * 返回 0 表示连权重都放不下。
 */
export function maxContext(input: Omit<VramEstimateInput, 'ctxSize'>, availBytes: number): number {
  const zero = estimateVram({ ...input, ctxSize: 0 })
  const remain = availBytes - zero.totalGpuBytes
  if (remain <= 0) return 0
  const nLayer = Math.max(1, Math.floor(input.nLayer))
  const gpuFrac = zero.gpuLayers / nLayer
  const perCtxBytes = zero.perTokenKvBytes * gpuFrac + (zero.gpuLayers > 0 ? OVERHEAD_CTX_COEF * input.nEmbd : 0)
  if (perCtxBytes <= 0) return 0
  return Math.floor(remain / perCtxBytes)
}

/** 部分卸载时留在 CPU 内存侧的字节数（未卸载层的权重 + KV） */
export function cpuSideBytes(est: VramEstimate): number {
  return (est.weightsTotalBytes - est.weightsGpuBytes) + (est.kvTotalBytes - est.kvGpuBytes)
}

// 常见量化的等效每权重位数（bpw，含块开销的经验值）：用于“换个量化需要多少显存”的 what-if 对比，
// 仅需 paramCount，无需下载对应文件。Q4_0/Q5_0/Q8_0 为精确值，K 系列为典型实测均值。
export const QUANT_BPW: { name: string; bpw: number }[] = [
  { name: 'Q3_K_M', bpw: 3.9 },
  { name: 'Q4_K_M', bpw: 4.85 },
  { name: 'Q5_K_M', bpw: 5.7 },
  { name: 'Q6_K', bpw: 6.6 },
  { name: 'Q8_0', bpw: 8.5 },
  { name: 'F16', bpw: 16 },
]

/** 按参数量×bpw 估算量化后权重体积（字节） */
export function weightBytesFromBpw(paramCount: number, bpw: number): number {
  return (paramCount * bpw) / 8
}

/** 字节 → GB 字符串（1 位小数） */
export function toGB(bytes: number): string {
  return (bytes / GIB).toFixed(2)
}
