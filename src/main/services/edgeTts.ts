// ══════════════════════════════════════════════════════════
// Edge TTS —— 微软 Edge「大声朗读」用的那套在线神经网络语音。
// 免费、无需 API Key，音质接近 Azure 神经网络语音（远好于 Windows 自带的 SAPI 音色），
// 单句合成实测 1.5s 左右（本地 TTS 模型要 10s+，所以聊天朗读改走这条）。
//
// 这是非公开接口，协议要点（都实测验证过，改的时候别删）：
//   · 握手必须带 Sec-MS-GEC 令牌，且必须带 Sec-MS-GEC-Version —— 缺 Version 直接 403。
//     令牌 = SHA256(把当前时间取整到 300 秒后换算成 Windows 100ns 刻度 + 客户端令牌)。
//   · 必须先发 Path:speech.config 再发 Path:ssml，两条都是文本帧。
//   · SSML 只认 voice + prosody + 纯文本这一种最简结构：<break>、<p>、<s> 会被
//     直接 1007「SSML is invalid」拒掉并断链（停顿因此改用标点，见 toSpeakableText）。
//   · 音频在二进制帧里：前 2 字节大端是头长度，头里带 Path:audio 的才是音频负载。
//   · 收到 Path:turn.end 表示本轮结束。
//
// 失败一律抛错，由调用方回退到系统语音 —— 这是在线服务，断网/改协议都必须能降级。
// 服务端被断链时不会补 turn.end，所以 close/error 也必须落地，否则 Promise 挂到超时，
// 报错就只剩一句看不出原因的「Edge TTS 超时」。
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

/** 单次请求送多少字。服务端约 9ms/字线性增长（实测 200 字 ≈1.5s、780 字 ≈7s），
    所以段长既要短到不会撞超时，也不能太碎（每段都要一次握手，约 1.3s 固定开销）。 */
const MAX_CHARS_PER_REQUEST = 400
/** 并发几路合成。实测同一份文本 4 路比 3 路快 1.8~2.8 倍且无限流迹象
    （3 路时 4 段要排两轮，尾部空转）；结果仍按原顺序拼接。 */
const CONCURRENCY = 4
/** 单段超时：正常 400 字 < 5s，20s 还不回话就是链路卡住了 */
const CHUNK_TIMEOUT_MS = 20000
/** 停顿长度：渲染层清洗后仍保留的换行 = 段落 / 硬换行 */
const PARA_PAUSE = '。'
const LINE_PAUSE = '，'
/** 句末标点：中英文都算 */
const SENTENCE_END = '。！？!?；;'
/** 段内退让边界：清洗层把各种符号统一换成中文逗号，长串优先在这里断 */
const SOFT_BREAK = ['，', ',', '、', ' ']

/**
 * 停顿只能用标点表达：实测 readaloud 端点只接受 voice + prosody + 纯文本，
 * `<break>`（无论 time 还是 strength）、`<p>`、`<s>` 一律回 1007「SSML is invalid」
 * 并直接断链——旧代码没接 close 事件，于是表现为「Edge TTS 超时」。
 * 段落换行给句末点（长停顿），行内硬换行给逗号（短停顿），与前文已有的句末标点不叠加。
 */
function toSpeakableText(text: string): string {
  return text
    .replace(/\n{2,}/g, PARA_PAUSE)
    .replace(/\n/g, LINE_PAUSE)
    .replace(/([。！？!?；;.])[，。]+/g, '$1')
}

/** 换行翻成停顿标点；文本逐段转义，不会被注入标签 */
function ssmlText(text: string): string {
  return xmlEscape(toSpeakableText(text))
}

