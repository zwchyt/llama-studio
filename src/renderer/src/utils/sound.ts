let audioCtx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/**
 * 播放清脆、明亮的完成提示音：两音快速上行（E6 → A6）
 * 特点：音量更大、攻击更快、高频更亮、带轻微合唱效果
 */
function playChime(): void {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()
  const now = ctx.currentTime
  const baseFreq = 1320
  const secondFreq = 1760

  const oscillators: OscillatorNode[] = []
  const gain = ctx.createGain()
  gain.connect(ctx.destination)

  const osc1 = ctx.createOscillator()
  osc1.type = 'sine'
  osc1.frequency.setValueAtTime(baseFreq, now)
  osc1.frequency.exponentialRampToValueAtTime(secondFreq, now + 0.12)
  osc1.connect(gain)
  oscillators.push(osc1)

  const osc2 = ctx.createOscillator()
  osc2.type = 'sine'
  osc2.frequency.setValueAtTime(baseFreq * 2, now)
  osc2.frequency.exponentialRampToValueAtTime(secondFreq * 2, now + 0.12)
  osc2.connect(gain)
  oscillators.push(osc2)

  const osc3 = ctx.createOscillator()
  osc3.type = 'square'
  osc3.frequency.setValueAtTime(baseFreq, now)
  osc3.frequency.exponentialRampToValueAtTime(secondFreq, now + 0.12)
  osc3.connect(gain)
  oscillators.push(osc3)

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.18, now + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28)

  oscillators.forEach(o => {
    o.start(now)
    o.stop(now + 0.3)
  })
}

/**
 * 轻快 POP 音：短促圆润的温暖音色
 * 特点：单正弦波 + 轻微低频，极短促
 */
function playPop(): void {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()
  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = 'sine'
  osc.frequency.setValueAtTime(660, now)
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.04)

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.25, now + 0.003)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)

  osc.start(now)
  osc.stop(now + 0.15)
}
/**
 * 成功提示：经典上行三连音 C5 → E5 → G5，带和弦叠加
 * 特点：听感像"叮叮叮"，有成就感 */
function playSuccess(): void {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()
  const now = ctx.currentTime

  const freqs = [523, 659, 784]
  const interval = 0.1
  const totalDuration = freqs.length * interval + 0.15

  const oscillators: OscillatorNode[] = []
  const gain = ctx.createGain()
  gain.connect(ctx.destination)

  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    const t = now + i * interval
    osc.frequency.setValueAtTime(freq, t)
    osc.connect(gain)
    oscillators.push(osc)
  })

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.2, now + 0.005)
  gain.gain.setValueAtTime(0.2, now + totalDuration - 0.05)
  gain.gain.exponentialRampToValueAtTime(0.001, now + totalDuration)

  oscillators.forEach((o, i) => {
    o.start(now + i * interval)
    o.stop(now + totalDuration)
  })
}

/**
 * 柔和提示：下行滑音，正弦波，缓慢衰减
 * 特点：轻柔不打扰，适合安静环境
 */
function playGentle(): void {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()
  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = 'sine'
  osc.frequency.setValueAtTime(880, now)
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.35)

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.12, now + 0.01)
  gain.gain.setValueAtTime(0.12, now + 0.2)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4)

  osc.start(now)
  osc.stop(now + 0.4)
}

/**
 * 科幻数字提示：方波 + 锯齿波，快速琶音
 * 特点：三音极速上行，电子感强
 */
function playDigital(): void {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()
  const now = ctx.currentTime

  const freqs = [880, 1175, 1568]
  const interval = 0.05
  const totalDuration = freqs.length * interval + 0.1

  const oscillators: OscillatorNode[] = []
  const gain = ctx.createGain()
  gain.connect(ctx.destination)

  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    const t = now + i * interval
    osc.frequency.setValueAtTime(freq, t)
    osc.connect(gain)
    oscillators.push(osc)
  })

  const oscSub = ctx.createOscillator()
  oscSub.type = 'sawtooth'
  oscSub.frequency.setValueAtTime(freqs[0] * 0.5, now)
  oscSub.frequency.exponentialRampToValueAtTime(freqs[2] * 0.5, now + totalDuration - 0.05)
  const gainSub = ctx.createGain()
  oscSub.connect(gainSub)
  gainSub.gain.setValueAtTime(0.03, now)
  gainSub.gain.exponentialRampToValueAtTime(0.001, now + totalDuration)
  gainSub.connect(ctx.destination)

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.15, now + 0.003)
  gain.gain.exponentialRampToValueAtTime(0.001, now + totalDuration)

  oscillators.forEach((o, i) => {
    o.start(now + i * interval)
    o.stop(now + totalDuration)
  })
  oscSub.start(now)
  oscSub.stop(now + totalDuration)
}

/** 播放预览音效（用于设置界面试听） */
export function previewSound(soundId: string): void {
  playSoundById(soundId)
}

function playSoundById(soundId: string): void {
  switch (soundId) {
    case 'pop':
      playPop()
      break
    case 'success':
      playSuccess()
      break
    case 'gentle':
      playGentle()
      break
    case 'digital':
      playDigital()
      break
    default:
      playChime()
      break
  }
}

/**
 * 播放通知提示音（根据当前设置选择对应音效） */
export function playNotificationSound(soundId?: string): void {
  try {
    playSoundById(soundId || 'chime')
  } catch (e) { console.warn('Notification sound failed:', e) }
}

/** 提示音选项列表（供 UI 渲染使用） */
export const SOUND_OPTIONS = [
  { id: 'chime', label: '清脆提示 (Chime)', description: 'E6→A6 快速上行，三层合成，清脆明亮' },
  { id: 'pop', label: '轻快 POP', description: '短促圆润的温暖音色，干净利落' },
  { id: 'success', label: '成功三连 (Success)', description: 'C5→E5→G5 上行三音，有成就感' },
  { id: 'gentle', label: '柔和提示 (Gentle)', description: 'A5→A4 下行滑音，柔和舒缓不打扰' },
  { id: 'digital', label: '科幻数字 (Digital)', description: '方波+锯齿波快速琶音，电子感强' },
] as const

export type SoundId = (typeof SOUND_OPTIONS)[number]['id']
