import { ipcMain, dialog, shell, BrowserWindow, net } from 'electron'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, createWriteStream, statSync, rmdirSync, renameSync, rmSync, promises as fsPromises
} from 'fs'
import { join, extname, basename, dirname, resolve, sep } from 'path'
import { spawn, execSync, ChildProcess } from 'child_process'
import http from 'http'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import * as pty from 'node-pty'

function countExtractedFiles(dir: string): number {
  let count = 0
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) count += countExtractedFiles(p)
    else count++
  }
  return count
}

interface TerminalSession {
  id: string
  pty: pty.IPty
  cols: number
  rows: number
  cwd: string
  shell: string
  title: string
  pendingData: string[]
  flushTimer: NodeJS.Timeout | null
  paused: boolean
  oscBuf?: string
}
const sessions = new Map<string, TerminalSession>()

const terminalSend = (channel: string, payload: unknown): void => {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send(channel, payload) })
}

function flushTerminalData(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.flushTimer = null
  if (s.pendingData.length === 0) return
  const merged = s.pendingData.join('')
  s.pendingData = []
  const buf = Buffer.from(merged, 'utf-8')
  const MAX_CHUNK = 128 * 1024
  for (let i = 0; i < buf.length; i += MAX_CHUNK) {
    const chunk = buf.slice(i, i + MAX_CHUNK).toString('utf-8')
    terminalSend('terminal:data', { id, data: chunk })
  }
  if (s.paused) {
    try { s.pty.resume() } catch {}
    s.paused = false
  }
}

interface HfModelRaw {
  id: string
  author?: string
  downloads?: number
  likes?: number
  tags?: string[]
  lastModified?: string
}
interface HfFileRaw { type: string; path: string; size?: number }
type ModelFileInfo = { name: string; path: string; size: number; folder: string; external: boolean }
interface GpuInfo {
  name: string
  temperatureGpu: number | null
  utilizationGpu: number | null
  memoryUsed: number | null
  memoryTotal: number | null
  powerDraw: number | null
}
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 })
function hasErrnoCode(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
interface BackendCommand { arg?: string; short?: string; type?: string }
interface BackendCategory { commands?: BackendCommand[] }
interface BackendSchema { categories?: BackendCategory[] }
function isBackendSchema(v: unknown): v is BackendSchema {
  return typeof v === 'object' && v !== null && 'categories' in v
}
const APP_ROOT = app.isPackaged ? join(app.getPath('userData')) : join(process.cwd())
const MODELS_DIR = join(APP_ROOT, 'models')
const TEMPLATES_DIR = join(APP_ROOT, 'templates')
const BACKEND_DIR = join(APP_ROOT, 'backend')
const CHATS_DIR = join(APP_ROOT, 'chats')
const SETTINGS_PATH = join(APP_ROOT, 'settings.json')
for (const dir of [MODELS_DIR, TEMPLATES_DIR, BACKEND_DIR, CHATS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
// 活跃的聊天流式请求，按 streamId 索引，支持中止
const activeChatStreams = new Map<string, http.ClientRequest>()
// 被用户主动中止的流，用于抑制 destroy 后的 error 事件
const abortedChatStreams = new Set<string>()
// 每个流的「是否正在 reasoning」状态，用于把 reasoning_content 包裹在 <think> 标签中
const chatStreamInReasoning = new Map<string, boolean>()
// 每个流累积的 tool_calls（流式传输时按 index 拼接增量片段）
const chatStreamToolCalls = new Map<string, Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }>>()
// isSafePath 函数用于防止路径遍历攻击（Path Traversal Attack），也称为目录遍历攻击。
function isSafePath(base: string, target: string): boolean {
  const rBase = resolve(base)
  const rTarget = resolve(target)
  return rTarget === rBase || rTarget.startsWith(rBase + sep)
}
// 下面的代码实现了一个简单的命令行参数验证机制，确保只有在 commands.json 中定义的参数才会被传递给后端执行的模型运行命令。这有助于防止恶意用户通过 IPC 传递危险的参数来执行未授权的操作。
const schemaCache = new Map<string, { allowed: Set<string>; boolean: Set<string> }>()
function loadSchemaArgs(backendPath: string): { allowed: Set<string>; boolean: Set<string> } {
  const cached = schemaCache.get(backendPath)
  if (cached) return cached
  let schema: BackendSchema | null = null
  const tryLoad = (p: string): BackendSchema | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
      return isBackendSchema(parsed) ? parsed : null
    } catch { return null }
  }
  const commandsPath = join(backendPath, 'commands.json')
  if (existsSync(commandsPath)) schema = tryLoad(commandsPath)
  if (!schema) {
    const defaultPaths = [
      join(APP_ROOT, 'resources', 'commands.json'),
      ...(app.isPackaged ? [join(process.resourcesPath, 'resources', 'commands.json')] : [])
    ]
    for (const p of defaultPaths) {
      if (existsSync(p)) { schema = tryLoad(p); break }
    }
  }
  const allowed = new Set<string>()
  const boolean = new Set<string>()
  if (schema?.categories) {
    for (const cat of schema.categories) {
      for (const cmd of cat.commands || []) {
        if (cmd.arg) allowed.add(cmd.arg)
        if (cmd.short) allowed.add(cmd.short)
        if (cmd.type === 'boolean') {
          if (cmd.arg) boolean.add(cmd.arg)
          if (cmd.short) boolean.add(cmd.short)
        }
      }
    }
  }
  allowed.add('--no-webui')
  if (allowed.size <= 1) {
    for (const a of ['--model', '-m', '--port', '--host', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b']) {
      allowed.add(a)
    }
  }
  const result = { allowed, boolean }
  schemaCache.set(backendPath, result)
  return result
}
// validateArgs 函数会检查传入的原始参数列表（raw）中的每个参数是否在允许的参数集合（allowed）中，并且根据参数类型（boolean）来决定是否需要跳过下一个参数值。
// 它会返回一个新的参数列表，只包含经过验证和过滤的参数。这有助于确保后端命令只接收到预期的、安全的参数。
function validateArgs(raw: string[], allowed: Set<string>, boolean: Set<string>): string[] {
  const MAX = 100
  const out: string[] = []
  let i = 0
  while (i < raw.length && out.length < MAX) {
    const t = raw[i]
    if (!t.startsWith('-')) { i++; continue }
    if (!allowed.has(t)) { console.warn('[run-model] blocked arg:', t); i++; continue }
    out.push(t)
    if (boolean.has(t)) { i++ }
    else { if (i + 1 < raw.length) out.push(raw[i + 1]); i += 2 }
  }
  return out
}
function killProcessTreeAsync(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      const timer = setTimeout(finish, 5000)
      try {
        const child = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        child.on('exit', () => { clearTimeout(timer); finish() })
        child.on('error', () => { clearTimeout(timer); finish() })
      } catch { clearTimeout(timer); finish() }
    })
  } else {
    try { process.kill(-proc.pid, 'SIGKILL') } catch { try { process.kill(proc.pid, 'SIGKILL') } catch { } }
    return Promise.resolve()
  }
}
interface AppSettings { externalModelFolders: string[]; imageModelFolders: string[]; metricsPolling?: boolean }
let settingsCache: AppSettings | null = null
async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], imageModelFolders: [], metricsPolling: true }; return settingsCache }
    const data = JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      imageModelFolders: Array.isArray(data.imageModelFolders) ? data.imageModelFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], imageModelFolders: [], metricsPolling: true }; return settingsCache }
}
async function saveSettings(s: AppSettings): Promise<void> {
  await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2))
  settingsCache = s
}
function loadSettingsSync(): AppSettings {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], imageModelFolders: [], metricsPolling: true }; return settingsCache }
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      imageModelFolders: Array.isArray(data.imageModelFolders) ? data.imageModelFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], imageModelFolders: [], metricsPolling: true }; return settingsCache }
}
interface RunningProcess { proc: ChildProcess; port: number }
const runningProcesses = new Map<string, RunningProcess>()
interface DownloadTask {
  id: string
  url: string
  filename: string
  destPath: string
  receivedBytes: number
  totalBytes: number
  speed: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  repoId?: string
  cancelFn?: () => void
}
const downloadTasks = new Map<string, DownloadTask>()
const broadcastTimes = new Map<string, number>()
const lastSent = new Map<string, { percent: number; phase: string; speedBucket: number }>()
const BROADCAST_THROTTLE_MS = 200
function canBroadcast(id: string): boolean {
  const now = Date.now()
  const last = broadcastTimes.get(id) || 0
  if (now - last >= BROADCAST_THROTTLE_MS) { broadcastTimes.set(id, now); return true }
  return false
}
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'application/json' }
    const token = process.env.GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`
    const req = net.request({ url, headers })
    const timeout = setTimeout(() => { req.abort(); reject(new Error('请求超时')) }, 10000)
    req.on('response', (res) => {
      clearTimeout(timeout)
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = ''
        res.on('data', (c) => { errBody += c.toString() })
        res.on('end', () => {
          const h = JSON.stringify(res.headers)
          console.error('[fetchJson] HTTP', res.statusCode, 'headers:', h, 'body:', errBody.slice(0, 500))
        })
        return reject(new Error(`HTTP ${res.statusCode} 速率限制剩余:${res.headers['x-ratelimit-remaining'] || '?'}`))
      }
      const MAX = 5 * 1024 * 1024
      let size = 0
      let data = ''
      res.on('data', (c) => {
        size += c.length
        if (size > MAX) {
          (res as any).destroy()
          return reject(new Error('响应数据过大'))
        }
        data += c
      })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    })
    req.on('error', (err) => { clearTimeout(timeout); reject(err) })
    req.end()
  })
}
interface GitHubAsset { name: string; browser_download_url: string; size: number }
interface GitHubRelease {
  tag_name: string
  name: string
  html_url: string
  published_at: string
  assets: GitHubAsset[]
}
/** 带 JSON body 的 HTTP POST/PUT 请求（用于 ModelScope 等 API） */
function fetchJsonWithBody(
  url: string,
  body: unknown,
  method: string = 'PUT'
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body)
    const req = net.request({
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    })
    const timeout = setTimeout(() => { req.abort(); reject(new Error('请求超时')) }, 15000)
    req.on('response', (res) => {
      clearTimeout(timeout)
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('无效的 JSON 响应')) }
      })
    })
    req.on('error', (err) => { clearTimeout(timeout); reject(err) })
    req.write(postData)
    req.end()
  })
}
function startDownload(
  url: string,
  destPath: string,
  startByte: number,
  onProgress: (received: number, total: number, speed: number) => void,
  onDone: () => void,
  onError: (err: Error) => void
): () => void {
  let destroyed = false
  let currentReq: Electron.ClientRequest | null = null
  const flags = startByte > 0 ? 'a' : 'w'
  const file = createWriteStream(destPath, { flags })

  let speedBytes = 0
  let lastSpeedCheck = Date.now()
  let currentSpeed = 0

  const headers: Record<string, string> = { 'User-Agent': 'hexllama/1.0' }
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`
  const req = net.request({ url, headers })
  currentReq = req
  file.on('error', (err) => {
    if (!destroyed) { destroyed = true; req.abort(); onError(err) }
  })
  const timeout = setTimeout(() => { if (!destroyed) { req.abort(); onError(new Error('连接超时')) } }, 30000)
  req.on('response', (res) => {
    clearTimeout(timeout)
    if (destroyed) { (res as any).destroy(); return }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      if (!destroyed) onError(new Error(`HTTP 错误 ${res.statusCode}`))
      return
    }
    const contentLength = parseInt(String(res.headers['content-length'] || '0'), 10)
    const totalBytes = contentLength + startByte
    let receivedBytes = startByte

    res.on('data', (chunk: Buffer) => {
      if (destroyed) return
      if (!file.write(chunk)) {
        (res as any).pause()
        file.once('drain', () => { if (!destroyed) (res as any).resume() })
      }
      receivedBytes += chunk.length
      speedBytes += chunk.length

      const now = Date.now()
      const elapsed = (now - lastSpeedCheck) / 1000
      if (elapsed >= 0.5) {
        currentSpeed = speedBytes / elapsed
        speedBytes = 0
        lastSpeedCheck = now
      }
      onProgress(receivedBytes, totalBytes, currentSpeed)
    })

    res.on('end', () => {
      if (destroyed) return
      file.end(() => {
        if (!destroyed) onDone()
      })
    })

    res.on('error', (err) => {
      if (!destroyed) { file.destroy(); onError(err) }
    })
  })
  req.on('error', (err) => {
    clearTimeout(timeout)
    if (!destroyed) { file.destroy(); onError(err) }
  })
  req.end()
  return () => {
    if (destroyed) return
    destroyed = true
    currentReq?.abort()
    clearTimeout(timeout)
    file.end()
  }
}

