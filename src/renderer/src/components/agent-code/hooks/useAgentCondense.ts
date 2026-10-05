// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentCondense —— 手动压缩入口（实做在 pi SDK 里）                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// 这里不再有压缩逻辑：触发、切点、摘要生成、失败重试全部由 pi 的原生 compaction 负责
// （见 piAgentBridge/index.ts 的 settingsManager 与 manager.ts 的 compaction_end 订阅）。
// 本 hook 只剩顶栏「压缩历史」按钮需要的三样：压缩中标志、弹层反馈文案、调用 pi 的动作。
//
// 自动压缩不需要渲染层参与：pi 在轮末与发 prompt 前各查一次，依据是上一条回复的真实 usage；
// 溢出时它还会「省略失败回复 → 压缩 → 重跑该轮」。压缩产出经 compaction_end 事件写回
// session.memory，所以这里连返回值都不需要接收。

import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { playEvent } from '../../../utils/sound'
import type { AgentSession } from '../../../../../shared/types'

/** 「压缩中」提示的超时兜底（ms）：超过它仍未收到 compaction_end 就强制复位，防止提示条卡死 */
const COMPACTING_WATCHDOG_MS = 3 * 60 * 1000

export function useAgentCondense({
  activeSessionId, activeSession, loading,
}: {
  activeSessionId: string
  activeSession: AgentSession | null
  loading: boolean
}) {
  // 「压缩中」标志放在 store：手动（本 hook 的 try/finally）与自动（useAgentLoop 收到
  // compaction_start 事件）两条路径都要置位，输入区据此渲染提示条；本 hook 不再自己持有。
  const condensing = useStore(s => s.compacting)
  const setCondensing = useStore(s => s.setCompacting)
  const [condenseMsg, setCondenseMsg] = useState('')    // 压缩历史弹层内的结果反馈

  // 看门狗：压缩中标志只由 pi 的 compaction_start / compaction_end 驱动，一旦结束事件丢失
  // （客户端被拆、事件落在 detach 之后、或压缩被反复中止），提示条会永远挂着、看起来「取消不掉」。
  // 这里加一条超时兜底：超过 3 分钟仍未收到结束事件就强制复位。
  // 本地模型的摘要请求正常在几十秒内完成，3 分钟足够宽松。
  useEffect(() => {
    if (!condensing) return
    const t = window.setTimeout(() => useStore.getState().setCompacting(false), COMPACTING_WATCHDOG_MS)
    return () => window.clearTimeout(t)
  }, [condensing])

  // 手动压缩：直接让 pi 压一次（不等水位）。无可压缩内容时 pi 会抛
  // "Already compacted" / "Nothing to compact (session too small)"，主进程已转成
  // { success:false, error }，这里只负责把原因说人话回给弹层。
  const handleManualCondense = useCallback(async () => {
    if (loading || condensing) return
    if (!activeSession || activeSession.messages.length === 0) { setCondenseMsg('当前会话无可压缩的历史。'); return }
    setCondenseMsg('')
    setCondensing(true)
    try {
      const res = await window.api.piAgent.compact(`pi-${activeSessionId}`)
      if (res?.success) {
        // 摘要与边界由 compaction_end 事件写进 session.memory，这里只报「做完了」
        setCondenseMsg('✅ 已压缩早期对话（摘要与剩余占用见「上下文」面板）。')
        notify('已压缩早期对话', 'success')
        playEvent('success')
      } else {
        const reason = res?.error || '（模型无响应或返回为空）'
        setCondenseMsg(`压缩未完成：${reason}`)
        notify('压缩未完成', 'error')
        playEvent('error')
      }
    } catch (e: any) {
      setCondenseMsg(`压缩未完成：${e?.message || String(e)}`)
      notify('压缩未完成', 'error')
      playEvent('error')
    } finally {
      setCondensing(false)
    }
  }, [loading, condensing, activeSession, activeSessionId])

  return { condensing, condenseMsg, setCondenseMsg, handleManualCondense }
}
