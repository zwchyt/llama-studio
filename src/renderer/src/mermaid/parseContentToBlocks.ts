export type ContentBlock = 
  | { kind: 'text'; content: string }
  | { kind: 'mermaid'; code: string }

export function parseContentToBlocks(content: string): ContentBlock[] {
  if (!content) return []
  
  const MERMAID_KEYWORDS = [
    'flowchart', 'graph', 'sequenceDiagram', 'classDiagram-v2', 'classDiagram',
    'stateDiagram-v2', 'stateDiagram', 'gantt', 'erDiagram', 'journey', 'gitGraph',
    'mindmap', 'timeline', 'pie', 'sankey-beta', 'xychart-beta', 'quadrantChart',
    'requirementDiagram', 'architecture-beta', 'block-beta', 'packet-beta', 'kanban',
    'swimlane-beta', 'usecase-beta', 'C4Context', 'C4Container', 'C4Component',
    'C4Dynamic', 'C4Deployment', 'zenuml', 'radar-beta', 'treemap-beta',
    'venn-beta', 'ishikawa-beta', 'wardley-beta', 'cynefin-beta', 'treeView-beta',
    'eventmodeling'
  ]
  const kwPattern = MERMAID_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const kwRe = new RegExp(`^(${kwPattern})(\\s|;|:|$)`)
  const isMermaidKw = (line: string) => kwRe.test(line)
  
  const lines = content.split('\n')
  const blocks: ContentBlock[] = []
  let currentText = ''
  let i = 0
  
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    
    // 检查是否是Mermaid关键字开头
    if (trimmed && !trimmed.startsWith('```') && !trimmed.startsWith('#') && isMermaidKw(trimmed)) {
      // 保存之前的文本
      if (currentText.trim()) {
        blocks.push({ kind: 'text', content: currentText })
        currentText = ''
      }
      
      // 查找Mermaid块的结束
      let end = i + 1
      while (end < lines.length) {
        const next = lines[end].trim()
        if (next === '' || next.startsWith('```') || isMermaidKw(next)) break
        end++
      }
      
      // 提取Mermaid代码
      const mermaidLines = lines.slice(i, end)
      const code = mermaidLines.join('\n').replace(/```[\s\S]*?```/g, '').trim()
      
      if (code.length > 5) {
        blocks.push({ kind: 'mermaid', code })
        i = end
        continue
      }
    }
    
    // 如果是代码块
    if (trimmed.startsWith('```')) {
      const codeBlockEnd = lines.findIndex((l, idx) => idx > i && l.trim().startsWith('```'))
      if (codeBlockEnd !== -1) {
        // 检查是否是 ```mermaid ``` 围栏包裹的Mermaid块
        if (trimmed.startsWith('```mermaid')) {
          // 保存之前的文本
          if (currentText.trim()) {
            blocks.push({ kind: 'text', content: currentText })
            currentText = ''
          }
          // 提取围栏内的Mermaid代码（去掉前后围栏行）
          const mermaidCode = lines.slice(i + 1, codeBlockEnd).join('\n').trim()
          if (mermaidCode.length > 5) {
            blocks.push({ kind: 'mermaid', code: mermaidCode })
          } else {
            currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
          }
          i = codeBlockEnd + 1
          continue
        }
        // 普通代码块，跳过
        currentText += lines.slice(i, codeBlockEnd + 1).join('\n') + '\n'
        i = codeBlockEnd + 1
        continue
      }
    }
    
    // 普通文本行
    currentText += line + '\n'
    i++
  }
  
  // 保存最后的文本
  if (currentText.trim()) {
    blocks.push({ kind: 'text', content: currentText })
  }
  
  return blocks
}
