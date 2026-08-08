import { createWithEqualityFn } from 'zustand/traditional'

/** 图像生成结果单（供「历史 / 结果区」使用，只存轻量元信息 + dataUrl） */
export interface ImageGenItem {
  id: string
  prompt: string
  dataUrl: string
  /** 已自动保存到磁盘的文件名（历史持久化用，展示时按需回读） */
  file?: string
  savedPath?: string
  /** 本次生成所用参数（展示用，便于追溯复现） */
  meta?: {
    mode?: string
    seed?: number
    steps?: number
    cfg?: number
    width?: number
    height?: number
    sampler?: string
    scheduler?: string
  }
  createdAt: number
}

export interface ImageLastGenInfo {
  seed?: number
  elapsedSec?: number
}

/** 用户自定义提示词预览（正向 / 负向各一份，localStorage 持久化） */
export interface ImagePromptPreset {
  id: string
  /** 点击后填入输入框的英文 tag（如 masterpiece） */
  tag: string
  /** 中文说明（界面展示用，如 大师作品） */
  cn: string
  /** 大类（常用 / 环境 / 风格 / 人物 / 服装 / 表情 / 动物 / 动作 / 自定义…） */
  group: string
}

export type PromptPresetSlot = 'pos' | 'neg'

const P = (
  id: string, tag: string, cn: string, group: string
): ImagePromptPreset => ({ id, tag, cn, group })

