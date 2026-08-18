import React from 'react'
import { JSONUIProvider, Renderer } from '@json-render/react'
import { registry } from '../jsonui/registry'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import type { Spec } from '@json-render/core'

export default function ModelDiagnosisPanel() {
  const diagnostics = useStore(s => s.modelDiagnostics)

  const ids = Object.keys(diagnostics)
  if (ids.length === 0) return null

  return (
    <div className="jui-diagnosis-panel">
      {ids.map(id => (
        <DiagnosisCard key={id} id={id} />
      ))}
    </div>
  )
}

function DiagnosisCard({ id }: { id: string }) {
  const d = useStore(s => s.modelDiagnostics[id])
  const dismiss = useStore(s => s.dismissModelDiagnosis)
  if (!d) return null

  const spec: Spec = {
    root: 'card',
    elements: {
      card: {
        type: 'ErrorDiagnosisCard',
        props: {
          severity: d.severity,
          title: d.title,
          cause: d.cause,
          recommendations: d.recommendations,
        },
        children: d.logExcerpt ? ['logExcerptEl'] : [],
        on: {
          retry: { action: 'retryModelLoad' },
          dismiss: { action: 'dismissCard' },
          copy: { action: 'copyDiagnosis' },
        },
      },
      ...(d.logExcerpt
        ? {
            logExcerptEl: {
              type: 'LogExcerpt',
              props: {
                title: '日志摘录',
                level: d.severity,
                lines: d.logExcerpt.lines,
                start: d.logExcerpt.start,
                errorLine: d.logExcerpt.errorLine,
              },
              children: [],
            },
          }
        : {}),
    },
  }

  return (
    <div className="jui-diagnosis-item">
      <JSONUIProvider
        registry={registry}
        handlers={{
          retryModelLoad: async () => notify('已发出模型重试请求'),
          dismissCard: async () => dismiss(id),
          copyDiagnosis: async () => {
            const head = `[${d.severity.toUpperCase()}] ${d.title}\n${d.cause}\n\n建议：\n${d.recommendations.map(r => `- ${r}`).join('\n')}`
            const excerpt = d.logExcerpt
              ? `\n\n日志摘录（${d.logExcerpt.start}-${d.logExcerpt.start + d.logExcerpt.lines.length - 1} 行）：\n${d.logExcerpt.lines.map((l, i) => `${d.logExcerpt!.start + i}  ${l}`).join('\n')}`
              : ''
            try {
              await navigator.clipboard.writeText(head + excerpt)
              notify('诊断报告已复制到剪贴板')
            } catch {
              notify('复制失败，请手动复制', 'error')
            }
          },
        }}
      >
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>
    </div>
  )
}