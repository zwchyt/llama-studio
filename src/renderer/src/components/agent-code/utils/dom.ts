// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：DOM 辅助（从事件目标解析源码预览行号）                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。
// 供预览区「框选行」与消息区「点击行号」两处使用，故置于共享 utils。

// 从事件目标解析源码预览行号（含行号槽）；不在预览行内返回 null
export function previewLineNoFromTarget(t: EventTarget | null): number | null {
  const el = t instanceof Element ? t : null
  const line = el?.closest('.agent-code-preview-line')
  const m = line ? /agent-preview-line-(\d+)/.exec(line.id || '') : null
  return m ? Number(m[1]) : null
}