/** 内置预览（首次进入/用户未自定义时使用）：英文 tag + 中文说明，参考 qpipi 分类 */
export const DEFAULT_PROMPT_PRESETS: Record<PromptPresetSlot, ImagePromptPreset[]> = {
  pos: [
    // ── 常用 ──
    P('u1', 'masterpiece', '大师作品', '常用'),
    P('u2', 'best quality', '最好画质', '常用'),
    P('u3', 'high quality', '高画质', '常用'),
    P('u4', 'highres', '高清', '常用'),
    P('u5', 'ultra detailed', '超精细', '常用'),
    P('u6', '8k', '8K分辨率', '常用'),
    P('u7', 'official art', '官方艺术', '常用'),
    P('u8', 'extremely detailed CG', '极致细节CG', '常用'),
    // ── 环境：日月星辰 ──
    P('e1', 'day', '白天', '环境'),
    P('e2', 'dusk', '黄昏', '环境'),
    P('e3', 'night', '夜晚', '环境'),
    P('e4', 'sun', '太阳', '环境'),
    P('e5', 'sunset', '落日', '环境'),
    P('e6', 'moon', '月亮', '环境'),
    P('e7', 'full_moon', '满月', '环境'),
    P('e8', 'stars', '星星', '环境'),
    P('e9', 'cloudy', '多云', '环境'),
    P('e10', 'rain', '下雨', '环境'),
    P('e11', 'in the rain', '雨中', '环境'),
    P('e12', 'snow', '下雪', '环境'),
    P('e13', 'sunlight', '阳光', '环境'),
    P('e14', 'summer', '夏天', '环境'),
    P('e15', 'winter', '冬天', '环境'),
    // ── 环境：天涯海角 ──
    P('e16', 'sky', '天空', '环境'),
    P('e17', 'sea', '大海', '环境'),
    P('e18', 'mountain', '山', '环境'),
    P('e19', 'on the beach', '海滩上', '环境'),
    P('e20', 'cityscape', '城市风景', '环境'),
    P('e21', 'landscape', '风景', '环境'),
    P('e22', 'beautiful detailed sky', '好天', '环境'),
    P('e23', 'flower field', '花田', '环境'),
    P('e24', 'underwater', '水下', '环境'),
    P('e25', 'forest', '森林', '环境'),
    P('e26', 'stars cluster', '星团', '环境'),
    P('e27', 'aurora', '极光', '环境'),
    P('e28', 'fireworks', '烟花', '环境'),
    // ── 风格 ──
    P('s1', 'artbook', '原画', '风格'),
    P('s2', 'game_cg', '游戏CG', '风格'),
    P('s3', 'comic', '漫画', '风格'),
    P('s4', 'realistic', '写实', '风格'),
    P('s5', 'photo', '照片', '风格'),
    P('s6', 'anime', '动漫', '风格'),
    P('s7', 'sketch', '素描', '风格'),
    P('s8', 'pixel_art', '点阵图', '风格'),
    P('s9', 'watercolor_(medium)', '水彩', '风格'),
    P('s10', 'oil painting', '油画', '风格'),
    P('s11', 'monochrome', '单色', '风格'),
    P('s12', 'colorful', '色彩斑斓', '风格'),
    P('s13', 'cyberpunk', '赛博朋克', '风格'),
    P('s14', 'science_fiction', '科技幻想', '风格'),
    P('s15', 'fantasy', '奇幻', '风格'),
    // ── 人物 ──
    P('p1', 'girl', '女孩', '人物'),
    P('p2', 'boy', '男孩', '人物'),
    P('p3', 'woman', '女人', '人物'),
    P('p4', 'man', '男人', '人物'),
    P('p5', 'solo', '单人', '人物'),
    P('p6', 'little girl', '小女孩', '人物'),
    P('p7', 'kawaii', '可爱', '人物'),
    P('p8', 'bishoujo', '美少女', '人物'),
    P('p9', 'angel', '天使', '人物'),
    P('p10', 'elf', '精灵', '人物'),
    P('p11', 'idol', '偶像', '人物'),
    P('p12', 'maid', '女仆', '人物'),
    P('p13', 'witch', '女巫', '人物'),
    P('p14', 'ninja', '忍者', '人物'),
    P('p15', 'student', '学生', '人物'),
    // ── 服装 ──
    P('c1', 'dress', '连衣裙', '服装'),
    P('c2', 'bikini', '比基尼', '服装'),
    P('c3', 'school uniform', '校服', '服装'),
    P('c4', 'maid uniform', '女仆装', '服装'),
    P('c5', 'kimono', '和服', '服装'),
    P('c6', 'cheongsam', '旗袍', '服装'),
    P('c7', 'military uniform', '军装', '服装'),
    P('c8', 'suit', '西装', '服装'),
    P('c9', 'casual', '休闲', '服装'),
    P('c10', 'hat', '帽子', '服装'),
    P('c11', 'hoodie', '连帽衫', '服装'),
    P('c12', 'white dress', '白裙', '服装'),
    // ── 表情 ──
    P('f1', 'smile', '微笑', '表情'),
    P('f2', 'happy', '开心', '表情'),
    P('f3', 'sad', '悲伤', '表情'),
    P('f4', 'angry', '生气', '表情'),
    P('f5', 'surprised', '惊讶', '表情'),
    P('f6', 'blush', '脸红', '表情'),
    P('f7', 'tears', '眼泪', '表情'),
    P('f8', 'serious', '严肃', '表情'),
    P('f9', 'calm', '平静', '表情'),
    // ── 头发 ──
    P('h1', 'long hair', '长发', '头发'),
    P('h2', 'short hair', '短发', '头发'),
    P('h3', 'ponytail', '马尾辫', '头发'),
    P('h4', 'twintails', '双马尾', '头发'),
    P('h5', 'braid', '辫子', '头发'),
    P('h6', 'blonde hair', '金发', '头发'),
    P('h7', 'black hair', '黑发', '头发'),
    P('h8', 'white hair', '白发', '头发'),
    P('h9', 'brown hair', '棕发', '头发'),
    P('h10', 'blue hair', '蓝发', '头发'),
    P('h11', 'red hair', '红发', '头发'),
    P('h12', 'tan hair', '棕发', '头发'),
    // ── 动作 ──
    P('a1', 'sitting', '坐着', '动作'),
    P('a2', 'standing', '站着', '动作'),
    P('a3', 'lying', '躺着', '动作'),
    P('a4', 'running', '奔跑', '动作'),
    P('a5', 'jumping', '跳跃', '动作'),
    P('a6', 'pointing', '指向', '动作'),
    P('a7', 'waving', '挥手', '动作'),
    P('a8', 'hands on hips', '叉腰', '动作'),
    // ── 眼睛（颜色，状态） ──
    P('ey1', 'eye color', '眼睛颜色', '眼睛'),
    P('ey2', 'blue eyes', '蓝眼睛', '眼睛'),
    P('ey3', 'brown eyes', '棕色眼睛', '眼睛'),
    P('ey4', 'green eyes', '绿眼睛', '眼睛'),
    P('ey5', 'black eyes', '黑眼睛', '眼睛'),
    P('ey6', 'red eyes', '红眼睛', '眼睛'),
    P('ey7', 'purple eyes', '紫眼睛', '眼睛'),
    P('ey8', 'heterochromia', '异色瞳', '眼睛'),
    P('ey9', 'glowing eyes', '发光眼', '眼睛'),
    P('ey10', 'sparkling eyes', '闪闪发光的眼睛', '眼睛'),
    P('ey11', 'closed eyes', '闭眼', '眼睛'),
    P('ey12', 'wide eyes', '睁大眼睛', '眼睛'),
    P('ey13', 'half-closed eyes', '半闭眼', '眼睛'),
    P('ey14', 'anime eyes', '动漫眼', '眼睛'),
    // ── 身体（胸） ──
    P('b1', 'breasts', '胸部', '身体'),
    P('b2', 'large breasts', '胸部丰满', '身体'),
    P('b3', 'medium breasts', '胸部适中', '身体'),
    P('b4', 'small breasts', '胸部小巧', '身体'),
    P('b5', 'flat chest', '平坦胸部', '身体'),
    P('b6', 'cleavage', '沟', '身体'),
    P('b7', 'bare shoulders', '露肩', '身体'),
    // ── 动物 ──
    P('an1', 'cat', '猫', '动物'),
    P('an2', 'dog', '狗', '动物'),
    P('an3', 'bird', '鸟', '动物'),
    P('an4', 'rabbit', '兔子', '动物'),
    P('an5', 'butterfly', '蝴蝶', '动物'),
    P('an6', 'fox', '狐狸', '动物'),
    P('an7', 'wolf', '狼', '动物'),
    P('an8', 'dragon', '龙', '动物'),
    P('an9', 'horse', '马', '动物')
  ],
  neg: [
    // ── 画面质量 ──
    P('nq1', 'lowres', '低分辨率', '画面质量'),
    P('nq2', 'worst quality', '最差质量', '画面质量'),
    P('nq3', 'low quality', '低质量', '画面质量'),
    P('nq4', 'blurry', '模糊', '画面质量'),
    P('nq5', 'jpeg artifacts', '压缩伪影', '画面质量'),
    P('nq6', 'oversharpened', '过度锐化', '画面质量'),
    P('nq7', 'grainy', '颗粒感', '画面质量'),
    P('nq8', 'pixelated', '像素化', '画面质量'),
    // ── 人物缺陷 ──
    P('nd1', 'bad anatomy', '结构错乱', '人物缺陷'),
    P('nd2', 'bad hands', '坏手', '人物缺陷'),
    P('nd3', 'missing fingers', '缺手指', '人物缺陷'),
    P('nd4', 'extra digits', '多手指', '人物缺陷'),
    P('nd5', 'extra limb', '多余肢体', '人物缺陷'),
    P('nd6', 'mutated hands', '畸形手', '人物缺陷'),
    P('nd7', 'deformed', '变形', '人物缺陷'),
    P('nd8', 'bad feet', '坏脚', '人物缺陷'),
    P('nd9', 'cross-eyed', '斗鸡眼', '人物缺陷'),
    P('nd10', 'bad face', '脸崩', '人物缺陷'),
    // ── 杂乱干扰 ──
    P('no1', 'watermark', '水印', '杂项干扰'),
    P('no2', 'signature', '签名', '杂项干扰'),
    P('no3', 'text', '文字', '杂项干扰'),
    P('no4', 'username', '用户名', '杂项干扰'),
    P('no5', 'logo', '徽标', '杂项干扰'),
    P('no6', 'border', '边框', '杂项干扰'),
    P('no7', 'framed', '构图', '杂项干扰'),
    P('no8', 'cropped', '裁切的', '杂项干扰')
  ]
}

