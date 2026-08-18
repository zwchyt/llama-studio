import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { z } from 'zod'

export const catalog = defineCatalog(schema, {
  components: {
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        format: z.enum(['currency', 'percent', 'number']).nullable(),
        hint: z.string().nullable(),
      }),
      description: '展示一个 KPI 数值',
    },
    InferenceMetrics: {
      props: z.object({
        status: z.enum(['running', 'loading', 'stopped', 'failed']),
        promptTokensPerSec: z.number().nullable(),
        generationTokensPerSec: z.number().nullable(),
        ctxTokens: z.number().nullable(),
        ctxLimit: z.number().nullable(),
        kvCacheMb: z.number().nullable(),
        gpuMemMb: z.number().nullable(),
      }),
      description: '推理引擎实时性能指标面板',
    },
    GpuUsagePanel: {
      props: z.object({
        engine: z.string(),
        utilization: z.number().nullable(),
        memoryUsedMb: z.number().nullable(),
        memoryTotalMb: z.number().nullable(),
        temperature: z.number().nullable(),
      }),
      description: 'GPU 显存与利用率面板',
    },
    ModelRuntimeStatus: {
      props: z.object({
        modelName: z.string(),
        engine: z.string(),
        port: z.number().nullable(),
        uptimeSec: z.number().nullable(),
        status: z.enum(['running', 'loading', 'stopped', 'failed']),
        contextLength: z.number().nullable(),
      }),
      description: '当前运行模型的状态卡片',
    },
    ErrorDiagnosisCard: {
      props: z.object({
        severity: z.enum(['info', 'warning', 'critical']),
        title: z.string(),
        cause: z.string(),
        recommendations: z.array(z.string()),
      }),
      description: '错误诊断卡片：原因与修复建议',
    },
    LogExcerpt: {
      props: z.object({
        title: z.string(),
        level: z.enum(['info', 'warning', 'critical']),
        lines: z.array(z.string()),
        start: z.number(),
        errorLine: z.number(),
      }),
      description: '日志摘要片段',
    },
    AgentStepCard: {
      props: z.object({
        status: z.enum(['pending', 'running', 'success', 'failed']),
        title: z.string(),
        description: z.string().nullable(),
        durationMs: z.number().nullable(),
      }),
      description: 'Agent 单步执行状态卡片',
    },
    TaskTimeline: {
      props: z.object({
        title: z.string().nullable(),
        steps: z.array(
          z.object({
            title: z.string(),
            status: z.enum(['pending', 'running', 'success', 'failed']),
            detail: z.string().nullable(),
          })
        ),
      }),
      description: '多步任务时间线',
    },
    ConfirmDangerousAction: {
      props: z.object({
        title: z.string(),
        message: z.string(),
        dangerLevel: z.enum(['warning', 'danger']),
        confirmLabel: z.string().nullable(),
      }),
      description: '危险操作二次确认卡片',
    },
    DownloadProgressCard: {
      props: z.object({
        fileName: z.string(),
        progress: z.number().min(0).max(100),
        speedMbPerSec: z.number().nullable(),
        sizeMb: z.number().nullable(),
        status: z.enum(['downloading', 'paused', 'verifying', 'done', 'failed']),
      }),
      description: '模型下载进度卡片',
    },
    ConfigurationDiff: {
      props: z.object({
        title: z.string(),
        changes: z.array(
          z.object({
            key: z.string(),
            from: z.string(),
            to: z.string(),
          })
        ),
      }),
      description: '配置项修改前后对比',
    },
    MessageCard: {
      props: z.object({
        variant: z.enum(['info', 'success', 'warning', 'error']),
        title: z.string(),
        message: z.string(),
      }),
      description: '通用提示卡片',
    },
  },
  actions: {
    retryModelLoad: { description: '重试加载失败的模型' },
    openLogFile: { description: '打开指定日志文件' },
    copySuggestedArgs: { description: '复制建议的启动参数' },
    applyRuntimePreset: { description: '应用推荐的运行预设' },
    confirmDangerousAction: { description: '确认执行危险操作' },
    dismissCard: { description: '关闭卡片' },
  },
})

export type AppCatalog = typeof catalog