function startParallelDownload(
  url: string,
  destPath: string,
  startByte: number,
  onProgress: (received: number, total: number, speed: number) => void,
  onDone: () => void,
  onError: (err: Error) => void
): () => void {
  const USER_AGENT = 'hexllama/1.0'
  const MIN_CHUNK = 1 * 1024 * 1024
  const MAX_CHUNKS = 6
  const CHUNK_RETRIES = 3
  let destroyed = false
  let cancelled = false
  let activeCancel: Array<() => void> = []
  let fallbackCancel: (() => void) | null = null
  let probeReq: Electron.ClientRequest | null = null

  let totalBytes = 0
  let receivedBytes = startByte
  let speedBytes = 0
  let lastSpeedCheck = Date.now()

  const report = () => {
    const now = Date.now()
    const elapsed = (now - lastSpeedCheck) / 1000
    let speed = 0
    if (elapsed >= 0.5) {
      speed = speedBytes / elapsed
      speedBytes = 0
      lastSpeedCheck = now
    }
    onProgress(Math.min(receivedBytes, totalBytes || receivedBytes), totalBytes, speed)
  }

  const fallback = () => {
    if (destroyed || cancelled) return
    fallbackCancel = startDownload(url, destPath, startByte, onProgress, onDone, onError)
  }

  const probe = (): void => {
    if (destroyed || cancelled) return
    const req = net.request({ url, headers: { 'User-Agent': USER_AGENT } })
    probeReq = req
    const timeout = setTimeout(() => { if (!destroyed && !cancelled) { req.abort(); onError(new Error('探测连接超时')) } }, 30000)
    req.on('response', (res) => {
      clearTimeout(timeout)
      if (destroyed || cancelled) { (res as any).destroy(); return }
      const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase()
      const total = parseInt(String(res.headers['content-length'] || '0'), 10)
      ;(res as any).destroy()
      if (!total || isNaN(total) || acceptRanges !== 'bytes' || total < MIN_CHUNK * 2) return fallback()
      startChunks(total)
    })
    req.on('error', () => { clearTimeout(timeout); if (!destroyed && !cancelled) fallback() })
    req.end()
  }

  const startChunks = (total: number): void => {
    totalBytes = total
    const numChunks = Math.min(MAX_CHUNKS, Math.max(2, Math.floor(total / (MIN_CHUNK * 2))))
    const chunkSize = Math.ceil(total / numChunks)
    const effectiveStart = Math.floor(startByte / chunkSize) * chunkSize
    receivedBytes = effectiveStart
    const ranges: Array<{ start: number; end: number }> = []
    for (let i = 0; i < numChunks; i++) {
      const s = i * chunkSize
      const e = Math.min(total - 1, s + chunkSize - 1)
      ranges.push({ start: s, end: e })
    }
    const ensureSize = async () => {
      if (existsSync(destPath)) {
        const cur = (await fsPromises.stat(destPath)).size
        if (cur < total) await fsPromises.truncate(destPath, total)
      } else {
        await fsPromises.writeFile(destPath, Buffer.alloc(0))
        await fsPromises.truncate(destPath, total)
      }
    }
    ensureSize().then(() => {
      if (destroyed || cancelled) return
      report()
      let doneCount = 0
      let finished = false
      const onChunkDone = () => {
        if (finished || destroyed || cancelled) return
        doneCount++
        report()
        if (doneCount >= numChunks) {
          finished = true
          if (totalBytes > 0 && receivedBytes !== totalBytes) {
            onError(new Error(`下载不完整: 已接收 ${receivedBytes} / ${totalBytes} 字节`))
            return
          }
          onDone()
        }
      }
      const onChunkError = (err: Error) => {
        if (finished || destroyed || cancelled) return
        finished = true
        for (const c of activeCancel) { try { c() } catch {} }
        onError(err)
      }
      for (const range of ranges) {
        if (range.end < effectiveStart) { onChunkDone(); continue }
         const rStart = Math.max(range.start, effectiveStart)
         const rEnd = range.end
         const expectedBytes = rEnd - rStart + 1
         let cancelledOne = false
         activeCancel.push(() => { cancelledOne = true })
         const fetchChunk = (retries: number) => {
           if (destroyed || cancelled || cancelledOne) return
           let reqRef: Electron.ClientRequest | null = null
           let chunkReceived = 0
           let stall: ReturnType<typeof setInterval> | null = null
          const fail = (err: Error) => {
            if (destroyed || cancelled || cancelledOne || finished) return
            if (retries > 0) {
              receivedBytes -= chunkReceived
              chunkReceived = 0
              fetchChunk(retries - 1)
              return
            }
            onChunkError(err)
          }
          const req = net.request({ url, headers: { 'User-Agent': USER_AGENT, Range: `bytes=${rStart}-${rEnd}` } })
          reqRef = req
          const timeout = setTimeout(() => { if (!destroyed && !cancelled && !cancelledOne) { req.abort(); fail(new Error('连接超时')) } }, 30000)
          req.on('response', (res) => {
            clearTimeout(timeout)
            if (destroyed || cancelled || cancelledOne) { (res as any).destroy(); return }
            if (res.statusCode === 200) {
              // 服务器未支持 Range（返回了完整文件），并行分片写入会导致文件损坏。
              // 取消所有分片，改用顺序下载重写整个文件。
              if (finished || destroyed || cancelled) { (res as any).destroy(); return }
              finished = true
              if (stall) clearInterval(stall)
              try { (res as any).destroy() } catch {}
              for (const c of activeCancel) { try { c() } catch {} }
              fallback()
              return
            }
            if (res.statusCode !== 206) { onChunkError(new Error(`HTTP 错误 ${res.statusCode}`)); return }
            const ws = createWriteStream(destPath, { flags: 'r+', start: rStart })
            let paused = false
            ws.on('drain', () => { if (paused && !destroyed && !cancelled && !cancelledOne) { paused = false; (res as any).resume() } })
            let lastDataTime = Date.now()
            stall = setInterval(() => {
              if (destroyed || cancelled || cancelledOne) { if (stall) clearInterval(stall); return }
              if (Date.now() - lastDataTime > 30000) {
                if (stall) clearInterval(stall)
                try { ws.destroy() } catch {}
                try { reqRef?.abort() } catch {}
                fail(new Error('下载停滞'))
              }
            }, 5000)
            res.on('data', (chunk: Buffer) => {
              if (destroyed || cancelled || cancelledOne) return
              lastDataTime = Date.now()
              speedBytes += chunk.length
              receivedBytes += chunk.length
              chunkReceived += chunk.length
              if (!ws.write(chunk)) { (res as any).pause(); paused = true }
            })
            res.on('end', () => {
              if (stall) clearInterval(stall)
              if (destroyed || cancelled || cancelledOne) return
              if (chunkReceived < expectedBytes) {
                // 服务器提前关闭连接，分片数据不完整（会在文件中留下空洞导致压缩包损坏），重试该分片
                try { ws.destroy() } catch {}
                fail(new Error('分片下载不完整'))
                return
              }
              ws.end(() => { if (!destroyed && !cancelled && !cancelledOne) onChunkDone() })
            })
            res.on('error', (err) => { if (stall) clearInterval(stall); fail(err) })
            ws.on('error', (err) => { if (stall) clearInterval(stall); fail(err) })
          })
          req.on('error', (err) => { clearTimeout(timeout); if (!destroyed && !cancelled && !cancelledOne) fail(err) })
          req.end()
        }
        fetchChunk(CHUNK_RETRIES)
      }
    }).catch((e) => { if (!destroyed && !cancelled) onError(e as Error) })
  }

  probe()
  return () => {
    if (destroyed) return
    destroyed = true
    cancelled = true
    try { probeReq?.abort() } catch {}
    if (fallbackCancel) fallbackCancel()
    for (const c of activeCancel) { try { c() } catch {} }
  }
}

let metricsPollingEnabled = true
let metricsInterval: ReturnType<typeof setInterval> | null = null
let cachedGpuData: GpuInfo | null = null
let lastGpuFetch = 0
let gpuLoggedFail = false
const GPU_CACHE_TTL = 5000
let nvidiaSmiPath: string | undefined = undefined

// ── CPU usage (system-wide, typeperf 性能计数器与任务管理器同源) ────
let cachedCpuPct: number | null = null
let lastCpuFetch = 0
const CPU_CACHE_TTL = 3000
let cpuCounterName: string | null = null  // 缓存已发现的计数器名称

// 从注册表发现本地化计数器名称（中文Windows名称与英文不同）
function discoverCpuCounterName(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\CurrentLanguage',
      '/v', 'Counter'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      // 查找 "Processor Information" 对象和 "% Processor Utility" 计数器
      const lines = stdout.split('\n')
      let objName: string | null = null
      let counterName: string | null = null
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim()
        if (l.toLowerCase() === 'processor information') {
          if (i > 0) objName = lines[i - 1].trim()
        }
        if (l.toLowerCase() === '% processor utility') {
          if (i > 0) counterName = lines[i - 1].trim()
        }
      }
      if (objName && counterName) {
        const name = `\\${objName}(_Total)\\${counterName}`
        resolve(name)
      } else {
        resolve(null)
      }
    })
    setTimeout(() => { try { proc.kill() } catch {} resolve(null) }, 3000)
  })
}

// typeperf 解析：取第二个样本（第一个样本可能不准）
function parseTypeperfOutput(stdout: string): number | null {
  const lines = stdout.split('\n').filter(l => l.startsWith('"'))
  if (lines.length >= 2) {
    const m = lines[1].match(/"[^"]*","([^"]+)"/)
    if (m) {
      const v = parseFloat(m[1])
      if (!isNaN(v) && isFinite(v)) return Math.round(Math.max(0, Math.min(100, v)))
    }
  }
  return null
}

function typeperfQuery(counterName: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('typeperf', [counterName, '-sc', '2', '-si', '1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', () => resolve(parseTypeperfOutput(stdout)))
    setTimeout(() => { try { proc.kill() } catch {} resolve(null) }, 5000)
  })
}