const PRESET_STORAGE_KEY = 'imagegen-prompts-presets-v3'

/** 预设分组显示顺序（未知/自定义靠后） */
export const PRESET_GROUP_ORDER = ['常用', '环境', '风格', '人物', '服装', '表情', '头发', '眼睛', '身体', '动作', '动物', '画面质量', '人物缺陷', '杂项干扰', '风景', '其他', '自定义']

/**
 * 从 JSON 文件加载预设（正/反各一份），写入 store。
 * - 用户可直接编辑 resources/ 下的两个 JSON 文件，无需改代码即可增删预设
 * - 首次加载时自动把当前内容（含旧 localStorage 数据）落盘，后续从文件读取
 */
async function loadPresetsFromFile(): Promise<Record<PromptPresetSlot, ImagePromptPreset[]>> {
  let fileData: Record<PromptPresetSlot, ImagePromptPreset[]> | null = null
  try {
    const data = await window.api.loadImagegenPresets()
    fileData = { pos: data.pos, neg: data.neg }
  } catch { /* IPC 失败则用内置默认 */ }
  if (fileData && (fileData.pos.length > 0 || fileData.neg.length > 0)) return fileData

  // 文件为空（首次运行/未生成）：合并旧 localStorage 数据后落盘
  let base: Record<PromptPresetSlot, ImagePromptPreset[]> = {
    pos: DEFAULT_PROMPT_PRESETS.pos.map(p => ({ ...p })),
    neg: DEFAULT_PROMPT_PRESETS.neg.map(p => ({ ...p }))
  }
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pos) && Array.isArray(parsed.neg)) {
        base = { pos: parsed.pos, neg: parsed.neg }
      }
    }
  } catch { /* 忽略损坏数据 */ }
  window.api.saveImagegenPresets(base).catch(() => {})
  return base
}

