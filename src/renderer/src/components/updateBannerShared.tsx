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
