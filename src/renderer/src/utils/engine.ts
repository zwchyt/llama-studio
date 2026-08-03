import type { EngineKind } from '../../../shared/types'

/** 全部可选引擎（参数集切换按钮的固定顺序） */
export const ALL_ENGINES: Exclude<EngineKind, 'other'>[] = ['llamacpp', 'tensorsharp', 'turboquant', 'beellama']

/** 引擎显示名（用于徽章 / 标签 / 下拉项） */
export const ENGINE_LABELS: Record<Exclude<EngineKind, 'other'>, string> = {
  llamacpp: 'llama.cpp',
  tensorsharp: 'TensorSharp',
  turboquant: 'TurboQuant',
  beellama: 'BeeLlama'
}

/** 将后端类型归一化为可用的参数集名：'other'（无法识别的 exe）按 llama.cpp 行为处理 */
export function paramSetOf(kind: EngineKind | undefined | null): Exclude<EngineKind, 'other'> {
  return kind === 'tensorsharp' || kind === 'turboquant' || kind === 'beellama' ? kind : 'llamacpp'
}
