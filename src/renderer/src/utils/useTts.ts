import { useState, useCallback, useEffect, useRef } from 'react'
import { notify } from '../store/notificationStore'
import { useStore } from '../store/useStore'
import { dataUrlToBlobUrl } from './audioUrl'
import { prepareTtsText, splitTtsSentences } from './ttsText'

// 聊天消息朗读 hook。两条路径：
//   · edge   —— Edge 在线神经网络语音（默认）。音质接近 Azure，实测约 1.5s 出音，
//               走主进程合成后拿 audio data URL 播放。本地 TTS 模型要 10s+，所以不用它。
//   · system —— 浏览器/系统内置语音（speechSynthesis）。离线可用，但机械感强。
// Edge 是网络服务，失败（断网 / 协议变动 / 被拒）时自动回退到 system，不让朗读直接失效。
// 消息正文是 Markdown，两条路径都在 speak() 里先过一次 prepareTtsText，避免符号被念出名称。
export function useTts() {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  // 竞态防护：stop / 新 speak 后忽略延迟入队（含 await 归来）的旧朗读
  const seqRef = useRef(0)

  /** 释放上一段音频的 blob URL（不释放会一直占内存） */
  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      try { URL.revokeObjectURL(blobUrlRef.current) } catch { /* ignore */ }
      blobUrlRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    seqRef.current++
    try { window.speechSynthesis?.cancel() } catch { /* 环境不支持 */ }
    if (audioRef.current) {
      try { audioRef.current.pause() } catch { /* ignore */ }
      audioRef.current = null
    }
    revokeBlob()
    setSpeakingId(null)
  }, [revokeBlob])

  /** 系统语音路径（离线兜底）：逐句入队、句间留一拍，长文本不会被 Chromium 掐断 */
  const speakSystem = useCallback((id: string, text: string, rate: number, seq: number) => {
    if (!('speechSynthesis' in window)) {
      notify('当前环境不支持系统语音朗读', 'error')
      setSpeakingId(null)
      return
    }
    const sentences = splitTtsSentences(text)
    const speakFrom = (i: number): void => {
      if (seq !== seqRef.current) return // 已被 stop 或新朗读取代
      if (i >= sentences.length) { setSpeakingId(null); return }
      const utter = new SpeechSynthesisUtterance(sentences[i])
      utter.lang = 'zh-CN'
      utter.rate = rate
      // 一句念完稍等再念下一句：句子之间因此有停顿，而不是连成一串
      utter.onend = () => setTimeout(() => speakFrom(i + 1), 120)
      utter.onerror = (e) => {
        setSpeakingId(null)
        // interrupted/canceled 是主动停止，不算故障
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          notify(`系统语音播放失败：${e.error || '未知错误'}`, 'error')
        }
      }
      utterRef.current = utter
      window.speechSynthesis.speak(utter)
    }
    setSpeakingId(id)
    window.speechSynthesis.cancel()
    // Chromium 坑：cancel() 后立即 speak() 可能被静默吞掉，延迟一拍再入队
    setTimeout(() => {
      if (seq !== seqRef.current) return
      speakFrom(0)
    }, 60)
  }, [])

  const speak = useCallback(async (id: string, text: string) => {
    const st = useStore.getState()
    const rate = st.ttsRate || 1
    // 摘掉 Markdown 与符号：直接喂原文会念出「左括号」「星号」「破折号」
    const speakable = prepareTtsText(text)
    if (!speakable) {
      notify('这条消息没有可朗读的正文', 'error')
      return
    }
    stop()
    const seq = ++seqRef.current
    setSpeakingId(id)

    if (st.ttsEngine === 'edge') {
      try {
        // preload 未重载时这个方法不存在（改 preload 必须完全重启应用）。
        // 显式探测一次，好给出能指导操作的提示，而不是一句 TypeError。
        if (typeof window.api?.edgeTtsSynthesize !== 'function') {
          throw new Error('主进程尚未加载 Edge TTS 接口（preload 改动需完全重启应用）')
        }
        const dataUrl = await window.api.edgeTtsSynthesize({ text: speakable, voice: st.ttsEdgeVoice, rate })
        if (seq !== seqRef.current) return // 合成期间被停止 / 换了一条
        // 必须先转 blob URL：CSP 的 media-src 不含 data:，直接喂 data URL 会被拒
        const url = dataUrlToBlobUrl(dataUrl)
        blobUrlRef.current = url
        const audio = new Audio(url)
        audioRef.current = audio
        const clear = (): void => { revokeBlob(); if (seq === seqRef.current) setSpeakingId(null) }
        audio.onended = clear
        audio.onerror = clear
        await audio.play()
        return
      } catch (e) {
        if (seq !== seqRef.current) return
        // 回退而不是直接报错：Edge 是网络服务，断网时用户仍应能听到系统语音
        notify(`Edge 语音合成失败，已回退系统语音：${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    }
    if (seq !== seqRef.current) return
    speakSystem(id, speakable, rate, seq)
  }, [stop, speakSystem])

  useEffect(() => {
    return () => {
      seqRef.current++
      try { window.speechSynthesis?.cancel() } catch { /* 环境不支持 */ }
      if (audioRef.current) { try { audioRef.current.pause() } catch { /* ignore */ } }
      if (blobUrlRef.current) { try { URL.revokeObjectURL(blobUrlRef.current) } catch { /* ignore */ } }
    }
  }, [])

  return { speakingId, speak, stop }
}
