// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentMic —— 麦克风语音输入（本地 STT 模型）                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx「麦克风语音输入」区域，逻辑与注释均未改动。
//
// 自持状态：mediaRecorder / micChunks / micStream / micBaseText / micBusy / micTimer
//           六个 ref，listening / micTranscribing 两个 state。
// 对外依赖：仅输入框的 input 与 setInput（识别结果回填）。
//
// ⚠️ 保留的原行为：startMic 的 useCallback 依赖数组为 []，因此其中读到的 input
//    是首次渲染时的值（`micBaseTextRef.current = input` 会取到空串）。这是搬移前
//    就存在的既有行为，本次拆分严格保持等价，未顺手修正——如需修复请单独提交。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { encodeWavBase64 } from '../utils/audio'

export function useAgentMic({ input, setInput }: {
  input: string
  setInput: (v: string) => void
}) {
  const mediaRecorderRef = useRef<any>(null)
  const micChunksRef = useRef<any[]>([])
  const micStreamRef = useRef<MediaStream | null>(null)
  const micBaseTextRef = useRef('') // 点录音前输入框已有的文字（实时回填时作为前缀保留）
  const micBusyRef = useRef(false) // 实时片段识别是否进行中（防止定时器重叠）
  const micTimerRef = useRef<number | null>(null)
  const [listening, setListening] = useState(false) // 录音中
  const [micTranscribing, setMicTranscribing] = useState(false) // 最终识别中

  const stopMic = (): void => {
    try { mediaRecorderRef.current?.stop() } catch { /* noop */ }
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
  }

  const startMic = useCallback(async () => {
    const st = useStore.getState()
    const backendPath = st.activeBackend?.path || ''
    // 仅使用手动配置的 STT 模型与音频 mmproj（不再自动从磁盘模型里挑选）
    const asrModel = st.sttModelPath || ''
    const mmproj = st.sttMmprojPath || ''
    if (!asrModel || !mmproj || !backendPath) {
      notify('语音识别缺少配置：需要 ASR 模型 + 音频 mmproj + 已选择的 llama.cpp 后端（在「后端管理」选中一个版本）', 'error')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      notify('当前环境无法访问麦克风（navigator.mediaDevices 不可用，可能需 Electron 允许媒体权限）', 'error')
      return
    }
    // 配置就绪，先给可见反馈（按钮变红脉冲），再申请麦克风
    setListening(true)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setListening(false)
      notify('无法访问麦克风（请检查系统 / Electron 麦克风权限）：' + String(e), 'error')
      return
    }
    micBaseTextRef.current = input
    micStreamRef.current = stream
    const mr = new MediaRecorder(stream)
    micChunksRef.current = []
    mr.ondataavailable = (e: any) => { if (e.data && e.data.size) micChunksRef.current.push(e.data) }
    // 实时回填：录音期间周期性把已录音频送本地 STT，识别结果写回输入框（边说边显示）
    const liveTranscribe = async () => {
      if (micBusyRef.current || micChunksRef.current.length === 0) return
      micBusyRef.current = true
      try {
        const blob = new Blob(micChunksRef.current, { type: mr.mimeType || 'audio/webm' })
        const wavB64 = await encodeWavBase64(await blob.arrayBuffer())
        const saved = await window.api.writeTempFile(`llama-studio-mic-${crypto.randomUUID()}.wav`, wavB64)
        if (saved.success && saved.path) {
          const res = await window.api.sttTranscribe({
            id: crypto.randomUUID(), backendPath, modelPath: asrModel, mmprojPath: mmproj,
            audioPath: saved.path, prompt: st.sttPrompt?.trim() || 'Transcribe the following audio to text.'
          })
          if (res.success && res.text) {
            const base = micBaseTextRef.current
            const txt = base ? (/\s$/.test(base) ? base + res.text : base + ' ' + res.text) : res.text
            setInput(txt)
          }
        }
      } catch { /* 忽略实时片段的瞬时错误 */ } finally {
        micBusyRef.current = false
      }
    }
    mr.onstop = async () => {
      micStreamRef.current?.getTracks().forEach(t => t.stop())
      micStreamRef.current = null
      if (micTimerRef.current) { clearInterval(micTimerRef.current); micTimerRef.current = null }
      try {
        const blob = new Blob(micChunksRef.current, { type: mr.mimeType || 'audio/webm' })
        const wavB64 = await encodeWavBase64(await blob.arrayBuffer())
        const saved = await window.api.writeTempFile(`llama-studio-mic-${crypto.randomUUID()}.wav`, wavB64)
        if (!saved.success || !saved.path) { notify('写入临时音频失败：' + (saved.error || ''), 'error'); return }
        setMicTranscribing(true)
        const res = await window.api.sttTranscribe({
          id: crypto.randomUUID(), backendPath, modelPath: asrModel, mmprojPath: mmproj,
          audioPath: saved.path, prompt: st.sttPrompt?.trim() || 'Transcribe the following audio to text.'
        })
        if (res.success && res.text) {
          const base = micBaseTextRef.current
          const txt = base ? (/\s$/.test(base) ? base + res.text : base + ' ' + res.text) : res.text
          setInput(txt)
          notify('语音识别完成', 'success')
        } else {
          notify('语音识别失败：' + (res.error || '未知错误'), 'error')
        }
      } catch (e) {
        notify('语音处理出错：' + String(e), 'error')
      } finally {
        setMicTranscribing(false)
        setListening(false)
      }
    }
    mediaRecorderRef.current = mr
    mr.start()
    micTimerRef.current = window.setInterval(liveTranscribe, 2000)
    // 尽早触发第一次实时识别（录音刚开始就开跑，不等满一个间隔）
    window.setTimeout(liveTranscribe, 1200)
  }, [])
  const toggleListen = useCallback(() => {
    if (micTranscribing) return
    if (listening) stopMic()
    else startMic()
  }, [listening, micTranscribing, startMic, stopMic])
  useEffect(() => () => { try { mediaRecorderRef.current?.stop() } catch { /* noop */ } if (micTimerRef.current) clearInterval(micTimerRef.current) }, [])

  return { listening, micTranscribing, startMic, toggleListen, stopMic }
}
