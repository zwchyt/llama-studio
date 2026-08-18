import type { Spec } from '@json-render/core'

export const SAMPLE_SPEC: Spec = {
  root: 'diagnosis',
  elements: {
    diagnosis: {
      type: 'ErrorDiagnosisCard',
      props: {
        severity: 'warning',
        title: 'VRAM 不足，无法加载当前上下文配置',
        cause: '8GB 显存不足以容纳该模型和 8192-token KV cache',
        recommendations: ['将 --ctx-size 调整为 4096', '降低 GPU offload layers 至 20', '关闭其他占用显存的应用'],
      },
      children: ['metrics', 'runtime', 'timeline', 'diff', 'confirm', 'download'],
    },
    metrics: { type: 'InferenceMetrics', props: { status: 'running', promptTokensPerSec: 245.6, generationTokensPerSec: 31.2, ctxTokens: 5120, ctxLimit: 8192, kvCacheMb: 386.4, gpuMemMb: 4210 }, children: [] },
    runtime: { type: 'ModelRuntimeStatus', props: { modelName: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', engine: 'llama-server.exe', port: 8080, uptimeSec: 3721, status: 'running', contextLength: 8192 }, children: [] },
    timeline: {
      type: 'TaskTimeline',
      props: { title: '诊断任务执行步骤', steps: [{ title: '解析 llama-server 启动日志', status: 'success', detail: '定位到 KV cache 分配失败' }, { title: '分析显存占用', status: 'running', detail: 'nvidia-smi 采样中…' }, { title: '生成修复建议', status: 'pending', detail: null }] },
      children: [],
    },
    diff: {
      type: 'ConfigurationDiff',
      props: { title: '建议的参数修改', changes: [{ key: '--ctx-size', from: '8192', to: '4096' }, { key: '-ngl', from: '99', to: '20' }, { key: '--mlock', from: 'off', to: 'on' }] },
      children: [],
      on: { apply: { action: 'applyRuntimePreset' } },
    },
    confirm: {
      type: 'ConfirmDangerousAction',
      props: { title: '确认卸载模型文件', message: '将删除 Qwen2.5-7B-Instruct-Q4_K_M.gguf（4.7GB）。此操作不可撤销。', dangerLevel: 'danger', confirmLabel: '确认删除' },
      children: [],
      on: { confirm: { action: 'confirmDangerousAction' } },
    },
    download: {
      type: 'DownloadProgressCard',
      props: { fileName: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', progress: 62.5, speedMbPerSec: 38.2, sizeMb: 9200, status: 'downloading' },
      children: [],
    },
  },
  state: { activeTab: 'diagnosis' },
}