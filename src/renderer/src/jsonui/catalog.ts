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
        type: z.enum(['line', 'bar', 'area', 'pie', 'scatter', 'radar']),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.record(z.string(), z.any())),
        xKey: z.string(),
        // 单序列用 yKey；多序列改用 series，此时 yKey 可省
        yKey: z.string().optional(),
        series: z
          .array(
            z.union([
              z.string(),
              z.object({
                key: z.string(),
                name: z.string().optional(),
                color: z.string().optional(),
              }),
            ])
          )
          .optional(),
        stacked: z.boolean().optional(),
        height: z.number().optional(),
        unit: z.string().optional(),
        colors: z.array(z.string()).optional(),
      }),
      description:
        'SVG 图表（折线 line / 柱状 bar / 面积 area / 饼图 pie / 散点 scatter / 雷达 radar）。' +
        'data 每行是一个数据点，xKey 是类目字段，yKey 是取值字段；多序列用 series:["a","b"]。' +
        '正文里也可以直接写 ```chart 围栏 + 同样的 JSON，效果一致。' +
        '注意：结构类图形（流程图/时序图/ER 图等）请用 MermaidCard，不要用 Chart。',
    },
    MermaidCard: {
      props: z.object({
        title: z.string().nullable().optional().default(null),
        code: z.preprocess(
          (val) => (typeof val === 'string' ? val : ''),
          z.string()
        ).default(''),
      }),
      description: 'Mermaid 图形卡片，支持 32 种图表：flowchart/sequence/class/state/gantt/er/journey/git/mindmap/timeline/pie/sankey/xychart/quadrant/requirement/architecture/block/packet/kanban/swimlane/usecase/c4/zenuml/radar/treemap/venn/ishikawa/wardley/cynefin/treeview/eventmodeling。code 字段放纯 Mermaid DSL 文本。',
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
    swimlane: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '泳道图（Mermaid 组件别名）',
    },
    usecase: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '用例图（Mermaid 组件别名）',
    },
    c4: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4架构图（Mermaid 组件别名）',
    },
    c4context: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4 Context图（Mermaid 组件别名）',
    },
    c4container: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4 Container图（Mermaid 组件别名）',
    },
    c4component: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4 Component图（Mermaid 组件别名）',
    },
    c4dynamic: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4 Dynamic图（Mermaid 组件别名）',
    },
    c4deployment: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'C4 Deployment图（Mermaid 组件别名）',
    },
    zenuml: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'ZenUML时序图（Mermaid 组件别名）',
    },
    radar: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '雷达图（Mermaid 组件别名）',
    },
    treemap: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '树状图（Mermaid 组件别名）',
    },
    venn: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '韦恩图（Mermaid 组件别名）',
    },
    ishikawa: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '鱼骨图（Mermaid 组件别名）',
    },
    wardley: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'Wardley地图（Mermaid 组件别名）',
    },
    cynefin: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: 'Cynefin框架图（Mermaid 组件别名）',
    },
    treeview: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '树视图（Mermaid 组件别名）',
    },
    eventmodeling: {
      props: z.object({
        code: z.string().default(''),
        title: z.string().nullable().optional().default(null),
        data: z.array(z.any()).optional(),
        children: z.array(z.any()).optional(),
      }),
      description: '事件建模图（Mermaid 组件别名）',
    },
  },
  actions: {},
})

export type AppCatalog = typeof catalog