/** 把预设持久化到 JSON 文件 */
function persistPresets(p: Record<PromptPresetSlot, ImagePromptPreset[]>) {
  window.api.saveImagegenPresets(p).catch(() => {})
}

interface ImageUiState {
  generating: boolean
  elapsed: number
  progress: number | null
  progressPreview: string | null
  results: ImageGenItem[]
  /** 本次会话历史（含磁盘持久化回读） */
  history: ImageGenItem[]
  lastGen: ImageLastGenInfo | null
  error: string
  /** 提示词预设（正向 / 负向），来自 resources/ 下的 JSON 文件 */
  promptPresets: Record<PromptPresetSlot, ImagePromptPreset[]>
  setGenerating: (v: boolean) => void
  setResults: (r: ImageGenItem[]) => void
  setHistory: (r: ImageGenItem[] | ((prev: ImageGenItem[]) => ImageGenItem[])) => void
  setElapsed: (n: number) => void
  setProgress: (n: number | null) => void
  setProgressPreview: (s: string | null) => void
  setLastGen: (v: ImageLastGenInfo | null) => void
  setError: (s: string) => void
  /** 初始化/重新加载预设（从 JSON 文件），应至少调用一次 */
  initPromptPresets: () => Promise<void>
  /** 新增一个标签预设（写入 state 并持久化到 JSON 文件） */
  addPromptPreset: (slot: PromptPresetSlot, tag: string, cn: string) => void
  /** 删除指定预设并持久化到 JSON 文件 */
  removePromptPreset: (slot: PromptPresetSlot, id: string) => void
  /** 恢复为内置默认预设 */
  resetPromptPresets: (slot: PromptPresetSlot) => void
  /** 以生成：重置计时，启动计时/预览端口轮询（跨组件卸载仍存活） */
  startInProgress: () => void
  /** 生成结束：停止计时/轮询并复位进行中状态 */
  stopInProgress: () => void
}

// 计时/轮询 interval 挂在模块作用域，切页卸载组件后仍在后台运行，
// 重新切回时 store 里的进度/结果不丢失，可继续展示。
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let progressTimer: ReturnType<typeof setInterval> | null = null

function clearTimers() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
}

export const useImageStore = createWithEqualityFn<ImageUiState>((set) => ({
  generating: false,
  elapsed: 0,
  progress: null,
  progressPreview: null,
  results: [],
  history: [],
  lastGen: null,
  error: '',
  promptPresets: { pos: [], neg: [] },

  setGenerating: (v) => set({ generating: v }),
  setResults: (r) => set({ results: r }),
  setHistory: (r) => set((s) => ({ history: typeof r === 'function' ? (r as (p: ImageGenItem[]) => ImageGenItem[])(s.history) : r })),
  setElapsed: (n) => set({ elapsed: n }),
  setProgress: (n) => set({ progress: n }),
  setProgressPreview: (s) => set({ progressPreview: s }),
  setLastGen: (v) => set({ lastGen: v }),
  setError: (s) => set({ error: s }),

  initPromptPresets: async () => {
    const loaded = await loadPresetsFromFile()
    set({ promptPresets: loaded })
  },

  addPromptPreset: (slot, tag, cn) => set((s) => {
    const list = s.promptPresets[slot]
    const next = { ...s.promptPresets, [slot]: [...list, { id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, tag, cn, group: '自定义' }] }
    persistPresets(next)
    return { promptPresets: next }
  }),

  removePromptPreset: (slot, id) => set((s) => {
    const next = { ...s.promptPresets, [slot]: s.promptPresets[slot].filter(p => p.id !== id) }
    persistPresets(next)
    return { promptPresets: next }
  }),

  resetPromptPresets: (slot) => set((s) => {
    const next = { ...s.promptPresets, [slot]: DEFAULT_PROMPT_PRESETS[slot].map(p => ({ ...p })) }
    persistPresets(next)
    return { promptPresets: next }
  }),

  startInProgress: () => {
    set({ generating: true, elapsed: 0, progress: null, progressPreview: null })
    clearTimers()
    elapsedTimer = setInterval(() => {
      set((s) => ({ elapsed: s.elapsed + 1 }))
    }, 1000)
  },

  stopInProgress: () => {
    clearTimers()
    set({ generating: false, elapsed: 0, progress: null, progressPreview: null })
  }
}))