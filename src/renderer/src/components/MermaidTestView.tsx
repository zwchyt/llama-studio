import React, { useState, useCallback } from 'react'
import { JSONUIProvider, Renderer } from '@json-render/react'
import { registry } from '../jsonui/registry'
import { MermaidCard } from '../jsonui/components/MermaidCard'
import type { Spec } from '@json-render/core'

// 每种图表的 JSON spec 预设（模拟 LLM 生成的 JSON）
const JSON_PRESETS: Array<{
  label: string
  spec: Spec
}> = [
  {
    label: 'flowchart',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'flowchart',
          props: {
            title: 'Flowchart',
            data: [
              { from: 'A[Start]', to: 'B{Decision}', arrow: '-->' },
              { from: 'B{Decision}', to: 'C[OK]', arrow: '-->', label: 'Yes' },
              { from: 'B{Decision}', to: 'D[Cancel]', arrow: '-->', label: 'No' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'sequence',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'sequence',
          props: {
            title: 'Sequence Diagram',
            data: [
              { from: 'Alice', to: 'Bob', message: 'Hello', arrow: '->>' },
              { from: 'Bob', to: 'Alice', message: 'Hi', arrow: '-->>' },
              { from: 'Alice', to: 'Bob', message: 'How are you?', arrow: '->>' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'class',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'class',
          props: {
            title: 'Class Diagram',
            data: [
              { class: 'Animal', members: ['+String name', '+int age'] },
              { class: 'Dog', members: ['+fetch()'] },
              { from: 'Animal', to: 'Dog', arrow: '<|--' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'state',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'state',
          props: {
            title: 'State Diagram',
            data: [
              { state: '[*]' },
              { from: '[*]', to: 'Idle', label: '' },
              { from: 'Idle', to: 'Processing', label: 'submit' },
              { from: 'Processing', to: 'Done', label: 'complete' },
              { from: 'Processing', to: 'Error', label: 'fail' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'gantt',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'gantt',
          props: {
            title: 'Gantt Chart',
            dateFormat: 'YYYY-MM-DD',
            section: 'Planning',
            data: [
              { name: 'Research', start: '2024-01-01', duration: '3d' },
              { name: 'Design', start: '2024-01-04', duration: '2d' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'er',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'er',
          props: {
            title: 'ER Diagram',
            data: [
              { entity: 'USER', relation: '||--o{', cardinality: 'ORDER', label: 'places' },
              { entity: 'ORDER', relation: '||--|{', cardinality: 'ORDER_ITEM', label: 'contains' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'journey',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'journey',
          props: {
            title: 'User Journey',
            data: [
              { section: 'Discovery' },
              { task: 'Visit site', score: 5, actor: 'User' },
              { task: 'Browse products', score: 3, actor: 'User' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'git',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'git',
          props: {
            title: 'Git Branch',
            data: [
              { commit: 'init' },
              { branch: 'develop' },
              { commit: 'feature' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'mindmap',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'mindmap',
          props: {
            title: 'Mindmap',
            data: [
              { parent: 'Project', child: 'Frontend' },
              { parent: 'Frontend', child: 'React' },
              { parent: 'Project', child: 'Backend' },
              { parent: 'Backend', child: 'Node.js' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'timeline',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'timeline',
          props: {
            title: 'Timeline',
            data: [
              { time: '2024 Q1', event: 'Planning' },
              { time: '2024 Q2', event: 'Development' },
              { time: '2024 Q3', event: 'Testing' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'pie',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'pie',
          props: {
            title: 'Pie Chart',
            labels: ['JavaScript', 'Python', 'TypeScript'],
            values: [35, 25, 20],
          },
        },
      },
    },
  },
  {
    label: 'sankey',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'sankey',
          props: {
            title: 'Sankey Diagram',
            data: [
              { from: 'Source', to: 'Target', value: 10 },
              { from: 'Source', to: 'Other', value: 5 },
            ],
          },
        },
      },
    },
  },
  {
    label: 'xychart',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'xychart',
          props: {
            title: 'XY Chart',
            xLabels: ['Jan', 'Feb', 'Mar'],
            yTitle: 'Revenue',
            yMin: 0,
            yMax: 100,
            bars: [40, 55, 65],
            lines: [40, 50, 60],
          },
        },
      },
    },
  },
  {
    label: 'quadrant',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'quadrant',
          props: {
            title: 'Quadrant Chart',
            xAxis: 'Low Risk --> High Risk',
            yAxis: 'Low Return --> High Return',
            data: [
              { label: 'Project A', x: 0.7, y: 0.8 },
              { label: 'Project B', x: 0.3, y: 0.6 },
            ],
          },
        },
      },
    },
  },
  {
    label: 'requirement',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'requirement',
          props: {
            title: 'Requirement Diagram',
            data: [
              { id: '1', text: 'User must authenticate', risk: 'high', verifymethod: 'test' },
              { id: '2', text: 'Token expires in 1h' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'architecture',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'architecture',
          props: {
            title: 'Architecture Diagram',
            data: [
              { type: 'group', name: 'api', shape: 'cloud', label: 'API Gateway' },
              { type: 'service', name: 'web', shape: 'server', label: 'Web Server', inGroup: 'api' },
              { type: 'service', name: 'db', shape: 'database', label: 'Database', inGroup: 'api' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'block',
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'block',
          props: {
            title: 'Block Diagram',
            data: [
              { id: 'a', label: 'Frontend', width: 2 },
              { id: 'b', label: 'API' },
              { id: 'c', label: 'Database' },
              { from: 'a', to: 'b' },
              { from: 'b', to: 'c' },
            ],
          },
        },
      },
    },
  },
  {
    label: 'kanban',
    spec: {
      root: 'card',
      elements: {
        card: {
          type: 'kanban',
          props: {
            title: 'Kanban Board',
            data: [
              { column: 'Todo', task: 'Design UI' },
              { column: 'Todo', task: 'Write API' },
              { column: 'In Progress', task: 'Implement auth' },
              { column: 'Done', task: 'Setup CI' },
            ],
          },
        },
      },
    },
  },
]

// DSL 直接输入预设（与 JSON 数据一致）
const DSL_PRESETS: Array<{ label: string; code: string }> = [
  { label: 'flowchart', code: 'flowchart TD\n  Alice --> Bob' },
  { label: 'sequence', code: 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi\n  Alice->>Bob: How are you?' },
  { label: 'class', code: 'classDiagram\n  class Animal {\n    +String name\n    +int age\n  }\n  class Dog {\n    +fetch()\n  }\n  Animal <|-- Dog' },
  { label: 'state', code: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Processing : submit\n  Processing --> Done : complete\n  Processing --> Error : fail' },
  { label: 'gantt', code: 'gantt\n  dateFormat YYYY-MM-DD\n  section Planning\n  Research :a1, 2024-01-01, 3d\n  Design :a2, 2024-01-04, 2d' },
  { label: 'er', code: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ ORDER_ITEM : contains' },
  { label: 'journey', code: 'journey\n  title User Journey\n  section Discovery\n    Visit site: 5: User\n    Browse products: 3: User' },
  { label: 'git', code: 'gitGraph\n  commit\n  branch develop\n  checkout develop\n  commit' },
  { label: 'mindmap', code: 'mindmap\n  root((Mindmap))\n    Frontend\n      React\n    Backend\n      Node.js' },
  { label: 'timeline', code: 'timeline\n  title Timeline\n  2024 Q1 : Planning\n  2024 Q2 : Development\n  2024 Q3 : Testing' },
  { label: 'pie', code: 'pie title Pie Chart\n  "JavaScript" : 35\n  "Python" : 25\n  "TypeScript" : 20' },
  { label: 'sankey', code: 'sankey-beta\n"Source","Target",10\n"Source","Other",5' },
  { label: 'xychart', code: 'xychart-beta\n  title "XY Chart"\n  x-axis [Jan, Feb, Mar]\n  y-axis "Revenue" 0 --> 100\n  bar [40, 55, 65]\n  line [40, 50, 60]' },
  { label: 'quadrant', code: 'quadrantChart\n  title Quadrant Chart\n  x-axis Low Risk --> High Risk\n  y-axis Low Return --> High Return\n  Project A: [0.7, 0.8]\n  Project B: [0.3, 0.6]' },
  { label: 'requirement', code: 'requirementDiagram\n  requirement req1 {\n    id: 1\n    text: User must authenticate\n    risk: high\n    verifymethod: test\n  }\n  requirement req2 {\n    id: 2\n    text: Token expires in 1h\n  }' },
  { label: 'architecture', code: 'architecture-beta\n  group api(cloud)[API Gateway]\n  service web(server)[Web Server] in api\n  service db(database)[Database] in api' },
  { label: 'block', code: 'block-beta\n  a["Frontend"]:2\n  b["API"]\n  c["Database"]\n  a --> b\n  b --> c' },
  { label: 'kanban', code: 'kanban\n  Todo\n    Design UI\n    Write API\n  In Progress\n    Implement auth\n  Done\n    Setup CI' },
]

export default function MermaidTestView() {
  const [mode, setMode] = useState<'json' | 'dsl'>('json')
  const [activeJsonPreset, setActiveJsonPreset] = useState(0)
  const [activeDslPreset, setActiveDslPreset] = useState(0)
  const [dslCode, setDslCode] = useState(DSL_PRESETS[0].code)
  const [jsonText, setJsonText] = useState(JSON.stringify(JSON_PRESETS[0].spec, null, 2))
  const [renderKey, setRenderKey] = useState(0)

  const { currentJsonSpec, parseError } = React.useMemo(() => {
    try {
      return { currentJsonSpec: JSON.parse(jsonText) as Spec, parseError: null }
    } catch (e: any) {
      return { currentJsonSpec: null, parseError: e.message as string }
    }
  }, [jsonText])

  const handleJsonPreset = useCallback((index: number) => {
    setActiveJsonPreset(index)
    setJsonText(JSON.stringify(JSON_PRESETS[index].spec, null, 2))
    setRenderKey(k => k + 1)
  }, [])

  const handleDslPreset = useCallback((index: number) => {
    setActiveDslPreset(index)
    setDslCode(DSL_PRESETS[index].code)
    setRenderKey(k => k + 1)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* 标题 + 模式切换 */}
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Mermaid 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          测试 JSON → DSL → 渲染 管道 | 点击预设自动填入并渲染
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setMode('json')}
            style={{
              padding: '5px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: mode === 'json' ? 'var(--accent, #3b82f6)' : 'var(--surface, #e5e7eb)',
              color: mode === 'json' ? '#fff' : 'var(--text, #111827)',
            }}
          >
            JSON Spec 模式
          </button>
          <button
            onClick={() => setMode('dsl')}
            style={{
              padding: '5px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: mode === 'dsl' ? 'var(--accent, #3b82f6)' : 'var(--surface, #e5e7eb)',
              color: mode === 'dsl' ? '#fff' : 'var(--text, #111827)',
            }}
          >
            DSL 直接输入模式
          </button>
        </div>
      </div>

      {/* JSON 模式 */}
      {mode === 'json' && (
        <>
          <div style={{ padding: '0 20px', flexShrink: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {JSON_PRESETS.map((preset, i) => (
                <button
                  key={preset.label}
                  onClick={() => handleJsonPreset(i)}
                  style={{
                    padding: '4px 10px', borderRadius: 4, border: '1px solid',
                    borderColor: activeJsonPreset === i ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
                    background: activeJsonPreset === i ? 'var(--accent, #3b82f6)' : 'transparent',
                    color: activeJsonPreset === i ? '#fff' : 'var(--text, #111827)',
                    cursor: 'pointer', fontSize: 12, fontWeight: activeJsonPreset === i ? 600 : 400,
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12, padding: '0 20px 16px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <textarea
                value={jsonText}
                onChange={e => { setJsonText(e.target.value); setRenderKey(k => k + 1) }}
                style={{
                  flex: 1, minHeight: 200, padding: 10, borderRadius: 4,
                  border: parseError ? '1px solid #ef4444' : '1px solid var(--border, #d1d5db)',
                  background: 'var(--surface, #ffffff)', color: 'var(--text, #111827)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 13, lineHeight: 1.5, resize: 'none', boxSizing: 'border-box',
                }}
              />
              {parseError && (
                <div style={{ color: '#ef4444', fontSize: 12, marginTop: 4 }}>JSON 解析错误: {parseError}</div>
              )}
            </div>
            <div style={{
              flex: 1, minWidth: 0, overflow: 'auto', border: '1px solid var(--border, #d1d5db)',
              borderRadius: 8, background: 'var(--bg, #f5f5f5)', padding: 12,
            }}>
              {currentJsonSpec ? (
                <JSONUIProvider registry={registry} initialState={{}}>
                  <Renderer key={renderKey} spec={currentJsonSpec} registry={registry} />
                </JSONUIProvider>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
                  JSON 格式错误，请检查
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* DSL 模式 */}
      {mode === 'dsl' && (
        <>
          <div style={{ padding: '0 20px', flexShrink: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {DSL_PRESETS.map((preset, i) => (
                <button
                  key={preset.label}
                  onClick={() => handleDslPreset(i)}
                  style={{
                    padding: '4px 10px', borderRadius: 4, border: '1px solid',
                    borderColor: activeDslPreset === i ? 'var(--accent, #3b82f6)' : 'var(--border, #d1d5db)',
                    background: activeDslPreset === i ? 'var(--accent, #3b82f6)' : 'transparent',
                    color: activeDslPreset === i ? '#fff' : 'var(--text, #111827)',
                    cursor: 'pointer', fontSize: 12, fontWeight: activeDslPreset === i ? 600 : 400,
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12, padding: '0 20px 16px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <textarea
                value={dslCode}
                onChange={e => setDslCode(e.target.value)}
                style={{
                  flex: 1, minHeight: 200, padding: 10, borderRadius: 4,
                  border: '1px solid var(--border, #d1d5db)',
                  background: 'var(--surface, #ffffff)', color: 'var(--text, #111827)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 13, lineHeight: 1.5, resize: 'none', boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => setRenderKey(k => k + 1)}
                style={{
                  marginTop: 8, padding: '6px 16px', borderRadius: 4, border: 'none',
                  background: 'var(--accent, #3b82f6)', color: '#fff', cursor: 'pointer',
                  fontSize: 13, fontWeight: 500, alignSelf: 'flex-start',
                }}
              >
                渲染
              </button>
            </div>
            <div style={{
              flex: 1, minWidth: 0, overflow: 'auto', border: '1px solid var(--border, #d1d5db)',
              borderRadius: 8, background: 'var(--bg, #f5f5f5)', padding: 12,
            }}>
              {dslCode ? (
                <MermaidCard key={renderKey} props={{ code: dslCode, title: DSL_PRESETS[activeDslPreset]?.label }} />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
                  请输入 Mermaid DSL 代码后点击渲染
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
