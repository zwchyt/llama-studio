// ══════════════════════════════════════════════════════════
// Edge TTS —— 微软 Edge「大声朗读」用的那套在线神经网络语音。
// 免费、无需 API Key，音质接近 Azure 神经网络语音（远好于 Windows 自带的 SAPI 音色），
// 单句合成实测 1.5s 左右（本地 TTS 模型要 10s+，所以聊天朗读改走这条）。
//
// 这是非公开接口，协议要点（都实测验证过，改的时候别删）：
//   · 握手必须带 Sec-MS-GEC 令牌，且必须带 Sec-MS-GEC-Version —— 缺 Version 直接 403。
//     令牌 = SHA256(把当前时间取整到 300 秒后换算成 Windows 100ns 刻度 + 客户端令牌)。
//   · 必须先发 Path:speech.config 再发 Path:ssml，两条都是文本帧。
//   · 音频在二进制帧里：前 2 字节大端是头长度，头里带 Path:audio 的才是音频负载。
//   · 收到 Path:turn.end 表示本轮结束。
//
// 失败一律抛错，由调用方回退到系统语音 —— 这是在线服务，断网/改协议都必须能降级。
// ══════════════════════════════════════════════════════════
import { createHash, randomUUID } from 'node:crypto'
import https from 'node:https'
import WebSocket from 'ws'

/** 客户端令牌（公开常量，Edge 朗读扩展里就是这个值） */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/** 冒充的 Chromium 版本：要和服务端期望的「近期版本」对得上，否则可能被拒 */
const CHROMIUM_VERSION = '141.0.0.0'
/** Windows 文件时间纪元与 Unix 纪元的秒差 */
const WIN_EPOCH = 11644473600
const BASE_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud'

function edgeHeaders(): Record<string, string> {
  return {
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`
  }
}

/** Sec-MS-GEC 令牌。用 BigInt 算刻度：1.7e16 已超 Number.MAX_SAFE_INTEGER，浮点会丢精度。 */
function secMsGec(): string {
  const secs = BigInt(Math.floor((Date.now() / 1000 + WIN_EPOCH) / 300) * 300)
  return createHash('sha256').update(`${secs * 10000000n}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase()
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface EdgeTtsOptions {
  text: string
  voice: string
  /** 语速倍率，1 = 原速（会换算成 SSML 的百分比） */
  rate?: number
  /** 音高偏移，单位 Hz */
  pitch?: number
  /** 音量为百分比，默认 0（原音量） */
  volume?: number
  timeoutMs?: number
}

/** 合成一段文本，返回 mp3 字节。 */
export function synthesizeEdgeTts(opts: EdgeTtsOptions): Promise<Buffer> {
  const { text, voice, rate = 1, pitch = 0, volume = 0, timeoutMs = 30000 } = opts
  return new Promise<Buffer>((resolve, reject) => {
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
      + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${secMsGec()}`
      + `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`
    const ws = new WebSocket(url, { headers: edgeHeaders() })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (err: Error | null, buf?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* 已关闭 */ }
      if (err) reject(err)
      else resolve(buf!)
    }
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* ignore */ }; finish(new Error('Edge TTS 超时')) }, timeoutMs)

    ws.on('open', () => {
      // ① 配置帧
      ws.send(
        `X-Timestamp:${new Date().toString()}\r\n`
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
      )
      // ② SSML 帧：rate 是「相对原速的百分比」，所以传 1.0 要换算成 +0%
      const pct = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v)}%`
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'>`
        + `<prosody pitch='${pitch >= 0 ? '+' : ''}${pitch}Hz' rate='${pct((rate - 1) * 100)}' volume='${pct(volume)}'>`
        + xmlEscape(text)
        + '</prosody></voice></speak>'
      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\n`
        + 'Content-Type:application/ssml+xml\r\n'
        + `X-Timestamp:${new Date().toISOString()}Z\r\n`
        + 'Path:ssml\r\n\r\n' + ssml
      )
    })

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) {
          const buf = Buffer.concat(chunks)
          if (buf.length > 0) finish(null, buf)
          else finish(new Error('Edge TTS 未返回音频'))
        }
        return
      }
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      const headerLen = b.readUInt16BE(0)
      if (b.subarray(2, 2 + headerLen).toString('utf8').includes('Path:audio')) {
        chunks.push(b.subarray(2 + headerLen))
      }
    })

    ws.on('error', (e: Error) => finish(e))
    // 握手被拒（403 等）时 ws 只给「unexpected-response」，不带上层状态码，这里显式取出来
    ws.on('unexpected-response', (_req, res) => finish(new Error(`Edge TTS 握手被拒：HTTP ${res.statusCode}`)))
  })
}

export interface EdgeVoice {
  /** 音色全名，如 zh-CN-XiaoxiaoNeural */
  name: string
  /** 展示名，如 晓晓 */
  label: string
  gender: string
  locale: string
}

interface RawVoice {
  ShortName?: string
  Gender?: string
  Locale?: string
  FriendlyName?: string
}

/** 拉取可用音色列表（用于设置界面下拉）。 */
export function listEdgeVoices(): Promise<EdgeVoice[]> {
  return new Promise<EdgeVoice[]>((resolve, reject) => {
    const url = `${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`
    https.get(url, { headers: edgeHeaders() }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`音色列表请求失败：HTTP ${res.statusCode}`)); return }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => {
        try {
          const raw = JSON.parse(body) as RawVoice[]
          resolve(raw
            .filter(v => !!v.ShortName)
            .map(v => ({
              name: v.ShortName!,
              // FriendlyName 形如「Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)」，
              // 取 ShortName 的第三段（XiaoxiaoNeural → Xiaoxiao）当展示名，够短且稳定
              label: (v.ShortName!.split('-')[2] || v.ShortName!).replace(/Neural$/, ''),
              gender: v.Gender === 'Male' ? '男' : '女',
              locale: v.Locale || ''
            })))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    }).on('error', reject)
  })
}
