/**
 * stable-diffusion.cpp / llama-server 图像生成日志解析器。
 *
 * 从后端 stderr/stdout 的进度条与阶段标记行中提取「当前阶段 / 进度 / 详情」,
 * 供图像生成界面可视化生成过程(加载模型 → 提示词编码 → 扩散采样 → VAE 解码 → 完成)。
 *
 * 日志样例(sd-server / llama-server 输出,进度条以 \r 或 \n 刷新):
 *   |######| 39/386 - 711.63MB/s          → 模型加载(块计数)
 *   |============>| 1/4 - 10.14s/it       → 采样步骤(步数)
 *   |#| 6/452 - 0.00MB/s                  → 采样内部迭代
 *   |###| 138/138 - 879.07MB/s            → VAE 解码
 */

export type SdGenStage = 'idle' | 'load' | 'encode' | 'sampling' | 'decode' | 'done'

/** 解析器对外暴露的进度快照 */
export interface SdGenSnapshot {
  stage: SdGenStage
  /** 0-1,无进度时为 null */
  progress: number | null
  /** 阶段描述 / 进度详情文本(如 39/386、迭代 6/452、步进 1/4) */
  detail: string
  /** 同阶段内进度条系列(如 452 迭代 → 4 步)切换次数,从 1 起 */
  round: number
}

export const SD_STAGE_TEXT: Record<SdGenStage, string> = {
  idle: '等待中',
  load: '加载模型中',
  encode: '提示词编码中',
  sampling: '扩散采样中',
  decode: 'VAE 解码中',
  done: '生成完成'
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const LINE_SPLIT_RE = /\r\n|\r|\n/
// 进度条:`  |######| 39/386 - 711.63MB/s` / `  |============>| 1/4 - 10.14s/it`
// (填充符后到收尾 `|` 之间可能有空格;进行中的步进条在 `>` 后仍以 `|` 收尾)
const PROGRESS_BAR_RE = /^\s*\|([#=>]+)\s*\|\s*(\d+)\s*\/\s*(\d+)\b/
const GENERATING_IMAGE_RE = /generating image:\s*(\d+)\s*\/\s*(\d+)/

interface SdParseState extends SdGenSnapshot {
  /** 当前进度条系列标识(step-总数 / iter-总数),用于识别系列切换 */
  seriesKey: string | null
}

export function createSdLogParser() {
  let buf = ''
  const st: SdParseState = { stage: 'idle', progress: null, detail: '', seriesKey: null, round: 1 }

  /** 喂入一段日志文本(可能跨 chunk/行);返回本轮是否有进度变化 */
  const ingest = (text: string): boolean => {
    const full = buf + text
    const lines = full.split(LINE_SPLIT_RE)
    buf = lines.pop() || ''
    let changed = false
    for (const raw of lines) {
      const line = raw.replace(ANSI_RE, '').trim()
      if (!line) continue
      if (applyLine(st, line)) changed = true
    }
    return changed
  }

  const snapshot = (): SdGenSnapshot => ({
    stage: st.stage,
    progress: st.progress,
    detail: st.detail,
    round: st.round
  })

  const reset = (): void => {
    buf = ''
    st.stage = 'idle'
    st.progress = null
    st.detail = ''
    st.seriesKey = null
    st.round = 1
  }

  return { ingest, snapshot, reset }
}

function applyLine(st: SdParseState, line: string): boolean {
  let changed = false

  // ── 阶段标记(按日志出现顺序判断) ──
  if (line.includes('loading diffusion model')) {
    changed = switchStage(st, 'load', '加载扩散模型') || changed
  } else if (line.includes('loading llm from')) {
    changed = switchStage(st, 'load', '加载文本编码器 (CLIP)') || changed
  } else if (line.includes('loading vae from')) {
    changed = switchStage(st, 'load', '加载 VAE 解码器') || changed
  } else if (line.includes('get_learned_condition completed')) {
    changed = setDetail(st, 'encode', '提示词编码完成') || changed
  } else if (GENERATING_IMAGE_RE.test(line)) {
    const m = line.match(GENERATING_IMAGE_RE)!
    const label = Number(m[1]) === 1 && Number(m[2]) === 1 ? '生成图像中' : `生成第 ${m[1]}/${m[2]} 张`
    changed = switchStage(st, 'sampling', label) || changed
  } else if (line.includes('sampling completed')) {
    if (st.stage !== 'sampling' || st.detail !== '采样完成' || st.progress !== 1) changed = true
    st.stage = 'sampling'
    st.detail = '采样完成'
    st.progress = 1
  } else if (/decoding\s+\d+\s+latents/.test(line)) {
    changed = switchStage(st, 'decode', 'VAE 解码中') || changed
  } else if (line.includes('generate_image completed')) {
    if (st.stage !== 'done' || st.progress !== 1) changed = true
    st.stage = 'done'
    st.progress = 1
    st.detail = '生成完成'
  }

  // ── 进度条 ──
  const pm = line.match(PROGRESS_BAR_RE)
  if (pm) {
    const cur = Number(pm[2])
    const total = Number(pm[3])
    if (total > 0) {
      // `#` 填充为迭代/加载条(如 |##| 39/386),`=`/`>` 填充为采样步进条(如 |====>| 1/4、|====| 4/4)
      const isStep = pm[1].includes('=')
      const key = `${isStep ? 'step' : 'iter'}-${total}`
      if (st.seriesKey && st.seriesKey !== key) st.round++
      st.seriesKey = key
      st.progress = Math.min(1, cur / total)
      st.detail = st.stage === 'sampling'
        ? (isStep ? `步进 ${cur}/${total}` : `迭代 ${cur}/${total}`)
        : `${cur}/${total}`
      changed = true
    }
  }
  return changed
}

/** 切换到新阶段:重置进度并复位系列跟踪 */
function switchStage(st: SdParseState, stage: SdGenStage, detail: string): boolean {
  const changed = st.stage !== stage || st.detail !== detail || st.progress !== null
  if (st.stage !== stage) {
    st.seriesKey = null
    st.round = 1
  }
  st.stage = stage
  st.detail = detail
  st.progress = null
  return changed
}

/** 仅更新阶段与描述(不重置进度,如编码完成) */
function setDetail(st: SdParseState, stage: SdGenStage, detail: string): boolean {
  const changed = st.stage !== stage || st.detail !== detail
  st.stage = stage
  st.detail = detail
  return changed
}