/** 超长单句的退让切分：逗号 → 空格 → 定长，尽量不断在词中间 */
function hardSplit(s: string, maxChars: number): string[] {
  const out: string[] = []
  let rest = s
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const cut = Math.max(...SOFT_BREAK.map(ch => window.lastIndexOf(ch)))
    const n = cut > maxChars / 2 ? cut + 1 : maxChars
    out.push(rest.slice(0, n))
    rest = rest.slice(n)
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** 切成若干请求段：先按句末标点与换行断句，再贪婪合并到 maxChars。
    英文的 . ! ? 只在后面是空白时算句末，免得把「3.14」腰斩；
    整段没有标点（长串英文 / 残留代码）时交给 hardSplit，保证没有超长段撞超时。 */
function splitForRequest(text: string, maxChars: number): string[] {
  const units: string[] = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    cur += ch
    const latinEnd = (ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1] ?? ' ')
    if (ch === '\n' || SENTENCE_END.includes(ch) || latinEnd) {
      units.push(cur)
      cur = ''
    }
  }
  if (cur) units.push(cur)

  const out: string[] = []
  let buf = ''
  const flush = (): void => { if (buf.trim()) out.push(buf); buf = '' }
  for (const u of units) {
    if (u.length > maxChars) { flush(); out.push(...hardSplit(u, maxChars)); continue }
    if (buf && buf.length + u.length > maxChars) flush()
    buf += u
  }
  flush()
  return out
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
export async function synthesizeEdgeTts(opts: EdgeTtsOptions): Promise<Buffer> {
  const chunks = splitForRequest(opts.text ?? '', MAX_CHARS_PER_REQUEST)
  if (chunks.length === 0) throw new Error('朗读文本为空')

  // 有限并发 + 按序号回填：串行时一段 400 字要 4s 左右，长回答等十几秒；
  // 段与段的顺序不变，拼出来的音频仍是原文顺序。
  const audio = new Array<Buffer>(chunks.length)
  let next = 0
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= chunks.length) return
      audio[i] = await synthesizeChunk(chunks[i]!, opts)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => lane()))
  return Buffer.concat(audio)
}

/** 单段合成，失败重试一次：在线服务偶发丢帧 / 握手抖动，重试比整条回退系统语音好。 */
async function synthesizeChunk(chunk: string, opts: EdgeTtsOptions): Promise<Buffer> {
  let lastErr = new Error('Edge TTS 合成失败')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await synthesizeEdgeTtsOnce({ ...opts, text: chunk })
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      // 协议级拒绝（握手 403 / SSML 非法）重试也是同样结果，直接上抛让调用方回退系统语音
      if (/握手被拒|SSML|invalid/i.test(lastErr.message)) break
      if (attempt === 0) await new Promise(r => setTimeout(r, 300))
    }
  }
  throw lastErr
}

/** 一段文本走一次 WebSocket 往返 */
function synthesizeEdgeTtsOnce(opts: EdgeTtsOptions): Promise<Buffer> {
  const { text, voice, rate = 1, pitch = 0, volume = 0, timeoutMs = CHUNK_TIMEOUT_MS } = opts
  return new Promise<Buffer>((resolve, reject) => {
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
      + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${secMsGec()}`
      + `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`
    // handshakeTimeout：连不上（DNS / 代理 / 网络被劫持）时 ws 只会挂着不报错，
    // 没有这个开关就只能等满整个 timeoutMs。
    const ws = new WebSocket(url, { headers: edgeHeaders(), handshakeTimeout: 8000 })
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
      // ① 配置帧。两个 boundary 元数据都关掉：本服务不消费它们，开着只是让服务端
      // 多回几百个文本帧（实测同一段文本 12.2s → 7.7s）。
      ws.send(
        `X-Timestamp:${new Date().toString()}\r\n`
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
      )
      // ② SSML 帧：rate 是「相对原速的百分比」，所以传 1.0 要换算成 +0%
      const pct = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v)}%`
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'>`
        + `<prosody pitch='${pitch >= 0 ? '+' : ''}${pitch}Hz' rate='${pct((rate - 1) * 100)}' volume='${pct(volume)}'>`
        + ssmlText(text)
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
    // 服务端不结 turn.end 就断链时（限流 / SSML 被判非法 / 链路被掐），少了这个回调
    // Promise 就一直挂着，直到超时计时器才报错 —— 「Edge TTS 超时」就是这么来的。
    ws.on('close', (code: number, reason: Buffer) => finish(new Error(`Edge TTS 连接被中断：${code}${reason?.length ? ` ${reason.toString()}` : ''}`)))
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
