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
  setGenerating: (v: boolean) => void
  setResults: (r: ImageGenItem[]) => void
  setHistory: (r: ImageGenItem[] | ((prev: ImageGenItem[]) => ImageGenItem[])) => void
  setElapsed: (n: number) => void
  setProgress: (n: number | null) => void
  setProgressPreview: (s: string | null) => void
  setLastGen: (v: ImageLastGenInfo | null) => void
  setError: (s: string) => void
  /** 以生成：重置计时，启动计时/预览轮询（跨组件卸载仍存活） */
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

  setGenerating: (v) => set({ generating: v }),
  setResults: (r) => set({ results: r }),
  setHistory: (r) => set((s) => ({ history: typeof r === 'function' ? (r as (p: ImageGenItem[]) => ImageGenItem[])(s.history) : r })),
  setElapsed: (n) => set({ elapsed: n }),
  setProgress: (n) => set({ progress: n }),
  setProgressPreview: (s) => set({ progressPreview: s }),
  setLastGen: (v) => set({ lastGen: v }),
  setError: (s) => set({ error: s }),

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