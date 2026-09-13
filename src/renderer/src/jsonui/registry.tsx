import React from 'react'
import { defineRegistry } from '@json-render/react'
import { catalog } from './catalog'
import './jsonui.css'
import { GpuUsagePanel } from './components/GpuUsagePanel'
import { MessageCard } from './components/MessageCard'
import { ChartCard, normalizeChartSpec } from '../recharts'
import { MermaidCard, convertToMermaid, detectChartTypeFromProps } from '../mermaid'

// ===== 智能路由组件：100% 自动检测 =====
function UniversalChart(renderProps: any) {
  // 获取所有可能的数据源，使用 ?? 防止空字符串 "" 被错误 fallback
  const props = renderProps.props ?? renderProps ?? {}
  const code = props.code ?? renderProps.code ?? ''

  // ===== 检测 1：如果有 code，直接用 MermaidCard =====
  if (code) {
    // zoomable={false}：jsonui 渲染的图表不带放大/全屏，只保留 复制 / 下载 / 查看源码。
    // 直连的 ```mermaid / ```chart 围栏不经这里，缩放功能照常。
    return <MermaidCard {...renderProps} zoomable={false} />
  }

  // ===== 检测 2：能归一化成 ChartSpec 就交给图表卡片 =====
  // 这里用 normalizeChartSpec 实打实校验一遍，而不是靠「有 data / xKey / yKey」
  // 猜字段名：猜中的 spec 若解析不出来，卡片会渲染成空白；校验过再渲染则不会。
  if (normalizeChartSpec(props)) {
    return <ChartCard props={props} zoomable={false} />
  }

  // ===== 检测 3：如果是 Mermaid 结构化数据 =====
  const hasMermaidData =
    props.dateFormat ||
    props.section ||
    props.labels ||
    props.values ||
    props.xLabels ||
    props.xAxis ||
    props.yAxis ||
    props.bars ||
    props.lines ||
    (Array.isArray(props.children) && props.children.length > 0) ||
    (Array.isArray(props.data) && props.data.length > 0)

  if (hasMermaidData) {
    const detectedType = detectChartTypeFromProps(props)
    const convertedCode = convertToMermaid(props, detectedType)
    if (convertedCode) {
      return <MermaidCard props={{ ...props, code: convertedCode, title: props.title }} zoomable={false} />
    }
  }

  // ===== 检测 4：尝试从 children 中检测 Mermaid 语法 =====
  if (Array.isArray(renderProps.children)) {
    const firstChild = renderProps.children[0]
    if (typeof firstChild === 'string') {
      const mermaidKeywords = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram',
        'stateDiagram', 'gantt', 'erDiagram', 'pie', 'mindmap', 'timeline', 'gitGraph', 'sankey']
      if (mermaidKeywords.some(kw => firstChild.includes(kw))) {
        return <MermaidCard props={{ code: renderProps.children.join('\n'), title: props.title }} zoomable={false} />
      }
    }
  }

  // ===== 检测 5：未知类型，显示错误 =====
  return (
    <div style={{
      padding: 16,
      border: '1px solid #ef4444',
      borderRadius: 8,
      color: '#dc2626',
      background: '#fef2f2'
    }}>
      <strong>⚠️ 无法识别的图表数据</strong>
      <div style={{ fontSize: 12, marginTop: 8, color: '#6b7280' }}>
        请检查数据格式是否正确
      </div>
    </div>
  )
}

export const { registry } = defineRegistry(catalog, {
  components: {
    GpuUsagePanel,
    MessageCard,
    // ===== 关键：把 Chart 和 MermaidCard 合并成 UniversalChart =====
    Chart: UniversalChart,
    MermaidCard: UniversalChart,

    // 所有图表类型都指向 UniversalChart
    flowchart: UniversalChart,
    sequence: UniversalChart,
    class: UniversalChart,
    state: UniversalChart,
    gantt: UniversalChart,
    er: UniversalChart,
    journey: UniversalChart,
    git: UniversalChart,
    mindmap: UniversalChart,
    timeline: UniversalChart,
    pie: UniversalChart,
    sankey: UniversalChart,
    xychart: UniversalChart,
    quadrant: UniversalChart,
    requirement: UniversalChart,
    architecture: UniversalChart,
    block: UniversalChart,
    packet: UniversalChart,
    kanban: UniversalChart,
    swimlane: UniversalChart,
    usecase: UniversalChart,
    c4: UniversalChart,
    c4context: UniversalChart,
    c4container: UniversalChart,
    c4component: UniversalChart,
    c4dynamic: UniversalChart,
    c4deployment: UniversalChart,
    zenuml: UniversalChart,
    radar: UniversalChart,
    treemap: UniversalChart,
    venn: UniversalChart,
    ishikawa: UniversalChart,
    wardley: UniversalChart,
    cynefin: UniversalChart,
    treeview: UniversalChart,
    eventmodeling: UniversalChart,
  },
  actions: {},
})
