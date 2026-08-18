export interface ModelDiagnosis {
  id: string
  code: number | null
  severity: 'info' | 'warning' | 'critical'
  title: string
  cause: string
  recommendations: string[]
  evidence: string
  logExcerpt?: { lines: string[]; start: number; errorLine: number }
}

interface DiagnosisRule {
  severity: 'info' | 'warning' | 'critical'
  title: string
  cause: string
  recommendations: string[]
  patterns: RegExp[]
}

const RULES: DiagnosisRule[] = [
  {
    severity: 'warning',
    title: '上下文窗口设置过大',
    cause: 'KV cache 所需内存超过可用（显存/系统）内存。',
    recommendations: ['减小 --ctx-size 为当前值的一半', '--mlock 改为 off（允许换页）', '改用 KV cache 更省内存的量化（Q8 → Q4_0）'],
    patterns: [/kv cache.*(?:out of memory|failed|overflow|insufficient|not enough)/i, /failed to alloc.*kv/i, /llama_kv_cache.*(?:failed|insufficient)/i],
  },
  {
    severity: 'critical',
    title: 'GPU 显存（VRAM）不足',
    cause: '模型权重或 KV cache 无法在 GPU 显存中完成分配。',
    recommendations: ['降低显卡卸载层数（-ngl 减半，如 99 → 20）', '减小 --ctx-size（如 8192 → 4096）', '改用更小的量化等级（Q8 → Q4_K_M）', '关闭其他占用显存的应用'],
    patterns: [/cuda\s*error:?.*out of memory/i, /failed to allocate\s+(?:cpu|gpu|metal)\s+memory/i, /not enough memory\b/i, /\bOOM\b/i, /out of memory/i, /failed to alloc/i, /cannot allocate\b/i],
  },
  {
    severity: 'warning',
    title: 'CUDA 后端不可用',
    cause: '系统没有可用的 CUDA 设备，或驱动/CUDA 运行库与编译版本不匹配。',
    recommendations: ['改用 CPU 版（GGUF 纯 CPU 推理可运行）', '更新 NVIDIA 显卡驱动', '确认后端为 cuda 版本并重装'],
    patterns: [/no\s+cuda\s*(?:capable)?\s*device/i, /could not find cuda/i, /cuda\s+error/i, /cublas\s+error/i, /failed to initialize cuda/i],
  },
  {
    severity: 'warning',
    title: '端口被占用',
    cause: '指定端口已被其他程序或其他 llama-server 实例占用，服务无法监听。',
    recommendations: ['更换端口（设置中修改 --port）', '使用任务管理器结束占用该端口的进程', '检查是否已有重复启动的模型卡片'],
    patterns: [/address already in use/i, /bind\(\).*failed/i, /failed to bind/i, /address in use/i, /eaddrinuse/i],
  },
  {
    severity: 'critical',
    title: '模型文件缺失或损坏',
    cause: 'GGUF 模型文件不存在、未下载完整或被损坏，无法加载。',
    recommendations: ['检查模型路径与文件名是否一致', '重新下载模型（模型中心里可校验哈希）', '确认磁盘空间充足'],
    patterns: [/failed to load model/i, /no such file/i, /cannot open\b/i, /model file.*not found/i, /llama_model_load\s*.*failed/i, /failed to mmap/i, /garbage or unsupported file format/i, /invalid file format/i, /garbage at end of file/i],
  },
  {
    severity: 'warning',
    title: '模型格式或量化不兼容',
    cause: '模型文件的量化格式或张量结构与当前 llama.cpp 版本不兼容。',
    recommendations: ['改用标准 GGUF Q4_K_M / Q8_0 量化', '更新 llama.cpp 后端版本', '使用官方转换工具重新导出模型'],
    patterns: [/unknown quantization/i, /incompatible tensor/i, /unsupported\s+(?:file|format|quant)/i, /failed to parse\s+gguf/i],
  },
  {
    severity: 'warning',
    title: '上下文窗口设置过大',
    cause: 'KV cache 所需内存超过可用（显存/系统）内存。',
    recommendations: ['减小 --ctx-size 为当前值的一半', '--mlock 改为 off（允许换页）', '改用 KV cache 更省内存的量化（Q8 → Q4_0）'],
    patterns: [/kv cache.*(?:out of memory|failed|overflow)/i, /failed to allocate.*kv/i, /kv cache.*insufficient/i, /not enough space.*kv/i],
  },
  {
    severity: 'warning',
    title: '模型元数据异常',
    cause: '模型文件的元数据（架构 / 词表 / 参数）读取失败或不受支持。',
    recommendations: ['确认模型架构受当前后端支持', '重新下载模型文件', '更新后端版本后重试'],
    patterns: [/metadata.*(?:invalid|missing|failed)/i, /unknown arch/i, /unsupported.*arch/i, /vocabulary.*(?:failed|invalid)/i],
  },
  {
    severity: 'warning',
    title: '架构不匹配',
    cause: '后端可执行文件与当前系统架构（x64/ARM64）不符合。',
    recommendations: ['在设置中删除当前后端', '下载本机架构对应的版本（x64）', '64 位系统无法运行 32 位后端'],
    patterns: [/arch.*(?:mismatch|not support)/i, /wrong architecture/i, /cannot run.*arm64|bad cpu type/i],
  },
]

export function diagnoseModelFailure(code: number | null, stderr: string, stdout: string, id: string): ModelDiagnosis {
  const full = `${stderr}\n${stdout}`.slice(-8000)
  const lines = full.split('\n')
  const evidence = lines
    .map(l => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join('; ')
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(full)) {
        return {
          id,
          code,
          severity: rule.severity,
          title: rule.title,
          cause: rule.cause,
          recommendations: rule.recommendations,
          evidence,
          logExcerpt: extractExcerpt(lines, lines.findIndex(l => p.test(l))),
        }
      }
    }
  }
  return {
    id,
    code,
    severity: 'info',
    title: code ? `进程异常退出（代码 ${code}）` : '进程异常退出',
    cause: evidence || '没有捕获到有效的错误日志。',
    recommendations: ['查看模型卡片日志确认具体错误', '尝试减少 --ctx-size 或 -ngl 后重试', '在设置中切换后端版本'],
    evidence,
    logExcerpt: extractExcerpt(lines, -1),
  }
}

// 命中行前后各取若干行作为日志摘录；未命中（errorLine < 0）时取日志尾部 30 行
function extractExcerpt(
  lines: string[],
  errorLine: number,
  before = 8,
  after = 12,
): ModelDiagnosis['logExcerpt'] {
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean).length
  if (nonEmpty === 0) return undefined
  let start: number
  let end: number
  if (errorLine < 0) {
    start = Math.max(0, lines.length - 30)
    end = lines.length
  } else {
    start = Math.max(0, errorLine - before)
    end = Math.min(lines.length, errorLine + after + 1)
  }
  return {
    lines: lines.slice(start, end),
    start: start + 1,
    errorLine: errorLine - start,
  }
}