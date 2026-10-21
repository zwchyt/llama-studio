// ══════════════════════════════════════════════════════════
// Edge TTS —— 微软 Edge「大声朗读」用的那套在线神经网络语音。
// 免费、无需 API Key，音质接近 Azure 神经网络语音（远好于 Windows 自带的 SAPI 音色），
// 单句合成实测 1.5s 左右（本地 TTS 模型要 10s+，所以聊天朗读改走这条）。
//
// 这是非公开接口，协议要点（都实测验证过，改的时候别删）：
//   · 握手必须带 Sec-MS-GEC 令牌，且必须带 Sec-MS-GEC-Version —— 缺 Version 直接 403。
//     2026 起服务端只认 v2 令牌：`<16位hex CS64>-<64位hex SHA256>`，版本前缀也从 1- 变成 2-。
//     旧版「纯 SHA256 + 1-xxx」一律 403（实测见下面的 secMsGec 注释）。
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
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import WebSocket from 'ws'

/** 客户端令牌（公开常量，Edge 朗读扩展里就是这个值） */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/** 冒充的 Chromium 全版本号：服务端按它判断客户端「够不够新」，落后就 403。
    上游 edge-tts 会随 Edge 发版更新这个值，令牌算法也绑在同一版本上。 */
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0]
/** 令牌协议版本：v2 起前缀是 2-，令牌也从纯 SHA256 变成 CS64-SHA256 组合 */
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`
/** Windows 文件时间纪元与 Unix 纪元的秒差 */
const WIN_EPOCH = 11644473600
const BASE_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud'

function edgeHeaders(): Record<string, string> {
  return {
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9'
  }
}

/** WebSocket 握手头：上游 Edge 朗读扩展会带这两条禁缓存头 */
function wsHeaders(): Record<string, string> {
  return { Pragma: 'no-cache', 'Cache-Control': 'no-cache', ...edgeHeaders() }
}

// ══════════════════════════════════════════════════════════
// Sec-MS-GEC v2 令牌
//
// 上游（edge-tts 的 drm.py）为防第三方重写，把 SHA-256 与 CS64 混合写成了带预计算
// 常量的混淆形式。下面是从上游逐行照搬的结果 —— 不要「优化」、不要换标准 SHA-256：
// 任何一处不等价都会让令牌与服务端期望值对不上，表现就是握手 403（不是报错信息）。
// 全部用 BigInt 运算：中间值远超 2^53，Number 会丢精度。
// ══════════════════════════════════════════════════════════
const U32 = 0xffffffffn
const SHA256_INITIAL = [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an,
  0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n]
/** 前 14 个 word 全 0 时跑完 0~13 轮的中间态（上游预计算） */
const SHA256_STATE14 = [0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an,
  0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n]
/** 全 0 块的消息扩展 word 16~29（上游预计算） */
const SHA256_SCHEDULE = [0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban,
  0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n, 0xf9e70ab6n,
  0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n,
  0xd258b060n, 0x72766564n]
/** 标准 SHA-256 轮常量（上游表里第 15 项被替换成 SHA256_ADJUSTMENT） */
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n]
const SHA256_ADJUSTMENT = 0xc9dc06a7n
const SHA256_BLOCK_CONSTANTS = [...SHA256_ROUND_CONSTANTS.slice(0, 14), SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15)]
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n

/** [系数, 偏移] 对（CS64 混合用） */
const CS64_COEFFICIENTS: Array<[bigint, bigint]> = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn], [0x8d1ec211n, 0xd405b4d5n], [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn], [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n], [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n]]
const CS64_FACTOR = 0x82893933n
const CS64_ADJUSTMENT0 = 0xf2f90b1an
const CS64_ADJUSTMENT1 = 0x0b1a0000n

function rol16(v: bigint): bigint {
  const x = v & U32
  return ((x << 16n) | (x >> 16n)) & U32
}

/** 按小端拆成 32 位 word，字节数补到 4 的倍数，word 数为奇数时补一个 0 */
function wordsLe4Even(buf: Buffer): bigint[] {
  const pad = (4 - (buf.length % 4)) % 4
  const b = Buffer.concat([buf, Buffer.alloc(pad)])
  const out: bigint[] = []
  for (let i = 0; i < b.length; i += 4) out.push(BigInt(b.readUInt32LE(i)))
  if (out.length % 2 === 1) out.push(0n)
  return out
}

function sigma0(v: bigint): bigint {
  return ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & U32
}

function sigma1(v: bigint): bigint {
  return ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & U32
}

/** SHA-256 压缩函数。firstRound=14 时用被替换过第 15 项常量的那张表（上游的断点续跑） */
function sha256Rounds(state: bigint[], words: bigint[], firstRound = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS
  const DUP = 0x100000001n // e * (2^32+1)：高低 32 位都放 e，右移即得旋转
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8)
  for (let i = firstRound; i < aligned; i++) {
    const rotE = e * DUP
    const rotA = a * DUP
    const t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + constants[i]! + words[i]!
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))
    ;[a, b, c, d, e, f, g, h] = [(t1 + t2) & U32, a, b, c, (d + t1) & U32, e, f, g]
  }
  for (let i = aligned; i < 64; i += 8) {
    let rotE = e * DUP
    let rotA = a * DUP
    let t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + constants[i]! + words[i]!
    d = (d + t1) & U32
    h = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) & U32
    rotE = d * DUP
    rotA = h * DUP
    t1 = g + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (f ^ (d & (e ^ f))) + constants[i + 1]! + words[i + 1]!
    c = (c + t1) & U32
    g = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) & U32
    rotE = c * DUP
    rotA = g * DUP
    t1 = f + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (e ^ (c & (d ^ e))) + constants[i + 2]! + words[i + 2]!
    b = (b + t1) & U32
    f = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) & U32
    rotE = b * DUP
    rotA = f * DUP
    t1 = e + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (d ^ (b & (c ^ d))) + constants[i + 3]! + words[i + 3]!
    a = (a + t1) & U32
    e = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) & U32
    rotE = a * DUP
    rotA = e * DUP
    t1 = d + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (c ^ (a & (b ^ c))) + constants[i + 4]! + words[i + 4]!
    h = (h + t1) & U32
    d = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) & U32
    rotE = h * DUP
    rotA = d * DUP
    t1 = c + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (b ^ (h & (a ^ b))) + constants[i + 5]! + words[i + 5]!
    g = (g + t1) & U32
    c = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) & U32
    rotE = g * DUP
    rotA = c * DUP
    t1 = b + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (a ^ (g & (h ^ a))) + constants[i + 6]! + words[i + 6]!
    f = (f + t1) & U32
    b = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) & U32
    rotE = f * DUP
    rotA = b * DUP
    t1 = a + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (h ^ (f & (g ^ h))) + constants[i + 7]! + words[i + 7]!
    e = (e + t1) & U32
    a = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) & U32
  }
  return [a, b, c, d, e, f, g, h]
}

function expandSha256Schedule(words: bigint[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2]!
    const y = words[i - 15]!
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n)
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n)
    words.push((s1 + words[i - 7]! + s0 + words[i - 16]!) & U32)
  }
}

/** 上游 _sha256_init：把前 7 字节塞进第一个块的末尾，等价于「先压 57 个 0x00」 */
function sha256Init(data7: Buffer): bigint[] {
  const words: bigint[] = new Array<bigint>(14).fill(0n)
  words.push(BigInt(data7.readUIntBE(0, 3)))
  words.push(BigInt(data7.readUInt32BE(3)))
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16]!
    if (i - 2 >= 14) {
      value += i === 16 ? (sigma1(words[i - 2]!) ^ SHA256_SIGMA1_ADJUSTMENT) : sigma1(words[i - 2]!)
    }
    if (i - 7 >= 14) value += words[i - 7]!
    if (i - 15 >= 14) {
      value += i === 29 ? (sigma0(words[i - 15]!) ^ SHA256_SIGMA0_ADJUSTMENT) : sigma0(words[i - 15]!)
    }
    words.push(value & U32)
  }
  words.push((sigma1(words[28]!) + words[23]! + sigma0(words[15]!) + words[14]!
    + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]!) & U32)
  expandSha256Schedule(words, 31)
  const working = sha256Rounds(SHA256_STATE14, words, 14)
  return SHA256_INITIAL.map((v, i) => (v + working[i]!) & U32)
}

/** 上游 _sha256_digest：注意它**不是**标准 SHA-256(57 个 0 + data)，别替换成 crypto 实现 */
function sha256Digest(data: Buffer): Buffer {
  const length = 57 + data.length
  const padLen = (((55 - length) % 64) + 64) % 64
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64BE(BigInt(length * 8))
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLen), lenBuf])
  let state = sha256Init(data.subarray(0, 7))
  for (let off = 0; off < padded.length; off += 64) {
    const words: bigint[] = []
    for (let i = 0; i < 16; i++) words.push(BigInt(padded.readUInt32BE(off + i * 4)))
    expandSha256Schedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((v, i) => (v + working[i]!) & U32)
  }
  const out = Buffer.alloc(32)
  state.forEach((v, i) => out.writeUInt32BE(Number(v), i * 4))
  return out
}

/** CS64 混合：用 digest 前 8 字节当密钥，与 data 混合出 16 位 hex */
function cs64Digest(data: Buffer, digest: Buffer): [bigint, bigint] {
  const keyA = BigInt(digest.readUInt32LE(0)) | 1n
  const keyB = BigInt(digest.readUInt32LE(4)) | 1n
  const factors = [(keyA * CS64_FACTOR) & U32, (keyB * CS64_FACTOR) & U32]
  const terms = CS64_COEFFICIENTS.map(([coef], i) => (coef * factors[i % 2]!) & U32)
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off)
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]))
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    let term = word * (index % 2 === 0 ? keyA : keyB)
    let offset = rol16(word) * (index % 2 === 0 ? 0xef0569fbn : 0xc31713dbn)
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0]!
      offset += CS64_ADJUSTMENT1
    }
    terms.push(term & U32)
    offsets.push(offset & U32)
  }
  let swapAcc = 0n
  let swapLast = 0n
  let state = 0n
  let acc = 0n
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]!
    const y = terms[i + 1]!
    let t = rol16((offsets[i]! + x) & U32)
    let q = (t * 0x76f50f34n) & U32
    swapAcc += (rol16(q) * 0xc3efea97n + q) & U32
    t = rol16((offsets[i + 1]! + y) & U32)
    q = (t * 0x1881ce3cn) & U32
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & U32
    swapAcc = (swapAcc + swapLast) & U32

    state = (state * keyA + x) & U32
    state = (rol16(state) * 0xcf98b111n) & U32
    state = (rol16(state) * 0x87085b9fn) & U32
    state = (rol16(state) * 0x12ceb96dn) & U32
    state = (rol16(state) * 0x257e1d83n) & U32
    acc += state
    t = (state * keyB + y) & U32
    t = (rol16(t) * 0xa27416f5n) & U32
    t = (rol16(t) * 0xd38396ffn) & U32
    state = (rol16((rol16(t) * 0x7c932b89n) & U32) * 0xbfa49f69n) & U32
    acc = (acc + state) & U32
  }
  return [swapLast ^ state, swapAcc ^ acc]
}

/**
 * Sec-MS-GEC v2 令牌：`<CS64 16位>-<SHA256 64位>`（全大写）。
 * 时间窗口 = 当前时间取整到 300 秒；刻度换算按上游用 float64 乘 1e7 再取整，
 * 这个乘法的结果超过 2^53、会按 32 对齐舍入，所以必须走 Number 乘法后转 BigInt，
 * 直接用 BigInt 精确乘会和服务端算出的字符串差几个数字 → 403。
 */
function secMsGec(): string {
  const secs = Math.floor(Date.now() / 1000) + WIN_EPOCH
  const windowStart = secs - (secs % 300)
  const data = Buffer.from(`${BigInt(windowStart * 1e7).toString()}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = sha256Digest(data)
  const [a, b] = cs64Digest(data, digest)
  // 上游 struct.pack('<II') 是小端：两个 32 位字各自按低字节在前拼成 16 位 hex
  const cs64 = Buffer.alloc(8)
  cs64.writeUInt32LE(Number(a), 0)
  cs64.writeUInt32LE(Number(b), 4)
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
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
      + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
    // handshakeTimeout：连不上（DNS / 代理 / 网络被劫持）时 ws 只会挂着不报错，
    // 没有这个开关就只能等满整个 timeoutMs。
    const ws = new WebSocket(url, { headers: wsHeaders(), handshakeTimeout: 8000 })
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
      + `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
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
