import { notify } from '../store/notificationStore'

/**
 * 安全包装 IPC 调用：自动 try/catch + 错误通知。
 * 成功返回结果，失败返回 null 并弹出 toast 提示。
 */
export async function safeCall<T>(
  fn: () => Promise<T>,
  errorLabel?: string
): Promise<T | null> {
  try {
    return await fn()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    notify(errorLabel ? `${errorLabel}：${msg}` : `操作失败：${msg}`, 'error')
    return null
  }
}
