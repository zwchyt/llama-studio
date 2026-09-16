// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentRunState —— 流式运行态与跨域共享 ref                            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx：loading / queueInfo / streaming / streamKind / thinkDone /
// thinkingLevel（含同步 ref）/ thinkLevelOpen / curToolName / condenseOpen 这批运行态
// state，以及被循环域、压缩域、消息操作域、斜杠命令域共同消费的 ref
// （sending / streamingSession / abort / currentStreamId / streamStartAt / modelLabel /
// lastRate / piReady / prevQueue / appendLiveUserMsg / followUpQueue）。
// 逻辑与注释均未改动。
//
// 为什么这些 ref 集中在此：它们的写入点分散在多个域（循环、压缩、消息操作），
// 但生命周期都与「一次流式运行」绑定，故作为跨域共享引用由本 hook 统一持有，
// 再由主组件转发给各消费方——避免各域各自 new ref 导致身份不一致、状态读不到。
//
// 对外输出：上述 state（值 + setter）与全部 ref，外加 handleStreamRate（t/s 采样上报）。

import { useCallback, useRef, useState } from 'react'
import { usePopoverDismiss } from '../../../utils/usePopoverDismiss'
import type { AgentMessage, Attachment, ThinkingLevel } from '../../../../../shared/types'

export function useAgentRunState() {

  const [loading, setLoading] = useState(false)
  const [queueInfo, setQueueInfo] = useState<{ followUp: string[] }>({ followUp: [] })
  const [streaming, setStreaming] = useState(false)
  // 流式期模型阶段（runPiTurn 实时维护）：think=思考中 / text=输出正文 / tools=工具调用执行中。
  // 输入框上方常驻状态栏据此显示「思考中 / 输出中 / 工具调用中」图标与文案。
  const [streamKind, setStreamKind] = useState<'think' | 'text' | 'tools' | 'idle'>('idle')
  // 思考是否已结束（显式状态机，参考 Reasonix 的 reasoningComplete）：
  // 思考增量 → false（思考中）；正文增量 / 思考闭合 / 工具声明 → true（思考结束）。
  // 思考链转圈只看 streaming && !thinkDone，不依赖任何推断，工具执行期间必然收起。
  const [thinkDone, setThinkDone] = useState(true)
  // 思考程度（发送给 Pi 会话前动态设置），默认 medium；ref 供 runPiTurn 闭包读最新值而不必进 deps。
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium')
  const thinkingLevelRef = useRef<ThinkingLevel>(thinkingLevel)
  thinkingLevelRef.current = thinkingLevel
  // 思考程度自绘下拉（替代原生 <select>，使展开列表也可用项目暗色主题）
  const [thinkLevelOpen, setThinkLevelOpen] = useState(false)
  const thinkLevelMenuRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(thinkLevelOpen, setThinkLevelOpen, undefined, undefined, thinkLevelMenuRef)
  const [curToolName, setCurToolName] = useState('')  // 当前正在调用/执行的工具名（状态栏 name 标签）
  const [condenseOpen, setCondenseOpen] = useState(false)  // 压缩历史弹层开关
  const sendingRef = useRef(false)
  // 流式归属会话：渲染层据此判定「当前会话是否正在流式」，避免 A 会话生成时
  // 切到 B 会话，B 的末条助手消息被误渲染为流式中（状态串扰）。
  const streamingSessionRef = useRef<string | null>(null)
  const abortRef = useRef<{ aborted: boolean; resolve: (() => void) | null }>({ aborted: false, resolve: null })
  const currentStreamIdRef = useRef<string | null>(null)
  // 流开始时刻（ms）：pending 思考卡与思考块实时头部时间共用此锚点连续计时（含 TTFT、不回退）
  const streamStartAtRef = useRef<number | null>(null)
  // 模型名在轮开始时固化：finalize 后 runningCard 可能已非 running，
  // 顶层派生 modelLabel 会退化成「模型」，徽标显示仍保持该轮真实模型名。
  const modelLabelRef = useRef('模型')
  // 最终采样速率（t/s）：由 StreamingBadge 的 onRate 回调同步写入。
  // 用 ref 而非 store：finalize 同步代码直接读 ref，无「异步 effect 未执行完」竞态
  // （此前写 store liveAgentMsg 再读：finalize 可能抢先于 effect → lastTps 丢失 → 刷新后无 t/s）。
  const lastRateRef = useRef<number | null>(null)
  // t/s 采样上报：仅写入 lastRateRef，随 finalize 最终 commit 持久化进消息，
  // 刷新后完成态徽标仍能还原最后速率
  const handleStreamRate = useCallback((v: number | null) => {
    if (v != null) lastRateRef.current = v
  }, [])
  // ── pi-agent 模式状态：当前已创建 pi session 的 sid（事件客户端随循环域下沉）──
  const piReadyRef = useRef<{ sid: string | null; ready: boolean }>({ sid: null, ready: false })
  // 队列/历史同步：followUp/steer 用户消息不在发送时写入聊天，而是在 SDK 真正执行该条
  // （queue_update 出队）时由 appendQueuedUserMsg 补写，避免多个追加问题提前堆在对话里。
  const prevQueueRef = useRef<{ followUp: string[] }>({ followUp: [] })
  const appendLiveUserMsgRef = useRef<(m: AgentMessage) => void>(() => { })
  // 前端 followUp 队列：追加的问题不再交给 SDK 自动续跑（单轮 runPiTurn 会吞掉回复），
  // 而是前端排队，当前轮 runPiTurn 结束后自动发起独立新轮（产生独立 user + assistant）。
  const followUpQueueRef = useRef<{ text: string; attachments: Attachment[]; packedText?: string }[]>([])

  return {
    loading, setLoading, queueInfo, setQueueInfo, streaming, setStreaming,
    streamKind, setStreamKind, thinkDone, setThinkDone,
    thinkingLevel, setThinkingLevel, thinkingLevelRef,
    thinkLevelOpen, setThinkLevelOpen, thinkLevelMenuRef, curToolName, setCurToolName,
    condenseOpen, setCondenseOpen,
    sendingRef, streamingSessionRef, abortRef, currentStreamIdRef, streamStartAtRef,
    modelLabelRef, lastRateRef, handleStreamRate, piReadyRef,
    prevQueueRef, appendLiveUserMsgRef, followUpQueueRef,
  }
}
