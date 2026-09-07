import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { z } from 'zod'

export const catalog = defineCatalog(schema, {
  components: {
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
    MessageCard: {
      props: z.object({
        variant: z.enum(['info', 'success', 'warning', 'error']),
        title: z.string(),
        message: z.string(),
      }),
      description: '通用提示卡片',
    },
    Chart: {
      props: z.object({
        type: z.enum(['line', 'bar', 'pie']),
        title: z.string().nullable(),
        data: z.array(z.record(z.string(), z.any())),
        xKey: z.string(),
        yKey: z.string(),
      }),
      description: '简单图表（折线/柱状/饼图）；data 由调用方提供具体值，xKey/yKey 指定字段',
    },
  },
  actions: {},
})

export type AppCatalog = typeof catalog