function wmiFallback(): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average`
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code !== 0) { resolve(null); return }
      const v = parseFloat(stdout.trim())
      resolve(isNaN(v) ? null : Math.round(v))
    })
    setTimeout(() => { try { proc.kill() } catch {} resolve(null) }, 4000)
  })
}

async function getCpuUsage(): Promise<number | null> {
  if (process.platform !== 'win32') return null
  const now = Date.now()
  if (cachedCpuPct !== null && (now - lastCpuFetch) < CPU_CACHE_TTL) return cachedCpuPct
  // 首次调用时从注册表发现本地化计数器名
  if (cpuCounterName === null) {
    cpuCounterName = await discoverCpuCounterName() ?? 'NOT_AVAILABLE'
  }
  // 尝试链：注册表发现名 → 英文 → 中文 → WMI 兑底
  let result: number | null = null
  if (cpuCounterName !== 'NOT_AVAILABLE') {
    result = await typeperfQuery(cpuCounterName!)
  }
  if (result === null) {
    result = await typeperfQuery('\\Processor Information(_Total)\\% Processor Utility')
  }
  if (result === null) {
    result = await typeperfQuery('\\处理器信息(_total)\\% 处理器实用工具')
  }
  if (result === null) {
    result = await wmiFallback()
  }
  if (result !== null) {
    cachedCpuPct = result
    lastCpuFetch = Date.now()
  }
  return cachedCpuPct
}

function findNvidiaSmi(): string | null {
  if (nvidiaSmiPath !== undefined) return nvidiaSmiPath || null
  const candidates = [
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    'C:\\Windows\\System32\\nvidia-smi.exe',
  ]
  for (const p of candidates) {
    if (existsSync(p)) { nvidiaSmiPath = p; return p }
  }
  // fallback: try bare command (relies on PATH)
  nvidiaSmiPath = 'nvidia-smi'
  return 'nvidia-smi'
}
let modelsCache: { ts: number; result: ModelFileInfo[] } | null = null
let modelsScanPromise: Promise<ModelFileInfo[]> | null = null
const MODELS_CACHE_TTL = 30000
const MAX_MODELS_FILES = 5000

export function cleanupRunningProcesses(): void {
  if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null }
  for (const [, { proc }] of runningProcesses) {
    killProcessTreeAsync(proc)
  }
  runningProcesses.clear()
  // 清理所有进行中的聊天流式请求
  for (const [, req] of activeChatStreams) {
    try { req.destroy() } catch { /* ignore */ }
  }
  activeChatStreams.clear()
  for (const [, s] of sessions) {
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
    try { s.pty.kill() } catch {}
  }
  sessions.clear()
}

export function registerIpcHandlers(): void {
  loadSettingsSync()
  function invalidateModelsCache(): void {
    modelsCache = null
    modelsScanPromise = null
  }
  async function scanModels(force: boolean): Promise<ModelFileInfo[]> {
    if (!force && modelsCache && (Date.now() - modelsCache.ts) < MODELS_CACHE_TTL) {
      return modelsCache.result
    }
    if (modelsScanPromise) return modelsScanPromise
    modelsScanPromise = (async () => {
      const exts = ['.gguf', '.bin', '.ggml']
      const results: ModelFileInfo[] = []
      const seen = new Set<string>()
      const visitedDirs = new Set<string>()
      const scan = async (dir: string, external: boolean, depth = 0): Promise<void> => {
        if (depth > 8 || results.length >= MAX_MODELS_FILES) return
        try {
          const realDir = await fsPromises.realpath(dir)
          if (visitedDirs.has(realDir)) return
          visitedDirs.add(realDir)
          const files = await fsPromises.readdir(dir, { withFileTypes: true })
          for (const e of files) {
            if (results.length >= MAX_MODELS_FILES) return
            if (e.isDirectory()) await scan(join(dir, e.name), external, depth + 1)
            else if (exts.includes(extname(e.name).toLowerCase()) && !e.name.endsWith('.tmp')) {
              const fp = join(dir, e.name)
              const key = resolve(fp)
              if (seen.has(key)) continue
              seen.add(key)
              const st = await fsPromises.stat(fp)
              results.push({ name: e.name, path: fp, size: st.size, folder: basename(dir), external })
            }
          }
        } catch { }
      }
      if (existsSync(MODELS_DIR)) await scan(MODELS_DIR, false)
      const settings = await loadSettings()
      for (const folder of settings.externalModelFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true)
      }
      modelsCache = { ts: Date.now(), result: results }
      return results
    })().finally(() => {
      modelsScanPromise = null
    })
    return modelsScanPromise
  }
  ipcMain.handle('list-models', () => scanModels(false))
  ipcMain.handle('list-models-refresh', () => scanModels(true))
  ipcMain.handle('list-external-model-folders', async () => (await loadSettings()).externalModelFolders)
  ipcMain.handle('add-external-model-folder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Add External Model Folder', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.externalModelFolders.includes(folder)) {
      s.externalModelFolders.push(folder)
      await saveSettings(s)
      invalidateModelsCache()
    }
    return { success: true, folders: s.externalModelFolders }
  })
  ipcMain.handle('remove-external-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.externalModelFolders = s.externalModelFolders.filter(f => f !== folder)
    await saveSettings(s)
    invalidateModelsCache()
    return { success: true, folders: s.externalModelFolders }
  })
  // ── 图片模型文件夹 ──
  const IMAGE_MODELS_CACHE_TTL = 30_000
  let imageModelsCache: { ts: number; result: ModelFileInfo[] } | null = null
  let imageModelsScanPromise: Promise<ModelFileInfo[]> | null = null
  function invalidateImageModelsCache(): void {
    imageModelsCache = null
    imageModelsScanPromise = null
  }
  async function scanImageModels(force: boolean): Promise<ModelFileInfo[]> {
    if (!force && imageModelsCache && (Date.now() - imageModelsCache.ts) < IMAGE_MODELS_CACHE_TTL) {
      return imageModelsCache.result
    }
    if (imageModelsScanPromise) return imageModelsScanPromise
    imageModelsScanPromise = (async () => {
      const exts = ['.gguf', '.bin', '.ggml']
      const results: ModelFileInfo[] = []
      const seen = new Set<string>()
      const visitedDirs = new Set<string>()
      const scan = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 8) return
        try {
          const realDir = await fsPromises.realpath(dir)
          if (visitedDirs.has(realDir)) return
          visitedDirs.add(realDir)
          const files = await fsPromises.readdir(dir, { withFileTypes: true })
          for (const e of files) {
            if (e.isDirectory()) await scan(join(dir, e.name), depth + 1)
            else if (exts.includes(extname(e.name).toLowerCase()) && !e.name.endsWith('.tmp')) {
              const fp = join(dir, e.name)
              const key = resolve(fp)
              if (seen.has(key)) continue
              seen.add(key)
              const st = await fsPromises.stat(fp)
              results.push({ name: e.name, path: fp, size: st.size, folder: basename(dir), external: true })
            }
          }
        } catch { }
      }
      const settings = await loadSettings()
      for (const folder of settings.imageModelFolders) {
        if (existsSync(folder)) await scan(folder)
      }
      imageModelsCache = { ts: Date.now(), result: results }
      return results
    })().finally(() => { imageModelsScanPromise = null })
    return imageModelsScanPromise
  }
  ipcMain.handle('list-image-models', () => scanImageModels(false))
  ipcMain.handle('list-image-models-refresh', () => scanImageModels(true))
  ipcMain.handle('list-image-model-folders', async () => (await loadSettings()).imageModelFolders)
  ipcMain.handle('add-image-model-folder', async () => {
    const r = await dialog.showOpenDialog({ title: '添加图片模型文件夹', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.imageModelFolders.includes(folder)) {
      s.imageModelFolders.push(folder)
      await saveSettings(s)
      invalidateImageModelsCache()
    }
    return { success: true, folders: s.imageModelFolders }
  })
  ipcMain.handle('remove-image-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.imageModelFolders = s.imageModelFolders.filter(f => f !== folder)
    await saveSettings(s)
    invalidateImageModelsCache()
    return { success: true, folders: s.imageModelFolders }
  })
  // ── 删除模型 ──
  ipcMain.handle('delete-model', (_e, filePath: string) => {
    try {
      if (!isSafePath(MODELS_DIR, filePath)) return { success: false, error: '访问被拒绝' }
      unlinkSync(filePath)
      const dir = dirname(filePath)
      if (dir !== MODELS_DIR) {
        try { if (readdirSync(dir).length === 0) rmdirSync(dir) } catch { }
      }
      invalidateModelsCache()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('rename-model', (_e, oldPath: string, newName: string) => {
    try {
      const settings = loadSettingsSync()
      const allDirs = [MODELS_DIR, ...settings.externalModelFolders, ...settings.imageModelFolders]
      const resolvedTarget = resolve(oldPath)
      const matches = allDirs.map(d => ({ dir: d, resolvedDir: resolve(d), match: resolvedTarget.startsWith(resolve(d)) }))
      const isAllowed = matches.some(m => m.match)
      if (!isAllowed) {
        return { success: false, error: `Access denied: 模型路径"${oldPath}"不在允许目录内。MODELS_DIR="${MODELS_DIR}", 外部文件夹=[${settings.externalModelFolders.join('; ')}], 匹配详情=[${matches.map(m => `{dir:${m.dir}, resolved:${m.resolvedDir}, match:${m.match}}`).join(', ')}]` }
      }
      const dir = dirname(oldPath)
      const newPath = join(dir, newName + extname(oldPath))
      const isNewAllowed = allDirs.some(d => isSafePath(d, newPath))
      if (!isNewAllowed) return { success: false, error: `Access denied (newPath): ${newPath}` }
      renameSync(oldPath, newPath)
      invalidateModelsCache()
      return { success: true, newPath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('start-model-download', (_event, opts: {
    url: string
    filename: string
    repoId?: string
    modelFolder?: string
  }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const t = downloadTasks.get(id)!
      if (t.phase === 'downloading') return { success: false, error: '已在下载中' }
    }
    const folder = opts.modelFolder || opts.repoId?.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!isSafePath(MODELS_DIR, destDir)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    if (!isSafePath(MODELS_DIR, finalPath)) return { success: false, error: '访问被拒绝' }
    const tmpPath = finalPath + '.tmp'
    const task: DownloadTask = {
      id, url: opts.url, filename: opts.filename,
      destPath: finalPath, receivedBytes: 0, totalBytes: 0, speed: 0,
      phase: 'downloading', repoId: opts.repoId
    }
    const broadcastProgress = (t: DownloadTask, force = false) => {
      if (!force && !canBroadcast(t.id)) return
      const percent = t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0
      const speedBucket = Math.round(t.speed / (500 * 1024))
      if (!force) {
        const last = lastSent.get(t.id)
        if (last && last.percent === percent && last.phase === t.phase && last.speedBucket === speedBucket) return
      }
      lastSent.set(t.id, { percent, phase: t.phase, speedBucket })
      const payload = {
        id: t.id, filename: t.filename,
        percent, receivedBytes: t.receivedBytes, totalBytes: t.totalBytes,
        speed: t.speed, phase: t.phase, destPath: t.destPath,
        repoId: t.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-download-progress', payload)
      })
    }
    task.cancelFn = startDownload(
      opts.url, tmpPath, 0,
      (received, total, speed) => { task.receivedBytes = received; task.totalBytes = total; task.speed = speed; broadcastProgress(task) },
      () => {
        try { renameSync(tmpPath, finalPath) } catch { }
        task.phase = 'done'; task.speed = 0; broadcastProgress(task, true)
        invalidateModelsCache()
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id); lastSent.delete(id) }, 5000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('下载错误:', err) }
    )
    downloadTasks.set(id, task)
    broadcastProgress(task, true)
    return { success: true, id }
  })
  ipcMain.handle('pause-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'downloading') return { success: false, error: '未在下载' }
    task.cancelFn?.()
    task.phase = 'paused'
    task.speed = 0

    broadcastTimes.delete(id)
    lastSent.delete(id)
    const payload = {
      id, filename: task.filename, phase: 'paused', speed: 0,
      percent: task.totalBytes > 0 ? Math.round((task.receivedBytes / task.totalBytes) * 100) : 0,
      receivedBytes: task.receivedBytes, totalBytes: task.totalBytes,
      destPath: task.destPath, repoId: task.repoId
    }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('model-download-progress', payload)
        if (task.repoId) win.webContents.send('hf-download-progress', payload)
      }
    })
    return { success: true }
  })
  ipcMain.handle('resume-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'paused') return { success: false, error: '未暂停' }
    task.phase = 'downloading'
    const tmpPath = task.destPath + '.tmp'

    try { task.receivedBytes = statSync(tmpPath).size } catch { }
    const broadcastProgress = (t: DownloadTask, force = false) => {
      if (!force && !canBroadcast(t.id)) return
      const payload = {
        id: t.id, filename: t.filename, phase: t.phase, speed: t.speed,
        percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0,
        receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, destPath: t.destPath,
        repoId: t.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-download-progress', payload)
          if (t.repoId) win.webContents.send('hf-download-progress', payload)
        }
      })
    }
    const startByte = task.receivedBytes
    task.cancelFn = startDownload(
      task.url, tmpPath, startByte,
      (received, total, speed) => { task.receivedBytes = received; task.totalBytes = total; task.speed = speed; broadcastProgress(task) },
      () => {
        try { renameSync(tmpPath, task.destPath) } catch { }
        task.phase = 'done'; task.speed = 0; broadcastProgress(task, true)
        invalidateModelsCache()
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id); lastSent.delete(id) }, 5000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('恢复下载错误:', err) }
    )
    broadcastProgress(task, true)
    return { success: true }
  })
  ipcMain.handle('cancel-model-download', (_event, id: string) => {
    const task = downloadTasks.get(id)
    if (!task) return { success: false, error: '未找到' }
    if (task.phase === 'done') return { success: true }
    task.cancelFn?.()
    task.phase = 'cancelled'

    try { unlinkSync(task.destPath + '.tmp') } catch { }
    try { unlinkSync(task.destPath) } catch { }
    const payload = { id, filename: task.filename, phase: 'cancelled', percent: 0, receivedBytes: 0, totalBytes: 0, speed: 0 }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('model-download-progress', payload)
        if (task.repoId) win.webContents.send('hf-download-progress', payload)
      }
    })
    downloadTasks.delete(id)
    return { success: true }
  })
  ipcMain.handle('list-model-downloads', () => {
    return Array.from(downloadTasks.values()).map(t => ({
      id: t.id, url: t.url, filename: t.filename, destPath: t.destPath,
      receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, phase: t.phase,
      percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0
    }))
  })
  ipcMain.handle('list-backends', async () => {
    if (!existsSync(BACKEND_DIR)) return []
    const findExecutable = async (dir: string, depth = 0): Promise<string | null> => {
      if (depth > 10) return null
      try {
        const files = await fsPromises.readdir(dir, { withFileTypes: true })
        const names = process.platform === 'win32'
          ? ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server', 'llama-cli.exe']
          : ['llama-server', 'main', 'server']
        for (const n of names) {
          const found = files.find(f => !f.isDirectory() && f.name.toLowerCase() === n)
          if (found) return found.name
        }
        if (process.platform === 'win32') {
          const exeFiles = files.filter(f => !f.isDirectory() && f.name.toLowerCase().endsWith('.exe'))
          if (exeFiles.length > 0) return exeFiles[0].name
        }
        for (const f of files) {
          if (f.isDirectory()) {
            const sub = await findExecutable(join(dir, f.name), depth + 1)
            if (sub) return join(f.name, sub)
          }
        }
      } catch { }
      return null
    }
    const entries = await fsPromises.readdir(BACKEND_DIR, { withFileTypes: true })
    const backends = await Promise.all(
      entries.filter(d => d.isDirectory()).map(async (d) => {
        const commandsPath = join(BACKEND_DIR, d.name, 'commands.json')
        const basePath = join(BACKEND_DIR, d.name)
        return {
          name: d.name,
          path: basePath,
          hasCommands: existsSync(commandsPath),
          exe: await findExecutable(basePath)
        }
      })
    )
    backends.sort((a, b) => {
      const n = (s: string) => parseInt((s.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
      return n(b.name) - n(a.name)
    })
    return backends
  })
  ipcMain.handle('delete-backend', (_e, backendName: string) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      if (!isSafePath(BACKEND_DIR, backendPath)) return { success: false, error: '访问被拒绝' }
      if (!existsSync(backendPath)) return { success: true }
      const rm = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          e.isDirectory() ? rm(p) : unlinkSync(p)
        }
        rmdirSync(dir)
      }
      rm(backendPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('get-commands', async (_e, backendName: string) => {
    const commandsPath = join(BACKEND_DIR, backendName, 'commands.json')
    if (!isSafePath(BACKEND_DIR, commandsPath)) return null
    try {
      if (existsSync(commandsPath)) return JSON.parse(await fsPromises.readFile(commandsPath, 'utf-8'))
    } catch { }
    const defaultPaths = [
      join(APP_ROOT, 'resources', 'commands.json'),
      ...(app.isPackaged ? [join(process.resourcesPath, 'resources', 'commands.json')] : [])
    ]
    for (const defaultPath of defaultPaths) {
      try {
        if (existsSync(defaultPath)) return JSON.parse(await fsPromises.readFile(defaultPath, 'utf-8'))
      } catch { }
    }
    return null
  })
  ipcMain.handle('save-backend-commands', (_e, backendName: string, schema: unknown) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      if (!isSafePath(BACKEND_DIR, backendPath)) return { success: false, error: '访问被拒绝' }
      if (!existsSync(backendPath)) mkdirSync(backendPath, { recursive: true })
      writeFileSync(join(backendPath, 'commands.json'), JSON.stringify(schema, null, 2))
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('list-templates', async () => {
    if (!existsSync(TEMPLATES_DIR)) return []
    const files = await fsPromises.readdir(TEMPLATES_DIR)
    const results = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async (f) => {
        try {
          const text = await fsPromises.readFile(join(TEMPLATES_DIR, f), 'utf-8')
          return { ...JSON.parse(text), _file: f }
        } catch { return null }
      })
    )
    return results.filter(Boolean)
  })
  ipcMain.handle('save-template', async (_e, template: Record<string, unknown>) => {
    try {
      const id = (template.id as string) || randomUUID()
      if (/[\\/]/.test(id) || id.includes('..')) return { success: false, error: '无效的模板 ID' }
      writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify({ ...template, id }, null, 2))
      return { success: true, id }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('delete-template', (_e, id: string) => {
    const fp = join(TEMPLATES_DIR, `${id}.json`)
    if (!isSafePath(TEMPLATES_DIR, fp)) return { success: false, error: '访问被拒绝' }
    try { if (existsSync(fp)) unlinkSync(fp) } catch { }
    return { success: true }
  })
  // ── 原生聊天会话 CRUD（与 templates 同模式） ──
  ipcMain.handle('list-chat-sessions', async () => {
    if (!existsSync(CHATS_DIR)) return []
    const files = await fsPromises.readdir(CHATS_DIR)
    const results = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async (f) => {
        try {
          const text = await fsPromises.readFile(join(CHATS_DIR, f), 'utf-8')
          return JSON.parse(text)
        } catch { return null }
      })
    )
    return results.filter(Boolean)
  })
  ipcMain.handle('save-chat-session', async (_e, session: Record<string, unknown>) => {
    try {
      const id = (session.id as string) || String(Date.now())
      if (/[\\/]/.test(id) || id.includes('..')) return { success: false, error: '无效的会话 ID' }
      const fp = join(CHATS_DIR, `${id}.json`)
      if (!isSafePath(CHATS_DIR, fp)) return { success: false, error: '访问被拒绝' }
      writeFileSync(fp, JSON.stringify({ ...session, id }, null, 2))
      return { success: true, id }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('delete-chat-session', (_e, id: string) => {
    const fp = join(CHATS_DIR, `${id}.json`)
    if (!isSafePath(CHATS_DIR, fp)) return { success: false, error: '访问被拒绝' }
    try { if (existsSync(fp)) unlinkSync(fp) } catch { }
    return { success: true }
  })
  ipcMain.handle('import-template', async () => {
    try {
      const r = await dialog.showOpenDialog({ title: 'Import Template', defaultPath: TEMPLATES_DIR, filters: [{ name: 'JSON Template', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths.length) return null
      const data = JSON.parse(readFileSync(r.filePaths[0], 'utf-8'))
      const id = String(Date.now()); data.id = id
      writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2))
      return data
    } catch { return null }
  })
  ipcMain.handle('export-template', async (_e, template: Record<string, unknown>) => {
    try {
      const r = await dialog.showSaveDialog({ title: 'Export Template', defaultPath: `${template.name ?? 'template'}.json`, filters: [{ name: 'JSON Template', extensions: ['json'] }] })
      if (r.canceled || !r.filePath) return { success: false }
      writeFileSync(r.filePath, JSON.stringify(template, null, 2)); return { success: true }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('pick-model-file', async () => {
    const r = await dialog.showOpenDialog({ title: 'Select Model File', filters: [{ name: 'GGUF / GGML Models', extensions: ['gguf', 'bin', 'ggml'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    return { name: basename(r.filePaths[0]), path: r.filePaths[0] }
  })
  ipcMain.handle('run-model', (_e, opts: { id: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number }) => {
    if (runningProcesses.has(opts.id)) return { success: false, error: '已在运行中' }
    const exePath = join(opts.backendPath, opts.exe)
    if (!isSafePath(BACKEND_DIR, exePath)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(exePath)) return { success: false, error: `可执行文件未找到: ${exePath}` }
    try {
      const { allowed, boolean } = loadSchemaArgs(opts.backendPath)
      const safeArgs = validateArgs(opts.args, allowed, boolean)
      const proc = spawn(exePath, safeArgs, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      let prefillResetTimer: ReturnType<typeof setTimeout> | null = null
      let stderrBuf = ''
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      proc.stderr?.on('data', (d) => {
        const text = d.toString()
        console.error('[llama-server]', text)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('model-log', { id: opts.id, stream: 'stderr', text })
        })
        // Buffer stderr and process complete lines to handle chunked data
        stderrBuf += text
        const lines = stderrBuf.split('\n')
        stderrBuf = lines.pop() || '' // keep incomplete last line in buffer
        // Parse prefill progress: "progress = 0.57, t = 3.02 s / 2035.72 tokens per second"
        for (const raw of lines) {
          const line = stripAnsi(raw.trim())
          if (!line) continue
          const m = line.match(/progress\s*=\s*([\d.]+)/)
          if (m) {
            const progress = parseFloat(m[1])
            if (!isNaN(progress) && progress >= 0 && progress <= 1) {
              if (prefillResetTimer) { clearTimeout(prefillResetTimer); prefillResetTimer = null }
              const update: Record<string, unknown> = { id: opts.id, prefillProgress: progress }
              BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed()) win.webContents.send('metrics-update', update)
              })
              // Clear prefillProgress 2s after completion so UI shows 100% briefly then resets
              if (progress >= 1) {
                prefillResetTimer = setTimeout(() => {
                  BrowserWindow.getAllWindows().forEach(win => {
                    if (!win.isDestroyed()) win.webContents.send('metrics-update', { id: opts.id, prefillProgress: null })
                  })
                }, 2000)
              }
            }
          }
        }
      })
      proc.stdout?.on('data', (d) => {
        const text = d.toString()
        console.log('[llama-server]', text)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('model-log', { id: opts.id, stream: 'stdout', text })
        })
        for (const raw of text.trim().split('\n')) {
          const line = raw.trim()
          if (!line) continue
          try {
            const json = JSON.parse(line)
            if (json && typeof json === 'object') {
              json.id = opts.id
              if (json.ttft_ms !== undefined) { json.ttftMs = json.ttft_ms; delete json.ttft_ms }
              BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed()) win.webContents.send('metrics-update', json)
              })
            }
          } catch { }
        }
      })
      proc.on('error', (err: unknown) => {
        let msg = String(err)
        if (hasErrnoCode(err) && err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
          msg = 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.'
        }
        console.error('[llama-server] spawn error:', msg)
        runningProcesses.delete(opts.id)
        if (runningProcesses.size === 0) stopMetricsInterval()
        if (!_e.sender.isDestroyed()) _e.sender.send('model-error', { id: opts.id, error: msg })
      })
      runningProcesses.set(opts.id, { proc, port: opts.port })
      if (metricsPollingEnabled) startMetricsInterval()
      // send initial pid metric immediately
      if (proc.pid !== undefined) {
        const payload = { id: opts.id, pid: proc.pid, lastUpdated: Date.now() }
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('metrics-update', payload)
        })
      }
      proc.on('exit', (code) => {
        if (code !== 0 && runningProcesses.has(opts.id)) {
          const errorLines = stderrBuf.split('\n').filter(l => l.trim()).slice(-5).join('; ')
          const msg = `Process exited with code ${code}${errorLines ? ': ' + errorLines : ''}`
          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) win.webContents.send('model-error', { id: opts.id, error: msg })
          })
        }
        runningProcesses.delete(opts.id)
        if (runningProcesses.size === 0) stopMetricsInterval()
      })
      if (opts.openBrowser) {
        setTimeout(() => {
          openChatWindow(opts.port)
        }, 2500)
      }
      return { success: true, pid: proc.pid }
    } catch (err: unknown) {
      if (hasErrnoCode(err) && err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
        return { success: false, error: '架构不匹配：你正在 x64 系统上运行 ARM64 版本的后端。请在设置中删除此后端并下载 x64 版本。' }
      }
      return { success: false, error: String(err) }
    }
  })

  function openChatWindow(port: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return
    const chatUrl = `http://127.0.0.1:${port}`
    const candidates = [
      join(process.cwd(), 'assets', 'icon.png'),
      join(__dirname, '../../assets/icon.png'),
      join(app.getAppPath(), 'assets', 'icon.png')
    ]
    const icon = candidates.find(existsSync)

    const chatWin = new BrowserWindow({
      width: 1024, height: 768, show: true, autoHideMenuBar: true,
      title: 'Hexllama - Llama-UI',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#ffffff',
      ...(icon ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--window-mode=chat']
      }
    })
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      chatWin.loadURL(`${rendererUrl}?chat_url=${encodeURIComponent(chatUrl)}`)
    } else {
      chatWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { chat_url: chatUrl } })
    }
  }

  ipcMain.handle('open-chat-window', (_e, port: number) => {
    openChatWindow(port)
  })
  const killByPortAsync = (port: number): Promise<boolean> => {
    if (process.platform !== 'win32') return Promise.resolve(false)
    return new Promise((resolve) => {
      let done = false
      const finish = (killed: boolean) => { if (!done) { done = true; resolve(killed) } }
      const netstatTimer = setTimeout(() => finish(false), 5000)
      let buf = ''
      try {
        const c = spawn('netstat', ['-ano'], { windowsHide: true })
        c.stdout?.on('data', (chunk: Buffer) => { buf += chunk.toString() })
        c.on('exit', () => {
          clearTimeout(netstatTimer)
          const pids = new Set<string>()
          for (const line of buf.split('\n')) {
            if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue
            const pid = line.trim().split(/\s+/).filter(Boolean).pop()
            if (pid && pid !== '0') pids.add(pid)
          }
          if (pids.size === 0) { finish(false); return }
          let remaining = pids.size
          let anyKilled = false
          const killOne = (pid: string) => {
            const killTimer = setTimeout(() => {
              if (--remaining === 0) finish(anyKilled)
            }, 3000)
            try {
              const k = spawn('taskkill', ['/F', '/PID', pid], { windowsHide: true })
              k.on('exit', () => { clearTimeout(killTimer); anyKilled = true; if (--remaining === 0) finish(anyKilled) })
              k.on('error', () => { clearTimeout(killTimer); if (--remaining === 0) finish(anyKilled) })
            } catch { clearTimeout(killTimer); if (--remaining === 0) finish(anyKilled) }
          }
          for (const pid of pids) killOne(pid)
        })
        c.on('error', () => { clearTimeout(netstatTimer); finish(false) })
      } catch { clearTimeout(netstatTimer); finish(false) }
    })
  }
  ipcMain.handle('stop-model', async (_e, id: string) => {
    const entry = runningProcesses.get(id)
    if (entry) {
      runningProcesses.delete(id)
      if (runningProcesses.size === 0) stopMetricsInterval()
      const tasks: Promise<unknown>[] = [killProcessTreeAsync(entry.proc)]
      if (entry.port) tasks.push(killByPortAsync(entry.port))
      await Promise.all(tasks)
      return { success: true }
    }
    let port = 0
    const templatesDir = join(APP_ROOT, 'templates')
    if (existsSync(templatesDir)) {
      for (const f of readdirSync(templatesDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const t = JSON.parse(readFileSync(join(templatesDir, f), 'utf-8'))
          if (t.id === id && t.serverPort) { port = t.serverPort; break }
        } catch { }
      }
    }
    const killed = port ? await killByPortAsync(port) : false
    return { success: killed || !port, error: killed || !port ? undefined : '未在运行' }
  })
  // ── 性能基准测试 ──
  interface RunningBenchmark { proc: ChildProcess }
  const runningBenchmarks = new Map<string, RunningBenchmark>()
  ipcMain.handle('run-benchmark', (_e, opts: { id: string; backendPath: string; exe: string; args: string[] }) => {
    if (runningBenchmarks.has(opts.id)) return { success: false, error: '已在运行中' }
    const exePath = join(opts.backendPath, opts.exe)
    if (!isSafePath(BACKEND_DIR, exePath)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(exePath)) return { success: false, error: `可执行文件未找到: ${exePath}` }
    try {
      const proc = spawn(exePath, opts.args, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      proc.stdout?.on('data', (d) => {
        const text = d.toString()
        BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.webContents.send('benchmark-log', { id: opts.id, stream: 'stdout', text }) })
      })
      proc.stderr?.on('data', (d) => {
        const text = d.toString()
        BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.webContents.send('benchmark-log', { id: opts.id, stream: 'stderr', text }) })
      })
      proc.on('error', (err) => {
        runningBenchmarks.delete(opts.id)
        BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.webContents.send('benchmark-error', { id: opts.id, error: String(err) }) })
      })
      proc.on('exit', (code) => {
        runningBenchmarks.delete(opts.id)
        BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.webContents.send('benchmark-done', { id: opts.id, code }) })
      })
      runningBenchmarks.set(opts.id, { proc })
      return { success: true, pid: proc.pid }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('stop-benchmark', async (_e, id: string) => {
    const entry = runningBenchmarks.get(id)
    if (!entry) return { success: false, error: '未在运行' }
    runningBenchmarks.delete(id)
    try {
      const pid = entry.proc.pid
      if (pid) {
        await new Promise<void>((resolve) => {
          const k = spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true })
          k.on('exit', () => resolve()); k.on('error', () => resolve())
        })
      }
      entry.proc.kill()
    } catch { /* ignore */ }
    return { success: true }
  })

  let cancelBackendDl: (() => void) | null = null

  ipcMain.handle('check-updates', async () => {
    try {
      const release = await fetchJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest') as any
      if (!release || !release.assets) return { error: 'GitHub 返回数据无效' }
      const isMac = process.platform === 'darwin'
      const isLinux = process.platform === 'linux'
      const arch = process.arch
      const platformAssets = release.assets.filter((a: any) => {
        const n = a.name.toLowerCase()
        if (n.startsWith('cudart-')) return false
        if (isMac) {
          if (!n.endsWith('.tar.gz') || !n.includes('macos')) return false
          if (arch === 'arm64' && !n.includes('arm64')) return false
          if (arch === 'x64' && !n.includes('x64')) return false
          return true
        }
        if (isLinux) {
          if (!n.endsWith('.tar.gz') || !n.includes('ubuntu')) return false
          if (arch === 'arm64' && !n.includes('arm64')) return false
          if (arch === 'x64' && n.includes('arm64')) return false
          return true
        }
        if (!n.endsWith('.zip')) return false
        if (!(n.includes('win') || n.includes('windows'))) return false
        if (arch === 'x64' && n.includes('arm64')) return false
        if (arch === 'arm64' && n.includes('x64')) return false
        return true
      })
      const latestNum = parseInt(release.tag_name.replace(/^b/, ''), 10)
      let isNewer = true
      if (existsSync(BACKEND_DIR)) {
        for (const d of readdirSync(BACKEND_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
          const m = d.name.match(/(\d{3,6})/); if (!m) continue
          if (parseInt(m[1], 10) >= latestNum || d.name.includes(release.tag_name)) { isNewer = false; break }
        }
      }
      return { tagName: release.tag_name, name: release.name, url: release.html_url, publishedAt: release.published_at, isNewer, assets: platformAssets.map((a: any) => ({ name: a.name, downloadUrl: a.browser_download_url, size: a.size })) }
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('download-release', async (event, opts: { url: string; version: string; assetName: string }) => {
    if (!opts.version || /[\\/:*?"<>|]/.test(opts.version) || opts.version.includes('..')) {
      return { success: false, error: '无效的版本' }
    }
    if (!opts.assetName || opts.assetName.includes('..') || opts.assetName.includes('/') || opts.assetName.includes('\\')) {
      return { success: false, error: '无效的资源名称' }
    }
    const archivePath = join(app.getPath('temp'), opts.assetName)
    const extractPath = join(BACKEND_DIR, opts.version)
    if (!isSafePath(BACKEND_DIR, extractPath)) return { success: false, error: '访问被拒绝' }
    const isTarGz = opts.assetName.toLowerCase().endsWith('.tar.gz')
    // 删除可能残留的损坏/不完整文件，确保本次为全新下载
    if (existsSync(archivePath)) { try { unlinkSync(archivePath) } catch {} }
    let startByte = 0
    try { const st = statSync(archivePath); if (st.size > 0) startByte = st.size } catch {}
    let dlReject: ((err: Error) => void) | null = null
    const overallTimer = setTimeout(() => {
      if (dlReject) dlReject(new Error('下载整体超时'))
      if (cancelBackendDl) { cancelBackendDl(); cancelBackendDl = null }
    }, 5 * 60 * 1000)
    try {
      event.sender.send('download-progress', { percent: 0, phase: 'downloading', received: 0, total: 0 })
      console.log('[dl] 开始下载:', opts.url)
      await new Promise<void>((resolve, reject) => {
        dlReject = reject
        cancelBackendDl = startParallelDownload(opts.url, archivePath, startByte,
          (r, t) => event.sender.send('download-progress', { percent: t > 0 ? Math.round(r / t * 100) : 0, phase: 'downloading', received: r, total: t }),
          () => { console.log('[dl] 下载完成'); resolve() },
          (err) => { console.log('[dl] 下载失败:', err.message); reject(err) })
      })
      cancelBackendDl = null; dlReject = null
      console.log('[dl] 开始解压:', archivePath, '->', extractPath)
      event.sender.send('download-progress', { percent: 100, phase: 'extracting', received: 0, total: 0 })
      if (!existsSync(extractPath)) mkdirSync(extractPath, { recursive: true })
      const archiveSize = statSync(archivePath).size
      if (archiveSize === 0) throw new Error('下载文件为空')
      if (isTarGz) {
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xzf', archivePath, '-C', extractPath], { stdio: 'pipe' })
          const t = setTimeout(() => { p.kill(); reject(new Error('tar解压超时')) }, 120000)
          p.on('error', (e) => { clearTimeout(t); reject(e) })
          p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`)) })
        })
      } else {
        // Windows 用原生 PowerShell Expand-Archive，Linux/macOS 用 unzip
        const [cmd, args] = process.platform === 'win32'
          ? ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractPath.replace(/'/g, "''")}' -Force`]]
          : ['unzip', ['-o', archivePath, '-d', extractPath]]
        await new Promise<void>((resolve, reject) => {
          const p = spawn(cmd, args, { stdio: 'pipe' })
          const t = setTimeout(() => { p.kill(); reject(new Error('解压超时')) }, 120000)
          p.on('error', (e) => { clearTimeout(t); reject(e) })
          p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`解压失败, exit code ${code}`)) })
        })
      }
      // 校验解压结果，避免“解压成功但内容为空”
      const extractedCount = countExtractedFiles(extractPath)
      console.log('[dl] 解压完成, 文件数:', extractedCount)
      if (extractedCount === 0) throw new Error('解压后内容为空')
      try { unlinkSync(archivePath) } catch (e) { console.error('清理临时文件失败', e) }
      clearTimeout(overallTimer)
      return { success: true, path: extractPath }
    } catch (err) {
      console.log('[dl] 失败:', err)
      cancelBackendDl = null; dlReject = null
      clearTimeout(overallTimer)
      if (existsSync(extractPath)) {
        try { rmSync(extractPath, { recursive: true, force: true }) } catch {}
      }
      const msg = String(err)
      let cnMsg = msg
      if (msg.includes('ERR_CONNECTION_TIMED_OUT') || msg.includes('Connection timeout') || msg.includes('Probe connection timeout')) cnMsg = '连接超时，请检查网络或代理设置'
      else if (msg.includes('ERR_CONNECTION_REFUSED')) cnMsg = '连接被拒绝'
      else if (msg.includes('ERR_INTERNET_DISCONNECTED')) cnMsg = '网络未连接'
      else if (msg.includes('ERR_NAME_NOT_RESOLVED')) cnMsg = 'DNS 解析失败，请检查网络'
      else if (msg.includes('Download stalled')) cnMsg = '下载停滞，请检查网络'
      else if (msg.includes('HTTP 4') || msg.includes('HTTP 5')) cnMsg = '服务器返回错误：' + (msg.match(/HTTP \d+/)?.[0] || '')
      else if (msg.includes('下载不完整') || msg.includes('分片下载不完整') || msg.includes('解压后内容为空') || msg.includes('下载文件为空')) cnMsg = '下载不完整，压缩包可能已损坏，请重试'
      else if (msg.includes('压缩包损坏') || msg.includes('tar') || msg.includes('unzip') || msg.includes('zip') || msg.includes('corrupt')) cnMsg = '解压失败，压缩包可能已损坏'
      else if (msg.includes('overall')) cnMsg = '下载整体超时'
      return { success: false, error: cnMsg }
    }
  })
  ipcMain.handle('cancel-backend-download', () => {
    if (cancelBackendDl) {
      cancelBackendDl()
      cancelBackendDl = null
    }
    return { success: true }
  })

  // ── 应用自身更新 ───────────────────────────────────────────
  const APP_GITHUB_OWNER = 'zwchyt'
  const APP_GITHUB_REPO = 'llama-studio'
  let cancelAppDl: (() => void) | null = null

  ipcMain.handle('check-app-update', async () => {
    try {
      const currentVersion = app.getVersion() || '0.0.0'

      const release = await fetchJson(`https://api.github.com/repos/${APP_GITHUB_OWNER}/${APP_GITHUB_REPO}/releases/latest`) as GitHubRelease
      if (!release || !release.tag_name) {
        return { available: false, currentVersion }
      }

      const tagName = release.tag_name
      const latestVersion = tagName.replace(/^v/, '')

      const currentParts = currentVersion.split('.').map(Number)
      const latestParts = latestVersion.split('.').map(Number)
      let available = false
      for (let i = 0; i < 3; i++) {
        const cur = currentParts[i] || 0
        const lat = latestParts[i] || 0
        if (lat > cur) { available = true; break }
        if (lat < cur) break
      }

      const isWin = process.platform === 'win32'
      const platformAssets = release.assets.filter((a: GitHubAsset) => {
        const n = a.name.toLowerCase()
        if (isWin) {
          return n.endsWith('.exe') && (n.includes('setup') || n.includes('installer'))
        }
        return false
      })

      const asset = platformAssets.length > 0 ? platformAssets[0] : null

      return {
        available,
        latestVersion,
        currentVersion,
        tagName,
        releaseName: release.name || tagName,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        assetName: asset?.name || '',
        assetUrl: asset?.browser_download_url || '',
        assetSize: asset?.size || 0,
      }
    } catch {
      return { available: false, currentVersion: app.getVersion() }
    }
  })

  ipcMain.handle('download-app-update', async (event, opts: { url: string; assetName: string }) => {
    await loadSettings()
    const urlOk = opts.url.startsWith('https://github.com/') || opts.url.startsWith('https://objects.githubusercontent.com/')
    if (!urlOk) {
      return { success: false, error: '无效的下载地址' }
    }
    if (!opts.assetName || opts.assetName.includes('..') || opts.assetName.includes('/') || opts.assetName.includes('\\')) {
      return { success: false, error: '无效的资源名称' }
    }

    const archivePath = join(app.getPath('temp'), opts.assetName)
    // 删除可能残留的损坏/不完整文件，确保本次为全新下载
    if (existsSync(archivePath)) { try { unlinkSync(archivePath) } catch {} }
    let startByte = 0
    try { const st = statSync(archivePath); if (st.size > 0) startByte = st.size } catch {}

    try {
      event.sender.send('app-download-progress', { percent: 0, phase: 'downloading' })

      await new Promise<void>((resolve, reject) => {
        cancelAppDl = startParallelDownload(
          opts.url, archivePath, startByte,
          (r, t) => {
            event.sender.send('app-download-progress', {
              percent: t > 0 ? Math.round(r / t * 100) : 0,
              phase: 'downloading',
              received: r,
              total: t
            })
          },
          () => {
            event.sender.send('app-download-progress', { percent: 100, phase: 'downloaded' })
            resolve()
          },
          (err) => reject(err)
        )
      })
      cancelAppDl = null
      return { success: true, path: archivePath }
    } catch (err) {
      cancelAppDl = null
      // 保留 archivePath 以支持断点续传：下次下载从断点继续，而不是从头重来
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('cancel-app-download', () => {
    if (cancelAppDl) {
      cancelAppDl()
      cancelAppDl = null
    }
    return { success: true }
  })

  ipcMain.handle('install-app-update', async (_e, opts: { installerPath: string }) => {
    if (!opts.installerPath || !existsSync(opts.installerPath)) {
      return { success: false, error: '安装程序未找到' }
    }
    if (!opts.installerPath.toLowerCase().endsWith('.exe')) {
      return { success: false, error: '不支持的安装程序类型' }
    }

    try {
      const installDir = dirname(app.getPath('exe'))

      // start 启动 GUI 安装器，/D= 指定默认安装路径
      // 用 shell 启动避免 Node 对含空格路径加引号导致 NSIS 解析失败
      const shellCmd = `start "" "${opts.installerPath}" /D=${installDir}`
      spawn(shellCmd, {
        shell: true,
        detached: true,
        stdio: 'ignore',
      })

      // 先返回 IPC 响应，再退出应用释放文件锁
      setTimeout(() => app.quit(), 2000)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('open-folder', async (_e, folderPath: string) => {
    const settings = await loadSettings()
    const allowedBases = [MODELS_DIR, BACKEND_DIR, CHATS_DIR, ...settings.externalModelFolders, ...settings.imageModelFolders]
    if (!allowedBases.some(base => isSafePath(base, folderPath))) return
    // 确保目录存在（例如 chats/images、chats/pdf_exports 是惰性创建的），
    // 否则 shell.openPath 在路径不存在时会静默失败、什么也不打开。
    if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true })
    const err = await shell.openPath(folderPath)
    if (err) console.error('[open-folder] 无法打开目录:', folderPath, err)
    return err
  })
  ipcMain.handle('get-paths', () => ({ models: MODELS_DIR, templates: TEMPLATES_DIR, backend: BACKEND_DIR, chats: CHATS_DIR, chatImages: join(CHATS_DIR, 'images'), chatPdfExports: join(CHATS_DIR, 'pdf_exports') }))
  ipcMain.handle('open-external', (_e, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch { }
  })
  ipcMain.handle('hf-search', async (_e, query: string) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=24&sort=downloads&direction=-1`)
      if (!Array.isArray(data)) return { error: 'API 返回格式异常' }
      return data.map((m: HfModelRaw) => ({ id: m.id, author: m.author || m.id.split('/')[0] || '', name: m.id.split('/').pop() || m.id, downloads: m.downloads || 0, likes: m.likes || 0, tags: m.tags || [], lastModified: m.lastModified || '' }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-get-files', async (_e, repoId: string) => {
    try {
      // repoId 格式为 "owner/repo"，斜杠是路径分隔符不能被编码
      const safeRepoId = repoId.split('/').map(s => encodeURIComponent(s)).join('/')
      const data = await fetchJson(`https://huggingface.co/api/models/${safeRepoId}/tree/main?recursive=true`)
      if (!Array.isArray(data)) {
        const errMsg = typeof data === 'object' && data !== null && 'error' in data ? String((data as any).error) : 'API 返回异常'
        return { error: errMsg }
      }
      const ggufFiles = data.filter((f: HfFileRaw) => f.type === 'file' && f.path.endsWith('.gguf'))
      if (ggufFiles.length === 0) return { error: '该仓库中没有找到 .gguf 文件' }
      return ggufFiles.map((f: HfFileRaw) => ({
        name: f.path,
        size: f.size || 0,
        downloadUrl: `https://huggingface.co/${safeRepoId}/resolve/main/${f.path.split('/').map(s => encodeURIComponent(s)).join('/')}`
      }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-download-model', (_event, opts: { repoId: string; filename: string; downloadUrl: string }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const existing = downloadTasks.get(id)!
      if (existing.phase === 'downloading') return { success: false, error: '已在下载中' }
    }
    const folder = opts.repoId.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!isSafePath(MODELS_DIR, destDir)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    if (!isSafePath(MODELS_DIR, finalPath)) return { success: false, error: '访问被拒绝' }
    const tmpPath = finalPath + '.tmp'
    const task: DownloadTask = { id, url: opts.downloadUrl, filename: opts.filename, destPath: finalPath, receivedBytes: 0, totalBytes: 0, speed: 0, phase: 'downloading', repoId: opts.repoId }
    const broadcast = (force = false) => {
      if (!force && !canBroadcast(task.id)) return
      const percent = task.totalBytes > 0 ? Math.round(task.receivedBytes / task.totalBytes * 100) : 0
      const speedBucket = Math.round(task.speed / (500 * 1024))
      if (!force) {
        const last = lastSent.get(task.id)
        if (last && last.percent === percent && last.phase === task.phase && last.speedBucket === speedBucket) return
      }
      lastSent.set(task.id, { percent, phase: task.phase, speedBucket })
      const payload = {
        id: task.id, filename: task.filename, phase: task.phase,
        percent, speed: task.speed, destPath: task.destPath,
        receivedBytes: task.receivedBytes, totalBytes: task.totalBytes,
        repoId: task.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('hf-download-progress', payload)
        }
      })
    }
    task.cancelFn = startDownload(
      opts.downloadUrl, tmpPath, 0,
      (r, t, speed) => { task.receivedBytes = r; task.totalBytes = t; task.speed = speed; broadcast() },
      () => {
        try { renameSync(tmpPath, finalPath) } catch { }
        task.phase = 'done'; task.speed = 0; broadcast(true)
        invalidateModelsCache()
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id); lastSent.delete(id) }, 10000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcast(true); console.error('HF 模型下载错误:', err) }
    )
    downloadTasks.set(id, task)
    return { success: true }
  })
  const checkFileCache = new Map<string, boolean>()
  ipcMain.handle('check-file-exists', async (_e, filePath: string) => {
    if (checkFileCache.has(filePath)) return checkFileCache.get(filePath)
    let exists: boolean
    if (isSafePath(MODELS_DIR, filePath)) {
      exists = existsSync(filePath)
    } else {
      const s = await loadSettings()
      const allowed = s.externalModelFolders.some(f => isSafePath(f, filePath))
      if (!allowed) { checkFileCache.set(filePath, false); return false }
      exists = existsSync(filePath)
    }
    checkFileCache.set(filePath, exists)
    return exists
  })
  ipcMain.handle('select-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const r = await dialog.showOpenDialog(win!, { title: 'Select Directory', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { path: null }
    return { path: r.filePaths[0] }
  })

  // --- metrics ---
  const lastCacheHit = new Map<string, { cached: number; total: number }>()
  const lastDecodeCount = new Map<string, { count: number; time: number }>()
  async function httpGetText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { agent: httpAgent }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c.toString(); if (body.length > 1e6) { req.destroy(); reject(new Error('响应数据过大')) } })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('超时')) })
    })
  }

  function tryParseJson(text: string): unknown {
    try { return JSON.parse(text) } catch { return null }
  }

  function parsePrometheusMetrics(text: string): Record<string, number> {
    const result: Record<string, number> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length >= 2) {
        const val = parseFloat(parts[parts.length - 1])
        if (!isNaN(val)) result[parts[0]] = val
      }
    }
    return result
  }

  async function refreshGpuData(): Promise<void> {
    const now = Date.now()
    if (cachedGpuData && (now - lastGpuFetch) < GPU_CACHE_TTL) return
    const smiPath = findNvidiaSmi()
    if (!smiPath) {
      if (!gpuLoggedFail) { console.warn('[gpu] nvidia-smi not found in any known path'); gpuLoggedFail = true }
      return
    }
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const isWin = process.platform === 'win32'
        const smiArgs = ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name,power.draw', '--format=csv,noheader,nounits']
        const proc = spawn(isWin ? `"${smiPath}" ${smiArgs.map(a => `"${a}"`).join(' ')}` : smiPath, isWin ? [] : smiArgs, { windowsHide: true, shell: isWin })
        let stdout = '', stderr = ''
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`nvidia-smi 退出码 ${code}: ${stderr.trim()}`))
        })
      })
      // output: "32, 8192, 24576, 45, NVIDIA GeForce RTX 4090, 150.50"
      const parts = result.split(',').map(s => s.trim())
      if (parts.length >= 4) {
        const util = parseInt(parts[0], 10)
        const memUsed = parseInt(parts[1], 10)
        const memTotal = parseInt(parts[2], 10)
        const temp = parseInt(parts[3], 10)
        const name = parts[4] || ''
        const power = parts[5] ? parseFloat(parts[5]) : NaN
        cachedGpuData = {
          name: name || 'Unknown GPU',
          temperatureGpu: isNaN(temp) ? null : temp,
          utilizationGpu: isNaN(util) ? null : util,
          memoryUsed: isNaN(memUsed) ? null : memUsed,
          memoryTotal: isNaN(memTotal) ? null : memTotal,
          powerDraw: isNaN(power) ? null : power,
        }
        lastGpuFetch = now
        gpuLoggedFail = false
      }
    } catch (err) {
      if (!gpuLoggedFail) { console.warn('[gpu] nvidia-smi failed:', err); gpuLoggedFail = true }
    }
  }

  async function collectMetrics(id: string, port: number, pid?: number): Promise<Record<string, unknown>> {
    const [rawSlots, rawMetrics] = await Promise.all([
      httpGetText(`http://127.0.0.1:${port}/slots`).catch(() => ''),
      httpGetText(`http://127.0.0.1:${port}/metrics`).catch(() => ''),
    ])
    const gpu = cachedGpuData
    const payload: Record<string, unknown> = { id, lastUpdated: Date.now() }
    const slots = rawSlots ? tryParseJson(rawSlots) : null
    if (slots && Array.isArray(slots) && slots.length > 0) {
      const s = slots[0]
      if (s.n_ctx !== undefined) payload.nCtx = s.n_ctx
      if (s.n_prompt_tokens !== undefined) payload.nPromptTokens = s.n_prompt_tokens
      if (s.n_prompt_tokens_processed !== undefined) payload.nPromptTokensProcessed = s.n_prompt_tokens_processed
      if (s.n_prompt_tokens_cache !== undefined && s.n_prompt_tokens_cache > 0) {
        payload.nPromptTokensCache = s.n_prompt_tokens_cache
        lastCacheHit.set(id, { cached: s.n_prompt_tokens_cache, total: s.n_prompt_tokens ?? 0 })
      } else {
        // 请求完成后保持最后一次有效缓存快照
        const snap = lastCacheHit.get(id)
        if (snap) {
          payload.nPromptTokensCache = snap.cached
          payload.nPromptTokens = snap.total || (s.n_prompt_tokens ?? 0)
        }
      }
      if (s.next_token?.[0]?.n_decoded !== undefined) payload.nDecoded = s.next_token[0].n_decoded
      if (s.is_processing !== undefined) payload.isProcessing = s.is_processing
      if (s.params?.n_predict !== undefined) payload.nPredict = s.params.n_predict
    }
    if (rawMetrics) {
      const prom = parsePrometheusMetrics(rawMetrics)
      if (prom['llamacpp:predicted_tokens_seconds'] !== undefined) payload.decodeTokS = prom['llamacpp:predicted_tokens_seconds']
      if (prom['llamacpp:prompt_tokens_seconds'] !== undefined) payload.prefillTokS = prom['llamacpp:prompt_tokens_seconds']
      if (prom['llamacpp:n_decode_total'] !== undefined) {
        const prev = lastDecodeCount.get(id)
        const now = Date.now()
        if (prev && prev.count >= 0) {
          const dt = (now - prev.time) / 1000
          if (dt > 0) {
            const delta = prom['llamacpp:n_decode_total'] - prev.count
            if (delta > 0) payload.reqPerSec = delta / dt
          }
        }
        lastDecodeCount.set(id, { count: prom['llamacpp:n_decode_total'], time: now })
      }
      // 不覆盖 nPromptTokensCache：slots API 的 n_prompt_tokens_cache 是真正的缓存命中数
      // kv_cache_tokens 是全局 KV cache 占用量，语义不同，仅用于推算 nCtx
      if (prom['llamacpp:kv_cache_usage_ratio'] !== undefined && prom['llamacpp:kv_cache_tokens'] !== undefined && prom['llamacpp:kv_cache_usage_ratio'] > 0) {
        payload.nCtx = Math.round(prom['llamacpp:kv_cache_tokens'] / prom['llamacpp:kv_cache_usage_ratio'])
      }
    }
    if (gpu) {
      payload.vramTotalMb = gpu.memoryTotal || 0
      payload.vramUsedMb = gpu.memoryUsed ?? null
      payload.gpuTemperature = gpu.temperatureGpu ?? null
      payload.gpuUtilization = gpu.utilizationGpu ?? null
      payload.gpuName = gpu.name || ''
      payload.gpuPowerDraw = gpu.powerDraw ?? null
    }
    // Estimate TTFT from prompt token count and prefill speed
    if (typeof payload.nPromptTokens === 'number' && payload.nPromptTokens > 0 &&
      typeof payload.prefillTokS === 'number' && payload.prefillTokS > 0) {
      payload.ttftMs = Math.round((payload.nPromptTokens / payload.prefillTokS) * 1000)
    }
    if (pid !== undefined) {
      payload.cpuUsage = await getCpuUsage()
    }
    return payload
  }

  async function broadcastMetrics(): Promise<void> {
    if (runningProcesses.size === 0) return
    const gpuReady = refreshGpuData()
    for (const [id, { proc, port }] of runningProcesses) {
      if (proc.pid === undefined) continue
      try {
        await gpuReady
        const payload = await collectMetrics(id, port, proc.pid)
        payload.pid = proc.pid
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('metrics-update', payload)
        })
      } catch { }
    }
  }

  function startMetricsInterval(): void {
    if (metricsInterval) return
    metricsInterval = setInterval(() => broadcastMetrics(), 2000)
  }

  function stopMetricsInterval(): void {
    if (metricsInterval) {
      clearInterval(metricsInterval)
      metricsInterval = null
    }
  }

  ipcMain.handle('get-metrics-polling', () => metricsPollingEnabled)
  ipcMain.handle('set-metrics-polling', async (_e, enabled: boolean) => {
    metricsPollingEnabled = enabled
    const s = await loadSettings()
    s.metricsPolling = enabled
    await saveSettings(s)
    if (enabled) startMetricsInterval()
    else stopMetricsInterval()
    return { success: true }
  })
  ipcMain.handle('get-metrics', async () => {
    const result: Record<string, unknown> = {}
    await refreshGpuData()
    for (const [id, { proc, port }] of runningProcesses) {
      if (proc.pid === undefined) continue
      try {
        const entry = await collectMetrics(id, port, proc.pid)
        entry.pid = proc.pid
        result[id] = entry
      } catch { }
    }
    return { metrics: result }
  })

  // --- wait-for-server ---
  ipcMain.handle('wait-for-server', async (_e, port: number) => {
    const maxAttempts = 60
    const delayMs = 500
    let resolved = false
    for (let i = 0; i < maxAttempts; i++) {
      if (resolved) return true
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/v1/models`, (res) => {
            (res as any).resume()
            if (res.statusCode === 200) {
              resolved = true
              resolve()
            } else {
              reject(new Error(`状态码 ${res.statusCode}`))
            }
          })
          req.on('error', () => reject())
          req.setTimeout(1000, () => { req.destroy(); reject() })
        })
        return true
      } catch {
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
    return false
  })

  // --- fetch-server-endpoint ---
  ipcMain.handle('fetch-server-endpoint', (_e, port: number, endpoint: string): Promise<{ ok: boolean; status?: number; text?: string; error?: string }> => {
    return new Promise((resolve) => {
      const url = `http://127.0.0.1:${port}/${endpoint}`
      const req = http.get(url, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => { body += c.toString() })
        res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode, text: body }))
      })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
    })
  })

	  // --- chat-completion-stream (流式聊天代理：POST /v1/chat/completions，SSE 转发) ---
	  ipcMain.handle('chat-completion-stream', (e, opts: {
	    streamId: string; port: number; body: Record<string, unknown>
	  }): Promise<{ success: boolean; error?: string }> => {
	    // 节流：累积多个 token 后再发送，减少 IPC 频率（约 20fps）
	    const streamThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>()
	    const streamPendingDeltas = new Map<string, string>()
	    const STREAM_THROTTLE_MS = 5
	    function flushStreamDelta(streamId: string): void {
	      const delta = streamPendingDeltas.get(streamId)
	      if (delta) {
	        streamPendingDeltas.delete(streamId)
	        e.sender.send('chat-stream-chunk', { streamId, delta, done: false })
	      }
	    }
	    function queueStreamDelta(streamId: string, delta: string): void {
	      const existing = streamPendingDeltas.get(streamId) || ''
	      streamPendingDeltas.set(streamId, existing + delta)
	      if (!streamThrottleTimers.has(streamId)) {
	        streamThrottleTimers.set(streamId, setTimeout(() => {
	          streamThrottleTimers.delete(streamId)
	          flushStreamDelta(streamId)
	        }, STREAM_THROTTLE_MS))
	      }
	    }
	    function flushStreamNow(streamId: string): void {
	      const t = streamThrottleTimers.get(streamId)
	      if (t) { clearTimeout(t); streamThrottleTimers.delete(streamId) }
	      flushStreamDelta(streamId)
	    }
	    return new Promise((resolve) => {
      const { streamId, port, body } = opts
      // stream_options.include_usage 让 llama-server 在流结束前发送 usage 统计
      const bodyStr = JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } })
      const streamStartTime = Date.now()
      let firstTokenTime: number | null = null
      let lastUsage: { promptTokens: number; completionTokens: number } | null = null
      let lastFinishReason: string | undefined
      let endMetricsPromise: Promise<{ decodeTokS?: number; completionTokens?: number }> | null = null
      const req = http.request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        agent: httpAgent
      }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
	          let errBody = ''
	          res.on('data', (c: Buffer) => { errBody += c.toString() })
	          res.on('end', () => {
	            activeChatStreams.delete(streamId)
	            flushStreamNow(streamId)
	            e.sender.send('chat-stream-chunk', { streamId, done: true, error: `HTTP 错误 ${res.statusCode}: ${errBody.slice(0, 500)}` })
	            resolve({ success: false, error: `HTTP 错误 ${res.statusCode}` })
	          })
	          return
	        }
	        let buf = ''
	        // SSE 事件解析：处理 buf 中以 \n\n 分隔的事件
	        function processBuf() {
	          let idx: number
	          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const line = raw.split('\n').find(l => l.startsWith('data: '))
            if (!line) continue
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') {
              return
            }
            try {
              const parsed = JSON.parse(payload)
              // 提取 usage（llama-server 在最后一个 SSE 事件中返回，choices 为空数组）
              if (parsed?.usage) {
                lastUsage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0
                }
                // usage chunk 到达时立即获取 /metrics 读取 predicted_tokens_seconds（与监控面板同源）
                if (!endMetricsPromise) {
                  endMetricsPromise = httpGetText(`http://127.0.0.1:${port}/metrics`)
                    .then(raw => {
                      const prom = parsePrometheusMetrics(raw)
                      return {
                        decodeTokS: prom['llamacpp:predicted_tokens_seconds'],
                        completionTokens: lastUsage?.completionTokens
}

                    })
                    .catch(() => ({ completionTokens: lastUsage?.completionTokens }))
                }
              }
              const choice = parsed?.choices?.[0]
              const content = choice?.delta?.content
              const reasoning = choice?.delta?.reasoning_content
              const inReasoning = chatStreamInReasoning.get(streamId) ?? false

              // 记录首 token 时间（content 或 reasoning 均算首 token）
              if ((content || reasoning) && firstTokenTime === null) {
                firstTokenTime = Date.now() - streamStartTime
              }

	              // reasoning_content → 包裹在 <think> 标签中，以便前端折叠显示
	              if (reasoning) {
	                const delta = (inReasoning ? '' : '<think>') + reasoning
	                queueStreamDelta(streamId, delta)
	                chatStreamInReasoning.set(streamId, true)
	              }
	              if (content) {
	                const prefix = inReasoning || (chatStreamInReasoning.get(streamId) ?? false) ? '</think>\n' : ''
	                if (prefix) chatStreamInReasoning.set(streamId, false)
	                queueStreamDelta(streamId, prefix + content)
	              }

              // 累积 tool_calls 增量片段（delta.tool_calls 按 index 分片到达）
              const deltaToolCalls = choice?.delta?.tool_calls
              if (Array.isArray(deltaToolCalls)) {
                let acc = chatStreamToolCalls.get(streamId)
                if (!acc) { acc = []; chatStreamToolCalls.set(streamId, acc) }
                for (const tc of deltaToolCalls) {
                  const idx = tc.index ?? 0
                  if (!acc[idx]) {
                    acc[idx] = { index: idx, id: tc.id ?? '', type: tc.type ?? 'function', function: { name: '', arguments: '' } }
                  }
                  if (tc.id) acc[idx].id = tc.id
                  if (tc.function?.name) acc[idx].function.name += tc.function.name
                  if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments
                }
              }
              // 记录 finish_reason（通常只在最后一个有 choices 的 chunk 中出现）
              if (choice?.finish_reason) lastFinishReason = choice.finish_reason
            } catch { /* 忽略心跳/keepalive/不完整 JSON */ }
          }
        }
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          processBuf()
        })
        res.on('end', () => {
          // 处理缓冲区中可能残留的未以 \n\n 结尾的 SSE 事件（如 usage chunk）
          if (buf.trim()) {
            buf += '\n\n'
            processBuf()
          }
          // 如果流结束时 <think> 尚未闭合，补上闭合标签
          const wasInReasoning = chatStreamInReasoning.get(streamId) ?? false
          if (wasInReasoning) {
            e.sender.send('chat-stream-chunk', { streamId, delta: '</think>', done: false })
          }
          chatStreamInReasoning.delete(streamId)

          // 等待 /metrics 结果，使用 predicted_tokens_seconds（与监控面板同源）
          const accToolCalls = chatStreamToolCalls.get(streamId)
          chatStreamToolCalls.delete(streamId)
	          const finalizeStream = (metrics?: { decodeTokS?: number; completionTokens?: number }) => {
	            const finalTokens = metrics?.completionTokens ?? lastUsage?.completionTokens
	            const finalUsage = finalTokens != null
	              ? { promptTokens: lastUsage?.promptTokens ?? 0, completionTokens: finalTokens }
	              : undefined
	            flushStreamNow(streamId)
	            e.sender.send('chat-stream-chunk', {
              streamId,
              done: true,
              usage: finalUsage,
              msFirstToken: firstTokenTime ?? undefined,
              decodeTokS: metrics?.decodeTokS,
              toolCalls: accToolCalls?.length ? accToolCalls.map(tc => ({ id: tc.id, function: tc.function })) : undefined,
              finishReason: lastFinishReason ?? (accToolCalls?.length ? 'tool_calls' : undefined)
            })
            activeChatStreams.delete(streamId)
            resolve({ success: true })
          }

          if (endMetricsPromise) {
            endMetricsPromise.then(m => finalizeStream(m)).catch(() => finalizeStream())
          } else {
            finalizeStream()
          }
        })
      })
	      req.on('error', (err) => {
	        chatStreamInReasoning.delete(streamId)
	        chatStreamToolCalls.delete(streamId)
	        // 主动中止的流不发 error 事件，避免前端误显示
	        if (!abortedChatStreams.has(streamId)) {
	          flushStreamNow(streamId)
	          e.sender.send('chat-stream-chunk', { streamId, done: true, error: err.message })
	        }
	        abortedChatStreams.delete(streamId)
	        activeChatStreams.delete(streamId)
	        resolve({ success: false, error: err.message })
	      })
	      // 流式生成可能很久，给一个较长的超时（5 分钟），超时则中止
	      req.setTimeout(300000, () => {
	        req.destroy()
	        chatStreamInReasoning.delete(streamId)
	        chatStreamToolCalls.delete(streamId)
	        flushStreamNow(streamId)
	        e.sender.send('chat-stream-chunk', { streamId, done: true, error: '超时' })
        activeChatStreams.delete(streamId)
        resolve({ success: false, error: '超时' })
      })
      activeChatStreams.set(streamId, req)
      req.write(bodyStr)
      req.end()
    })
  })

  // --- chat-stream-abort (中止一个进行中的聊天流) ---
  ipcMain.handle('chat-stream-abort', (_e, streamId: string) => {
    const req = activeChatStreams.get(streamId)
    if (req) {
      abortedChatStreams.add(streamId)
      req.destroy()
      activeChatStreams.delete(streamId)
    }
    return { success: true }
  })

  // --- ocr-stream (发送图片到 /completion，llama.cpp 原生多模态格式) ---
  ipcMain.handle('ocr-stream', async (e, opts: {
    streamId: string; port: number; image: string; prompt: string; templateArgs?: Record<string, string | number | boolean | null>
  }): Promise<{ success: boolean; error?: string }> => {
    const { streamId, port, image, prompt, templateArgs } = opts
    // 1. 获取 media_marker（告诉模型图片插在哪）
    let mediaMarker = '<image>'
    try {
      const propsJson = await fetchText(`http://127.0.0.1:${port}/props`)
      const props = JSON.parse(propsJson)
      if (props?.media_marker) mediaMarker = props.media_marker
    } catch { /* 使用默认值 */ }
    const base64Image = image.startsWith('data:') ? image.split(',')[1] : image
    const promptText = prompt || 'OCR this image:'
    const finalPrompt = `<|user|>\n${mediaMarker}\n${promptText}\n<|assistant|>`
    const nPredict = (typeof templateArgs?.['n-predict'] === 'number' ? templateArgs['n-predict'] :
      typeof templateArgs?.n_predict === 'number' ? templateArgs.n_predict : 2048)
    const temperature = typeof templateArgs?.temperature === 'number' ? templateArgs.temperature : 0.1
    const body: Record<string, unknown> = {
      prompt: {
        prompt_string: finalPrompt,
        multimodal_data: [base64Image]
      },
      stream: true,
      n_predict: nPredict,
      temperature
    }
    const bodyStr = JSON.stringify(body)
    return new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${port}/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        agent: httpAgent
      }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = ''
          res.on('data', (c: Buffer) => { errBody += c.toString() })
          res.on('end', () => {
            activeChatStreams.delete(streamId)
            e.sender.send('ocr-chunk', { streamId, done: true, error: `HTTP 错误 ${res.statusCode}: ${errBody.slice(0, 500)}` })
            resolve({ success: false, error: `HTTP 错误 ${res.statusCode}` })
          })
          return
        }
        let buf = ''
        let finished = false
        let chunkCount = 0
        const MAX_CHUNKS = 4096
        res.on('data', (c: Buffer) => {
          buf += c.toString()
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const line = raw.split('\n').find(l => l.startsWith('data: '))
            if (!line) continue
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') {
              if (!finished) { finished = true; e.sender.send('ocr-chunk', { streamId, done: true }) }
              continue
            }
            try {
              const parsed = JSON.parse(payload)
              if (parsed.content) {
                chunkCount++
                if (chunkCount > MAX_CHUNKS) {
                  if (!finished) { finished = true; e.sender.send('ocr-chunk', { streamId, done: true }) }
                  req.destroy()
                  continue
                }
                e.sender.send('ocr-chunk', { streamId, delta: parsed.content, done: false })
              }
              if (parsed.stop) {
                if (!finished) { finished = true; e.sender.send('ocr-chunk', { streamId, done: true }) }
              }
            } catch { /* skip */ }
          }
        })
        res.on('end', () => {
          activeChatStreams.delete(streamId)
          if (!finished) {
            if (buf.trim()) {
              try {
                const parsed = JSON.parse(buf)
                if (parsed.content) {
                  e.sender.send('ocr-chunk', { streamId, delta: parsed.content, done: false })
                }
              } catch { /* skip */ }
            }
            finished = true
            e.sender.send('ocr-chunk', { streamId, done: true })
          }
          resolve({ success: true })
        })
      })
      req.on('error', (err) => {
        activeChatStreams.delete(streamId)
        e.sender.send('ocr-chunk', { streamId, done: true, error: err.message })
        resolve({ success: false, error: err.message })
      })
      req.write(bodyStr)
      req.end()
      activeChatStreams.set(streamId, req)
    })
  })

  // --- ocr-stream-abort ---
  ipcMain.handle('ocr-stream-abort', (_e, streamId: string) => {
    const req = activeChatStreams.get(streamId)
    if (req) {
      abortedChatStreams.add(streamId)
      req.destroy()
      activeChatStreams.delete(streamId)
    }
    return { success: true }
  })

  // load initial settings (cache is already populated synchronously above)
  metricsPollingEnabled = settingsCache!.metricsPolling ?? true
  if (metricsPollingEnabled) startMetricsInterval()

  ipcMain.handle('hf-open-models-dir', () => shell.openPath(MODELS_DIR))
  // ── ModelScope ──
  ipcMain.handle('ms-search', async (_e, query: string) => {
    try {
      // MS 搜索需要用 Name 参数（Query 参数无效），附加 GGUF 关键词精确定位
      const searchName = query.trim() ? query + ' GGUF' : 'GGUF'
      const data: any = await fetchJsonWithBody('https://modelscope.cn/api/v1/dolphin/models', {
        Name: searchName,
        PageSize: 50,
        PageNumber: 1,
        Sort: { SortBy: 'DownloadCount', Descending: true }
      })
      const raw = data?.Data?.Model?.Models
      if (!Array.isArray(raw)) return { error: 'API 返回格式异常' }
      // 辅助函数：解析 Libraries 字段（可能是 JSON 字符串或数组）
      const parseLibs = (libs: any): string[] => {
        if (typeof libs === 'string') { try { return JSON.parse(libs) } catch { return [] } }
        return Array.isArray(libs) ? libs : []
      }
      // 只保留 GGUF 模型
      const ggufModels = raw.filter((m: any) =>
        parseLibs(m.Libraries).some((l: string) => l.toLowerCase() === 'gguf')
      )
      if (ggufModels.length === 0) return { error: '未找到 GGUF 模型，请尝试其他关键词' }
      return ggufModels.map((m: any) => ({
        id: String(m.Path) + '/' + String(m.Name),
        author: String(m.CreatedBy || m.Path || ''),
        name: String(m.Name),
        downloads: m.Downloads || 0,
        likes: m.Stars || 0,
        tags: typeof m.Tags === 'string' ? (() => { try { return JSON.parse(m.Tags) } catch { return [] } })() : (Array.isArray(m.Tags) ? m.Tags : []),
        lastModified: m.LastUpdatedTime ? new Date(m.LastUpdatedTime * 1000).toISOString() : ''
      }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('ms-get-files', async (_e, repoId: string) => {
    try {
      const safeRepoId = repoId.split('/').map(s => encodeURIComponent(s)).join('/')
      const data: any = await fetchJson(`https://modelscope.cn/api/v1/models/${safeRepoId}/repo/files?Revision=master&Root=`)
      const files = data?.Data?.Files
      if (!Array.isArray(files)) return { error: 'API 返回格式异常' }
      const ggufFiles = files.filter((f: any) => f.Type === 'blob' && String(f.Name).endsWith('.gguf'))
      if (ggufFiles.length === 0) return { error: '该仓库中没有找到 .gguf 文件' }
      return ggufFiles.map((f: any) => ({
        name: f.Name,
        size: f.Size || 0,
        downloadUrl: `https://modelscope.cn/models/${safeRepoId}/resolve/master/${String(f.Name).split('/').map(s => encodeURIComponent(s)).join('/')}`
      }))
    } catch (err) { return { error: String(err) } }
  })
  // ms-download-model 复用 hf-download-model 的下载基础设施，仅下载URL不同
  ipcMain.handle('ms-download-model', (_event, opts: { repoId: string; filename: string; downloadUrl: string }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const existing = downloadTasks.get(id)!
      if (existing.phase === 'downloading') return { success: false, error: '已在下载中' }
    }
    const folder = opts.repoId.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!isSafePath(MODELS_DIR, destDir)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    if (!isSafePath(MODELS_DIR, finalPath)) return { success: false, error: '访问被拒绝' }
    const tmpPath = finalPath + '.tmp'
    const task: DownloadTask = { id, url: opts.downloadUrl, filename: opts.filename, destPath: finalPath, receivedBytes: 0, totalBytes: 0, speed: 0, phase: 'downloading', repoId: opts.repoId }
    const broadcast = (force = false) => {
      if (!force && !canBroadcast(task.id)) return
      const percent = task.totalBytes > 0 ? Math.round(task.receivedBytes / task.totalBytes * 100) : 0
      const speedBucket = Math.round(task.speed / (500 * 1024))
      if (!force) {
        const last = lastSent.get(task.id)
        if (last && last.percent === percent && last.phase === task.phase && last.speedBucket === speedBucket) return
      }
      lastSent.set(task.id, { percent, phase: task.phase, speedBucket })
      const payload = {
        id: task.id, filename: task.filename, phase: task.phase,
        percent, speed: task.speed, destPath: task.destPath,
        receivedBytes: task.receivedBytes, totalBytes: task.totalBytes,
        repoId: task.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('hf-download-progress', payload)
        }
      })
    }
    task.cancelFn = startDownload(
      opts.downloadUrl, tmpPath, 0,
      (r, t, speed) => { task.receivedBytes = r; task.totalBytes = t; task.speed = speed; broadcast() },
      () => {
        try { renameSync(tmpPath, finalPath) } catch { }
        task.phase = 'done'; task.speed = 0; broadcast(true)
        invalidateModelsCache()
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id); lastSent.delete(id) }, 10000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcast(true); console.error('MS 模型下载错误:', err) }
    )
    downloadTasks.set(id, task)
    return { success: true }
  })
  ipcMain.handle('ms-open-models-dir', () => shell.openPath(MODELS_DIR))
  ipcMain.handle('onDownloadProgress', () => { })
  ipcMain.handle('removeDownloadListener', () => { })

  // --- AI Agent detection ---
  const KNOWN_AGENTS: { name: string; pkg: string; cmd: string; nonNpm?: boolean; logo?: string; website?: string }[] = [
    { name: 'OpenCode',          pkg: 'opencode-ai',                     cmd: 'opencode',    logo: './agent-logos/OpenCode.png',      website: 'https://opencode.ai' },
    { name: 'Codex',             pkg: '@openai/codex',                   cmd: 'codex',       logo: './agent-logos/Codex.png',         website: 'https://developers.openai.com/codex/cli' },
    { name: 'Qwen Code',         pkg: '@qwen-code/qwen-code',            cmd: 'qwen',        logo: './agent-logos/QwenCode.png',      website: 'https://qwen.ai/qwencode' },
    { name: 'Droid',             pkg: 'droid',                           cmd: 'droid',       logo: './agent-logos/Droid.png',         website: 'https://factory.ai/' },
    { name: 'Pi Coding Agent',   pkg: '@earendil-works/pi-coding-agent', cmd: 'pi',          logo: './agent-logos/Pi.png',            website: 'https://pi.dev/' },
    { name: 'GitHub Copilot',    pkg: '@github/copilot',                 cmd: 'copilot',     logo: './agent-logos/Copilot.png',       website: 'https://github.com/features/copilot/cli' },
    { name: 'KiloCode',          pkg: '@kilocode/cli',                   cmd: 'kilo',        logo: './agent-logos/KiloCode.png',      website: 'https://kilo.ai/cli' },
    { name: 'Mimo AI',           pkg: '@mimo-ai/cli',                    cmd: 'mimo',        logo: './agent-logos/MiMoCode .png',     website: 'https://mimo.xiaomi.com/mimocode/install' },
    { name: 'Command Code',      pkg: 'command-code',                    cmd: 'command-code',logo: './agent-logos/Command Code.png',  website: 'https://commandcode.ai/'},
    { name: 'OpenClaude',        pkg: '@gitlawb/openclaude',             cmd: 'openclaude',  logo: './agent-logos/OpenClaude.png',    website: 'https://openclaude.gitlawb.com/' },
    { name: 'Crush',             pkg: '@charmland/crush',                cmd: 'crush',       logo: './agent-logos/Cursh.png',         website: 'https://github.com/charmbracelet/crush' },
    { name: 'CodeWhale',         pkg: 'codewhale',                       cmd: 'codewhale',   logo: './agent-logos/CodeWhale.jpg',     website: 'https://github.com/Hmbown/CodeWhale' },
    { name: 'Kimi',              pkg: '@moonshot-ai/kimi-code',          cmd: 'kimi',        logo: './agent-logos/KimiCode.jpg',      website: 'https://www.kimi.com/code' },
    { name: 'Cline',             pkg: 'cline',                           cmd: 'cline',       logo: './agent-logos/Cline.png',         website: 'https://cline.bot/' },
    { name: 'Augment Code',      pkg: '@augmentcode/auggie',             cmd: 'auggie',      logo: './agent-logos/Augment Code.png',  website: 'https://www.augmentcode.com/product/cli' },
    { name: 'Gemini CLI',        pkg: '@google/gemini-cli',              cmd: 'gemini',      logo: './agent-logos/Gemini.jpg',        website: 'https://geminicli.com/' },
    { name: 'Claude Code',       pkg: '@anthropic/claude-code',          cmd: 'claude',      nonNpm: true, logo: './agent-logos/Claude code.png', website: 'https://claude.com/product/claude-code' },
    { name: 'Zero',              pkg: '@gitlawb/zero',                   cmd: 'zero',        logo: './agent-logos/OpenClaude.png',    website: 'https://zero.gitlawb.com/' },
    { name: 'Grok',              pkg: 'grok',                            cmd: 'grok',        nonNpm: true, logo: './agent-logos/Grok.png',        website: 'https://x.ai/cli' },
    { name: 'OMP',               pkg: '@oh-my-pi/pi-coding-agent',       cmd: 'omp',         nonNpm: true, logo: './agent-logos/omp.jpg',         website: 'https://omp.sh/' },
    { name: 'Claurst',           pkg: 'claurst',                         cmd: 'claurst',     logo: './agent-logos/Caurst.png',        website: 'https://claurst.kuber.studio/' },
    { name: 'Codeep',            pkg: 'codeep',                          cmd: 'codeep',      logo: './agent-logos/Codeep.png',        website: 'https://codeep.dev/' },
    { name: 'DeepSeek Code',     pkg: '@vegamo/deepcode-cli',            cmd: 'deepcode',    logo: './agent-logos/DeepSeek Code.png', website: 'https://deepcode.vegamo.cn/' },
    { name: 'Langcli',           pkg: 'langcli-com',                     cmd: 'langcli',     logo: './agent-logos/Langcli.webp',      website: 'https://langcli.com/' },
    { name: 'Reasonix',          pkg: 'reasonix',                        cmd: 'reasonix',    logo: './agent-logos/reasonix.png',      website: 'https://reasonix.io/' },
  ]
  // Special update commands — agents not updated via npm install -g
  const AGENT_UPDATE_OVERRIDES: Record<string, { exe: string; args: string[] }> = {
    '@earendil-works/pi-coding-agent': { exe: 'pi', args: ['update'] },
    'codewhale': { exe: 'codewhale', args: ['update'] },
    '@moonshot-ai/kimi-code': { exe: 'npm', args: ['install', '-g', '@moonshot-ai/kimi-code@latest'] },
    '@anthropic/claude-code': { exe: 'claude', args: ['update'] },
    'grok': { exe: 'grok', args: ['update'] },
    '@oh-my-pi/pi-coding-agent': { exe: 'powershell.exe', args: ['-Command', 'irm https://omp.sh/install.ps1 | iex'] },
  }
  // Install commands per agent — non-npm agents use custom exe/args
  const INSTALL_OVERRIDES: Record<string, { exe: string; args: string[] }> = {
    '@earendil-works/pi-coding-agent': { exe: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] },
    '@moonshot-ai/kimi-code': { exe: 'npm', args: ['install', '-g', '--ignore-scripts', '@moonshot-ai/kimi-code'] },
    '@anthropic/claude-code': { exe: 'powershell.exe', args: ['-Command', 'irm https://claude.ai/install.ps1 | iex'] },
    'grok': { exe: 'powershell.exe', args: ['-Command', 'irm https://x.ai/cli/install.ps1 | iex'] },
    '@oh-my-pi/pi-coding-agent': { exe: 'powershell.exe', args: ['-Command', 'irm https://omp.sh/install.ps1 | iex'] },
  }
  let agentsCache: { ts: number; result: { name: string; pkg: string; cmd: string; installed: boolean; version: string | null; logo?: string }[] } | null = null
  const AGENTS_CACHE_TTL = 30000

  /** Detect non-npm agents by checking if the binary exists in PATH */
  async function detectNonNpmAgents(results: { name: string; pkg: string; cmd: string; installed: boolean; version: string | null; logo?: string }[]): Promise<void> {
    const nonNpmAgents = KNOWN_AGENTS.filter(a => a.nonNpm)
    const checks = nonNpmAgents.map(async (agent) => {
      const idx = results.findIndex(r => r.pkg === agent.pkg)
      if (idx === -1) return
      try {
        // Check if binary exists in PATH
        const whereCmd = process.platform === 'win32' ? 'where' : 'which'
        await new Promise<void>((resolve, reject) => {
          const p = spawn(whereCmd, [agent.cmd], { windowsHide: true, stdio: 'ignore' })
          p.on('close', (code) => code === 0 ? resolve() : reject(new Error('未找到')))
          p.on('error', reject)
        })
        // Binary exists, get version
        const version = await new Promise<string | null>((resolve) => {
          const isWin = process.platform === 'win32'
          const vp = spawn(isWin ? `"${agent.cmd}" --version` : agent.cmd, isWin ? [] : ['--version'], { windowsHide: true, shell: isWin })
          let out = ''
          vp.stdout?.on('data', (d: Buffer) => { out += d.toString() })
          const t = setTimeout(() => { try { vp.kill() } catch {} resolve(null) }, 5000)
          vp.on('close', () => {
            clearTimeout(t)
            const v = out.trim().match(/(\d+\.\d+\.\d+)/)
            resolve(v ? v[1] : out.trim() || null)
          })
          vp.on('error', () => { clearTimeout(t); resolve(null) })
        })
        results[idx] = { ...results[idx], installed: true, version }
      } catch {
        // not found, keep as not installed
      }
    })
    await Promise.all(checks)
  }

  let resolvedNpmCmd: string | null = null
  function findNpmCmd(): string {
    if (resolvedNpmCmd) return resolvedNpmCmd
    if (process.platform === 'win32') {
      const appDataNpm = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'npm.cmd') : ''
      if (appDataNpm && existsSync(appDataNpm)) { resolvedNpmCmd = appDataNpm; return resolvedNpmCmd }
      try {
        const lines = execSync('where npm.cmd', { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)
        const cwd = process.cwd().toLowerCase()
        for (const line of lines) {
          const p = line.trim()
          if (p && !p.toLowerCase().startsWith(cwd)) {
            resolvedNpmCmd = p
            return resolvedNpmCmd
          }
        }
      } catch {}
    }
    resolvedNpmCmd = 'npm'
    return resolvedNpmCmd
  }
  function npmGlobalEnv(): Record<string, string | undefined> {
    const npmBinDir = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : ''
    return npmBinDir
      ? { ...process.env, PATH: `${npmBinDir};${process.env.PATH || ''}` }
      : { ...process.env }
  }

  ipcMain.handle('list-global-agents', async () => {
    if (agentsCache && (Date.now() - agentsCache.ts) < AGENTS_CACHE_TTL) {
      return agentsCache.result
    }
    const result = await new Promise<{ name: string; pkg: string; cmd: string; installed: boolean; version: string | null }[]>((resolve) => {
      const npmCmd = findNpmCmd()
      const isWin = process.platform === 'win32'
      const proc = spawn(isWin ? `"${npmCmd}" list -g --depth=0 --json` : npmCmd, isWin ? [] : ['list', '-g', '--depth=0', '--json'], { windowsHide: true, shell: isWin })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      const timeout = setTimeout(() => {
        try { proc.kill() } catch {}
        console.warn('[npm list] timed out after 15s, stderr:', stderr.slice(0, 300))
        const fallback = KNOWN_AGENTS.map(a => ({ ...a, installed: false, version: null }))
        resolve(fallback)
      }, 15000)
      proc.on('close', () => {
        clearTimeout(timeout)
        if (stderr.trim()) console.warn('[npm list stderr]', stderr.trim())
        try {
          const data = JSON.parse(stdout)
          const deps = data.dependencies || {}
          const r = KNOWN_AGENTS.map(a => {
            const entry = deps[a.pkg]
            return {
              name: a.name,
              pkg: a.pkg,
              cmd: a.cmd,
              installed: !!entry,
              version: entry?.version ?? null,
              logo: a.logo,
              website: a.website
            }
          })
          resolve(r)
        } catch {
          console.warn('[npm list] JSON parse failed, stdout:', stdout.slice(0, 500))
          const fallback = KNOWN_AGENTS.map(a => ({ ...a, installed: false, version: null }))
          resolve(fallback)
        }
      })
      proc.on('error', (err) => {
        clearTimeout(timeout)
        console.warn('[npm list] spawn error:', err.message)
        const fallback = KNOWN_AGENTS.map(a => ({ ...a, installed: false, version: null }))
        resolve(fallback)
      })
    })
    // Detect non-npm agents (e.g. kimi installed via PowerShell script)
    await detectNonNpmAgents(result)
    agentsCache = { ts: Date.now(), result }
    return result
  })

  ipcMain.handle('check-agent-updates', async (_e, installed: { pkg: string; version: string }[]) => {
    const results: Record<string, { latest: string }> = {}
    // Some non-npm agents support a flag to check the latest published version.
    // `json: true` means the command emits machine-readable JSON we parse for `latestVersion`.
    const CLI_LATEST_VERSION: Record<string, { exe: string; args: string[]; json?: boolean }> = {
      'grok': { exe: 'grok', args: ['update', '--check', '--json'], json: true },
    }
    // Non-npm agents are not looked up on the npm registry.
    const nonNpmPkgs = new Set(KNOWN_AGENTS.filter(a => a.nonNpm).map(a => a.pkg))
    const npmAgents = installed.filter(a => !nonNpmPkgs.has(a.pkg))
    const checks = npmAgents.map(async (agent) => {
      try {
        // npm registry API: scoped packages use @scope%2Fname
        const encodedPkg = agent.pkg.startsWith('@')
          ? agent.pkg.replace('/', '%2F')
          : agent.pkg
        const data = await fetchJson(`https://registry.npmjs.org/${encodedPkg}/latest`) as { version?: string }
        if (data?.version && data.version !== agent.version) {
          results[agent.pkg] = { latest: data.version }
        }
      } catch {
        // silently skip failed queries
      }
    })
    await Promise.all(checks)
    // Check non-npm agents that support --latest-version
    for (const agent of installed) {
      const cliCheck = CLI_LATEST_VERSION[agent.pkg]
      if (!cliCheck) continue
      try {
        const latestVersion = await new Promise<string | null>((resolve) => {
          const isWin = process.platform === 'win32'
          const p = spawn(isWin ? `"${cliCheck.exe}" ${cliCheck.args.join(' ')}` : cliCheck.exe, isWin ? [] : cliCheck.args, { windowsHide: true, shell: isWin })
          let out = ''
          p.stdout?.on('data', (d: Buffer) => { out += d.toString() })
          const t = setTimeout(() => { try { p.kill() } catch {} resolve(null) }, 10000)
          p.on('close', () => {
            clearTimeout(t)
            if (cliCheck.json) {
              try {
                const data = JSON.parse(out)
                resolve(typeof data.latestVersion === 'string' ? data.latestVersion : null)
              } catch {
                resolve(null)
              }
            } else {
              const v = out.trim().match(/(\d+\.\d+\.\d+)/)
              resolve(v ? v[1] : null)
            }
          })
          p.on('error', () => { clearTimeout(t); resolve(null) })
        })
        if (latestVersion && latestVersion !== agent.version) {
          results[agent.pkg] = { latest: latestVersion }
        }
      } catch {
        // silently skip
      }
    }
    // Non-npm agents that publish releases on GitHub — query the latest release tag.
    // (Keeps update detection aligned with their non-npm / ps1 install channel.)
    const GITHUB_LATEST: Record<string, string> = {
      '@anthropic/claude-code': 'anthropics/claude-code',
      '@oh-my-pi/pi-coding-agent': 'can1357/oh-my-pi',
    }
    for (const agent of installed) {
      const repo = GITHUB_LATEST[agent.pkg]
      if (!repo) continue
      try {
        const data = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`) as { tag_name?: string }
        const tag = data?.tag_name
        if (tag) {
          const m = tag.match(/(\d+\.\d+\.\d+)/)
          const latest = m ? m[1] : tag.replace(/^v/, '')
          if (latest && latest !== agent.version) {
            results[agent.pkg] = { latest }
          }
        }
      } catch {
        // silently skip failed queries (e.g. rate limit)
      }
    }
    return results
  })

  ipcMain.handle('update-agent', async (_e, opts: { pkg: string }) => {
    if (!opts.pkg) return { success: false, error: '缺少包名' }
    const known = KNOWN_AGENTS.find(a => a.pkg === opts.pkg)
    if (!known) return { success: false, error: `未知 agent: ${opts.pkg}` }
    try {
      const override = AGENT_UPDATE_OVERRIDES[opts.pkg]
      let exe: string, args: string[], env: Record<string, string | undefined> | undefined
      if (override) {
        exe = override.exe
        args = override.args
        env = npmGlobalEnv()
      } else {
        exe = findNpmCmd()
        args = ['install', '-g', `${opts.pkg}@latest`]
        env = undefined
      }
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', exe, ...args], {
          detached: true, stdio: 'ignore', env: env || npmGlobalEnv()
        }).unref()
      } else if (process.platform === 'darwin') {
        const fullCmd = [exe, ...args].join(' ')
        spawn('open', ['-a', 'Terminal', '.'], { detached: true, stdio: 'ignore' }).unref()
        setTimeout(() => {
          spawn('osascript', ['-e', `tell application "Terminal" to do script "${fullCmd}" in front window`], {
            detached: true, stdio: 'ignore', env
          }).unref()
        }, 500)
      } else {
        const fullCmd = [exe, ...args].join(' ')
        const terminals = ['x-terminal-emulator', 'gnome-terminal', 'xterm']
        for (const term of terminals) {
          try {
            spawn(term, ['-e', fullCmd], { detached: true, stdio: 'ignore', env }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: '未找到终端模拟器' }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('install-agent', async (_e, opts: { pkg: string }) => {
    if (!opts.pkg) return { success: false, error: '缺少包名' }
    const known = KNOWN_AGENTS.find(a => a.pkg === opts.pkg)
    if (!known) return { success: false, error: `未知 agent: ${opts.pkg}` }
    agentsCache = null
    try {
      const override = INSTALL_OVERRIDES[opts.pkg]
      let exe: string, args: string[]
      if (override) {
        exe = override.exe
        args = override.args
      } else {
        exe = findNpmCmd()
        args = ['install', '-g', opts.pkg]
      }
      const env = npmGlobalEnv()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', exe, ...args], {
          detached: true, stdio: 'ignore', env
        }).unref()
      } else if (process.platform === 'darwin') {
        const fullCmd = [exe, ...args].join(' ')
        spawn('open', ['-a', 'Terminal', '.'], { detached: true, stdio: 'ignore' }).unref()
        setTimeout(() => {
          spawn('osascript', ['-e', `tell application "Terminal" to do script "${fullCmd}" in front window`], {
            detached: true, stdio: 'ignore', env
          }).unref()
        }, 500)
      } else {
        const fullCmd = [exe, ...args].join(' ')
        const terminals = ['x-terminal-emulator', 'gnome-terminal', 'xterm']
        for (const term of terminals) {
          try {
            spawn(term, ['-e', fullCmd], { detached: true, stdio: 'ignore', env }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: '未找到终端模拟器' }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('launch-agent', async (_e, opts: { cmd: string; cwd: string }) => {
    if (!opts.cmd || !opts.cwd) return { success: false, error: '缺少命令或目录' }
    const known = KNOWN_AGENTS.find(a => a.cmd === opts.cmd)
    if (!known) return { success: false, error: `未知的命令: ${opts.cmd}` }
    if (!existsSync(opts.cwd)) return { success: false, error: `目录未找到: ${opts.cwd}` }
    try {
      if (process.platform === 'win32') {
        // Do NOT set windowsHide: true — the new cmd window must be visible
        spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', opts.cmd], {
          cwd: opts.cwd, detached: true, stdio: 'ignore', env: npmGlobalEnv()
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', opts.cwd], {
          detached: true, stdio: 'ignore'
        }).unref()
        setTimeout(() => {
          spawn('osascript', ['-e', `tell application "Terminal" to do script "${opts.cmd}" in front window`], {
            detached: true, stdio: 'ignore'
          }).unref()
        }, 500)
      } else {
        const terminals = ['x-terminal-emulator', 'gnome-terminal', 'xterm']
        for (const term of terminals) {
          try {
            spawn(term, ['-e', opts.cmd], {
              cwd: opts.cwd, detached: true, stdio: 'ignore'
            }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: '未找到终端模拟器' }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── 终端控制台 ──
  const MAX_PTY_SESSIONS = 64
  ipcMain.handle('terminal:create', (_e, opts: { cwd?: string; cols?: number; rows?: number }) => {
    // 限制同时存在的 PTY 数量，防止失控的渲染端循环创建把主机 fork-bomb。
    if (sessions.size >= MAX_PTY_SESSIONS) {
      return { success: false, error: `PTY 数量已达上限（${MAX_PTY_SESSIONS}）` }
    }
    const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : app.getPath('home')
    try {
      const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
      const p = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as any,
      })
      // 从数据流中解析 OSC 标题变更序列（\x1b]0;title\x07 或 \x1b]2;title\x07）
      p.onData((data) => {
        const s = sessions.get(id)
        if (!s) return
        s.pendingData.push(data)
        // OSC 标题解析：累积缓冲区并匹配 \x1b][02];<title>\x07
        s.oscBuf = (s.oscBuf || '') + data
        const oscRe = /\x1b\][02];([^\x07\x1b]*)\x07/g
        let m: RegExpExecArray | null
        while ((m = oscRe.exec(s.oscBuf)) !== null) {
          const newTitle = m[1].trim()
          if (newTitle && newTitle !== s.title) {
            s.title = newTitle
            terminalSend('terminal:title', { id, title: newTitle })
          }
        }
        // 只保留末尾未完成的 OSC 序列片段（最多 256 字节）
        const lastEsc = s.oscBuf.lastIndexOf('\x1b')
        s.oscBuf = lastEsc >= 0 ? s.oscBuf.slice(lastEsc).slice(0, 256) : ''
        const totalBytes = s.pendingData.reduce((sum, d) => sum + Buffer.byteLength(d, 'utf-8'), 0)
        if (totalBytes > 1024 * 1024 && !s.paused) {
          try { s.pty.pause() } catch {}
          s.paused = true
        }
        if (!s.flushTimer) {
          s.flushTimer = setTimeout(() => flushTerminalData(id), 16)
        }
      })
      p.onExit(({ exitCode }) => {
        const s = sessions.get(id)
        if (s?.flushTimer) {
          clearTimeout(s.flushTimer)
          s.flushTimer = null
        }
        flushTerminalData(id)
        terminalSend('terminal:exited', { id, exitCode })
        sessions.delete(id)
      })
      // 监听 OSC 标题变更序列已通过 onData 解析实现
      sessions.set(id, { id, pty: p, cols, rows, cwd, shell, title: shell, pendingData: [], flushTimer: null, paused: false, oscBuf: '' })
      return { success: true, id, shell }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('terminal:input', (_e, { id, data }: { id: string; data: string }) => {
    sessions.get(id)?.pty.write(data)
  })

  ipcMain.handle('terminal:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try { sessions.get(id)?.pty.resize(cols, rows) } catch {}
  })

  ipcMain.handle('terminal:kill', (_e, { id }: { id: string }) => {
    try { sessions.get(id)?.pty.kill() } catch {}
    sessions.delete(id)
  })

  // ── 网络搜索工具 ──────────────────────────────────────────
  ipcMain.handle('web-search', async (_e, query: string): Promise<string> => {
    if (!query?.trim()) return JSON.stringify({ error: '搜索关键词不能为空' })
    try {
      const encoded = encodeURIComponent(query.trim())
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`
      const html = await fetchText(url)
      // 解析 DuckDuckGo HTML 搜索结果
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const rgLink = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      const rgSnippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
      const rgUrl = /uddg=([^&"]+)/i
      let m: RegExpExecArray | null
      while ((m = rgLink.exec(html)) !== null) {
        const rawHref = m[1]
        const title = stripHtml(m[2]).trim()
        const hrefMatch = rawHref.match(rgUrl)
        const resultUrl = hrefMatch ? decodeURIComponent(hrefMatch[1]) : rawHref
        results.push({ title, url: resultUrl, snippet: '' })
      }
      let si = 0
      while ((m = rgSnippet.exec(html)) !== null && si < results.length) {
        results[si].snippet = stripHtml(m[1]).trim()
        si++
      }
      return JSON.stringify(results.slice(0, 5))
    } catch (e: any) {
      return JSON.stringify({ error: `搜索失败: ${e?.message || e}` })
    }
  })

  ipcMain.handle('fetch-webpage', async (_e, url: string): Promise<string> => {
    if (!url?.trim()) return JSON.stringify({ error: 'URL 不能为空' })
    try {
      validateUrl(url)
      const html = await fetchText(url, 15_000)
      const text = stripHtml(html)
        .replace(/\s*\n\s*\n\s*/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
      // 截取前 8192 个字符（约 2048 token）
      const truncated = text.length > 8192 ? text.slice(0, 8192) + '\n\n…（内容已截断）' : text
      return JSON.stringify({ url, content: truncated || '（页面无文本内容）' })
    } catch (e: any) {
      return JSON.stringify({ error: `获取页面失败: ${e?.message || e}` })
    }
  })

  ipcMain.handle('print-to-pdf', async (_e, html: string): Promise<string> => {
    // 内联 KaTeX CSS，避免 CDN 加载失败
    let katexCss = ''
    try {
      const katexPkgPath = require.resolve('katex/package.json')
      const katexCssPath = join(dirname(katexPkgPath), 'dist', 'katex.min.css')
      katexCss = readFileSync(katexCssPath, 'utf-8')
    } catch { /* 找不到就跳过，公式仍可见只是缺少样式 */ }
    const finalHtml = html.replace('</head>', `<style>${katexCss}</style></head>`)

    const pdfWindow = new BrowserWindow({
      show: false,
      width: 1024, height: 768,
      webPreferences: { offscreen: false, sandbox: false }
    })
    try {
      await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`)
      const pdfBuffer = await pdfWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      })
      const chatDir = join(CHATS_DIR, 'pdf_exports')
      mkdirSync(chatDir, { recursive: true })
      const filePath = join(chatDir, `chat-${Date.now()}.pdf`)
      writeFileSync(filePath, pdfBuffer)
      return filePath
    } finally {
      if (!pdfWindow.isDestroyed()) pdfWindow.close()
    }
  })

  ipcMain.handle('save-png', async (_e, dataUrl: string): Promise<string> => {
    const chatDir = join(CHATS_DIR, 'images')
    mkdirSync(chatDir, { recursive: true })
    const matches = dataUrl.match(/^data:image\/png;base64,(.+)$/)
    if (!matches) throw new Error('无效的 PNG data URL')
    const buffer = Buffer.from(matches[1], 'base64')
    const filePath = join(chatDir, `chat-${Date.now()}.png`)
    writeFileSync(filePath, buffer)
    return filePath
  })
}

// ── 辅助函数 ──────────────────────────────────────────────
function fetchText(url: string, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' } })
    const t = setTimeout(() => { req.abort(); reject(new Error('请求超时')) }, timeout)
    req.on('response', (res) => {
      clearTimeout(t)
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.on('error', (err) => { clearTimeout(t); reject(err) })
    req.end()
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function validateUrl(url: string): void {
  if (/\\/.test(url)) throw new Error('URL 中包含反斜杠')
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('不支持的协议')
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0' ||
      parsed.hostname.startsWith('192.168.') || parsed.hostname.startsWith('10.') ||
      parsed.hostname.startsWith('172.16.')) throw new Error('不允许访问内网地址')
}

