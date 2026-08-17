// 模型能力判定：根据 GGUF 元数据（architecture + tokenizer.chat_template + general.tags）
// 判断模型是否支持 思考模式 / 工具调用 / 看图（视觉）。
import type { GgufKvEntry } from '../../../shared/types'

export interface ModelCapabilities {
  thinking: boolean
  tools: boolean
  vision: boolean
}

// 视觉架构族（llama.cpp 支持的主要多模态架构）
const VISION_ARCHS = new Set([
  'mllama',
  'llava',
  'llava-1.5',
  'llava-1.6',
  'llava-next',
  'minicpmv',
  'qwen2vl',
  'qwen2.5vl',
  'qwen3vl',
  'gemma3',
  'idefics3',
  'paligemma',
  'phi3v',
  'moondream',
  'glm4v',
  'smolvlm',
  'granite-moe',
  // 生图模型架构（stable-diffusion.cpp 系）：图像相关能力统一点亮
  'lumina',
  'lumina2',
  'stable-diffusion',
  'stable-diffusion-xl',
  'sdxl',
  'sd3',
  'sd3.5',
  'flux',
  'flux1',
  's-v-d',
  'svd',
])

// 模板内视觉 token（次要依据）
const VISION_TEMPLATE_RE = /<image>|vision|image_pad|image_token|image_url|image_placeholder/i

// general.tags 里的多模态标记（如 OCR 模型的 ["image-to-text"]）：
// 架构不在视觉名单（glm4/llama 等通用架构 + mmproj）时兜底点亮看图
const VISION_TAGS_RE = /image\s*[-_ ]*\s*to\s*[-_ ]*\s*text|image-text-to-text|vision|multi\s*-?\s*modal/i

// 工具调用模板特征（tools 变量声明 / 工具调用占位符）
const TOOLS_TEMPLATE_RE = /\btools\b|tool_calls|tool_call|'tool_call|"tool_call|function_|handle_tool|messages\.append\(.*tool/i

// 思考模式模板特征
const THINKING_TEMPLATE_RE = /\bthink\b|thinking|reasoning|reasoning_content/i

export function detectModelCapabilities(meta: { architecture?: string; chatTemplate?: string; kv?: GgufKvEntry[] }): ModelCapabilities {
  const arch = meta.architecture || ''
  const tpl = meta.chatTemplate || ''
  const tags = (meta.kv || []).find(k => k.key === 'general.tags')?.arrayPreview?.join(' ') || ''
  return {
    vision: VISION_ARCHS.has(arch.toLowerCase()) || VISION_TEMPLATE_RE.test(tpl) || VISION_TAGS_RE.test(tags),
    tools: TOOLS_TEMPLATE_RE.test(tpl),
    thinking: THINKING_TEMPLATE_RE.test(tpl),
  }
}
