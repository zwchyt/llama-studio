export function formatBytes(b: number): string {
  if (!b) return '—'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

export function formatSpeed(bps?: number): string {
  if (!bps) return ''
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}
