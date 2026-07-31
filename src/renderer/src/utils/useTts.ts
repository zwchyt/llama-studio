import { useState, useCallback, useEffect, useRef } from 'react'
import { notify } from '../store/notificationStore'

// 聊天消息朗读 hook：只走系统语音（speechSynthesis）。
// 本地模型 TTS 已独立为「语音合成」视图（TtsView），不再介入聊天朗读。
export function useTts() {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)
  // 竞态防护：stop / 新 speak 后忽略延迟入队的旧朗读
  const seqRef = useRef(0)

  const speak = useCallback((id: string, text: string) => {
    if (!('speechSynthesis' in window)) {
      notify('当前环境不支持系统语音朗读', 'error')
      return
    }
    window.speechSynthesis.cancel()
    const seq = ++seqRef.current
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'zh-CN'
    utter.rate = 2.0
    utter.onend = () => setSpeakingId(null)
    utter.onerror = (e) => {
      setSpeakingId(null)
      // interrupted/canceled 是主动停止，不算故障
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        notify(`系统语音播放失败：${e.error || '未知错误'}`, 'error')
      }
    }
    utterRef.current = utter
    setSpeakingId(id)
    // Chromium 坑：cancel() 后立即 speak() 可能被静默吞掉，延迟一拍再入队
    setTimeout(() => {
      if (seq !== seqRef.current) return // 已被 stop 或新朗读取代
      window.speechSynthesis.speak(utter)
    }, 60)
  }, [])

  const stop = useCallback(() => {
    seqRef.current++
    window.speechSynthesis.cancel()
    setSpeakingId(null)
  }, [])

  useEffect(() => {
    return () => {
      seqRef.current++
      window.speechSynthesis.cancel()
    }
  }, [])

  return { speakingId, speak, stop }
}
