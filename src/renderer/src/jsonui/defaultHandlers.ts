import { notify } from '../store/notificationStore'

const maker: Record<string, () => Promise<string>> = {
  retryModelLoad: () => Promise.resolve('已发出重试模型加载'),
  openLogFile: () => Promise.resolve('已请求打开日志文件'),
  copySuggestedArgs: () => Promise.resolve('建议参数已复制到剪贴板'),
  applyRuntimePreset: () => Promise.resolve('已应用运行预设'),
  confirmDangerousAction: () => Promise.resolve('危险操作已确认'),
  dismissCard: () => Promise.resolve('卡片已关闭'),
}

export function makeDefaultHandlers(): Record<string, (params: Record<string, unknown>) => Promise<unknown>> {
  return Object.fromEntries(
    Object.entries(maker).map(([k, mk]) => [
      k,
      async () => {
        notify(await mk())
      },
    ])
  )
}