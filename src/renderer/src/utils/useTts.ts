import { useState, useCallback, useEffect, useRef } from 'react'

export function useTts() {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)

  const speak = useCallback((id: string, text: string) => {
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'zh-CN'
    utter.rate = 2.0
    utter.onend = () => setSpeakingId(null)
    utter.onerror = () => setSpeakingId(null)
    utterRef.current = utter
    setSpeakingId(id)
    window.speechSynthesis.speak(utter)
  }, [])

  const stop = useCallback(() => {
    window.speechSynthesis.cancel()
    setSpeakingId(null)
  }, [])

  useEffect(() => {
    return () => { window.speechSynthesis.cancel() }
  }, [])

  return { speakingId, speak, stop }
}
