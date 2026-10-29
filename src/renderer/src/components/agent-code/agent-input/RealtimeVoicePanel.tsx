// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：RealtimeVoicePanel —— 聊天输入框上方的实时语音状态条                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 只在实时会话进行中出现（未开始时整块不渲染，输入区外观与原来完全一致）。
// 位置与「上下文压缩中」那条提示线一致：会话区底部、输入框上方横一条，
// 属于对话区的收尾提示，不是输入框的一部分。
//
// 两个刻意的设计：
//   ① 电平条不走 React 状态——麦克风每 256ms 就有新值，setState 会让整个聊天页跟着重渲染；
//      这里用 rAF 直接改 DOM 宽度。
//   ② 只收基本类型 props 并 memo——上层每次渲染都会新建 realtime 对象，
//      直接把对象传进来，memo 形同虚设，聊天区流式输出时状态条会被连带重绘。

import { memo, useEffect, useRef } from 'react'
import { CircleStop, Mic, Send, TriangleAlert, Volume2 } from 'lucide-react'
import type { RealtimePhase, RealtimeTurn } from '../hooks/useRealtimeVoice'
import '../../../styles/realtime.css'

export interface RealtimeVoicePanelProps {
  phase: RealtimePhase
  speaking: boolean
  /** 服务端槽数：只用于判断走的是实时转写还是本地识别 */
  slots: number
  singleSlot: boolean
  /** 真故障：占掉正文位置，必须让人看到 */
  error: string
  /** 配置类提示（不是故障）：走独立位置，不抢正文 */
  notice: string
  turns: RealtimeTurn[]
  levelRef: React.RefObject<number>
  commit: () => void
  stop: () => void
}

export const RealtimeVoicePanel = memo(function RealtimeVoicePanel({
  phase, speaking, slots, singleSlot, error, notice, turns, levelRef, commit, stop,
}: RealtimeVoicePanelProps) {
  const fillRef = useRef<HTMLDivElement | null>(null)

  // 电平条：跟着 rAF 走，停止时归零
  useEffect(() => {
    const el = fillRef.current
    if (phase === 'idle') {
      if (el) el.style.width = '0%'
      return
    }
    let raf = 0
    let last = -1
    const tick = (): void => {
      // 只在整数值真的变了才写 DOM：60fps 无脑写样式等于每帧触发一次样式计算
      const pct = Math.round((levelRef.current || 0) * 100)
      if (pct !== last) {
        last = pct
        if (el) el.style.width = `${pct}%`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, levelRef])

  // 只展示最后一条：实时语音是即时的，堆历史会把输入区顶得很高
  const last = turns[turns.length - 1]
  const text = last?.text?.trim() || (phase === 'connecting' ? '正在连接本地实时接口…' : '对着麦克风说话，说完停顿一下')
  const status = phase === 'connecting' ? '连接中' : speaking ? '模型正在说话' : '在听你说'

  return (
    <div className={`rt-bar${phase === 'live' ? ' live' : ''}`}>
      <span className={`rt-bar-dot${speaking ? ' speaking' : ''}`} aria-hidden />
      {/* 读屏只念这一句状态；下面的正文是逐字变化的，不能挂 aria-live，否则会一直念 */}
      <span className="rt-bar-status" role="status" aria-live="polite">
        {speaking ? <Volume2 size={13} /> : <Mic size={13} />}
        {status}
      </span>
      <div className="rt-bar-level" aria-hidden="true">
        <div className="rt-bar-level-fill" ref={fillRef} />
      </div>
      <span className={`rt-bar-text${last?.role === 'user' ? ' is-user' : ''}`} title={error || text}>
        {error ? <><TriangleAlert size={12} /> {error}</> : text}
      </span>
      {/* 正常双槽时不显示任何标签（那是调试信息）；单槽或配置没生效才提示 */}
      {notice ? (
        <span className="rt-bar-note rt-bar-note-warn" title={notice}>配置未生效</span>
      ) : singleSlot ? (
        <span
          className="rt-bar-note"
          title="服务端只有 1 个槽位：开不了实时转写会话，你说的那句要等本地 ASR 补文字（比回复晚几秒）。把模板参数里的 --parallel 改成 2 后重启服务即可让文字和说话同步。"
        >
          槽 {slots} · 本地转写
        </span>
      ) : null}
      <button className="rt-bar-btn" onClick={commit} disabled={phase !== 'live'} title="正常情况下说完停顿一下就会自动发出去；环境太吵没自动发时点这里">
        <Send size={12} />手动发送
      </button>
      <button className="rt-bar-btn rt-bar-btn-stop" onClick={stop} title="结束实时对话">
        <CircleStop size={12} />结束
      </button>
    </div>
  )
})
