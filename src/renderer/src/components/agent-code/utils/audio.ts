// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：音频编码（浏览器可解码音频 → 16-bit PCM WAV base64）                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，逻辑未变。

/** 将浏览器可解码的音频（如 webm/opus）转成 16-bit PCM WAV 的 base64，供本地 STT 模型识别。 */
export async function encodeWavBase64(inputBuf: ArrayBuffer): Promise<string> {
  const AudioContextCtor: typeof AudioContext =
    window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
  const ac = new AudioContextCtor()
  const audioBuf = await ac.decodeAudioData(inputBuf)
  const numCh = audioBuf.numberOfChannels
  const sampleRate = audioBuf.sampleRate
  const len = audioBuf.length
  const bytesPerSample = 2
  const blockAlign = numCh * bytesPerSample
  const dataSize = len * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE')
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, dataSize, true)
  const channels: Float32Array[] = []
  for (let c = 0; c < numCh; c++) channels.push(audioBuf.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  const bytes = new Uint8Array(buffer)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)))
  }
  return btoa(bin)
}
