// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useRealtimeVoice —— 聊天界面的实时语音对话                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 走本地 llama.cpp 的实时语音接口（/v1/realtime WebSocket）：麦克风 PCM 直接进模型，
// 模型边生成边回语音，不需要「录音 → 转写 → 发送 → 合成」四步。
//
// 同时开两条连接（同一个服务、同一个模型）：
//   · 对话连接：音频进 → 文字 + 语音出
//   · 转写连接（session.type = transcription）：音频进 → 用户说的话的文字
// 为什么要两条：对话连接不会转写用户的音频（实测会话里没有输入转写事件，
// 请求里带 transcription 字段也会被忽略），只有转写会话才吐 transcript。
//
// 前提（缺一不可）：
//   · 服务端跑的是 LFM3-Audio / LFM3-Omni 这类能出语音的模型；
//   · 启动参数挂了音频投影 --mmproj（语音的收与发都靠它）；
//   · llama.cpp b11960 以上（本项目自带的后端已满足）。
//
// 音频格式（实测）：上行 16 kHz 单声道 PCM16，下行 24 kHz 单声道 PCM16。

import { useCallback, useEffect, useRef, useState } from 'react'
import { notify } from '../../../store/notificationStore'
import { useStore } from '../../../store/useStore'

import {
  IN_RATE, OUT_RATE, CHUNK, VAD_MIN_LEVEL, VAD_NOISE_FACTOR, VAD_SILENCE_MS,
  VAD_MIN_SPEECH_MS, VAD_MAX_BUFFER_MS,
  pcm16ToBase64, pcmToWavBase64, isJunkTranscript, fetchSlots, pickLocalAsr,
} from '../utils/realtimeAudio'

export type RealtimePhase = 'idle' | 'connecting' | 'live'
/** 一轮对话的文本。id 形如 u3 / a3，数字是第几轮，界面据此把两侧消息按轮次排好 */
export interface RealtimeTurn { id: string; role: 'user' | 'assistant'; text: string; done: boolean; round: number }
/** 引擎事件是 OpenAI Realtime 风格的 JSON，字段随版本增减，这里按需读取、缺字段就跳过 */
type RtEvent = { type?: string; [k: string]: unknown }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 回合合并：同一个 id 的增量文本累加，final 时整段替换（转写完成事件给的是全量文本） */
function patchTurn(
  list: RealtimeTurn[],
  id: string,
  role: RealtimeTurn['role'],
  opts: { delta?: string; replace?: string; done?: boolean }
): RealtimeTurn[] {
  const round = Number(id.slice(1)) || 0
  const i = list.findIndex((t) => t.id === id)
  const base: RealtimeTurn = i < 0 ? { id, role, text: '', done: false, round } : list[i]!
  const text = opts.replace !== undefined ? opts.replace : base.text + (opts.delta ?? '')
  const done = opts.done ?? base.done
  if (i < 0) return [...list, { ...base, text, done }]
  const next = list.slice()
  next[i] = { ...base, text, done }
  return next
}

