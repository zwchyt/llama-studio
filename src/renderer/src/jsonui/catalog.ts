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
    MermaidCard: {
      props: z.object({
        title: z.string().nullable().optional().default(null),
        code: z.preprocess(
          (val) => (typeof val === 'string' ? val : ''),
          z.string()
        ).default(''),
      }),
      description: 'Mermaid 图形卡片，支持 20 种图表：flowchart/sequence/class/state/gantt/er/journey/git/mindmap/timeline/pie/sankey/xychart/quadrant/requirement/architecture/block/packet/kanban。code 是纯 DSL 文本（不要包 ```mermaid 围栏）。',
    },
    // ===== Mermaid 图表类型别名（支持结构化数据输入）=====
    flowchart: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '流程图（Mermaid 组件别名）',
    },
    sequence: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '时序图（Mermaid 组件别名）',
    },
    class: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '类图（Mermaid 组件别名）',
    },
    state: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '状态图（Mermaid 组件别名）',
    },
    gantt: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        dateFormat: z.string().optional(),
        section: z.string().optional(),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '甘特图（Mermaid 组件别名）',
    },
    er: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'ER 图（Mermaid 组件别名）',
    },
    journey: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '用户旅程图（Mermaid 组件别名）',
    },
    git: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'Git 分支图（Mermaid 组件别名）',
    },
    mindmap: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '思维导图（Mermaid 组件别名）',
    },
    timeline: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '时间线图（Mermaid 组件别名）',
    },
    pie: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        labels: z.array(z.string()).optional(),
        values: z.array(z.number()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '饼图（Mermaid 组件别名）',
    },
    sankey: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '桑基图（Mermaid 组件别名）',
    },
    xychart: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'XY 图表（Mermaid 组件别名）',
    },
    quadrant: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '象限图（Mermaid 组件别名）',
    },
    requirement: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '需求图（Mermaid 组件别名）',
    },
    architecture: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '架构图（Mermaid 组件别名）',
    },
    block: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '块图（Mermaid 组件别名）',
    },
    packet: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '数据包图（Mermaid 组件别名）',
    },
    kanban: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '看板图（Mermaid 组件别名）',
    },
  },
  actions: {},
})

export type AppCatalog = typeof catalog