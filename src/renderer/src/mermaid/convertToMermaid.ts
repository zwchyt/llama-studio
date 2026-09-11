// ===== Mermaid 图表类型别名 → 完整 Mermaid 关键字 =====
export const MERMAID_TYPE_KEYWORDS: Record<string, string> = {
  flowchart: 'flowchart',
  graph: 'flowchart',
  sequence: 'sequenceDiagram',
  sequenceDiagram: 'sequenceDiagram',
  class: 'classDiagram',
  classDiagram: 'classDiagram',
  state: 'stateDiagram-v2',
  stateDiagram: 'stateDiagram-v2',
  gantt: 'gantt',
  er: 'erDiagram',
  erDiagram: 'erDiagram',
  journey: 'journey',
  git: 'gitGraph',
  gitGraph: 'gitGraph',
  mindmap: 'mindmap',
  timeline: 'timeline',
  pie: 'pie',
  sankey: 'sankey-beta',
  xychart: 'xychart-beta',
  quadrant: 'quadrantChart',
  requirement: 'requirementDiagram',
  architecture: 'architecture-beta',
  block: 'block-beta',
  packet: 'packet-beta',
  kanban: 'kanban',
  swimlane: 'swimlane-beta',
  usecase: 'usecase-beta',
  c4: 'C4Context',
  c4context: 'C4Context',
  c4container: 'C4Container',
  c4component: 'C4Component',
  c4dynamic: 'C4Dynamic',
  c4deployment: 'C4Deployment',
  zenuml: 'zenuml',
  radar: 'radar-beta',
  treemap: 'treemap-beta',
  venn: 'venn-beta',
  ishikawa: 'ishikawa-beta',
  wardley: 'wardley-beta',
  cynefin: 'cynefin-beta',
  treeview: 'treeView-beta',
  eventmodeling: 'eventmodeling',
}

// 归一化图表类型别名 → switch 分支使用的规范别名（全部小写）
// 例如 "sequenceDiagram"、"Sequence" 都会归一到 "sequence"
export function normalizeAlias(rawType: string): string {
  const lower = String(rawType || '').toLowerCase().trim()
  switch (lower) {
    case 'sequencediagram':
      return 'sequence'
    case 'classdiagram':
      return 'class'
    case 'statediagram':
    case 'statediagram-v2':
      return 'state'
    case 'erdiagram':
      return 'er'
    case 'gitgraph':
      return 'git'
    case 'sankey-beta':
      return 'sankey'
    case 'xychart-beta':
      return 'xychart'
    case 'quadrantchart':
      return 'quadrant'
    case 'requirementdiagram':
      return 'requirement'
    case 'architecture-beta':
      return 'architecture'
    case 'block-beta':
      return 'block'
    case 'packet-beta':
      return 'packet'
    case 'swimlane-beta':
      return 'swimlane'
    case 'usecase-beta':
      return 'usecase'
    case 'c4context':
      return 'c4context'
    case 'c4container':
      return 'c4container'
    case 'c4component':
      return 'c4component'
    case 'c4dynamic':
      return 'c4dynamic'
    case 'c4deployment':
      return 'c4deployment'
    case 'radar-beta':
      return 'radar'
    case 'treemap-beta':
      return 'treemap'
    case 'venn-beta':
      return 'venn'
    case 'ishikawa-beta':
      return 'ishikawa'
    case 'wardley-beta':
      return 'wardley'
    case 'cynefin-beta':
      return 'cynefin'
    case 'treeview-beta':
      return 'treeview'
    default:
      return lower
  }
}

// 由短别名取默认完整关键字（兜底）
export function keywordOfAlias(alias: string): string {
  return MERMAID_TYPE_KEYWORDS[alias] || 'flowchart'
}

