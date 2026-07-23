// ── Bash 前台命令实时输出（渲染进程内存存储）──
// 主进程在前台命令执行期间按块推送 stdout/stderr（IPC 事件 agent-command-chunk），
// 本模块累积当前执行的输出并通知订阅者。由于前台 Bash 同一时刻至多一个（工具循环串行、
// 且 Bash 需审批不并发），用单一「当前执行」状态即可，execId 仅用于隔离新旧执行、防串扰。

let currentExecId: string | null = null
let text = ''
const listeners = new Set<() => void>()
let registered = false

function emit() {
  listeners.forEach(fn => { try { fn() } catch { /* 忽略订阅者异常 */ } })
}

// 首次使用时注册 IPC 监听（renderer 内 window.api 一定可用）
function ensureRegistered() {
  if (registered) return
  registered = true
  try {
    window.api.onCommandChunk?.(({ execId, chunk }) => {
      // 仅接受当前执行的块，防止上一条命令的迟到输出串入
      if (execId !== currentExecId) return
      text += chunk
      emit()
    })
  } catch { /* 监听注册失败不影响命令执行本身 */ }
}

/** 开始一次前台命令：重置缓冲并记录 execId */
export function startBashLive(execId: string): void {
  ensureRegistered()
  currentExecId = execId
  text = ''
  emit()
}

/** 结束一次前台命令：清空当前执行状态（输出已并入工具结果，无需再实时展示） */
export function stopBashLive(execId: string): void {
  if (currentExecId !== execId) return
  currentExecId = null
  text = ''
  emit()
}

export function getBashLiveText(): string {
  return text
}

export function isBashLiveActive(): boolean {
  return currentExecId !== null
}

export function subscribeBashLive(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
