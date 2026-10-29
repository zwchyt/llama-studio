// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：实时语音的音频与识别辅助（纯函数）                                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 从 useRealtimeVoice 里抽出来的纯逻辑：采样率常量、PCM/WAV 编码、噪声结果过滤、
// 槽位探测、本地 ASR 选型。放在这里是为了让那个 hook 只留「连接与状态」，
// 也让这些函数能被单独读、单独改，不用在一千行里翻。

import { useStore } from '../../../store/useStore'

export const IN_RATE = 16000 // 上行采样率
export const OUT_RATE = 24000 // 下行采样率（模型输出）
export const CHUNK = 4096 // ScriptProcessor 每帧样本数（必须是 2 的幂）

// ── 自动断句（客户端静音检测）──
// 这个实时接口不做服务端断句（turn_detection 恒为 null，传 server_vad 也被忽略），
// 所以「说完自动发出去」只能自己判。
export const VAD_MIN_LEVEL = 0.004 // 阈值下限：再低会被风扇/电流声触发
export const VAD_NOISE_FACTOR = 2.5 // 阈值 = 当前底噪 × 2.5
export const VAD_SILENCE_MS = 600 // 停顿多久算说完
export const VAD_MIN_SPEECH_MS = 300 // 有效语音至少这么长（按真实有声时长算）
export const VAD_MAX_BUFFER_MS = 15000 // 缓冲最多攒这么久，超了要么提交要么丢弃

/** 任意字节 → base64：分块拼串，避免 fromCharCode 一次性展开超长参数栈 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** Int16 PCM → base64（上行音频用） */
export function pcm16ToBase64(pcm: Int16Array): string {
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
}

/** 16 kHz 单声道 16 位 WAV：本地 ASR 只认音频文件，得把 PCM 套上 RIFF 头 */
export function pcmToWavBase64(pcm: Int16Array): string {
  const dataBytes = pcm.byteLength
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const put = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  put(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // 单声道
  v.setUint32(24, IN_RATE, true)
  v.setUint32(28, IN_RATE * 2, true) // 每秒字节数
  v.setUint16(32, 2, true) // 块对齐
  v.setUint16(34, 16, true) // 位深
  put(36, 'data')
  v.setUint32(40, dataBytes, true)
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes))
  return bytesToBase64(new Uint8Array(buf))
}

// 识别模型对噪声有固定「套路」输出（尤其静音/风扇声），这些不是用户说的话。
const JUNK_PATTERNS = [
  /^谢谢(观看|大家|收看|收听)/,
  /^字幕/,
  /^请不吝/,
  /^(订阅|点赞|打赏|关注)/,
  /^thank you for watching/i,
  /^thanks for watching/i,
  /^subscribe/i,
  /^\.{2,}$/,
]

/** 这段识别结果是不是「不是人话」：空、纯符号、单字、固定套路、同一个字重复 */
export function isJunkTranscript(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  const visible = t.replace(/[\s\p{P}\p{S}]/gu, '')
  if (visible.length < 2) return true
  if (JUNK_PATTERNS.some((re) => re.test(t))) return true
  if (visible.length >= 4 && new Set(visible).size === 1) return true
  return false
}

/** 读服务端槽位数：一条实时会话要独占一个槽。
 *  走主进程 IPC 而不是页面里 fetch —— 渲染层受 CSP 与跨域限制，读失败会被当成单槽，
 *  结果明明有 4 个槽却退回慢路径。 */
export async function fetchSlots(port: number): Promise<number> {
  try {
    const r = await window.api.getServerProps(port)
    return r.ok && typeof r.slots === 'number' && r.slots > 0 ? r.slots : 1
  } catch {
    return 1
  }
}

/** 选一套本地 ASR：优先用户在「语音转写」里配好的，没配就按文件名自动配对 */
export function pickLocalAsr(): { model: string; mmproj: string } | null {
  const st = useStore.getState()
  if (st.sttModelPath && st.sttMmprojPath) return { model: st.sttModelPath, mmproj: st.sttMmprojPath }
  const model = st.models.find((m) => m.asr) ?? st.models.find((m) => /asr|speech|whisper/i.test(m.name))
  if (!model) return null
  // 型号关键字：去掉量化后缀，「Qwen3-ASR-1.7B-Q8_0.gguf」→「qwen3-asr-1.7b」
  const key = model.name.replace(/\.gguf$/i, '').replace(/[-_.]q\d.*$/i, '').toLowerCase()
  const exact = st.imageModels.find((m) => /mmproj/i.test(m.name) && m.name.toLowerCase().includes(key))
  if (exact) return { model: model.path, mmproj: exact.path }
  // 名字对不上时的兜底：只有「带 asr 字样的投影恰好一个」才敢用，多个候选宁可放弃
  const asrLike = st.imageModels.filter((m) => /mmproj/i.test(m.name) && /asr/i.test(m.name))
  return asrLike.length === 1 ? { model: model.path, mmproj: asrLike[0]!.path } : null
}
