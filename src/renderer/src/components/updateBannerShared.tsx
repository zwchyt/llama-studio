import React, { useState } from 'react'

/** 合并调度模式下横幅组件的公共 Props */
export interface BannerSlotProps {
  /** 合并模式下被切换到后台时隐藏（保持挂载以保留下载状态） */
  hidden?: boolean
  /** 合并模式下的切换器节点 */
  switcher?: React.ReactNode
}

/** 横幅关闭收起动画：先播放 closing 动画，结束后执行真正的关闭 */
export function useBannerClose(onClosed: () => void) {
  const [closing, setClosing] = useState(false)
  const closeWithAnim = () => {
    setClosing(true)
    setTimeout(onClosed, 280)
  }
  return { closing, closeWithAnim }
}

/** 「跳过此版本」持久化读写 */
export function isVersionSkipped(key: string, version: string): boolean {
  try { return localStorage.getItem(key) === version } catch { return false }
}

export function skipVersion(key: string, version: string): void {
  try { localStorage.setItem(key, version) } catch { /* ignore */ }
}

/** 统一下载进度展示：进度条 + 百分比 + 已下载/总大小 */
export function UbProgress({ percent, received, total }: { percent: number; received?: number; total?: number }) {
  return (
    <>
      <div className="ub-progress">
        <div className="ub-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="ub-progress-text">
        {percent}%
        {received ? ` · ${formatSize(received)}${total ? '/' + formatSize(total) : ''}` : ''}
      </span>
    </>
  )
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 分片可视化：一排小方块，idle 灰 / active 高亮 / done 绿 */
export function ChunkGrid({ chunks, cell = 7, maxCells = 32 }: { chunks?: Array<'idle' | 'active' | 'done'>; cell?: number; maxCells?: number }) {
  if (!chunks || chunks.length === 0) return null
  // 大文件分片数可能上千（每片 4MB），单行直出会把横幅撑开。
  // 超出上限时把相邻分片聚合成一格（取区间最差状态），总宽保持 ~maxCells 格。
  const cells = chunks.length > maxCells ? downsampleChunks(chunks, maxCells) : chunks
  const bg: Record<string, string> = { idle: 'var(--bg)', active: 'var(--accent)', done: 'var(--success)' }
  return (
    <span className="ub-chunks" style={{ display: 'inline-flex', gap: 2, alignItems: 'center', verticalAlign: 'middle' }}>
      {cells.map((s, i) => (
        <span
          key={i}
          title={`分片 ${i + 1}：${s === 'idle' ? '等待中' : s === 'active' ? '下载中' : '已完成'}`}
          style={{
            width: cell, height: 12, borderRadius: 2, display: 'inline-block',
            background: bg[s] ?? 'var(--bg)',
            opacity: s === 'idle' ? 0.35 : 1,
            boxShadow: s === 'active' ? '0 0 5px var(--accent)' : 'none',
            transition: 'background 0.2s, opacity 0.2s'
          }}
        />
      ))}
    </span>
  )
}

function downsampleChunks(chunks: Array<'idle' | 'active' | 'done'>, n: number): Array<'idle' | 'active' | 'done'> {
  const step = chunks.length / n
  const out: Array<'idle' | 'active' | 'done'> = []
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step)
    const b = Math.max(a + 1, Math.floor((i + 1) * step))
    let hasActive = false
    let hasIdle = false
    for (let j = a; j < b; j++) {
      if (chunks[j] === 'active') hasActive = true
      else if (chunks[j] === 'idle') hasIdle = true
    }
    out.push(hasActive ? 'active' : hasIdle ? 'idle' : 'done')
  }
  return out
}
