import { useEffect } from 'react'
import { useStateStore } from '@json-render/react'
import { useStore } from '../store/useStore'
import type { ModelMetrics } from '../../../shared/types'

const METRIC_MAP: Record<string, (m: ModelMetrics) => unknown> = {
  '/metrics/gpuUtilization': (m) => m.gpuUtilization,
  '/metrics/vramUsedMb': (m) => m.vramUsedMb,
  '/metrics/vramTotalMb': (m) => m.vramTotalMb,
  '/metrics/gpuTemperature': (m) => m.gpuTemperature,
  '/metrics/cpuUsage': (m) => m.cpuUsage,
  '/metrics/decodeTokS': (m) => m.decodeTokS,
  '/metrics/reqPerSec': (m) => m.reqPerSec,
  '/metrics/ttftMs': (m) => m.ttftMs,
  '/metrics/prefillTokS': (m) => m.prefillTokS,
  '/metrics/nCtx': (m) => m.nCtx,
  '/metrics/nDecoded': (m) => m.nDecoded,
  '/metrics/nPromptTokens': (m) => m.nPromptTokens,
  '/metrics/isProcessing': (m) => m.isProcessing,
}

export default function MetricsBridge({ modelId }: { modelId: string }) {
  const { update } = useStateStore()
  const metrics = useStore((s) => (modelId ? s.modelMetrics[modelId] : undefined))
  useEffect(() => {
    if (!metrics) return
    const updates: Record<string, unknown> = {}
    for (const [path, pick] of Object.entries(METRIC_MAP)) {
      updates[path] = pick(metrics)
    }
    update(updates)
  }, [metrics, update])
  return null
}