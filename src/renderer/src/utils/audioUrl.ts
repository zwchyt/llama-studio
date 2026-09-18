// data URL → blob URL 转换。
//
// 为什么必须转：renderer 的 CSP 是 `media-src 'self' blob:`（见 src/renderer/index.html），
// **不含 data:** —— 所以把 data URL 直接喂给 <audio> 会被拒绝，
// play() 抛 NotSupportedError「Failed to load because no supported source was found」。
// 「语音合成」视图（TtsView）也是同样处理，这里是抽出来给聊天朗读复用。
//
// 用完记得 URL.revokeObjectURL 释放，否则 blob 会一直留在内存里。
export function dataUrlToBlobUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const mime = /data:([^;,]+)/.exec(dataUrl.slice(0, comma))?.[1] || 'audio/mpeg'
  const base64 = dataUrl.slice(comma + 1)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}
