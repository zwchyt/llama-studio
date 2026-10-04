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

import { useCallback, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { playEvent } from '../../../utils/sound'
import type { AgentSession } from '../../../../../shared/types'

export function useAgentCondense({
  activeSessionId, activeSession, loading,
}: {
  activeSessionId: string
  activeSession: AgentSession | null
  loading: boolean
}) {
  const [condensing, setCondensing] = useState(false)   // 正在压缩历史（顶栏轻量提示）
  const [condenseMsg, setCondenseMsg] = useState('')    // 压缩历史弹层内的结果反馈

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