export function useRealtimeVoice({ port, hasProjector, expectedSlots }: { port: number; hasProjector: boolean; expectedSlots: number }) {
  const [phase, setPhase] = useState<RealtimePhase>('idle')
  const [turns, setTurns] = useState<RealtimeTurn[]>([])
  const [error, setError] = useState('')
  // 配置类提示（不是故障）：单独一条通道，避免把状态条正文整段顶掉
  const [notice, setNotice] = useState('')
  const [speaking, setSpeaking] = useState(false)
  // 电平是每 256ms 一次的高频数据：放 state 会让整个聊天页每秒重渲染 4 次，
  // 所以只存 ref，由状态条自己用 rAF 读出来画。
  const levelRef = useRef(0)
  // 单槽模式（服务端只开 1 个槽）：开不了实时转写会话，文字要等本地 ASR 补上，界面据此提示
  const [singleSlot, setSingleSlot] = useState(false)
  // 服务端实际槽数：状态条上显示出来，用户一眼能看出走的是实时转写还是本地识别
  const [slots, setSlots] = useState(0)
  // 本次实时会话的标识：同一段聊天里可能开好几次语音，消息 id 必须能区分开，否则后一次会覆盖前一次
  const [runId, setRunId] = useState('')

  const wsRef = useRef<WebSocket | null>(null) // 对话连接
  const txWsRef = useRef<WebSocket | null>(null) // 转写连接
  const micCtxRef = useRef<AudioContext | null>(null)
  const playCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const sourcesRef = useRef<AudioBufferSourceNode[]>([])
  const nextTimeRef = useRef(0) // 播放排队的下一个空位（秒）
  const uncommittedRef = useRef(0) // 已发给对话连接、但还没提交的样本数
  const txSentRef = useRef(0) // 已发给转写连接、但还没提交的样本数
  const roundRef = useRef(0) // 第几轮（每提交一次 +1）
  const pendingRoundRef = useRef(0) // 最近一次提交的轮次：两个连接的回复都归到这一轮
  // 模型是否正在出声（用 ref：采集回调里要同步读，state 更新太慢）
  const speakingRef = useRef(false)
  // 断句状态：这一轮是否已经在说话、最后一次有声的时刻、这一轮开始说话的时刻
  const vadRef = useRef({ voiced: false, lastVoiceAt: 0, speechStartAt: 0 })
  // 这一轮里出现过的最强电平：判断「整段是静音」还是「有人在轻声说话」。
  // 只看瞬时电平会把说话很轻的人整段丢掉，必须看峰值。
  const peakRmsRef = useRef(0)
  // 双槽兜底的延时器：停止会话时必须清掉，否则停了还会跑一次本地转写
  const fallbackTimerRef = useRef<number | null>(null)
  // 播放看门狗：播放上下文异常时 onended 可能永远不来，会把「模型正在说话」卡死
  const watchdogRef = useRef<number | null>(null)
  // 已经提交、等模型回答的期间不再重复提交
  const awaitingRef = useRef(false)
  const awaitingSinceRef = useRef(0)
  // 当前底噪（RMS），断句阈值由它推出来
  const noiseRef = useRef(0.005)
  // 本轮缓冲从什么时候开始攒（兜底强制提交用）
  const bufferStartRef = useRef(0)
  // 这一轮录到的音频（每块 256ms）：提交时整段交给本地 ASR，或留给双槽兜底用
  const roundChunksRef = useRef<Int16Array[]>([])
  const pendingAudioRef = useRef(new Map<number, Int16Array[]>())
  // 转写连接是否真的开了（双槽才有）。必须和「有没有办法拿到文字」分开判断：
  // 混用会让「有本地 ASR」被当成「有实时转写」，音频既没送转写连接、也没留下来给本地 ASR。
  const dualRef = useRef(false)
  // 实时转写已经拿到文字的轮次：双槽下用它判断要不要回退到本地 ASR
  const userTextRef = useRef(new Map<number, string>())
  // 事件的回调是稳定引用（依赖数组里没有 phase），握手阶段报错要靠 ref 判断当前处于哪一档
  const phaseRef = useRef<RealtimePhase>('idle')
  // 启动代次：每次 start 自增。start 里每个 await 之后都要核对一次，
  // 否则「连接中取消」时旧的那次启动会继续跑完，留下没人管的连接和一直开着的麦克风。
  const startGenRef = useRef(0)
  // 正在跑的本地转写任务 id：停止会话时要一并掐掉，不然进程会在后台白跑几分钟
  const sttIdsRef = useRef<Set<string>>(new Set())
  // 端口与投影状态随卡片变化，但回调不该因此重建，统一走 ref 读取最新值
  const portRef = useRef(port)
  const projectorRef = useRef(hasProjector)
  const expectedSlotsRef = useRef(expectedSlots)
  portRef.current = port
  projectorRef.current = hasProjector
  expectedSlotsRef.current = expectedSlots

  const goPhase = useCallback((p: RealtimePhase) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  /** 停掉排队中的播放，并把时间轴归零 */
  const stopPlayback = useCallback(() => {
    for (const s of sourcesRef.current) {
      try { s.stop() } catch { /* 已结束 */ }
    }
    sourcesRef.current = []
    nextTimeRef.current = 0
    speakingRef.current = false
    setSpeaking(false)
  }, [])

  /** 把一段 base64 PCM16 排进播放队列：后到的一段接在前一段后面，避免重叠爆音 */
  const enqueueAudio = useCallback((b64: string) => {
    const ctx = playCtxRef.current
    if (!ctx || !b64) return
    let bin: string
    try { bin = atob(b64) } catch { return }
    const len = bin.length >> 1
    if (len <= 0) return
    const f32 = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      const lo = bin.charCodeAt(i * 2)
      const hi = bin.charCodeAt(i * 2 + 1)
      let v = (hi << 8) | lo
      if (v >= 0x8000) v -= 0x10000
      f32[i] = v / 32768
    }
    const buf = ctx.createBuffer(1, len, OUT_RATE)
    buf.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime + 0.03, nextTimeRef.current)
    src.start(startAt)
    nextTimeRef.current = startAt + buf.duration
    sourcesRef.current.push(src)
    speakingRef.current = true
    setSpeaking(true)
    src.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== src)
      if (sourcesRef.current.length === 0) {
        speakingRef.current = false
        setSpeaking(false)
      }
    }
  }, [])

  /** 把这一轮的音频交给本地 ASR 单独转写（独立进程，不占实时会话的槽）。
   *  单槽时在提交那一刻就启动，和模型生成并行；双槽时只作为「实时转写没回话」的兜底。 */
  const transcribeLocal = useCallback(async (round: number, chunks: Int16Array[]) => {
    // 失败时也要给个明确说法：一直停在「识别中…」比报错更让人困惑
    const fail = (label: string): void => {
      // 已经停止的会话不再改写：进程是被我们掐掉的，报「识别失败」只会误导
      if (phaseRef.current === 'idle') return
      setTurns((prev) => patchTurn(prev, `u${round}`, 'user', { replace: label, done: true }))
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    if (total < IN_RATE * 0.3) return // 太短的一段没有转写价值
    const st = useStore.getState()
    const backend = st.activeBackend?.path
    const pick = pickLocalAsr()
    if (!backend || !pick) {
      fail('语音输入（未配置本地识别模型）')
      return
    }
    const pcm = new Int16Array(total)
    let off = 0
    for (const c of chunks) {
      pcm.set(c, off)
      off += c.length
    }
    const id = `rt-${round}-${Date.now().toString(36)}`
    sttIdsRef.current.add(id)
    try {
      const saved = await window.api.writeTempFile(
        `llama-studio-rt-${Date.now().toString(36)}.wav`,
        pcmToWavBase64(pcm)
      )
      if (!saved.success || !saved.path) {
        fail('语音输入（音频写入失败）')
        return
      }
      const res = await window.api.sttTranscribe({
        id,
        backendPath: backend,
        modelPath: pick.model,
        mmprojPath: pick.mmproj,
        audioPath: saved.path,
        // 「Perform ASR.」让模型自己判断语言；写死英文指令时中文会被转成英文胡话
        prompt: st.sttPrompt?.trim() || 'Perform ASR.',
      })
      const text = (res.text ?? '').trim()
      if (res.success && text && !isJunkTranscript(text)) {
        setTurns((prev) => patchTurn(prev, `u${round}`, 'user', { replace: text, done: true }))
      } else if (res.success) {
        // 识别成功但结果是噪声套路：如实标注，不把胡话写进会话
        fail('语音输入（未识别到内容）')
      } else {
        fail(`语音输入（识别失败${res.error ? '：' + res.error.slice(0, 60) : ''}）`)
      }
    } catch {
      // 转写失败不影响对话本身，只在气泡上说明
      fail('语音输入（识别失败）')
    } finally {
      sttIdsRef.current.delete(id)
    }
  }, [])

  /** 关连接、停麦克风、停播放，回到未连接状态 */
  const stopAll = useCallback(() => {
    // 让正在进行的 start 立刻作废：它每个 await 之后都会核对代次
    startGenRef.current++
    // 掐掉还在跑的本地转写进程（preload 未就绪时静默跳过）
    for (const id of sttIdsRef.current) void window.api?.sttStop(id).catch(() => { /* 已结束 */ })
    sttIdsRef.current.clear()
    for (const ref of [wsRef, txWsRef]) {
      const ws = ref.current
      ref.current = null
      if (!ws) continue
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try { ws.close() } catch { /* 已关闭 */ }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    try { procRef.current?.disconnect() } catch { /* 未连接 */ }
    procRef.current = null
    if (micCtxRef.current) void micCtxRef.current.close().catch(() => { /* 已关闭 */ })
    micCtxRef.current = null
    stopPlayback()
    if (playCtxRef.current) void playCtxRef.current.close().catch(() => { /* 已关闭 */ })
    playCtxRef.current = null
    if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null }
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null }
    uncommittedRef.current = 0
    txSentRef.current = 0
    roundChunksRef.current = []
    pendingAudioRef.current.clear()
    userTextRef.current.clear()
    dualRef.current = false
    vadRef.current = { voiced: false, lastVoiceAt: 0, speechStartAt: 0 }
    peakRmsRef.current = 0
    awaitingRef.current = false
    goPhase('idle')
    levelRef.current = 0
    // 停止时还停在「识别中…」的用户回合，标成未转写，别让它永远转圈
    setTurns((prev) => {
      if (!prev.some((t) => t.role === 'user' && !t.text.trim())) return prev
      return prev.map((t) => (t.role === 'user' && !t.text.trim() ? { ...t, text: '语音输入（未转写）', done: true } : t))
    })
  }, [stopPlayback, goPhase])

  /** 对话连接的事件：模型这边的一切（文字 + 语音） */
  const handleConvEvent = useCallback((ev: RtEvent) => {
    const type = ev.type ?? ''
    const round = pendingRoundRef.current
    const id = `a${round}`
    switch (type) {
      case 'session.created':
      case 'session.updated':
        goPhase('live')
        break
      case 'error': {
        const msg = str((ev.error as { message?: unknown } | undefined)?.message) || '实时会话出错'
        // 清空静音缓冲用的 clear 事件如果服务端不认识，会回一条 error；它不是故障，不弹到界面上。
        // 只放过「不认识这个事件」这一类，别的错误照常显示，别把真问题也一起吞掉。
        if (/input_audio_buffer\.clear/i.test(msg) && /(unknown|unsupported|invalid|not\s+support)/i.test(msg)) break
        setError(msg)
        awaitingRef.current = false // 别因为一次报错就再也不提交了
        // 握手阶段就报错（例如模型不支持实时语音），直接收摊，别把麦克风一直开着
        if (phaseRef.current === 'connecting') stopAll()
        break
      }
      case 'response.created':
        // 新一轮开始：上一轮的播放看门狗作废，否则它会在这一轮里把声音掐掉
        if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null }
        stopPlayback() // 新一轮回复开始，上一轮残留的排队音频不能接着放
        setTurns((prev) => patchTurn(prev, id, 'assistant', {}))
        break
      case 'response.output_text.delta':
        setTurns((prev) => patchTurn(prev, id, 'assistant', { delta: str(ev.delta) }))
        break
      case 'response.output_text.done':
        setTurns((prev) => patchTurn(prev, id, 'assistant', { done: true }))
        break
      case 'response.output_audio.delta':
        enqueueAudio(str(ev.delta) || str(ev.audio))
        break
      case 'response.output_audio.done':
        setTurns((prev) => patchTurn(prev, id, 'assistant', { done: true }))
        break
      case 'response.done': {
        awaitingRef.current = false
        setTurns((prev) => patchTurn(prev, id, 'assistant', { done: true }))
        // 双槽：先等实时转写，3 秒还没文字就回退到本地 ASR（单槽在提交时就已经开始转了）
        const chunks = pendingAudioRef.current.get(round)
        if (chunks && dualRef.current) {
          pendingAudioRef.current.delete(round)
          if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
          fallbackTimerRef.current = window.setTimeout(() => {
            fallbackTimerRef.current = null
            if (!userTextRef.current.get(round)) void transcribeLocal(round, chunks)
          }, 3000)
        }
        // 看门狗：播放上下文异常时 onended 可能永远不来，会把「模型正在说话」卡死、上行永久静音
        if (watchdogRef.current) clearTimeout(watchdogRef.current)
        watchdogRef.current = window.setTimeout(() => {
          watchdogRef.current = null
          if (speakingRef.current) stopPlayback()
        }, 60000)
        break
      }
      case 'input_audio_buffer.committed':
        uncommittedRef.current = 0
        break
      default:
        break
    }
  }, [enqueueAudio, stopPlayback, stopAll, goPhase, transcribeLocal])

  /** 转写连接的事件：用户说的话 */
  const handleTxEvent = useCallback((ev: RtEvent) => {
    const type = ev.type ?? ''
    const id = `u${pendingRoundRef.current}`
    switch (type) {
      case 'conversation.item.input_audio_transcription.delta':
        setTurns((prev) => patchTurn(prev, id, 'user', { delta: str(ev.delta) }))
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const text = str(ev.transcript).trim()
        if (isJunkTranscript(text)) {
          // 噪声识别出的固定套路：不写进会话，也不再触发本地兜底
          userTextRef.current.set(pendingRoundRef.current, ' ')
          setTurns((prev) => patchTurn(prev, id, 'user', { replace: '语音输入（未识别到内容）', done: true }))
          break
        }
        userTextRef.current.set(pendingRoundRef.current, text)
        setTurns((prev) => patchTurn(prev, id, 'user', { replace: text, done: true }))
        break
      }
      case 'input_audio_buffer.committed':
        txSentRef.current = 0
        break
      default:
        break
    }
  }, [])

  /** 提交这一轮并让模型开口：commit 定稿用户消息，response.create 触发回复。
   *  转写连接也要提交一次，否则它不会给这一轮出文字。 */
  const sendCommit = useCallback((ws: WebSocket) => {
    if (uncommittedRef.current <= 0) return
    pendingRoundRef.current = ++roundRef.current
    awaitingRef.current = true
    awaitingSinceRef.current = performance.now()
    const commit = JSON.stringify({ type: 'input_audio_buffer.commit' })
    ws.send(commit)
    ws.send(JSON.stringify({ type: 'response.create' }))
    uncommittedRef.current = 0
    // 用户这一轮到此结束：先立一个空的用户回合，界面据此立刻给出用户气泡。
    // 文字要等转写回来才填，但气泡本身不该等转写——没有文字也该看得到「我刚说了一句」。
    setTurns((prev) => patchTurn(prev, `u${pendingRoundRef.current}`, 'user', {}))
    // 这一轮音频存一份：单槽马上拿去本地转写，双槽留着给「实时转写没回话」兜底
    peakRmsRef.current = 0
    const chunks = roundChunksRef.current
    roundChunksRef.current = []
    if (chunks.length) {
      if (!dualRef.current) {
        // 单槽：提交就立刻转写，和模型生成并行。放到回复之后再转，文字会白白晚一整轮。
        void transcribeLocal(pendingRoundRef.current, chunks)
      } else {
        pendingAudioRef.current.set(pendingRoundRef.current, chunks)
      }
    }
    const tx = txWsRef.current
    if (tx && tx.readyState === WebSocket.OPEN && txSentRef.current > 0) {
      tx.send(commit)
      txSentRef.current = 0
    }
  }, [transcribeLocal])

  /** 整段静音的处理：把服务端缓冲和本地留的音频一起丢掉。
   *  不能靠「提交」来清空——提交会把一段静音当成一条用户消息，模型会对着空气回答。 */
  const clearIdleBuffer = useCallback((ws: WebSocket) => {
    const payload = JSON.stringify({ type: 'input_audio_buffer.clear' })
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    const tx = txWsRef.current
    if (tx && tx.readyState === WebSocket.OPEN) tx.send(payload)
    uncommittedRef.current = 0
    txSentRef.current = 0
    roundChunksRef.current = []
    peakRmsRef.current = 0
    vadRef.current.voiced = false
    bufferStartRef.current = performance.now()
  }, [])

  /** 断句：有声就记时刻，静音超过阈值就自动提交，不需要用户点任何按钮。
   *  阈值不写死：底噪随环境变化（空调、风扇、麦克风增益），只在「判定为静音」时缓慢跟随，
   *  否则固定值在安静麦克风上永远触发不了、在嘈杂环境里又一直被噪声触发。 */
  const detectTurnEnd = useCallback((ws: WebSocket, rms: number) => {
    const vad = vadRef.current
    const now = performance.now()
    const threshold = Math.max(VAD_MIN_LEVEL, noiseRef.current * VAD_NOISE_FACTOR)
    if (rms >= threshold) {
      if (!vad.voiced) {
        vad.voiced = true
        vad.speechStartAt = now
      }
      vad.lastVoiceAt = now
    } else if (!vad.voiced) {
      // 没在说话时顺手校准底噪（慢跟随，一次只动 5%）
      noiseRef.current = noiseRef.current * 0.95 + rms * 0.05
    }

    // 兜底：缓冲攒太久还没断句（一直在说话、或环境有持续底噪）
    if (uncommittedRef.current > 0 && now - bufferStartRef.current > VAD_MAX_BUFFER_MS && !awaitingRef.current) {
      if (peakRmsRef.current >= VAD_MIN_LEVEL) {
        // 这一轮里确实有声音（哪怕很轻）：按说话处理，不能把人的话丢掉
        vad.voiced = false
        sendCommit(ws)
      } else {
        // 一直没人说话：丢掉这段静音，别让模型被静音触发，也别让缓冲无限涨
        clearIdleBuffer(ws)
      }
      return
    }

    if (rms >= threshold || !vad.voiced) return
    if (now - vad.lastVoiceAt < VAD_SILENCE_MS) return
    vad.voiced = false
    // 太短的一段当噪声丢掉。这里必须用「有声时长」（lastVoiceAt - speechStartAt），
    // 不能用「现在 - 说话开始」——后者已经把静音等待算进去了，
    // 于是任何一声敲击都能凑够时长，噪声就被当成一句话提交了。
    if (vad.lastVoiceAt - vad.speechStartAt < VAD_MIN_SPEECH_MS) return
    // 上一轮提交后迟迟没有回应（模型卡住 / 事件丢了）：别把会话锁死，20 秒后允许重新提交
    if (awaitingRef.current && now - awaitingSinceRef.current < 20000) return
    sendCommit(ws)
  }, [sendCommit, clearIdleBuffer])

  /** 麦克风采集：16 kHz 单声道 PCM16 → base64 → 同时送对话与转写两条连接 */
  const startCapture = useCallback((stream: MediaStream, ws: WebSocket) => {
    const ctx = new AudioContext({ sampleRate: IN_RATE })
    micCtxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(CHUNK, 1, 1)
    procRef.current = proc
    // 必须接到 destination 才会持续回调；中间插一个 0 增益，避免把自己的声音放出来
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(proc)
    proc.connect(mute)
    mute.connect(ctx.destination)
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const data = e.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(data.length)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = Math.max(-1, Math.min(1, data[i]!))
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
        sum += v * v
      }
      const rms = Math.sqrt(sum / data.length)
      levelRef.current = Math.min(1, rms * 4)
      if (rms > peakRmsRef.current) peakRmsRef.current = rms
      // 模型正在出声时不上行：否则扬声器的声音会被当成用户输入，模型听见自己就会自问自答
      if (speakingRef.current) return
      const payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(pcm) })
      ws.send(payload)
      if (uncommittedRef.current === 0) bufferStartRef.current = performance.now()
      uncommittedRef.current += pcm.length
      const tx = txWsRef.current
      if (tx && tx.readyState === WebSocket.OPEN) {
        tx.send(payload)
        txSentRef.current += pcm.length
      }
      // 音频一律留一份：实时转写万一没回话，还能退回本地 ASR（16k×2 字节/秒，一分钟约 1.9MB）
      roundChunksRef.current.push(pcm)
      detectTurnEnd(ws, rms)
    }
    void ctx.resume()
  }, [detectTurnEnd])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle') return
    const p = portRef.current
    if (!p) {
      notify('先启动一个模型（实时语音要用正在运行的 llama-server）', 'error')
      return
    }
    if (!projectorRef.current) {
      notify('这个模型没有挂音频投影（--mmproj），实时语音收不到也发不出声音：在模板参数里加上 --mmproj 指向 mmproj GGUF，重启后再试', 'error')
      return
    }
    const gen = ++startGenRef.current
    setError('')
    setNotice('')
    setTurns([])
    roundRef.current = 0
    pendingRoundRef.current = 0
    setRunId(Date.now().toString(36))
    goPhase('connecting')
    try {
      // 先问服务端有几个槽：一条实时会话独占一个。只有 1 个时绝不能开第二条，
      // 否则对话会话拿不到槽，表现就是「能说话、模型不回答」。
      const slots = await fetchSlots(p)
      if (startGenRef.current !== gen) return // 等待期间被取消
      setSlots(slots)
      const dual = slots >= 2
      dualRef.current = dual
      setSingleSlot(!dual)
      // 模板写了 --parallel 2，服务端却只报 1 个槽：说明这个服务是改参数之前启动的，
      // 不重启的话实时转写永远开不了，用户只会看到「文字很晚才补上」
      if (!dual && expectedSlotsRef.current >= 2) {
        setNotice('这个服务仍按单槽在跑（模板里的 --parallel 没生效）：在模型管理里停掉再启动一次，文字才会实时出来')
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (startGenRef.current !== gen) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const playCtx = new AudioContext({ sampleRate: OUT_RATE })
      if (startGenRef.current !== gen) {
        stream.getTracks().forEach((t) => t.stop())
        void playCtx.close().catch(() => { /* 忽略 */ })
        return
      }
      playCtxRef.current = playCtx
      // 浏览器策略：AudioContext 可能在 await 之后处于挂起态，不恢复就永远不出声
      void playCtx.resume().catch(() => { /* 忽略 */ })

      // 转写连接（只在槽位够时开）：它只负责把用户说的话转成文字，挂了不影响对话
      if (dual) {
        const tx = new WebSocket(`ws://127.0.0.1:${p}/v1/realtime`)
        txWsRef.current = tx
        tx.onopen = () => {
          // instructions 让模型自己判断语言（中英混说也按实际语言转写）；
          // 服务端若不认这个字段，会被忽略，不影响转写本身
          tx.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', instructions: 'Perform ASR.' } }))
        }
        tx.onmessage = (e) => {
          try { handleTxEvent(JSON.parse(String(e.data)) as RtEvent) } catch { /* 非 JSON 帧忽略 */ }
        }
        tx.onerror = () => { /* 静默失败：对话本身不受影响 */ }
      }

      const ws = new WebSocket(`ws://127.0.0.1:${p}/v1/realtime`)
      wsRef.current = ws
      if (startGenRef.current !== gen) {
        stopAll() // 创建连接期间被取消：把已建的连接与麦克风一并收掉
        return
      }
      ws.onopen = () => {
        // 连接建立即可开始送音频；个别构建只回 session.updated 而不回 session.created，
        // 不能把「已连接」挂在某一个事件上，否则界面永远停在连接中
        goPhase('live')
        // 模型卡里 voice chat 用的就是这句系统提示，换别的措辞容易只回文字不回语音
        ws.send(JSON.stringify({
          type: 'session.update',
          session: { instructions: 'Respond with interleaved text and audio.' },
        }))
        try {
          startCapture(stream, ws)
        } catch (err) {
          // 麦克风初始化失败（比如设备不支持 16 kHz 上下文）：必须报出来并收摊，
          // 否则界面显示「已连接」却一个字也发不出去，看起来就像模型不回答
          stopAll()
          setError(`麦克风初始化失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      ws.onmessage = (e) => {
        try { handleConvEvent(JSON.parse(String(e.data)) as RtEvent) } catch { /* 非 JSON 帧忽略 */ }
      }
      ws.onerror = () => setError(`连不上实时接口（ws://127.0.0.1:${p}/v1/realtime）`)
      ws.onclose = () => {
        // 自己调 stopAll 时 wsRef 已被置空，这里只管意外断开
        if (!wsRef.current) return
        stopAll()
        setError('实时会话已断开')
      }
    } catch (err) {
      stopAll()
      const msg = err instanceof Error ? err.message : String(err)
      setError(`启动失败：${msg}`)
      notify(`启动实时语音失败：${msg}`, 'error')
    }
  }, [startCapture, stopAll, goPhase, handleConvEvent, handleTxEvent])

  const stop = useCallback(() => { stopAll() }, [stopAll])

  const toggle = useCallback(() => {
    if (phaseRef.current === 'idle') void start()
    else stopAll()
  }, [start, stopAll])

  /** 手动兜底：环境太吵、断句没触发时，用户自己催一次回复 */
  const commit = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (uncommittedRef.current <= 0) {
      notify('还没有录到声音', 'error')
      return
    }
    sendCommit(ws)
  }, [sendCommit])

  // 服务被停掉或换了一个（端口变了）时，会话已经没有意义，直接收摊
  useEffect(() => {
    if (phaseRef.current !== 'idle' && !port) stopAll()
  }, [port, stopAll])

  // 组件卸载（切走会话/关掉界面）时务必收干净：麦克风与 WebSocket 都不该在后台留着
  useEffect(() => () => { stopAll() }, [stopAll])

  return { phase, active: phase !== 'idle', turns, error, notice, levelRef, speaking, singleSlot, slots, runId, start, stop, toggle, commit }
}
