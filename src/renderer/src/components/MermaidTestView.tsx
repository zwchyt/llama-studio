import React, { useState, useCallback } from 'react'
import { MermaidCard } from '../mermaid'

// DSL 直接输入预设
const DSL_PRESETS: Array<{ label: string; code: string }> = [
  {
    label: 'flowchart',
    code: `
flowchart LR
  subgraph Client
    UI[Web app]
    Cache[(Local cache)]
  end
  subgraph Services
    API[API gateway]
    Auth[Auth service]
    Orders[Order service]
  end
  subgraph Storage
    DB[(Orders DB)]
  end
  UI --> API
  UI --> Cache
  API --> Auth
  API --> Orders
  Orders --> DB
  Auth -. token .-> UI
`,
  },
  {
    label: 'sequence',
    code: `
sequenceDiagram
  autonumber
  actor Customer
  participant Web as Web app
  participant API as API gateway
  participant Bank
  Customer->>Web: Place order
  Web->>API: POST /orders
  activate API
  API->>Bank: Authorise payment
  Bank-->>API: Approved
  API-->>Web: 201 Created
  deactivate API
  Web-->>Customer: Order confirmed
  Note over Customer,Bank: One order, one transaction

`,
  },
  {
    label: 'class',
    code: `
classDiagram
    note "From Duck till Zebra"
    Animal <|-- Duck
    note for Duck "can fly<br>can swim<br>can dive<br>can help in debugging"
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Duck{
        +String beakColor
        +swim()
        +quack()
    }
    class Fish{
        -int sizeInFeet
        -canEat()
    }
    class Zebra{
        +bool is_wild
        +run()
    }

`,
  },
  {
    label: 'state',
    code: `
stateDiagram-v2
  [*] --> Draft
  Draft --> Submitted : submit
  state Review {
    [*] --> Screening
    Screening --> Decision
  }
  Submitted --> Review
  Review --> Published : approved
  Review --> Draft : rejected
  Published --> [*]

`,
  },
  {
    label: 'gantt',
    code: `
gantt
  dateFormat YYYY-MM-DD
  section Planning
  Research :a1, 2024-01-01, 3d
  Design :a2, 2024-01-04, 2d
`,
  },
  {
    label: 'er',
    code: `
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER }|..|{ DELIVERY-ADDRESS : uses
`,
  },
  {
    label: 'journey',
    code: `
journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me
`,
  },
  {
    label: 'git',
    code: `
gitGraph
  commit
  branch develop
  checkout develop
  commit
`,
  },
  {
    label: 'mindmap',
    code: `
mindmap
  root((mindmap))
    Origins
      Long history
      ::icon(fa fa-book)
      Popularisation
        British popular psychology author Tony Buzan
    Research
      On effectiveness<br/>and features
      On Automatic creation
        Uses
            Creative techniques
            Strategic planning
            Argument mapping
    Tools
      Pen and paper
      Mermaid
`,
  },
  {
    label: 'timeline',
    code: `
timeline
  title Timeline
  2024 Q1 : Planning
  2024 Q2 : Development
  2024 Q3 : Testing
`,
  },
  {
    label: 'pie',
    code: `
pie title Pie Chart
  "JavaScript" : 35
  "Python" : 25
  "TypeScript" : 20
`,
  },
  {
    label: 'sankey',
    code: `
sankey-beta
"Source","Target",10
"Source","Other",5
`,
  },
  {
    label: 'xychart',
    code: `
xychart-beta
  title "An Example Chart"
  x-axis ["90d", "60d", "30d", "7d", "1d", "Current"]
  y-axis "Seconds" 0 --> 198.2
  line "avg" [48.1, 41.5, 45.7, 72.8, 67.7, 59.9]
  line "p50" [38.2, 36.8, 39.7, 54.5, 49.0, 38.4]
  line "p95" [112.2, 75.3, 103.0, 177.0, 180.2, 109.4]
`,
  },
  {
    label: 'quadrant',
    code: `
quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]
    Campaign E: [0.40, 0.34]
    Campaign F: [0.35, 0.78]
`,
  },
  {
    label: 'requirement',
    code: `
requirementDiagram
  requirement checkout_req {
    id: 1
    text: Orders must be payable online.
    risk: high
    verifymethod: test
  }
  functionalRequirement payment_req {
    id: 1.1
    text: Card payments must be authorised.
    risk: high
    verifymethod: test
  }
  element checkout_service {
    type: service
  }
  checkout_req - contains -> payment_req
  checkout_service - satisfies -> payment_req

`,
  },
  {
    label: 'architecture',
    code: `
architecture-beta
    group sources(cloud)[Sources]
        service src_a(server)[Source A] in sources
        service src_b(server)[Source B] in sources
        service src_c(server)[Source C] in sources

    group storage(database)[Storage]
        service db_one(database)[DB One] in storage
        service db_two(database)[DB Two] in storage
        service db_three(database)[DB Three] in storage

    group output(disk)[Output]
        service brief(disk)[Brief] in output
        service analyst(server)[Analyst] in output
        service delivery(cloud)[Delivery] in output

    src_a:B --> T:db_one
    src_b:B --> T:db_two
    src_c:B --> T:db_three
    db_two:B --> T:brief
    brief:R --> L:analyst
    analyst:R --> L:delivery
`,
  },
  {
    label: 'block',
    code: `
block
columns 1
  db(("DB"))
  blockArrowId6<["&nbsp;&nbsp;&nbsp;"]>(down)
  block:ID
    A
    B["A wide one in the middle"]
    C
  end
  space
  D
  ID --> D
  C --> D
  style B fill:#969,stroke:#333,stroke-width:4px
`,
  },
  {
    label: 'kanban',
    code: `
kanban
  Todo
    Design UI
    Write API
  In Progress
    Implement auth
  Done
    Setup CI
`,
  },
  {
    label: 'swimlane',
    code: `
flowchart LR
  subgraph Customer
    Browse[Browse catalogue]
    Pay[Pay]
  end
  subgraph Warehouse
    Pick[Pick items]
    Ship[Ship order]
  end
  subgraph Finance
    Invoice[Raise invoice]
  end
  Browse --> Pay
  Pay --> Pick
  Pick --> Ship
  Pay --> Invoice
`,
  },
  {
    label: 'usecase',
    code: `
usecase-beta
direction LR
actor Customer
actor Support
systemBoundary Storefront
  Browse("Browse catalogue")
  Checkout("Checkout")
end
systemBoundary Fulfilment
  Track("Track delivery")
end
Customer --> Browse
Customer --> Checkout
Customer --> Track
Support --> Track
Checkout ..> : include Browse
`,
  },
  {
    label: 'c4',
    code: `
C4Context
  Person(user, "User")
  System(ecommerce, "E-Commerce System")
  Rel(user, ecommerce, "Uses")
`,
  },
  {
    label: 'radar',
    code: `
radar-beta
  axis Speed, Quality, Cost, UX
  curve Team-A {80, 90, 70, 60}
  curve Team-B {60, 70, 90, 80}
`,
  },
  {
    label: 'treemap',
    code: `
treemap-beta
  "Project"
    "Frontend": 40
    "Backend": 60
    "DevOps": 20
`,
  },
  {
    label: 'venn',
    code: `
venn-beta
  set A
  set B
  set C
`,
  },
  {
    label: 'ishikawa',
    code: `
ishikawa-beta
    Blurry Photo
    Process
        Out of focus
        Shutter speed too slow
        Protective film not removed
        Beautification filter applied
    User
        Shaky hands
    Equipment
        LENS
            Inappropriate lens
            Damaged lens
            Dirty lens
        SENSOR
            Damaged sensor
            Dirty sensor
    Environment
        Subject moved too quickly
        Too dark
`,
  },
  {
    label: 'wardley',
    code: `
wardley-beta
title Tea Shop Value Chain

anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61]
component Tea [0.63, 0.81]
component Hot Water [0.52, 0.80]
component Kettle [0.43, 0.35]
component Power [0.10, 0.70]

Business -> Cup of Tea
Cup of Tea -> Tea
Cup of Tea -> Hot Water
Hot Water -> Kettle
Kettle -> Power

evolve Kettle 0.62
evolve Power 0.89

note "Standardising power allows Kettles to evolve faster" [0.30, 0.49]
`,
  },
  {
    label: 'cynefin',
    code: `
cynefin-beta
  clear
    "Best Practices"
    "Checklists"
  complicated
    "Expert Analysis"
    "Modeling"
`,
  },
  {
    label: 'treeview',
    code: `
treeView-beta
├── src/
│   ├── App.tsx :::highlight icon(logos:react) ## main component
│   └── index.ts ## entry point
├── .env ## environment variables
├── Dockerfile
└── package.json
`,
  },
  {
    label: 'eventmodeling',
    code: `
eventmodeling
  tf 01 ui ProductListUI
  tf 02 cmd AddToCart
  tf 03 evt ItemAdded
  tf 04 ui CartView
`,
  },
]

export default function MermaidTestView() {
  const [activeDslPreset, setActiveDslPreset] = useState(0)
  const [dslCode, setDslCode] = useState(DSL_PRESETS[0].code)
  const [renderKey, setRenderKey] = useState(0)

  const handleDslPreset = useCallback((index: number) => {
    setActiveDslPreset(index)
    setDslCode(DSL_PRESETS[index].code)
    setRenderKey(k => k + 1)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Mermaid 图表渲染测试</h2>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          DSL 直接输入模式 | 点击预设自动填入并渲染
        </p>
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
    </div>
  )
}
