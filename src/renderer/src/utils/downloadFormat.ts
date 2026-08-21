import type { DownloadPhase } from '../../../shared/types'
import { formatSpeed } from './format'

interface DownloadStatusInput {
  phase: DownloadPhase
  percent: number
  speed?: number
}

/**
 * 下载行/列表中的状态文本（ModelsView DownloadRow / HuggingFaceView 文件进度）。
 * 统一 phase→中文映射，消除散落重复。
 */
export function formatDownloadStatus(dl: DownloadStatusInput): string {
  switch (dl.phase) {
    case 'downloading':
      return dl.speed
        ? `${dl.percent}% • ${formatSpeed(dl.speed)}`
        : `${dl.percent}%`
    case 'paused':
      return `已暂停 • ${dl.percent}%`
    case 'saving':
      return '保存中...'
    case 'creating_template':
      return '创建模板中...'
    case 'starting':
      return '准备中...'
    case 'done':
      return '已完成'
    case 'error':
      return '错误'
    case 'cancelled':
      return '已取消'
    default:
      return `${dl.percent}%`
  }
}

/**
 * 底部下载条的紧凑状态文本（HuggingFaceView downloads strip）。
 * 比 formatDownloadStatus 更紧凑。
 */
export function formatDownloadStripText(dl: DownloadStatusInput): string {
  switch (dl.phase) {
    case 'downloading':
      return dl.speed
        ? `${dl.percent}% • ${formatSpeed(dl.speed)}`
        : `下载中 [${dl.percent}%]`
    case 'paused':
      return `已暂停 • ${dl.percent}%`
    case 'saving':
      return '保存至 /models...'
    case 'creating_template':
      return '创建模板中...'
    case 'starting':
      return '准备中...'
    case 'done':
      return '已完成'
    case 'error':
      return '错误'
    case 'cancelled':
      return '已取消'
    default:
      return `${dl.percent}%`
  }
}

/**
 * 把剩余秒数格式化为中文时长（如「1分20秒」「2时5分」）。
 * 非法/无限值返回空串（调用方据此决定是否展示）。
 */
export function formatEta(seconds?: number): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}时${rm}分` : `${h}时`
}