// gantt 任务行解析：支持 "名称: 开始, 时长(/结束)" 或 "名称, 开始, 结束" 等形态
function parseGanttTask(child: string, index: number): string {
  const id = `task${String.fromCharCode(97 + index)}`
  // 已是完整 mermaid 任务行（含 :a1 等 id）
  if (/^\s*[^:]+:\s*[a-zA-Z]+\d*\s*,\s*.+,\s*.+/.test(child)) return child.trim()
  // 名称: 开始, 结束/时长
  const m = child.match(/^\s*(.+?)\s*:\s*([\w\-/. :]+?)\s*,\s*([\w\-/. :]+)\s*$/)
  if (m) {
    const name = m[1].trim()
    const start = m[2].trim()
    const endOrDuration = m[3].trim()
    return `${name} :${id}, ${start}, ${endOrDuration}`
  }
  // 名称, 开始, 结束
  const parts = child.split(',').map((s) => s.trim())
  if (parts.length >= 3 && parts[0]) {
    return `${parts[0]} :${id}, ${parts[1]}, ${parts[2]}`
  }
  return child.trim()
}

// ===== 智能转换函数 =====
// 把结构化数据 props 转成纯 Mermaid DSL 文本。首行一律用完整 Mermaid 关键字，
// 否则 MermaidCard.detectChartType 无法识别该图表类型。
export function convertToMermaid(props: any, chartType?: string | null): string {
  const { dateFormat, section, children, data, title, labels, values } = props
  if (props.code) return props.code

  const rawType = chartType || props.type || 'flowchart'
  const alias = normalizeAlias(rawType)
  const keyword = keywordOfAlias(rawType)
  const lines: string[] = [keyword]

  switch (alias) {
    case 'gantt':
      if (dateFormat) lines.push(`dateFormat ${dateFormat}`)
      if (section) lines.push(`section ${section}`)
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child, index) => {
          if (typeof child !== 'string' || !child.trim()) return
          lines.push(parseGanttTask(child, index))
        })
      }
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((task, index) => {
          const id = `task${String.fromCharCode(97 + index)}`
          if (typeof task === 'string') {
            if (task.trim()) lines.push(task)
          } else if (task && task.name && (task.start || task.date) && (task.duration || task.end)) {
            const start = task.start || task.date
            if (task.duration) {
              lines.push(`${task.name} :${id}, ${start}, ${task.duration}`)
            } else {
              const s = new Date(start)
              const e = new Date(task.end)
              const diffDays = Number.isNaN(e.getTime()) ? 1 : Math.max(1, Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)))
              lines.push(`${task.name} :${id}, ${start}, ${diffDays}d`)
            }
          }
        })
      }
      break

    case 'sequence':
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.participant) {
            lines.push(`participant ${item.participant}${item.alias ? ` as ${item.alias}` : ''}`)
          } else if (item && item.actor) {
            lines.push(`actor ${item.actor}`)
          } else if (item && item.from !== undefined && item.to !== undefined) {
            const arrow = item.arrow || '->>'
            lines.push(`${item.from}${arrow}${item.to}${item.message ? `: ${item.message}` : ''}`)
          }
        })
      }
      break
    case 'class':
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.class) {
            const members = Array.isArray(item.members) ? item.members.join('; ') : (item.members || '')
            lines.push(`class ${item.class}${members ? ` {\n  ${members}\n}` : ''}`)
          } else if (item && item.from && item.to && (item.relation || item.arrow)) {
            lines.push(`${item.from} ${item.relation || item.arrow} ${item.to}`)
          }
        })
      }
      break

    case 'state':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.state) {
            lines.push(`state ${item.state}`)
          } else if (item && item.from && item.to) {
            lines.push(`${item.from} --> ${item.to}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'er':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.entity && item.relation && (item.cardinality || item.to)) {
            // 关系行：{ entity, relation, cardinality/to, label }
            const target = item.cardinality || item.to
            const label = item.label || item.name || 'rel'
            lines.push(`  ${item.entity} ${item.relation} ${target} : ${label}`)
          } else if (item && item.entity) {
            // 实体块：{ entity, attributes: [{ type, name }] }
            const attrs = Array.isArray(item.attributes) ? item.attributes : []
            lines.push(`${item.entity} {`)
            attrs.forEach((a: any) => {
              lines.push(`  ${typeof a === 'string' ? a : `${a.type} ${a.name}`}`)
            })
            lines.push('}')
          } else if (item && (item.from || item.start) && (item.to || item.end)) {
            // 兼容 from/to 格式的关系
            const from = item.from || item.start
            const to = item.to || item.end
            const label = item.label || item.name || 'rel'
            lines.push(`  ${from} ${item.relation || '||--o{'} ${to} : ${label}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'journey':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.section) {
            lines.push(`section ${item.section}`)
          } else if (item && item.task !== undefined) {
            lines.push(`${item.task}: ${item.score ?? 5}: ${item.actor || '用户'}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'git':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.commit) {
            lines.push('commit')
          } else if (item && item.branch) {
            lines.push(`branch ${item.branch}`)
          } else if (item && item.checkout) {
            lines.push(`checkout ${item.checkout}`)
          } else if (item && item.merge) {
            lines.push(`merge ${item.merge}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'pie':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.label && item.value !== undefined) {
            lines.push(`"${item.label}" : ${item.value}`)
          }
        })
      }
      if (Array.isArray(labels) && Array.isArray(values)) {
        labels.forEach((label, index) => {
          lines.push(`"${label}" : ${values[index]}`)
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'sankey':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.source && item.target) {
            lines.push(`${item.source} --> ${item.target}: ${item.value}`)
          } else if (item && item.node && item.value !== undefined) {
            lines.push(`${item.node}, ${item.value}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break
    case 'xychart':
      if (title) lines.push(`title "${title}"`)
      if (props.xAxis || props.xLabels) {
        const labels = props.xLabels || props.xAxis
        lines.push(`x-axis [${Array.isArray(labels) ? labels.join(', ') : labels}]`)
      }
      if (props.yAxis !== undefined || props.yMin !== undefined || props.yMax !== undefined) {
        const yTitle = props.yTitle || 'Value'
        const yMin = props.yMin ?? 0
        const yMax = props.yMax ?? 100
        lines.push(`y-axis "${yTitle}" ${yMin} --> ${yMax}`)
      }
      if (Array.isArray(data)) {
        const barData: number[] = []
        const lineData: number[] = []
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'number') {
            barData.push(item)
          } else if (item && typeof item === 'object') {
            if (item.bar !== undefined) barData.push(item.bar)
            if (item.line !== undefined) lineData.push(item.line)
          }
        })
        if (barData.length) lines.push(`bar [${barData.join(', ')}]`)
        if (lineData.length) lines.push(`line [${lineData.join(', ')}]`)
      }
      if (Array.isArray(props.bars)) lines.push(`bar [${props.bars.join(', ')}]`)
      if (Array.isArray(props.lines)) lines.push(`line [${props.lines.join(', ')}]`)
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break
    case 'mindmap':
      if (title) lines.push(`root((${title}))`)
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(`  ${child.trim()}`)
        })
      }
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(`  ${item.trim()}`)
          } else if (item && item.parent && item.child) {
            lines.push(`  ${item.parent} --> ${item.child}`)
          } else if (item && item.text) {
            lines.push(`  ${item.text}`)
          }
        })
      }
      break

    case 'timeline':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.time && item.event) {
            lines.push(`${item.time} : ${item.event}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'quadrant':
      if (title) lines.push(`title ${title}`)
      if (props.xAxis) lines.push(`x-axis ${props.xAxis}`)
      if (props.yAxis) lines.push(`y-axis ${props.yAxis}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.label && item.x !== undefined && item.y !== undefined) {
            lines.push(`${item.label}: [${item.x}, ${item.y}]`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'requirement':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.id) {
            let block = `requirement req${item.id} {\n  id: ${item.id}\n`
            if (item.text) block += `  text: ${item.text}\n`
            if (item.risk) block += `  risk: ${item.risk}\n`
            if (item.verifymethod) block += `  verifymethod: ${item.verifymethod}\n`
            block += '}'
            lines.push(block)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'block':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.columns) {
            lines.push(`  columns ${item.columns}`)
          } else if (item && item.from && item.to) {
            lines.push(`  ${item.from} --> ${item.to}`)
          } else if (item && item.id) {
            const w = item.width ? `:${item.width}` : ''
            lines.push(`  ${item.id}["${item.label || item.id}"]${w}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'kanban':
      if (Array.isArray(data)) {
        const columns = new Map<string, string[]>()
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.column && item.task) {
            if (!columns.has(item.column)) columns.set(item.column, [])
            columns.get(item.column)!.push(item.task)
          }
        })
        columns.forEach((tasks, col) => {
          lines.push(`  ${col}`)
          tasks.forEach(t => lines.push(`    ${t}`))
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'architecture':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.type === 'group') {
            lines.push(`  group ${item.name}(${item.shape})[${item.label || item.name}]`)
          } else if (item && item.type === 'service') {
            const inG = item.inGroup ? ` in ${item.inGroup}` : ''
            lines.push(`  service ${item.name}(${item.shape})[${item.label || item.name}]${inG}`)
          } else if (item && item.from && item.to) {
            lines.push(`  ${item.from} --> ${item.to}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'swimlane':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.lane && item.nodes) {
            lines.push(`subgraph ${item.lane}`)
            const nodes = Array.isArray(item.nodes) ? item.nodes : [item.nodes]
            nodes.forEach((n: any) => {
              if (typeof n === 'string') lines.push(`  ${n}`)
            })
            lines.push('end')
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'usecase':
      lines.push('usecase-beta')
      if (props.direction) lines.push(`  direction ${props.direction}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.actor) {
            const label = item.label || item.actor
            lines.push(`  actor ${item.actor}("${label}")`)
          } else if (item && item.usecase) {
            const label = item.label || item.usecase
            lines.push(`  ${item.usecase}("${label}")`)
          } else if (item && item.from && item.to) {
            lines.push(`  ${item.from} --> ${item.to}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'c4context':
    case 'c4container':
    case 'c4component':
    case 'c4dynamic':
    case 'c4deployment':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.person) {
            lines.push(`Person(${item.person}, "${item.label || item.person}")`)
          } else if (item && item.system) {
            lines.push(`System(${item.system}, "${item.label || item.system}")`)
          } else if (item && item.container) {
            lines.push(`Container(${item.container}, "${item.label || item.container}")`)
          } else if (item && item.component) {
            lines.push(`Component(${item.component}, "${item.label || item.component}")`)
          } else if (item && item.from && item.to) {
            lines.push(`Rel(${item.from}, ${item.to}, "${item.label || ''}")`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'zenuml':
      lines.push('sequenceDiagram')
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.participant) {
            lines.push(`  participant ${item.participant}`)
          } else if (item && item.message) {
            lines.push(`  ${item.from || 'A'}->>${item.to || 'B'}: ${item.message}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'radar':
      if (title) lines.push(`title ${title}`)
      if (props.axis) lines.push(`axis ${props.axis}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.curve) {
            const vals = Array.isArray(item.values) ? item.values.join(',') : (item.values || '')
            const formatted = vals.startsWith('{') ? vals : `{${vals}}`
            lines.push(`curve ${item.curve} ${formatted}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'treemap':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.name) {
            const value = item.value !== undefined ? `: ${item.value}` : ''
            lines.push(`"${item.name}"${value}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'venn':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.set) {
            const size = item.size !== undefined ? `: ${item.size}` : ''
            lines.push(`set ${item.set}${size}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'ishikawa':
      if (title) lines.push(`${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.cause) {
            const category = item.category ? `  ${item.category}` : ''
            lines.push(`${category}${item.cause}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'wardley':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.component) {
            const vis = item.visibility ?? 0.5
            const evo = item.evolution ?? 0.5
            lines.push(`component ${item.component} [${vis}, ${evo}]`)
          } else if (item && item.anchor) {
            const vis = item.visibility ?? 0.9
            const evo = item.evolution ?? 0.95
            lines.push(`anchor ${item.anchor} [${vis}, ${evo}]`)
          } else if (item && item.from && item.to) {
            lines.push(`${item.from} -> ${item.to}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'cynefin':
      if (title) lines.push(`title ${title}`)
      if (Array.isArray(data)) {
        const domains = new Map<string, string[]>()
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.domain && item.item) {
            if (!domains.has(item.domain)) domains.set(item.domain, [])
            domains.get(item.domain)!.push(`"${item.item}"`)
          }
        })
        domains.forEach((items, domain) => {
          lines.push(domain)
          items.forEach(i => lines.push(`  ${i}`))
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'treeview':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.name) {
            const indent = '  '.repeat(item.depth || 0)
            const suffix = item.isDirectory ? '/' : ''
            lines.push(`${indent}${item.name}${suffix}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    case 'eventmodeling':
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.tf) {
            const type = item.type || 'ui'
            const entity = item.entity || item.name || ''
            lines.push(`tf ${item.tf} ${type} ${entity}`)
          }
        })
      }
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      break

    default:
      // flowchart / xychart / quadrant / requirement / architecture / block / packet / kanban
      if (Array.isArray(children)) {
        ;(children as string[]).forEach((child) => {
          if (typeof child === 'string' && child.trim()) lines.push(child.trim())
        })
      }
      if (Array.isArray(data)) {
        ;(data as any[]).forEach((item) => {
          if (typeof item === 'string') {
            if (item.trim()) lines.push(item.trim())
          } else if (item && item.from && item.to) {
            const arrow = item.arrow || '-->'
            const label = item.label ? `|${item.label}|` : ''
            lines.push(`  ${item.from} ${arrow}${label} ${item.to}`)
          } else if (item && item.id) {
            const shape = item.shape === 'round' ? `(${item.id})` : `[${item.id}]`
            lines.push(`  ${shape}`)
          }
        })
      }
  }
  if (lines.length <= 1) return ''
  return lines.join('\n')
}

// 自动检测图表类型：优先看顶层字段与显式 type，再回退到 data/children 结构推断。无法确定返回 null。
export function detectChartTypeFromProps(props: any): string | null {
  if (!props || typeof props !== 'object') return null

  // 1. 显式 type
  if (props.type && typeof props.type === 'string') {
    if (MERMAID_TYPE_KEYWORDS[props.type.toLowerCase()]) return props.type
  }

  // 2. 顶层字段特征
  if (props.dateFormat || props.section) return 'gantt'
  if (props.labels || props.values) return 'pie'
  if (props.xAxis && props.yAxis && !props.bars && !props.lines && !props.xLabels) return 'quadrant'
  if (props.xAxis || props.xLabels || props.bars || props.lines) return 'xychart'
  if (props.from && props.to) return 'flowchart'
  if (props.participant || props.actors) return 'sequence'
  if (props.time && props.event) return 'timeline'
  if (props.parent && props.child) return 'mindmap'
  if (props.entities || props.relations) return 'er'
  if (props.namespaces && props.blocks) return 'architecture'

  // 3. 从 data 数组首元素结构推断
  const firstData = Array.isArray(props.data) && props.data.length > 0 ? props.data[0] : undefined
  if (firstData && typeof firstData === 'object') {
    if (firstData.message && (firstData.from !== undefined || firstData.source)) return 'sequence'
    if (firstData.class || firstData.members) return 'class'
    if (firstData.from && firstData.to) return 'flowchart'
    if (firstData.entity && (firstData.relation || firstData.cardinality)) return 'er'
    if (firstData.time && firstData.event) return 'timeline'
    if (firstData.parent && firstData.child) return 'mindmap'
    if (firstData.label && firstData.value !== undefined) return 'pie'
    if (firstData.name && (firstData.start || firstData.date) && (firstData.duration || firstData.end)) return 'gantt'
    if (firstData.commit !== undefined || firstData.branch !== undefined) return 'git'
    if (firstData.state !== undefined || firstData.transition !== undefined) return 'state'
    if (firstData.column && firstData.task) return 'kanban'
    if (firstData.task !== undefined || firstData.section) return 'journey'
    if (firstData.x !== undefined && firstData.y !== undefined && firstData.label) return 'xychart'
    if (firstData.text && firstData.id) return 'requirement'
    if (firstData.label && firstData.width !== undefined) return 'block'
    if (firstData.shape && firstData.name) return 'architecture'
  }

  // 4. 从 children 数组首元素结构推断
  const firstChild = Array.isArray(props.children) && props.children.length > 0 ? props.children[0] : undefined
  if (firstChild && typeof firstChild === 'object') {
    if (firstChild.message && (firstChild.from !== undefined || firstChild.source)) return 'sequence'
    if (firstChild.from && firstChild.to) return 'flowchart'
    if (firstChild.entity && firstChild.relation) return 'er'
    if (firstChild.time && firstChild.event) return 'timeline'
    if (firstChild.parent && firstChild.child) return 'mindmap'
    if (firstChild.label && firstChild.value !== undefined) return 'pie'
    if (firstChild.state !== undefined || firstChild.transition !== undefined) return 'state'
  }

  return null
}
