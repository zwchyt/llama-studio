import { ipcMain, dialog, shell, BrowserWindow, net } from 'electron'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, createWriteStream, statSync, rmdirSync, renameSync, rmSync, watch, promises as fsPromises,
  createReadStream
} from 'fs'
import * as readline from 'readline'
import { join, extname, basename, dirname, resolve, sep, relative, isAbsolute } from 'path'
import { spawn, execSync, ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import iconv from 'iconv-lite'
import extractZip from 'extract-zip'
import yauzl from 'yauzl'
import http from 'http'
import { app } from 'electron'
import { randomUUID, createHash } from 'crypto'
import type * as ptyNs from 'node-pty'
import type { AgentProject, AgentMessage, AgentTask, TodoUpdate, AgentTaskStatus, EngineKind } from '../shared/types'
import { registerCodeMapIpc, disposeCodeMaps } from './services/codeMapService'
import { registerRetrievalIpc } from './services/retrievalService'
import { registerMemoryStoreIpc } from './services/memoryStore'
import { readGgufMeta } from './services/ggufReader'
import { registerKnowledgeIpc } from './services/knowledgeService'

let ptyModule: typeof ptyNs | null = null
async function getPty(): Promise<typeof ptyNs> {
  if (!ptyModule) ptyModule = await import('node-pty')
  return ptyModule
}

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

// 若目录中只有一个子目录且没有其他条目（zip 内顶层目录包裹，如 TensorSharp 发布包），
// 把该子目录的内容上移一层，保证可执行文件直接位于后端版本目录下。
// 循环执行直到不再可拍平（处理多层包裹目录），单文件失败跳过继续，已拍平部分不受影响
function flattenSingleRoot(dir: string): void {
  for (let guard = 0; guard < 16; guard++) {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    if (entries.length !== 1) return
    const only = join(dir, entries[0])
    let isDir = false
    try { isDir = statSync(only).isDirectory() } catch { return }
    if (!isDir) return
    let movedAll = true
    for (const e of readdirSync(only)) {
      try { renameSync(join(only, e), join(dir, e)) } catch { movedAll = false }
    }
    try { rmdirSync(only) } catch {}
    if (!movedAll) return
  }
}

// 在目录树内（有限深度）查找任一目标文件名，用于校验解压出的后端主程序是否齐全
function findAnyFile(dir: string, names: string[], maxDepth = 4): boolean {
  const wanted = new Set(names.map(n => n.toLowerCase()))
  const walk = (d: string, depth: number): boolean => {
    if (depth > maxDepth) return false
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { return false }
    for (const e of entries) {
      if (wanted.has(e.toLowerCase())) return true
      const p = join(d, e)
      try { if (statSync(p).isDirectory() && walk(p, depth + 1)) return true } catch { continue }
    }
    return false
  }
  return walk(dir, 0)
}

interface TerminalSession {
  id: string
  ownerKey: string | null
  pty: ptyNs.IPty
  cols: number
  rows: number
  cwd: string
  shell: string
  title: string
  pendingData: string[]
  flushTimer: NodeJS.Timeout | null
  paused: boolean
  oscBuf?: string
  replay: string
}
const sessions = new Map<string, TerminalSession>()
const sessionsByOwner = new Map<string, string>()

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
type ModelFileInfo = { name: string; path: string; size: number; folder: string; external: boolean; tts?: boolean; ocr?: boolean; sdRole?: 'model' | 'vae' | 'llm' }
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
const LLAMA_CPP_EXE_NAMES = new Set(['llama-server', 'llama-server.exe', 'main', 'main.exe', 'server', 'server.exe', 'llama-cli', 'llama-cli.exe'])
// stable-diffusion.cpp 的可执行文件（sd-server = HTTP 推理服务，sd-cli = 单次命令行生成）
const SD_CPP_EXE_NAMES = new Set(['sd-server', 'sd-server.exe', 'sd-cli', 'sd-cli.exe', 'sd-convert', 'sd-convert.exe'])
// 按可执行文件名 + 后端目录名推断后端引擎类型：
// TensorSharp.Server.exe → 'tensorsharp'；llama.cpp 分支（目录名含 turboquant / beellama）→ 对应分支；
// sd-server/sd-cli → 'sdcpp'；llama.cpp 系列 → 'llamacpp'
function detectEngineKind(exe: string | null, dirHint = ''): EngineKind {
  const n = basename(exe ?? '').toLowerCase()
  const dir = dirHint.toLowerCase()
  if (n.includes('tensorsharp')) return 'tensorsharp'
  // llama.cpp 分支的后端目录名来自发布资产（如 turboquant-plus-tqp-v… / beellama-v0.4.2-…）
  if (dir.includes('turboquant')) return 'turboquant'
  if (dir.includes('beellama')) return 'beellama'
  if (SD_CPP_EXE_NAMES.has(n) || n.startsWith('sd-')) return 'sdcpp'
  if (LLAMA_CPP_EXE_NAMES.has(n)) return 'llamacpp'
  return 'other'
}
const APP_ROOT = app.isPackaged ? join(app.getPath('userData')) : join(process.cwd())
const MODELS_DIR = join(APP_ROOT, 'models')
const TEMPLATES_DIR = join(APP_ROOT, 'templates')
const BACKEND_DIR = join(APP_ROOT, 'backend')
const CHATS_DIR = join(APP_ROOT, 'chats')
const CHAT_TEMPLATES_DIR = join(APP_ROOT, 'chat-templates')
const SETTINGS_PATH = join(APP_ROOT, 'settings.json')
for (const dir of [MODELS_DIR, TEMPLATES_DIR, BACKEND_DIR, CHATS_DIR, CHAT_TEMPLATES_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
// 参数集由用户在参数设置里手动切换（paramSet），不自动识别引擎：
// 'tensorsharp' → commands-tensorsharp.json，'turboquant' → commands-turboquant.json，
// 'beellama' → commands-beellama.json，'sdcpp' → commands-sdcpp.json，其余 → commands.json
function commandsFileName(paramSet: EngineKind): string {
  switch (paramSet) {
    case 'tensorsharp': return 'commands-tensorsharp.json'
    case 'turboquant': return 'commands-turboquant.json'
    case 'beellama': return 'commands-beellama.json'
    case 'sdcpp': return 'commands-sdcpp.json'
    default: return 'commands.json'
  }
}
function schemaResourcePaths(paramSet: EngineKind): string[] {
  const name = commandsFileName(paramSet)
  return [
    join(APP_ROOT, 'resources', name),
    ...(app.isPackaged ? [join(process.resourcesPath, 'resources', name)] : [])
  ]
}
function normalizeParamSet(paramSet: unknown): EngineKind {
  return paramSet === 'tensorsharp' || paramSet === 'turboquant' || paramSet === 'beellama' || paramSet === 'sdcpp'
    ? paramSet
    : 'llamacpp'
}
// 活跃的聊天流式请求，按 streamId 索引，支持中止
const activeChatStreams = new Map<string, http.ClientRequest>()
// 被用户主动中止的流，用于抑制 destroy 后的 error 事件
const abortedChatStreams = new Set<string>()
// 每个流的「是否正在 reasoning」状态，用于把 reasoning_content 包裹在 <think> 标签中
const chatStreamInReasoning = new Map<string, boolean>()
// 每个流累积的 tool_calls（流式传输时按 index 拼接增量片段）
const chatStreamToolCalls = new Map<string, Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }>>()
// 每个流已上报给前端的「工具名称签名」（done 之前，tool_calls 的 arguments（如 Write
// 的整份文件内容）会逐 token 到达，前端看不到任何工具信号 → 表现为“一直思考中”。
// 记录已上报的工具名签名，仅当新工具名出现时才推一次 toolCallsProgress 事件（避免逐 token 洪水）。
const chatStreamToolProgress = new Map<string, string>()
// 各端口的托管模型名缓存（/v1/models 查询结果）：llama.cpp 忽略 model 字段，但 TensorSharp
// 会严格校验 model 必须与 --model 托管的 GGUF 匹配；模型停止时由 stop-model 失效对应端口缓存。
const hostedModelCache = new Map<number, { id: string; at: number }>()
// isSafePath 函数用于防止路径遍历攻击（Path Traversal Attack），也称为目录遍历攻击。
function isSafePath(base: string, target: string): boolean {
  const rBase = resolve(base)
  const rTarget = resolve(target)
  return rTarget === rBase || rTarget.startsWith(rBase + sep)
}
// 模型工具类 handler 的模型路径校验：限制在模型目录 / 文本模型文件夹 / 图片模型文件夹内，且扩展名合法
async function isAllowedModelPath(p: string): Promise<boolean> {
  if (!p || typeof p !== 'string' || !existsSync(p)) return false
  const ext = extname(p).toLowerCase()
  if (!['.gguf', '.bin', '.ggml', '.safetensors', '.ckpt', '.pth', '.pt'].includes(ext)) return false
  const s = await loadSettings()
  const roots = [MODELS_DIR, ...s.externalModelFolders, ...s.imageModelFolders, ...s.ttsModelFolders, ...s.ocrModelFolders, ...s.sdModelFolders, ...s.sdVaeFolders, ...s.sdLlmFolders]
  return roots.some(root => isSafePath(root, p))
}
// 下面的代码实现了一个简单的命令行参数验证机制，确保只有在 commands.json 中定义的参数才会被传递给后端执行的模型运行命令。这有助于防止恶意用户通过 IPC 传递危险的参数来执行未授权的操作。
const schemaCache = new Map<string, { mtimeMs: number; allowed: Set<string>; boolean: Set<string> }>()
// 加载后端的参数白名单：先读后端目录内用户保存的专属参数文件，再回退到 resources/ 下对应参数集的文件
function loadSchemaArgs(backendPath: string, paramSet: EngineKind = 'llamacpp'): { allowed: Set<string>; boolean: Set<string> } {
  const cached = schemaCache.get(backendPath)
  // 资源白名单源文件的最终路径：用户自定义优先，否则用 resources/ 下的默认文件
  const commandsPath = join(backendPath, commandsFileName(paramSet))
  const schemaPath = existsSync(commandsPath)
    ? commandsPath
    : schemaResourcePaths(paramSet).find(p => existsSync(p))
  if (cached) {
    if (schemaPath) {
      let mtimeMs = 0
      try { mtimeMs = statSync(schemaPath).mtimeMs } catch { mtimeMs = 0 }
      if (cached.mtimeMs === mtimeMs) return cached
    } else if (cached.mtimeMs === -1) {
      return cached
    }
  }
  let schema: BackendSchema | null = null
  const tryLoad = (p: string): BackendSchema | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
      return isBackendSchema(parsed) ? parsed : null
    } catch { return null }
  }
  // 用户保存的自定义参数集按参数集分文件名（TensorSharp → commands-tensorsharp.json，llama.cpp 分支 → 各自专属文件）
  if (existsSync(commandsPath)) schema = tryLoad(commandsPath)
  if (!schema) {
    for (const p of schemaResourcePaths(paramSet)) {
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
  // 记录源文件的 mtime：文件更新后下次调用自动重新加载（否则新增参数会被旧白名单拦住）
  let mtimeMs = -1
  if (schemaPath) {
    try { mtimeMs = statSync(schemaPath).mtimeMs } catch { mtimeMs = -1 }
  }
  const result = { mtimeMs, allowed, boolean }
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
interface AppSettings { externalModelFolders: string[]; imageModelFolders: string[]; ttsModelFolders: string[]; ocrModelFolders: string[]; sdModelFolders: string[]; sdVaeFolders: string[]; sdLlmFolders: string[]; metricsPolling?: boolean; splashEnabled?: boolean; soundEnabled?: boolean;       notificationSound?: string; chatSidebarCollapsed?: boolean; agentToolCardsExpanded?: boolean; ttsEngine?: string; ttsModelPath?: string; ttsVocoderPath?: string }
const UI_KEYS = new Set(['splashEnabled', 'soundEnabled', 'notificationSound', 'chatSidebarCollapsed', 'agentToolCardsExpanded', 'ttsEngine', 'ttsModelPath', 'ttsVocoderPath'])
let settingsCache: AppSettings | null = null
async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], imageModelFolders: [], ttsModelFolders: [], ocrModelFolders: [], sdModelFolders: [], sdVaeFolders: [], sdLlmFolders: [], metricsPolling: true, splashEnabled: true, soundEnabled: true, notificationSound: 'chime', chatSidebarCollapsed: false, agentToolCardsExpanded: true }; return settingsCache }
    const data = JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      imageModelFolders: Array.isArray(data.imageModelFolders) ? data.imageModelFolders : [],
      ttsModelFolders: Array.isArray(data.ttsModelFolders) ? data.ttsModelFolders : [],
      ocrModelFolders: Array.isArray(data.ocrModelFolders) ? data.ocrModelFolders : [],
      sdModelFolders: Array.isArray(data.sdModelFolders) ? data.sdModelFolders : [],
      sdVaeFolders: Array.isArray(data.sdVaeFolders) ? data.sdVaeFolders : [],
      sdLlmFolders: Array.isArray(data.sdLlmFolders) ? data.sdLlmFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true,
      splashEnabled: data.splashEnabled !== undefined ? data.splashEnabled : true,
      soundEnabled: data.soundEnabled !== undefined ? data.soundEnabled : true,
      notificationSound: data.notificationSound !== undefined ? data.notificationSound : 'chime',
      chatSidebarCollapsed: data.chatSidebarCollapsed !== undefined ? data.chatSidebarCollapsed : false,
      agentToolCardsExpanded: data.agentToolCardsExpanded !== undefined ? data.agentToolCardsExpanded : true,
      ttsEngine: typeof data.ttsEngine === 'string' ? data.ttsEngine : 'system',
      ttsModelPath: typeof data.ttsModelPath === 'string' ? data.ttsModelPath : '',
      ttsVocoderPath: typeof data.ttsVocoderPath === 'string' ? data.ttsVocoderPath : ''
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], imageModelFolders: [], ttsModelFolders: [], ocrModelFolders: [], sdModelFolders: [], sdVaeFolders: [], sdLlmFolders: [], metricsPolling: true, splashEnabled: true, soundEnabled: true, notificationSound: 'chime', chatSidebarCollapsed: false, agentToolCardsExpanded: true }; return settingsCache }
}
async function saveSettings(s: AppSettings): Promise<void> {
  await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2))
  settingsCache = s
}
function loadSettingsSync(): AppSettings {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], imageModelFolders: [], ttsModelFolders: [], ocrModelFolders: [], sdModelFolders: [], sdVaeFolders: [], sdLlmFolders: [], metricsPolling: true, splashEnabled: true, soundEnabled: true, chatSidebarCollapsed: false, agentToolCardsExpanded: true }; return settingsCache }
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      imageModelFolders: Array.isArray(data.imageModelFolders) ? data.imageModelFolders : [],
      ttsModelFolders: Array.isArray(data.ttsModelFolders) ? data.ttsModelFolders : [],
      ocrModelFolders: Array.isArray(data.ocrModelFolders) ? data.ocrModelFolders : [],
      sdModelFolders: Array.isArray(data.sdModelFolders) ? data.sdModelFolders : [],
      sdVaeFolders: Array.isArray(data.sdVaeFolders) ? data.sdVaeFolders : [],
      sdLlmFolders: Array.isArray(data.sdLlmFolders) ? data.sdLlmFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true,
      splashEnabled: data.splashEnabled !== undefined ? data.splashEnabled : true,
      soundEnabled: data.soundEnabled !== undefined ? data.soundEnabled : true,
      notificationSound: data.notificationSound !== undefined ? data.notificationSound : 'chime',
      chatSidebarCollapsed: data.chatSidebarCollapsed !== undefined ? data.chatSidebarCollapsed : false,
      agentToolCardsExpanded: data.agentToolCardsExpanded !== undefined ? data.agentToolCardsExpanded : true,
      ttsEngine: typeof data.ttsEngine === 'string' ? data.ttsEngine : 'system',
      ttsModelPath: typeof data.ttsModelPath === 'string' ? data.ttsModelPath : '',
      ttsVocoderPath: typeof data.ttsVocoderPath === 'string' ? data.ttsVocoderPath : ''
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], imageModelFolders: [], ttsModelFolders: [], ocrModelFolders: [], sdModelFolders: [], sdVaeFolders: [], sdLlmFolders: [], metricsPolling: true, splashEnabled: true, soundEnabled: true, notificationSound: 'chime', chatSidebarCollapsed: false, agentToolCardsExpanded: true }; return settingsCache }
}
interface RunningProcess { proc: ChildProcess; port: number; kind: EngineKind }
const runningProcesses = new Map<string, RunningProcess>()
// 模型日志缓存：主进程留存每个模型的输出块，界面刷新后可拉回历史日志（每模型限量，防内存膨胀）
const MODEL_LOG_BUFFER_MAX = 1000
const modelLogBuffers = new Map<string, { stream: string; text: string }[]>()
function pushModelLog(id: string, stream: string, text: string): void {
  let buf = modelLogBuffers.get(id)
  if (!buf) { buf = []; modelLogBuffers.set(id, buf) }
  buf.push({ stream, text })
  if (buf.length > MODEL_LOG_BUFFER_MAX) buf.splice(0, buf.length - MODEL_LOG_BUFFER_MAX)
}
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
interface GitHubAsset { name: string; browser_download_url: string; size: number; digest?: string }
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
// 计算文件 sha256（用于下载后与 GitHub 发布资产的官方 digest 比对）
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(filePath)
    rs.on('data', (d) => hash.update(d))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
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

  const headers: Record<string, string> = { 'User-Agent': 'llama-studio/1.0' }
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`
  const req = net.request({ url, headers })
  currentReq = req
  file.on('error', (err) => {
    if (!destroyed) { destroyed = true; req.abort(); onError(err) }
  })
  const timeout = setTimeout(() => { if (!destroyed) { req.abort(); onError(new Error('连接超时')) } }, 120000)
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
  onProgress: (received: number, total: number, speed: number, chunks?: Array<'idle' | 'active' | 'done'>) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStatus?: (note: string) => void
): () => void {
  const USER_AGENT = 'llama-studio/1.0'
  const MIN_CHUNK = 4 * 1024 * 1024
  const MAX_CHUNKS = 12
  const CHUNK_RETRIES = 3
  // 断点续传的完整性依据：服务器 ETag 变化说明远端文件已更新，残留分片不可续
  const ETAG_FILE = destPath + '.etag'
  let destroyed = false
  let cancelled = false
  let activeCancel: Array<() => void> = []
  let fallbackCancel: (() => void) | null = null
  let probeReq: Electron.ClientRequest | null = null

  let totalBytes = 0
  let receivedBytes = startByte
  let speedBytes = 0
  let lastSpeedCheck = Date.now()
  // 最近一次 0.5s 采样窗口的平均速度；采样窗口之外上报沿用上次值，
  // 避免 UI 在「有速度 / 0」之间闪烁跳动
  let currentSpeed = 0
  // 进度上报节流：并行分片数据包里逐个上报太频繁，至少间隔 200ms 才同步一次回执
  let lastReportAt = 0
  // 分片状态（供 UI 分片可视化）：与切片数组同序，'idle' 未领取 / 'active' 下载中 / 'done' 完成
  let sliceStates: Array<'idle' | 'active' | 'done'> = []
  // 续传时断点之前的完整前缀（格子数 = 已下载的整切片数），上报时拼在 sliceStates 前面，
  // 让分片网格与进度百分比对齐（否则续传后网格会从全灰开始，与 40% 进度脱节）
  let preDoneChunks: Array<'idle' | 'active' | 'done'> = []

  const note = (msg: string) => { if (!destroyed && !cancelled) onStatus?.(msg) }

  const report = (force = false) => {
    const now = Date.now()
    const elapsed = (now - lastSpeedCheck) / 1000
    if (elapsed >= 0.5) {
      // 指数平滑，避免速度显示大幅抖动
      const s = speedBytes / elapsed
      currentSpeed = currentSpeed === 0 ? s : currentSpeed * 0.6 + s * 0.4
      speedBytes = 0
      lastSpeedCheck = now
    }
    if (!force && now - lastReportAt < 200) return
    lastReportAt = now
    onProgress(Math.min(receivedBytes, totalBytes || receivedBytes), totalBytes, currentSpeed, preDoneChunks.concat(sliceStates))
  }

  const fallback = () => {
    if (destroyed || cancelled) return
    note('服务器不支持多线程下载，已切换为单连接下载')
    // 服务器不支持 Range 时不续传：先清掉残缺文件再整包重下，
    // 避免把完整内容追加到半截文件后面导致压缩包损坏
    if (startByte > 0) {
      try { fsPromises.truncate(destPath, 0) } catch {}
      startByte = 0
    }
    fallbackCancel = startDownload(url, destPath, startByte, onProgress, onDone, onError)
  }

  const readEtag = (): string => {
    try { return readFileSync(ETAG_FILE, 'utf8').trim() } catch { return '' }
  }
  const writeEtag = (etag: string) => {
    try { if (etag) writeFileSync(ETAG_FILE, etag) } catch {}
  }
  const clearEtag = () => { try { unlinkSync(ETAG_FILE) } catch {} }

  // 探测结果统一出口：etag 续传校验 → 能力判定 → 分片或回退
  const handleProbeInfo = (acceptRanges: string, contentLength: string, etag: string) => {
    if (destroyed || cancelled) return
    const total = parseInt(contentLength || '0', 10)
    if (startByte > 0) {
      // 远端文件已更新（ETag 变了）：残留分片对不上新文件，续传只会拼出损坏包，删除重下
      const oldEtag = readEtag()
      if (oldEtag && etag && oldEtag !== etag) {
        note('远端文件已更新，重新开始下载')
        try { unlinkSync(destPath) } catch {}
        clearEtag()
        startByte = 0
      }
    } else {
      // 全新下载：清除可能残留的陈旧 etag 旁路文件
      clearEtag()
    }
    if (etag) writeEtag(etag)
    if (!total || isNaN(total) || acceptRanges !== 'bytes' || total < MIN_CHUNK * 2) return fallback()
    // startByte 是真实已下载字节数：达到 total 说明字节已全部收齐（分片按序领取写入、无空洞），
    // 文件内容完整，交给 startChunks 的空切片分支直接完成，不再删档重下
    startChunks(total)
  }

  // 探测优先用 HEAD（不拉取任何 body）；个别服务器不支持 HEAD 或 HEAD 无 content-length 时退回 GET 探测
  const probeHead = (): void => {
    if (destroyed || cancelled) return
    const req = net.request({ method: 'HEAD', url, headers: { 'User-Agent': USER_AGENT } })
    probeReq = req
    const timeout = setTimeout(() => { if (!destroyed && !cancelled) { req.abort(); onError(new Error('探测连接超时')) } }, 120000)
    req.on('response', (res) => {
      clearTimeout(timeout)
      if (destroyed || cancelled) { (res as any).destroy(); return }
      const headers = res.headers
      if (res.statusCode === 405 || res.statusCode === 501 || !headers['content-length']) {
        ;(res as any).destroy()
        probeGet()
        return
      }
      if (res.statusCode !== 200) { (res as any).destroy(); return fallback() }
      const etag = typeof headers.etag === 'string' ? headers.etag : ''
      handleProbeInfo(String(headers['accept-ranges'] || '').toLowerCase(), String(headers['content-length'] || '0'), etag)
      ;(res as any).destroy()
    })
    req.on('error', () => { clearTimeout(timeout); if (!destroyed && !cancelled) probeGet() })
    req.end()
  }

  const probeGet = (): void => {
    if (destroyed || cancelled) return
    const req = net.request({ url, headers: { 'User-Agent': USER_AGENT } })
    probeReq = req
    const timeout = setTimeout(() => { if (!destroyed && !cancelled) { req.abort(); onError(new Error('探测连接超时')) } }, 120000)
    req.on('response', (res) => {
      clearTimeout(timeout)
      if (destroyed || cancelled) { (res as any).destroy(); return }
      const etag = typeof res.headers.etag === 'string' ? res.headers.etag : ''
      handleProbeInfo(String(res.headers['accept-ranges'] || '').toLowerCase(), String(res.headers['content-length'] || '0'), etag)
      ;(res as any).destroy()
    })
    req.on('error', () => { clearTimeout(timeout); if (!destroyed && !cancelled) fallback() })
    req.end()
  }

  const startChunks = (total: number): void => {
    totalBytes = total
    // 并发上限：不超过 12 路，同时不小于 2MB/片换算出的最少路数
    const numWorkers = Math.min(MAX_CHUNKS, Math.max(2, Math.floor(total / (MIN_CHUNK * 2))))
    // 统一切片粒度 = MIN_CHUNK：完成一片的 worker 立即领取下一片（分片池），
    // 快连接不会在慢连接之后空等，尾部由空闲 worker 接管，总耗时接近带宽最优
    const sliceSize = MIN_CHUNK
    const effectiveStart = Math.min(Math.floor(startByte / sliceSize) * sliceSize, total)
    receivedBytes = effectiveStart
    const slices: Array<{ start: number; end: number }> = []
    for (let s = effectiveStart; s < total; s += sliceSize) {
      slices.push({ start: s, end: Math.min(total - 1, s + sliceSize - 1) })
    }
    sliceStates = slices.map(() => 'idle' as const)
    // 断点之前已完整下载的切片数：网格前缀显示为 done，与进度百分比对齐
    preDoneChunks = Array(Math.floor(effectiveStart / sliceSize)).fill('done' as const)
    // 磁盘空间预检：truncate 抛 ENOSPC 前先拦截，给出明确提示（statfs 不可用则跳过，由 ENOSPC 兜底）
    const checkDisk = async (need: number): Promise<void> => {
      if (need <= 0) return
      try {
        const fst = await (fsPromises as any).statfs(dirname(destPath))
        if (fst && typeof fst.bavail !== 'undefined') {
          const free = Number(fst.bavail) * Number(fst.bsize)
          if (!isNaN(free) && free < need) throw new Error('磁盘空间不足（ENOSPC）')
        }
      } catch (e) {
        if (String((e as Error)?.message).includes('磁盘空间不足')) throw e
      }
    }
    const ensureSize = async () => {
      if (existsSync(destPath)) {
        const cur = (await fsPromises.stat(destPath)).size
        if (cur > total) await fsPromises.truncate(destPath, total)
        else if (cur < total) {
          await checkDisk(total - cur)
          await fsPromises.truncate(destPath, total)
        }
      } else {
        await checkDisk(total)
        await fsPromises.writeFile(destPath, Buffer.alloc(0))
        await fsPromises.truncate(destPath, total)
      }
    }
    ensureSize().then(() => {
      if (destroyed || cancelled) return
      report()
      let doneCount = 0
      let finished = false
      let nextSlice = 0
      const onSliceDone = () => {
        if (finished || destroyed || cancelled) return
        doneCount++
        // 最后一个分片完成时强制回执一次，保证终态进度一定到达界面
        report(doneCount >= slices.length)
        if (doneCount >= slices.length) {
          finished = true
          if (receivedBytes !== totalBytes) {
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
      // 续传边界：临时文件已完整（上次下载完成但解压/替换中断），无需再合并分片，直接结束
      if (slices.length === 0) {
        receivedBytes = total
        report(true)
        onDone()
        return
      }
      const fetchSlice = (range: { start: number; end: number }, sliceIdx: number, onOk: () => void): void => {
        const rStart = range.start
        const rEnd = range.end
        const expectedBytes = rEnd - rStart + 1
        let cancelledOne = false
        let retryTimer: ReturnType<typeof setTimeout> | null = null
        let wsRef: ReturnType<typeof createWriteStream> | null = null
        // 暂停/取消时立即关闭写入流句柄，避免文件被旧句柄持有影响后续续传写入与清理
        activeCancel.push(() => {
          cancelledOne = true
          if (retryTimer) clearTimeout(retryTimer)
          try { wsRef?.destroy() } catch {}
        })
        const attempt = (retries: number) => {
          if (destroyed || cancelled || cancelledOne) return
          let reqRef: Electron.ClientRequest | null = null
          let chunkReceived = 0
          let stall: ReturnType<typeof setInterval> | null = null
          const fail = (err: Error) => {
            if (destroyed || cancelled || cancelledOne || finished) return
            if (retries > 0) {
              receivedBytes -= chunkReceived
              note('连接不稳定，正在重试分片')
              // 随机退避 0.3~1.5s：多路同时失败时避免瞬时重连风暴
              retryTimer = setTimeout(() => attempt(retries - 1), 300 + Math.random() * 1200)
              return
            }
            onChunkError(err)
          }
          const req = net.request({ url, headers: { 'User-Agent': USER_AGENT, Range: `bytes=${rStart}-${rEnd}` } })
          reqRef = req
          const timeout = setTimeout(() => { if (!destroyed && !cancelled && !cancelledOne) { req.abort(); fail(new Error('连接超时')) } }, 120000)
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
            wsRef = ws
            let paused = false
            ws.on('drain', () => { if (paused && !destroyed && !cancelled && !cancelledOne) { paused = false; (res as any).resume() } })
            let lastDataTime = Date.now()
            stall = setInterval(() => {
              if (destroyed || cancelled || cancelledOne) { if (stall) clearInterval(stall); return }
              if (Date.now() - lastDataTime > 120000) {
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
              report()
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
              ws.end(() => { if (!destroyed && !cancelled && !cancelledOne) { sliceStates[sliceIdx] = 'done'; onOk() } })
            })
            res.on('error', (err) => { if (stall) clearInterval(stall); fail(err) })
            ws.on('error', (err) => { if (stall) clearInterval(stall); fail(err) })
          })
          req.on('error', (err) => { clearTimeout(timeout); if (!destroyed && !cancelled && !cancelledOne) fail(err) })
          req.end()
        }
        attempt(CHUNK_RETRIES)
      }
      // worker 池：完成一片立即领取下一片，领不到即自然退出
      const worker = () => {
        if (destroyed || cancelled || finished) return
        const idx = nextSlice++
        if (idx >= slices.length) return
        sliceStates[idx] = 'active'
        fetchSlice(slices[idx], idx, () => { onSliceDone(); worker() })
      }
      for (let i = 0; i < numWorkers; i++) worker()
    }).catch((e) => { if (!destroyed && !cancelled) onError(e as Error) })
  }

  probeHead()
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
// 最近一次成功估算的 TTFT（ms）：ttft 仅能在 prefill 进行中的瞬时计算，
// 轮询间隔容易错过窗口，这里记住最后值供后续采集持续携带展示
let lastTtft = new Map<string, number>()
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
// NVIDIA GPU 探测缓存（会话内一次）：用于 TensorSharp 启动时自动选择 CUDA 后端
let nvidiaGpuCache: boolean | null = null
function hasNvidiaGpu(): boolean {
  if (nvidiaGpuCache !== null) return nvidiaGpuCache
  nvidiaGpuCache = false
  try {
    const smiPath = findNvidiaSmi()
    if (!smiPath) return false
    const isWin = process.platform === 'win32'
    const out = execSync(
      isWin ? `"${smiPath}" --query-gpu=name --format=csv,noheader` : `${smiPath} --query-gpu=name --format=csv,noheader`,
      { timeout: 5000, encoding: 'utf-8' }
    )
    nvidiaGpuCache = String(out).trim().length > 0
  } catch { /* nvidia-smi 不可用则视为无 NVIDIA GPU */ }
  return nvidiaGpuCache
}
let modelsCache: { ts: number; result: ModelFileInfo[] } | null = null
let modelsScanPromise: Promise<ModelFileInfo[]> | null = null
const MODELS_CACHE_TTL = 30000
const MAX_MODELS_FILES = 5000
// 退出清理钩子：registerIpcHandlers 内的后台任务表在此登记，
// 供 cleanupRunningProcesses 在应用退出时终止残留子进程
let killAllBackgroundTasks: (() => void) | null = null

export function cleanupRunningProcesses(): void {
  if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null }
  disposeCodeMaps()
  // 终止残留的后台任务子进程（dev server 等），避免退出后成为孤儿进程占用端口
  if (killAllBackgroundTasks) { try { killAllBackgroundTasks() } catch { /* ignore */ } }
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
  sessionsByOwner.clear()
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
      // 含扩散模型权重（.safetensors/.ckpt/.pth/.pt）与 llama.cpp 模型（.gguf/.bin/.ggml）
      const exts = ['.gguf', '.bin', '.ggml', '.safetensors', '.ckpt', '.pth', '.pt']
      const results: ModelFileInfo[] = []
      const seen = new Set<string>()
      const visitedDirs = new Set<string>()
      const scan = async (dir: string, external: boolean, tts = false, ocr = false, depth = 0, sdRole: 'model' | 'vae' | 'llm' | '' = ''): Promise<void> => {
        if (depth > 8 || results.length >= MAX_MODELS_FILES) return
        try {
          const realDir = await fsPromises.realpath(dir)
          if (visitedDirs.has(realDir)) return
          visitedDirs.add(realDir)
          const files = await fsPromises.readdir(dir, { withFileTypes: true })
          for (const e of files) {
            if (results.length >= MAX_MODELS_FILES) return
            if (e.isDirectory()) await scan(join(dir, e.name), external, tts, ocr, depth + 1, sdRole)
            else if (exts.includes(extname(e.name).toLowerCase()) && !e.name.endsWith('.tmp')) {
              const fp = join(dir, e.name)
              const key = resolve(fp)
              if (seen.has(key)) continue
              seen.add(key)
              const st = await fsPromises.stat(fp)
              results.push({ name: e.name, path: fp, size: st.size, folder: basename(dir), external, tts: tts || undefined, ocr: ocr || undefined, sdRole: sdRole || undefined })
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
      for (const folder of settings.ttsModelFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true, true)
      }
      for (const folder of settings.ocrModelFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true, false, true)
      }
      // stable-diffusion.cpp 图像生成的三类模型文件夹（扩散模型 / VAE / LLM 文本编码器）：
      // 统一扫入模型列表并打上 sdRole 标记，供模板模型下拉与 --vae / --llm 参数选择
      for (const folder of settings.sdModelFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true, false, false, 0, 'model')
      }
      for (const folder of settings.sdVaeFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true, false, false, 0, 'vae')
      }
      for (const folder of settings.sdLlmFolders) {
        if (results.length >= MAX_MODELS_FILES) break
        if (existsSync(folder)) await scan(folder, true, false, false, 0, 'llm')
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
  // ── 语音合成（TTS）模型文件夹 ──
  // 与文字/图片模型文件夹同设计：目录不复制文件，TTS 模型（OuteTTS / WavTokenizer 的 GGUF）
  // 归入通用模型列表，语音合成视图的模型下拉可直接选用
  ipcMain.handle('list-tts-model-folders', async () => (await loadSettings()).ttsModelFolders)
  ipcMain.handle('add-tts-model-folder', async () => {
    const r = await dialog.showOpenDialog({ title: '添加语音合成模型文件夹', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.ttsModelFolders.includes(folder)) {
      s.ttsModelFolders.push(folder)
      await saveSettings(s)
      invalidateModelsCache()
    }
    return { success: true, folders: s.ttsModelFolders }
  })
  ipcMain.handle('remove-tts-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.ttsModelFolders = s.ttsModelFolders.filter(f => f !== folder)
    await saveSettings(s)
    invalidateModelsCache()
    return { success: true, folders: s.ttsModelFolders }
  })
  // ── OCR 模型文件夹 ──
  ipcMain.handle('list-ocr-model-folders', async () => (await loadSettings()).ocrModelFolders)
  ipcMain.handle('add-ocr-model-folder', async () => {
    const r = await dialog.showOpenDialog({ title: '添加 OCR 模型文件夹', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.ocrModelFolders.includes(folder)) {
      s.ocrModelFolders.push(folder)
      await saveSettings(s)
      invalidateModelsCache()
    }
    return { success: true, folders: s.ocrModelFolders }
  })
  ipcMain.handle('remove-ocr-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.ocrModelFolders = s.ocrModelFolders.filter(f => f !== folder)
    await saveSettings(s)
    invalidateModelsCache()
    return { success: true, folders: s.ocrModelFolders }
  })
  // ── stable-diffusion.cpp 模型文件夹（图像生成三合一：扩散模型 / VAE / LLM 文本编码器）──
  // 三种角色共用一套 handler，kind 决定读写 settings 里对应的数组
  type SdFolderKind = 'model' | 'vae' | 'llm'
  const sdFolderKey = (kind: SdFolderKind): 'sdModelFolders' | 'sdVaeFolders' | 'sdLlmFolders' =>
    kind === 'model' ? 'sdModelFolders' : kind === 'vae' ? 'sdVaeFolders' : 'sdLlmFolders'
  const SD_FOLDER_TITLES: Record<SdFolderKind, string> = { model: '扩散模型', vae: 'VAE', llm: 'LLM 文本编码器' }
  ipcMain.handle('list-sd-model-folders', async (): Promise<{ model: string[]; vae: string[]; llm: string[] }> => {
    const s = await loadSettings()
    return { model: s.sdModelFolders, vae: s.sdVaeFolders, llm: s.sdLlmFolders }
  })
  ipcMain.handle('add-sd-model-folder', async (_e, kind: SdFolderKind) => {
    if (kind !== 'model' && kind !== 'vae' && kind !== 'llm') return { success: false }
    const r = await dialog.showOpenDialog({ title: `添加${SD_FOLDER_TITLES[kind]}文件夹`, properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    const key = sdFolderKey(kind)
    if (!s[key].includes(folder)) {
      s[key].push(folder)
      await saveSettings(s)
      invalidateModelsCache()
    }
    return { success: true, folders: s[key] }
  })
  ipcMain.handle('remove-sd-model-folder', async (_e, kind: SdFolderKind, folder: string) => {
    if (kind !== 'model' && kind !== 'vae' && kind !== 'llm') return { success: false }
    const s = await loadSettings()
    const key = sdFolderKey(kind)
    s[key] = s[key].filter(f => f !== folder)
    await saveSettings(s)
    invalidateModelsCache()
    return { success: true, folders: s[key] }
  })
  // ── 自定义聊天模板 (Jinja) ──
  ipcMain.handle('list-chat-templates', async () => {
    if (!existsSync(CHAT_TEMPLATES_DIR)) return []
    const files = await fsPromises.readdir(CHAT_TEMPLATES_DIR)
    const results: ModelFileInfo[] = []
    for (const f of files) {
      if (!f.endsWith('.jinja')) continue
      const fp = join(CHAT_TEMPLATES_DIR, f)
      try {
        const st = await fsPromises.stat(fp)
        results.push({ name: f, path: fp, size: st.size, folder: 'chat-templates', external: false })
      } catch { /* skip */ }
    }
    return results
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
      const allDirs = [MODELS_DIR, ...settings.externalModelFolders, ...settings.imageModelFolders, ...settings.ttsModelFolders, ...settings.ocrModelFolders]
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
    // 递归查找后端目录内的可执行文件（先按已知服务名精确匹配，再兜底取首个 .exe）
    const findExecutable = async (dir: string, depth = 0): Promise<string | null> => {
      if (depth > 10) return null
      try {
        const files = await fsPromises.readdir(dir, { withFileTypes: true })
        const names = process.platform === 'win32'
          ? ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server', 'llama-cli.exe', 'TensorSharp.Server.exe', 'sd-server.exe', 'sd-server']
          : ['llama-server', 'main', 'server', 'TensorSharp.Server', 'sd-server']
        for (const n of names) {
          const found = files.find(f => !f.isDirectory() && f.name.toLowerCase() === n)
          if (found) return found.name
        }
        if (process.platform === 'win32') {
          // 兜底：取目录内首个 .exe；跳过 createdump.exe（.NET 崩溃转储工具，非服务程序）
          const exeFiles = files.filter(f => !f.isDirectory() && f.name.toLowerCase().endsWith('.exe') && f.name.toLowerCase() !== 'createdump.exe')
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
        const basePath = join(BACKEND_DIR, d.name)
        const exe = await findExecutable(basePath)
        // llama.cpp 分支（turboquant / beellama）与 llama.cpp 同名 exe，需结合目录名识别
        const kind = detectEngineKind(exe, d.name)
        // 参数集不同，自定义参数文件名也不同：TensorSharp → commands-tensorsharp.json，
        // llama.cpp 分支 → 各自专属文件，其他 → commands.json
        const commandsPath = join(BACKEND_DIR, d.name, commandsFileName(kind))
        return {
          name: d.name,
          path: basePath,
          hasCommands: existsSync(commandsPath),
          exe,
          kind
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
  ipcMain.handle('get-commands', async (_e, backendName: string, paramSet?: EngineKind) => {
    const backendPath = join(BACKEND_DIR, backendName)
    if (!isSafePath(BACKEND_DIR, backendPath)) return null
    // 参数集由参数设置里的切换按钮决定，主进程不自动识别引擎
    const ps = normalizeParamSet(paramSet)
    const fileName = commandsFileName(ps)
    const commandsPath = join(backendPath, fileName)
    try {
      if (existsSync(commandsPath)) return JSON.parse(await fsPromises.readFile(commandsPath, 'utf-8'))
    } catch { }
    for (const defaultPath of schemaResourcePaths(ps)) {
      try {
        if (existsSync(defaultPath)) return JSON.parse(await fsPromises.readFile(defaultPath, 'utf-8'))
      } catch { }
    }
    return null
  })
  ipcMain.handle('save-backend-commands', async (_e, backendName: string, schema: unknown, paramSet?: EngineKind) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      if (!isSafePath(BACKEND_DIR, backendPath)) return { success: false, error: '访问被拒绝' }
      if (!existsSync(backendPath)) mkdirSync(backendPath, { recursive: true })
      // 保存到对应参数集的文件（TensorSharp → commands-tensorsharp.json，llama.cpp 分支 → 各自专属文件）
      const ps = normalizeParamSet(paramSet)
      const fileName = commandsFileName(ps)
      writeFileSync(join(backendPath, fileName), JSON.stringify(schema, null, 2))
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
  // ── 模板文件以模型卡片名称为文件名（重名自动加序号；重命名时同步改文件名）──
  // 模板内容里的 id 仍是唯一主键，文件名只用于直观展示/管理
  function sanitizeTemplateFilename(name: string): string {
    let s = String(name ?? '').trim().replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    s = s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
    return /^\.\.?$/.test(s) ? '' : s
  }
  // 找到 id 对应的模板文件（读 JSON 内容里的 id，文件名已不再等于 id）
  function templateFileForId(id: string): string | null {
    if (!existsSync(TEMPLATES_DIR)) return null
    for (const f of readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8'))
        if (String(data.id) === String(id)) return f
      } catch { /* skip unreadable */ }
    }
    return null
  }
  // 生成不与现有模板文件冲突的文件名：desired 被占用时追加 " (n)"
  // existingFile 是同 id 当前文件名，需排除（否则未改名也会被当作占用）
  function uniqueTemplateFilename(desired: string, existingFile: string | null): string {
    const base = desired || randomUUID()
    const taken = new Set(readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')))
    if (existingFile) taken.delete(existingFile)
    if (!taken.has(`${base}.json`)) return base
    let i = 1
    while (taken.has(`${base} (${i}).json`)) i++
    return `${base} (${i})`
  }
  ipcMain.handle('save-template', async (_e, template: Record<string, unknown>) => {
    try {
      const id = (template.id as string) || randomUUID()
      const content = { ...template, id }
      const desired = sanitizeTemplateFilename(template.name as string) || id
      const existingFile = templateFileForId(id)
      const fileName = uniqueTemplateFilename(desired, existingFile)
      // 若文件名随模型名变化，先删旧文件再写新文件（同一 id 的旧文件改名）
      if (existingFile && existingFile !== `${fileName}.json`) {
        try { unlinkSync(join(TEMPLATES_DIR, existingFile)) } catch { }
      }
      writeFileSync(join(TEMPLATES_DIR, `${fileName}.json`), JSON.stringify(content, null, 2))
      return { success: true, id, _file: `${fileName}.json` }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('delete-template', (_e, id: string) => {
    const fileName = templateFileForId(String(id))
    if (!fileName) return { success: true }
    const fp = join(TEMPLATES_DIR, fileName)
    if (!isSafePath(TEMPLATES_DIR, fp)) return { success: false, error: '访问被拒绝' }
    try { unlinkSync(fp) } catch { }
    return { success: true }
  })
  // ── 原生聊天会话 CRUD（与 templates 同模式） ──
  // 聊天图片附件存储：原图独立落盘，会话 JSON 仅存引用（chatimg://<文件名>）。
  // 若内嵌数 MB base64，流式期间每 3s 节流落盘的 JSON.stringify + 同步写盘会
  // 阻塞主进程（SSE 转发也在主进程），导致 token 输出周期性卡顿。
  const CHAT_IMAGES_DIR = join(CHATS_DIR, 'images')
  const CHATIMG_PREFIX = 'chatimg://'
  const IMG_MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }
  const IMG_EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' }
  function saveChatImageFromDataUrl(dataUrl: string): string | null {
    if (!dataUrl.startsWith('data:')) return null
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    const meta = dataUrl.slice(5, comma) // 如 image/png;base64
    if (!meta.includes('base64')) return null
    const mime = meta.split(';')[0] || 'image/png'
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    if (buf.length === 0) return null
    // 内容哈希作文件名：同图自动去重，重复落盘直接跳过
    const hash = createHash('sha1').update(buf).digest('hex')
    const name = `${hash}.${IMG_MIME_EXT[mime] || 'bin'}`
    if (!existsSync(CHAT_IMAGES_DIR)) mkdirSync(CHAT_IMAGES_DIR, { recursive: true })
    const fp = join(CHAT_IMAGES_DIR, name)
    if (!existsSync(fp)) writeFileSync(fp, buf)
    return CHATIMG_PREFIX + name
  }
  ipcMain.handle('save-chat-image', (_e, dataUrl: string): { ok: boolean; ref?: string; error?: string } => {
    try {
      if (typeof dataUrl !== 'string' || dataUrl.length > 64 * 1024 * 1024) return { ok: false, error: '无效图片数据' }
      const ref = saveChatImageFromDataUrl(dataUrl)
      return ref ? { ok: true, ref } : { ok: false, error: '无效的 dataUrl' }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('read-chat-image', async (_e, ref: string): Promise<string | null> => {
    try {
      if (typeof ref !== 'string' || !ref.startsWith(CHATIMG_PREFIX)) return null
      const name = ref.slice(CHATIMG_PREFIX.length)
      if (/[\\/]/.test(name) || name.includes('..')) return null
      const fp = join(CHAT_IMAGES_DIR, name)
      if (!isSafePath(CHAT_IMAGES_DIR, fp) || !existsSync(fp)) return null
      const buf = await fsPromises.readFile(fp)
      const mime = IMG_EXT_MIME[extname(name).slice(1).toLowerCase()] || 'application/octet-stream'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { return null }
  })
  // ── 图像生成页：自动保存 + 历史持久化 ──
  // 生成图以「带参数的描述性文件名」落到 CHAT_IMAGES_DIR；历史清单存 JSON（仅存文件名与元信息，
  // 不内嵌 base64，避免文件巨大）。图片读取按需从磁盘回读成 dataUrl。
  const SD_HISTORY_FILE = join(CHATS_DIR, 'imagegen-history.json')
  // 标准 PNG 文本元数据：把生成参数/提示词写入 PNG 底层的 tEXt 块（看图工具可读，不影响文件名）
  const SD_CRC_TABLE: number[] = (() => {
    const t = new Array(256).fill(0)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  function sdCrc32(buf: Buffer): number {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = SD_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  function sdPngWithMeta(raw: Buffer, fields: Record<string, string>): Buffer {
    const endMarker = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]) // 0长度 + "IEND"
    const endIdx = raw.indexOf(endMarker)
    if (endIdx < 0) return raw
    const chunks: Buffer[] = []
    for (const [key, val] of Object.entries(fields)) {
      if (!val || !key) continue
      const keyword = Buffer.from(key)
      const text = Buffer.from(val)
      if (keyword.length === 0 || keyword.length > 79 || keyword.length + 1 + text.length > 8192) continue
      const data = Buffer.concat([keyword, Buffer.from([0]), text])
      const type = Buffer.from('tEXt')
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      const crcBuf = Buffer.alloc(4)
      crcBuf.writeUInt32BE(sdCrc32(Buffer.concat([type, data])))
      chunks.push(len, type, data, crcBuf)
    }
    if (chunks.length === 0) return raw
    return Buffer.concat([raw.subarray(0, endIdx), ...chunks, raw.subarray(endIdx)])
  }
  ipcMain.handle('save-images', (_e, opts: { images: string[]; mode?: string; seed?: number; steps?: number; cfg?: number; width?: number; height?: number; prompt?: string; negativePrompt?: string; sampler?: string; scheduler?: string; model?: string }): Promise<{ ok: boolean; files?: string[]; error?: string }> => {
    try {
      if (!opts || !Array.isArray(opts.images) || opts.images.length === 0) return Promise.resolve({ ok: false, error: '无图片数据' })
      if (!existsSync(CHAT_IMAGES_DIR)) mkdirSync(CHAT_IMAGES_DIR, { recursive: true })
      const files = opts.images.map((dataUrl, i) => {
        const comma = String(dataUrl || '').indexOf(',')
        const b64 = comma >= 0 ? String(dataUrl).slice(comma + 1) : String(dataUrl)
        const buf = Buffer.from(b64, 'base64')

        // 写入 PNG 底层元数据（tEXt 块）：完整提示词、负向提示词、实际 seed 与生成参数
        const meta: Record<string, string> = {
          prompt: opts.prompt || '',
          'negative_prompt': opts.negativePrompt || '',
          'seed': opts.seed !== undefined ? String(opts.seed) : '',
          'steps': opts.steps !== undefined ? String(opts.steps) : '',
          'cfg_scale': opts.cfg !== undefined ? String(opts.cfg) : '',
          'sampler_name': opts.sampler || '',
          'scheduler': opts.scheduler || '',
          'width': opts.width !== undefined ? String(opts.width) : '',
          'height': opts.height !== undefined ? String(opts.height) : '',
          'model': opts.model || ''
        }
        const png = sdPngWithMeta(buf, meta)
        if (buf.length === 0) throw new Error('无效图片数据')
        const parts = [
          `sd`,
          opts.mode === 'img2img' ? 'img2img' : 'txt2img'
        ]
        if (typeof opts.seed === 'number') parts.push(`s${opts.seed}`)
        if (typeof opts.steps === 'number') parts.push(`steps${opts.steps}`)
        if (typeof opts.cfg === 'number') parts.push(`cfg${opts.cfg}`)
        if (typeof opts.width === 'number' && typeof opts.height === 'number') parts.push(`${opts.width}x${opts.height}`)
        parts.push(`${Date.now()}_${i}`)
        const name = `${parts.join('_')}.png`
        const fp = join(CHAT_IMAGES_DIR, name)
        if (!existsSync(fp)) writeFileSync(fp, png)
        return name
      })
      return Promise.resolve({ ok: true, files })
    } catch (err) { return Promise.resolve({ ok: false, error: String(err) }) }
  })
  ipcMain.handle('read-imagegen-image', async (_e, name: string): Promise<string | null> => {
    try {
      if (typeof name !== 'string' || !name) return null
      if (/[\\/]/.test(name) || name.includes('..')) return null
      const fp = join(CHAT_IMAGES_DIR, name)
      if (!isSafePath(CHAT_IMAGES_DIR, fp) || !existsSync(fp)) return null
      const buf = await fsPromises.readFile(fp)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch { return null }
  })
  ipcMain.handle('load-imagegen-history', (): unknown[] => {
    try {
      if (!existsSync(SD_HISTORY_FILE)) return []
      const raw = JSON.parse(readFileSync(SD_HISTORY_FILE, 'utf-8'))
      return Array.isArray(raw) ? raw : []
    } catch { return [] }
  })
  ipcMain.handle('save-imagegen-history', (_e, items: unknown[]): boolean => {
    try {
      if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true })
      writeFileSync(SD_HISTORY_FILE, JSON.stringify(Array.isArray(items) ? items : [], null, 2), 'utf-8')
      return true
    } catch { return false }
  })
  ipcMain.handle('delete-imagegen-images', (_e, names: string[]): boolean => {
    try {
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name.includes('..')) continue
        const fp = join(CHAT_IMAGES_DIR, name.trim())
        if (isSafePath(CHAT_IMAGES_DIR, fp) && existsSync(fp)) { try { unlinkSync(fp) } catch { /* ignore */ } }
      }
      return true
    } catch { return false }
  })

  // ── 提示词预设（resources/ 下的 JSON 文件，正向/反向各一份，用户可直接编辑）──
  // 结构与 commands.json 一致：dev 指向项目 resources/ 目录，打包后回退到 process.resourcesPath
  interface ImagePresetItem { id: string; tag: string; cn: string; group: string }
  interface ImagePresetGroupJson { name?: unknown; presets?: unknown }
  function imagePresetFileName(slot: 'pos' | 'neg'): string {
    return slot === 'pos' ? 'imagegen-presets-pos.json' : 'imagegen-presets-neg.json'
  }
  function imagePresetResourcePaths(slot: 'pos' | 'neg'): string[] {
    const name = imagePresetFileName(slot)
    return [
      join(APP_ROOT, 'resources', name),
      ...(app.isPackaged ? [join(process.resourcesPath, 'resources', name)] : [])
    ]
  }
  function readImagePresets(slot: 'pos' | 'neg'): ImagePresetItem[] {
    for (const p of imagePresetResourcePaths(slot)) {
      try {
        if (!existsSync(p)) continue
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
        if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { groups?: unknown }).groups)) continue
        const items: ImagePresetItem[] = []
        ;(parsed as { groups: ImagePresetGroupJson[] }).groups.forEach((g, gi) => {
          const group = typeof g?.name === 'string' && g.name ? g.name : '其他'
          if (!Array.isArray(g?.presets)) return
          g.presets.forEach((pr, pi) => {
            const o = (pr && typeof pr === 'object' ? pr : {}) as Record<string, unknown>
            items.push({
              id: `preset-${gi}-${pi}`,
              tag: String(o.tag ?? o.prompt ?? ''),
              cn: String(o.cn ?? ''),
              group
            })
          })
        })
        if (items.length > 0) return items
      } catch { /* 继续尝试下一个候选路径 */ }
    }
    return []
  }
  function writeImagePresets(slot: 'pos' | 'neg', items: ImagePresetItem[]): boolean {
    try {
      const target = join(APP_ROOT, 'resources', imagePresetFileName(slot))
      mkdirSync(join(APP_ROOT, 'resources'), { recursive: true })
      const map: Record<string, { tag: string; cn: string }[]> = {}
      items.forEach(it => {
        const group = it.group && it.group.trim() ? it.group : '其他'
        ;(map[group] ??= []).push({ tag: it.tag, cn: it.cn })
      })
      const groups = Object.keys(map).map(g => ({ name: g, presets: map[g] }))
      writeFileSync(target, JSON.stringify({ groups }, null, 2), 'utf-8')
      return true
    } catch { return false }
  }
  ipcMain.handle('load-imagegen-presets', (): { pos: ImagePresetItem[]; neg: ImagePresetItem[] } => ({
    pos: readImagePresets('pos'),
    neg: readImagePresets('neg')
  }))
  ipcMain.handle('save-imagegen-presets', (_e, data: { pos?: ImagePresetItem[]; neg?: ImagePresetItem[] }): boolean => {
    let ok = true
    if (data?.pos) ok = writeImagePresets('pos', data.pos) && ok
    if (data?.neg) ok = writeImagePresets('neg', data.neg) && ok
    return ok
  })
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
      // 兼容旧数据：附件内嵌的原图（data:）转独立文件引用，保持会话 JSON 小体积
      const msgs = session.messages
      if (Array.isArray(msgs)) {
        for (const m of msgs as Array<Record<string, unknown>>) {
          const atts = m?.attachments
          if (!Array.isArray(atts)) continue
          for (const a of atts as Array<Record<string, unknown>>) {
            if (a && a.type === 'image' && typeof a.fullDataUrl === 'string' && a.fullDataUrl.startsWith('data:')) {
              try { const ref = saveChatImageFromDataUrl(a.fullDataUrl); if (ref) a.fullDataUrl = ref } catch { /* 转换失败保留内嵌 */ }
            }
          }
        }
      }
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
      const desired = sanitizeTemplateFilename(data.name as string) || id
      const fileName = uniqueTemplateFilename(desired, null)
      writeFileSync(join(TEMPLATES_DIR, `${fileName}.json`), JSON.stringify(data, null, 2))
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
  ipcMain.handle('get-model-logs', (_e, id: string) => modelLogBuffers.get(String(id)) ?? [])
  ipcMain.handle('run-model', (_e, opts: { id: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number; paramSet?: EngineKind; kind?: EngineKind }) => {
    if (runningProcesses.has(opts.id)) return { success: false, error: '已在运行中' }
    const exePath = join(opts.backendPath, opts.exe)
    if (!isSafePath(BACKEND_DIR, exePath)) return { success: false, error: '访问被拒绝' }
    if (!existsSync(exePath)) return { success: false, error: `可执行文件未找到: ${exePath}` }
    try {
      // 参数白名单按参数集加载（参数设置里的切换按钮决定，TensorSharp → commands-tensorsharp.json），
      // 文件本身只含对应参数，无需再按引擎二次过滤
      const paramSet = normalizeParamSet(opts.paramSet)
      const { allowed, boolean } = loadSchemaArgs(opts.backendPath, paramSet)
      const safeArgs = validateArgs(opts.args, allowed, boolean)
      // TensorSharp 引擎（按实际可执行文件判断，与参数集无关）官方默认后端为 ggml_cpu（不自动探测 GPU）；
      // 本机存在 NVIDIA GPU 且用户未显式指定 --backend 时，自动注入 ggml_cuda
      const kind = opts.kind ?? detectEngineKind(opts.exe, opts.backendPath)
      if (kind === 'tensorsharp' && !safeArgs.includes('--backend') && hasNvidiaGpu()) {
        safeArgs.push('--backend', 'ggml_cuda')
      }
      // 模型监控面板的速度数据（decode tok/s、prefill tok/s 等）依赖 llama.cpp 的 /metrics 端点；
      // 该端点需 --metrics 启动参数才启用。模板参数默认未开启，这里对 llama.cpp 系列引擎强制注入，
      // 保证存量模板无需手动改动即可恢复监控数据（TensorSharp / stable-diffusion.cpp 无此参数，跳过）
      if (kind !== 'tensorsharp' && kind !== 'sdcpp' && !safeArgs.includes('--metrics')) {
        safeArgs.push('--metrics')
      }
      const proc = spawn(exePath, safeArgs, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      modelLogBuffers.delete(opts.id) // 新一轮启动：丢弃上一轮的日志缓存
      let prefillResetTimer: ReturnType<typeof setTimeout> | null = null
      let stderrBuf = ''
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      proc.stderr?.on('data', (d) => {
        const text = d.toString()
        console.error('[llama-server]', text)
        pushModelLog(opts.id, 'stderr', text)
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
          // 从 llama-server 日志解析真实的 prompt eval time（即 TTFT，prefill 完成瞬间打印）
          const ttftM = line.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*\d+\s*tokens/)
          if (ttftM) {
            const ttftMs = Math.round(parseFloat(ttftM[1]))
            if (!isNaN(ttftMs) && ttftMs > 0) {
              lastTtft.set(opts.id, ttftMs)
              BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed()) win.webContents.send('metrics-update', { id: opts.id, ttftMs, lastUpdated: Date.now() })
              })
              continue
            }
          }
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
          // 监听就绪：llama_server: listening on http://127.0.0.1:8080 / ASP.NET: Now listening on: http://127.0.0.1:5000
          const readyMatch = line.match(/listening on:?\s+(https?:\/\/\S+)/i)
          if (readyMatch) {
            BrowserWindow.getAllWindows().forEach(win => {
              if (!win.isDestroyed()) win.webContents.send('model-ready', { id: opts.id, url: readyMatch[1] })
            })
          }
        }
      })
      proc.stdout?.on('data', (d) => {
        const text = d.toString()
        console.log('[llama-server]', text)
        pushModelLog(opts.id, 'stdout', text)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('model-log', { id: opts.id, stream: 'stdout', text })
        })
        for (const raw of text.trim().split('\n')) {
          const line = raw.trim()
          if (!line) continue
          // 监听就绪：llama_server: listening on http://127.0.0.1:8080 / ASP.NET: Now listening on: http://127.0.0.1:5000
          const readyMatch = line.match(/listening on:?\s+(https?:\/\/\S+)/i)
          if (readyMatch) {
            BrowserWindow.getAllWindows().forEach(win => {
              if (!win.isDestroyed()) win.webContents.send('model-ready', { id: opts.id, url: readyMatch[1] })
            })
          }
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
      runningProcesses.set(opts.id, { proc, port: opts.port, kind })
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

  function openChatWindow(port: number, kind: EngineKind = 'llamacpp') {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return
    // TensorSharp 的网页聊天 UI 在 /html（根路径返回 JSON 状态），llama.cpp 在根路径
    const chatUrl = kind === 'tensorsharp' ? `http://127.0.0.1:${port}/html` : `http://127.0.0.1:${port}`
    const candidates = [
      join(process.cwd(), 'assets', 'llama-studio-icon.png'),
      join(__dirname, '../../assets/llama-studio-icon.png'),
      join(app.getAppPath(), 'assets', 'llama-studio-icon.png'),
      // 打包后 assets 不在应用目录内，图标通过 extraResources 随安装包分发
      join(process.resourcesPath, 'assets', 'llama-studio-icon.png')
    ]
    const icon = candidates.find(existsSync)

    const chatWin = new BrowserWindow({
      width: 1024, height: 768, show: true, autoHideMenuBar: true,
      title: 'llama-studio - Llama-UI',
      backgroundColor: '#ffffff',
      ...(icon ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--window-mode=chat'],
        // 打包版彻底禁用 DevTools，与主窗口策略一致
        devTools: !app.isPackaged
      }
    })
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      chatWin.loadURL(`${rendererUrl}?chat_url=${encodeURIComponent(chatUrl)}`)
    } else {
      chatWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { chat_url: chatUrl } })
    }
  }

  ipcMain.handle('open-chat-window', (_e, port: number, kind?: EngineKind) => {
    openChatWindow(port, kind)
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
      lastTtft.delete(id)
      if (runningProcesses.size === 0) stopMetricsInterval()
      const tasks: Promise<unknown>[] = [killProcessTreeAsync(entry.proc)]
      if (entry.port) { tasks.push(killByPortAsync(entry.port)); hostedModelCache.delete(entry.port) }
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
    if (port) hostedModelCache.delete(port)
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

  // ── 模型工具（GGUF 检查器 / Token 可视化 / 显存计算器）与本地 TTS ──
  // 通用：校验后端目录内的二进制路径（沿用 run-benchmark 的 isSafePath 模式）
  const resolveBackendExe = (backendPath: string, exe: string): { path?: string; error?: string } => {
    const exePath = join(backendPath, exe)
    if (!isSafePath(BACKEND_DIR, exePath)) return { error: '访问被拒绝' }
    if (!existsSync(exePath)) return { error: `可执行文件未找到: ${exe}（当前后端版本可能未包含该工具）` }
    return { path: exePath }
  }
  // 通用：spawn 二进制并收集全部输出（带超时杀进程），供 tokenize / fit-params 这类一次性工具调用
  const runToolProcess = (exePath: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> => {
    return new Promise((resolveRun) => {
      let stdout = '', stderr = '', timedOut = false
      const proc = spawn(exePath, args, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: true })
      const timer = setTimeout(() => { timedOut = true; killProcessTreeAsync(proc) }, timeoutMs)
      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => { if (stderr.length < 256 * 1024) stderr += d.toString() })
      proc.on('error', (err) => { clearTimeout(timer); resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut }) })
      proc.on('exit', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }) })
    })
  }

  ipcMain.handle('read-gguf-meta', async (_e, path: string) => {
    try {
      if (!(await isAllowedModelPath(path))) return { error: '访问被拒绝或文件不存在' }
      return await readGgufMeta(path)
    } catch (err) {
      console.warn('[read-gguf-meta] failed:', path, err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('tokenize-text', async (_e, opts: { port?: number; backendPath?: string; modelPath?: string; text: string }) => {
    const text = typeof opts.text === 'string' ? opts.text : ''
    if (!text) return { success: true, tokens: [] }
    // 模式一：运行中的 llama-server，POST /tokenize（带 piece）
    if (opts.port) {
      if (text.length > 100000) return { success: false, error: '文本过长（上限 100000 字符）', tokens: [] }
      try {
        const result = await new Promise<{ tokens: unknown[] }>((resolveReq, rejectReq) => {
          const body = JSON.stringify({ content: text, with_pieces: true })
          const req = http.request({
            hostname: '127.0.0.1', port: opts.port, path: '/tokenize', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            agent: httpAgent, timeout: 30000
          }, (res) => {
            let data = ''
            res.on('data', (c) => { data += c })
            res.on('end', () => {
              try {
                if (res.statusCode !== 200) return rejectReq(new Error(`HTTP ${res.statusCode}`))
                resolveReq(JSON.parse(data))
              } catch (e) { rejectReq(e) }
            })
          })
          req.on('timeout', () => { req.destroy(new Error('请求超时')) })
          req.on('error', rejectReq)
          req.write(body); req.end()
        })
        const tokens = (Array.isArray(result.tokens) ? result.tokens : []).map((t) => {
          if (typeof t === 'number') return { id: t, piece: '' }
          const obj = t as { id?: number; piece?: unknown }
          // piece 在非法 UTF-8 时会以字节数组形式返回
          const piece = typeof obj.piece === 'string' ? obj.piece
            : Array.isArray(obj.piece) ? Buffer.from(obj.piece as number[]).toString('utf-8') : ''
          return { id: obj.id ?? 0, piece }
        })
        return { success: true, tokens }
      } catch (err) {
        return { success: false, error: `调用 /tokenize 失败: ${err instanceof Error ? err.message : String(err)}`, tokens: [] }
      }
    }
    // 模式二：spawn llama-tokenize（仅加载词表）
    if (!opts.backendPath || !opts.modelPath) return { success: false, error: '缺少后端或模型路径', tokens: [] }
    if (text.length > 8000) return { success: false, error: '二进制模式文本上限 8000 字符，请改用运行中模型', tokens: [] }
    if (!(await isAllowedModelPath(opts.modelPath))) return { success: false, error: '模型路径访问被拒绝', tokens: [] }
    const exe = resolveBackendExe(opts.backendPath, 'llama-tokenize.exe')
    if (!exe.path) return { success: false, error: exe.error, tokens: [] }
    const run = await runToolProcess(exe.path, ['-m', opts.modelPath, '-p', text], 120000)
    if (run.timedOut) return { success: false, error: '分词超时', tokens: [] }
    if (run.code !== 0) return { success: false, error: `llama-tokenize 退出码 ${run.code}: ${run.stderr.slice(-500)}`, tokens: [] }
    // 输出行格式：`123456 -> 'piece'`；piece 可能含换行，用前瞻下一条记录的惰性匹配跨行提取
    const tokens: { id: number; piece: string }[] = []
    const re = /^\s*(\d+) -> '([\s\S]*?)'\r?\n(?=\s*\d+ -> '|\s*$)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(run.stdout)) !== null) tokens.push({ id: parseInt(m[1], 10), piece: m[2] })
    return { success: true, tokens }
  })

  ipcMain.handle('fit-params', async (_e, opts: { backendPath: string; modelPath: string; ctxSize?: number }) => {
    if (!(await isAllowedModelPath(opts.modelPath))) return { success: false, error: '模型路径访问被拒绝' }
    const exe = resolveBackendExe(opts.backendPath, 'llama-fit-params.exe')
    if (!exe.path) return { success: false, error: exe.error }
    const args = ['-m', opts.modelPath]
    if (opts.ctxSize && opts.ctxSize > 0) args.push('-c', String(Math.floor(opts.ctxSize)))
    const run = await runToolProcess(exe.path, args, 120000)
    if (run.timedOut) return { success: false, error: '参数拟合超时' }
    if (run.code !== 0) return { success: false, error: `llama-fit-params 退出码 ${run.code}: ${run.stderr.slice(-500)}`, log: run.stderr }
    // stdout 末行即拟合参数（如 "-c 72448 -ngl -1"）
    const lines = run.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const fitted = [...lines].reverse().find(l => l.startsWith('-')) || ''
    const ctxMatch = fitted.match(/(?:^|\s)-c\s+(\d+)/)
    const nglMatch = fitted.match(/(?:^|\s)-ngl\s+(-?\d+)/)
    // GPU 显存信息复用监控链路的 nvidia-smi 缓存（失败时为 null，前端隐藏 GPU 卡片）
    await refreshGpuData()
    const gpus = cachedGpuData && cachedGpuData.memoryTotal !== null
      ? [{ name: cachedGpuData.name, totalMiB: cachedGpuData.memoryTotal, usedMiB: cachedGpuData.memoryUsed ?? 0 }]
      : null
    return {
      success: true,
      fittedArgs: fitted || undefined,
      ctxSize: ctxMatch ? parseInt(ctxMatch[1], 10) : undefined,
      gpuLayers: nglMatch ? parseInt(nglMatch[1], 10) : undefined,
      log: run.stderr,
      gpus
    }
  })

  // 显存计算器：轻量返回 GPU 显存（复用 nvidia-smi 缓存；非 N 卡/无缓存时返回 null）
  ipcMain.handle('get-gpu-vram', async (): Promise<{ name: string; totalMiB: number; usedMiB: number } | null> => {
    await refreshGpuData()
    if (!cachedGpuData || cachedGpuData.memoryTotal === null) return null
    return { name: cachedGpuData.name, totalMiB: cachedGpuData.memoryTotal, usedMiB: cachedGpuData.memoryUsed ?? 0 }
  })

  // Chat 模板分析：模板文本写临时 jinja → llama-template-analysis.exe --template-file → 返回原始报告（解析在渲染层）
  ipcMain.handle('analyze-template', async (_e, opts: { backendPath: string; template: string }) => {
    const template = String(opts.template ?? '')
    if (!template.trim()) return { success: false, error: '模板内容为空' }
    if (template.length > 256 * 1024) return { success: false, error: '模板过大（上限 256KB）' }
    const exe = resolveBackendExe(opts.backendPath, 'llama-template-analysis.exe')
    if (!exe.path) return { success: false, error: exe.error }
    const tplPath = join(tmpdir(), `llama-studio-tpl-${randomUUID()}.jinja`)
    try {
      writeFileSync(tplPath, template, 'utf-8')
      const run = await runToolProcess(exe.path, ['--template-file', tplPath], 60000)
      if (run.timedOut) return { success: false, error: '模板分析超时' }
      // 注意：该工具把报告写到 stderr 且带 ANSI 颜色码（实测），合并两路输出并剥离后再判断
      const report = (run.stdout + run.stderr).replace(/\u001b\[[0-9;]*m/g, '').trim()
      if (run.code !== 0 && !report.includes('ANALYSIS COMPLETE')) {
        return { success: false, error: `llama-template-analysis 退出码 ${run.code}: ${report.slice(-500)}` }
      }
      return { success: true, report }
    } catch (err) {
      return { success: false, error: String(err) }
    } finally {
      try { unlinkSync(tplPath) } catch { /* ignore */ }
    }
  })

  // ── 本地 TTS（llama-tts.exe 生成 wav，返回 base64 供渲染层播放）──
  const runningTts = new Map<string, ChildProcess>()
  ipcMain.handle('tts-generate', async (_e, opts: { id: string; backendPath: string; modelPath: string; vocoderPath: string; text: string }) => {
    if (runningTts.has(opts.id)) return { success: false, error: '该朗读任务已在进行中' }
    if (!(await isAllowedModelPath(opts.modelPath)) || !(await isAllowedModelPath(opts.vocoderPath))) {
      return { success: false, error: 'TTS 模型路径访问被拒绝，请在设置中重新选择' }
    }
    const exe = resolveBackendExe(opts.backendPath, 'llama-tts.exe')
    if (!exe.path) return { success: false, error: exe.error }
    const text = String(opts.text ?? '').slice(0, 500)
    if (!text.trim()) return { success: false, error: '朗读文本为空' }
    const outPath = join(tmpdir(), `llama-studio-tts-${randomUUID()}.wav`)
    const args = ['-m', opts.modelPath, '-mv', opts.vocoderPath, '-p', text, '-o', outPath]
    try {
      const result = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolveRun) => {
        let stderr = '', timedOut = false
        const proc = spawn(exe.path!, args, { detached: false, stdio: 'pipe', cwd: dirname(exe.path!), windowsHide: true })
        runningTts.set(opts.id, proc)
        const timer = setTimeout(() => { timedOut = true; killProcessTreeAsync(proc) }, 180000)
        proc.stderr?.on('data', (d) => { if (stderr.length < 128 * 1024) stderr += d.toString() })
        proc.on('error', (err) => { clearTimeout(timer); runningTts.delete(opts.id); resolveRun({ code: null, stderr: stderr + String(err), timedOut }) })
        proc.on('exit', (code) => { clearTimeout(timer); runningTts.delete(opts.id); resolveRun({ code, stderr, timedOut }) })
      })
      if (result.timedOut) return { success: false, error: '语音生成超时' }
      if (result.code !== 0 || !existsSync(outPath)) {
        return { success: false, error: result.code === null ? 'llama-tts 被中止' : `llama-tts 退出码 ${result.code}: ${result.stderr.slice(-500)}` }
      }
      const wav = await fsPromises.readFile(outPath)
      // 防残缺产出：验证 RIFF/WAVE 头与最小长度，否则渲染层会拿到解码不了的音频
      if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return { success: false, error: `llama-tts 产出无效 wav（${wav.length} 字节）: ${result.stderr.slice(-300)}` }
      }
      return { success: true, wavBase64: wav.toString('base64') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
    }
  })
  ipcMain.handle('tts-stop', async (_e, id: string) => {
    const proc = runningTts.get(id)
    if (!proc) return { success: false, error: '未在运行' }
    runningTts.delete(id)
    await killProcessTreeAsync(proc)
    return { success: true }
  })

  let cancelBackendDl: (() => void) | null = null
  let pauseBackendDl: (() => void) | null = null
  // 最近一次后端包下载参数：暂停后供「继续」复用；成功/失败/取消后清空。
  // startByte 记录暂停瞬间的真实已下载字节数（文件被预分配为完整大小，
  // 续传必须用真实进度，不能按文件大小推断，否则会误判残留完整文件而删档重下）
  let lastBackendDlOpts: { url: string; version: string; assetName: string; digest?: string; startByte?: number } | null = null

  // ── 共享的后端发布版本检查（llama.cpp 与 TensorSharp 通用，均直连 GitHub）──
  // repo 形如「owner/name」，由渲染进程显式传入；缺省为 llama.cpp。
  async function checkBackendRelease(repo: string) {
    const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`) as any
    if (!release || !release.assets) return { error: 'GitHub 返回数据无效' }
    const isMac = process.platform === 'darwin'
    const isLinux = process.platform === 'linux'
    const arch = process.arch
    const isTs = repo.toLowerCase().includes('tensorsharp')
    const isSdcpp = repo.toLowerCase().includes('stable-diffusion.cpp')
    const platformAssets = release.assets.filter((a: any) => {
      const n = a.name.toLowerCase()
      if (n.startsWith('cudart-')) return false
      // TensorSharp 的发布页同时包含 cli 与 server 两种资产，本项目只使用推理服务器
      if (isTs && !n.includes('tensorsharp-server')) return false
      // stable-diffusion.cpp 的发布资产以 sd- 前缀命名（sd-<tag>-bin-win-… / -Darwin-… / -Linux-…）
      if (isSdcpp && !n.startsWith('sd-')) return false
      if (isMac) {
        // sd 的 macOS 资产是 zip（Darwin/macOS 命名），llama.cpp 系列是 tar.gz
        if (isSdcpp) {
          if (!n.endsWith('.zip')) return false
          if (!n.includes('darwin')) return false
          if (arch === 'x64' && n.includes('arm64')) return false
          if (arch === 'arm64' && !n.includes('arm64')) return false
          return true
        }
        if (!n.endsWith('.tar.gz')) return false
        // llama.cpp 资产名用 macos，TensorSharp 用 osx
        if (isTs) {
          if (!n.includes('osx')) return false
          if (arch === 'x64' && n.includes('arm64')) return false
          return true
        }
        if (!n.includes('macos')) return false
        if (arch === 'arm64' && !n.includes('arm64')) return false
        if (arch === 'x64' && !n.includes('x64')) return false
        return true
      }
      if (isLinux) {
        // sd 的 Linux 资产是 zip（Linux-Ubuntu-…-x86_64 命名），llama.cpp 系列是 tar.gz
        if (isSdcpp) {
          if (!n.endsWith('.zip')) return false
          if (!n.includes('linux')) return false
          if (arch === 'x64' && n.includes('arm64')) return false
          if (arch === 'arm64' && !n.includes('arm64')) return false
          return true
        }
        if (!n.endsWith('.tar.gz')) return false
        // llama.cpp 资产名带发行版标识（ubuntu 等），Tensor 用 linux-x64
        if (isTs) return n.includes('linux-x64') && !n.includes('arm64')
        if (!n.includes('ubuntu')) return false
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
    // 版本号解析（版本目录名 = tagName + '-' + 资产名，版本号位于开头）：
    // 点分版本：v3.1.2.0 → [3,1,2,0]、v0.4.2 → [0,4,2]、tqp-v0.3.0-… → [0,3,0]；
    // 构建号：b4379 → [4379]、4379 → [4379]；解析失败返回 null。
    // 注意必须锚定字符串开头，否则会误取资产名里的 cuda-13.1 等无关数字段
    const parseVersion = (s: string): number[] | null => {
      const dot = s.match(/^v?(\d+(?:\.\d+){1,4})/i)
      if (dot) return dot[1].split('.').map(n => parseInt(n, 10))
      const dotPrefixed = s.match(/^[a-z0-9]+[-_]v?(\d+(?:\.\d+){1,4})/i)
      if (dotPrefixed) return dotPrefixed[1].split('.').map(n => parseInt(n, 10))
      const build = s.match(/^[a-z]+[-_]b?(\d{3,6})/i) || s.match(/^b?(\d{3,6})/i)
      if (build) return [parseInt(build[1], 10)]
      return null
    }
    // 逐位比较版本数组（缺位补 0）：a < b → -1，a === b → 0，a > b → 1
    const cmpVersion = (a: number[], b: number[]): number => {
      const len = Math.max(a.length, b.length)
      for (let i = 0; i < len; i++) {
        const av = a[i] ?? 0, bv = b[i] ?? 0
        if (av !== bv) return av < bv ? -1 : 1
      }
      return 0
    }
    // 引擎识别（与 detectEngineKind 同语义）：只与同引擎的已装目录比较，避免跨引擎版本串扰
    const repoLower = repo.toLowerCase()
    const repoKind = repoLower.includes('tensorsharp') ? 'tensorsharp'
      : repoLower.includes('turboquant') ? 'turboquant'
      : repoLower.includes('beellama') ? 'beellama'
      : repoLower.includes('stable-diffusion.cpp') ? 'sdcpp'
      : 'llamacpp'
    const latestVer = parseVersion(String(release.tag_name))
    let isNewer = true
    if (existsSync(BACKEND_DIR)) {
      for (const d of readdirSync(BACKEND_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
        const dn = d.name.toLowerCase()
        const dirKind = dn.includes('tensorsharp') ? 'tensorsharp'
          : dn.includes('turboquant') ? 'turboquant'
          : dn.includes('beellama') ? 'beellama'
          // sd 版本目录形如 master-813-bfbef5b-sd-master-bfbef5b-bin-win-cpu-x64
          : dn.includes('sd-master') || dn.includes('stable-diffusion') ? 'sdcpp'
          : 'llamacpp'
        if (dirKind !== repoKind) continue
        // 兜底：目录名包含完整 tagName（历史命名差异 / 无法解析版本号的旧目录）
        if (d.name.includes(release.tag_name)) { isNewer = false; break }
        const installed = parseVersion(d.name)
        if (installed && latestVer && cmpVersion(installed, latestVer) >= 0) { isNewer = false; break }
      }
    }
    // stable-diffusion.cpp 的 CUDA 运行时包（cudart-sd-bin-win-cu12-x64.zip）：
    // 主引擎包不含 CUDA 运行时，需单独下载合并进引擎目录（仅 Windows；macOS/Linux 包自带运行时）
    const cudartAsset = isSdcpp && process.platform === 'win32'
      ? (release.assets.find((a: any) => a.name.toLowerCase().startsWith('cudart-') && a.name.toLowerCase().endsWith('.zip')) ?? null)
      : null
    return {
      tagName: release.tag_name, name: release.name, url: release.html_url, publishedAt: release.published_at,
      isNewer, noPackage: platformAssets.length === 0,
      cudartAsset: cudartAsset
        ? { name: cudartAsset.name, downloadUrl: cudartAsset.browser_download_url, size: cudartAsset.size, digest: String(cudartAsset.digest || '').replace(/^sha256:/i, '') }
        : undefined,
      assets: platformAssets.map((a: any) => ({ name: a.name, downloadUrl: a.browser_download_url, size: a.size, digest: String(a.digest || '').replace(/^sha256:/i, '') }))
    }
  }
  ipcMain.handle('check-updates', async (_event, repo?: string) => {
    try {
      const target = String(repo || 'ggml-org/llama.cpp').trim()
      if (!/^[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+$/.test(target)) return { error: '无效的仓库' }
      return await checkBackendRelease(target)
    } catch (err) { return { error: String(err) } }
  })
  // 共享的后端发布包下载 + 解压实现（llama.cpp 与 TensorSharp 通用，直连 GitHub）
  async function downloadBackendRelease(event: Electron.IpcMainInvokeEvent, opts: { url: string; version: string; assetName: string; digest?: string; startByte?: number }): Promise<{ success: boolean; path?: string; cancelled?: boolean; paused?: boolean; error?: string }> {
    if (!opts.version || /[\\/:*?"<>|]/.test(opts.version) || opts.version.includes('..')) {
      return { success: false, error: '无效的版本' }
    }
    if (!opts.assetName || opts.assetName.includes('..') || opts.assetName.includes('/') || opts.assetName.includes('\\')) {
      return { success: false, error: '无效的资源名称' }
    }
    lastBackendDlOpts = { url: opts.url, version: opts.version, assetName: opts.assetName, digest: opts.digest }
    const archivePath = join(app.getPath('temp'), opts.assetName)
    const extractPath = join(BACKEND_DIR, opts.version)
    if (!isSafePath(BACKEND_DIR, extractPath)) return { success: false, error: '访问被拒绝' }
    // 解压先落到同卷的 staging 目录（避免跨盘 rename），全部校验通过后再原子替换正式版本目录；
    // 失败时只清理 staging，绝不误删已安装好的后端
    const stagingDir = join(dirname(BACKEND_DIR), `.staging-${opts.version}-${Date.now()}`)
    const isTarGz = opts.assetName.toLowerCase().endsWith('.tar.gz')
    // 断点续传：保留已下完的临时文件，让 Range 分片从断点继续；损坏与否由下载步自身的校验兜底。
    // 注意：文件被预分配为完整大小，不能按 statSync 大小推断进度；暂停续传优先使用暂停时记录的真实字节数
    let startByte = 0
    if (opts.startByte && opts.startByte > 0) {
      try { const st = statSync(archivePath); if (st.size > 0) startByte = Math.min(opts.startByte, st.size) } catch {}
    } else {
      try { const st = statSync(archivePath); if (st.size > 0) startByte = st.size } catch {}
    }
    let dlReject: ((err: Error) => void) | null = null
    // 用户取消标志 + 内部取消函数（看门狗停滞中止复用内部函数，避免误标为“用户取消”）
    let dlCancelled = false
    // 暂停标志：暂停中止请求但保留临时文件，供「继续」断点续传
    let dlPaused = false
    let cancelFn: (() => void) | null = null
    // 停滞看门狗：任何分片/顺序流一旦超过 2 分钟没有任何数据到达，则判定卡死并中止。
    // 每个分片还有更严的 30s 停滞自检，这里只兜底顺序下载等个别无自检的路径。
    let lastProgressAt = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt > 120 * 1000) {
        if (dlReject) dlReject(new Error('下载停滞'))
        if (cancelFn) { cancelFn(); cancelFn = null }
      }
    }, 30 * 1000)
    // 供顶部进度横幅识别引擎与包名（按资产名推断：TensorSharp / TurboQuant / BeeLlama / stable-diffusion.cpp，其余视为 llama.cpp）
    const assetLower = opts.assetName.toLowerCase()
    const dlLabel = assetLower.startsWith('sd-') || assetLower.includes('stable-diffusion') ? 'stable-diffusion.cpp'
      : assetLower.includes('tensorsharp') ? 'TensorSharp'
      : assetLower.includes('turboquant') ? 'TurboQuant'
      : assetLower.includes('beellama') ? 'BeeLlama'
      : 'llama.cpp'
    const dlEngine = dlLabel === 'stable-diffusion.cpp' ? 'sdcpp'
      : dlLabel === 'TensorSharp' ? 'tensorsharp'
      : dlLabel === 'TurboQuant' ? 'turboquant'
      : dlLabel === 'BeeLlama' ? 'beellama'
      : 'llamacpp'
    const progressPayload = (phase: string, received: number, total: number, percent: number, speed?: number, note?: string, chunks?: Array<'idle' | 'active' | 'done'>) => ({ percent, phase, received, total, engine: dlEngine, name: opts.assetName, speed, note, chunks })
    // 最近一次进度快照：onStatus（如回退提示）需要用它补全 payload
    let lastR = 0, lastT = 0, lastSpeed = 0
    let lastChunks: Array<'idle' | 'active' | 'done'> | undefined
    const sendProgress = (phase: string, r: number, t: number, pct: number, noteText?: string, chunks?: Array<'idle' | 'active' | 'done'>) => {
      lastR = r; lastT = t
      if (chunks) lastChunks = chunks
      event.sender.send('download-progress', progressPayload(phase, r, t, pct, lastSpeed, noteText, lastChunks))
    }
    try {
      sendProgress('downloading', 0, 0, 0)
      console.log('[dl] 开始下载:', opts.url, startByte > 0 ? `(续传 ${startByte} 字节)` : '')
      // 用户取消标志：取消时让下载 Promise 立即 settle（否则会挂起到停滞看门狗超时）
      await new Promise<void>((resolve, reject) => {
        dlReject = reject
        cancelFn = startParallelDownload(opts.url, archivePath, startByte,
          (r, t, speed, chunks) => { lastProgressAt = Date.now(); lastSpeed = speed ?? 0; sendProgress('downloading', r, t, t > 0 ? Math.round(r / t * 100) : 0, undefined, chunks) },
          () => { console.log('[dl] 下载完成'); resolve() },
          (err) => { console.log('[dl] 下载失败:', err.message); reject(err) },
          (n) => { sendProgress('downloading', lastR, lastT, lastT > 0 ? Math.round(lastR / lastT * 100) : 0, n) })
        cancelBackendDl = () => {
          dlCancelled = true
          cancelFn?.()
          reject(new Error('已取消'))
        }
        pauseBackendDl = () => {
          dlPaused = true
          cancelFn?.()
          reject(new Error('已暂停'))
        }
      })
      cancelBackendDl = null; pauseBackendDl = null; dlReject = null
      clearInterval(watchdog)
      // GitHub 发布资产携带 sha256 digest 时做下载后校验：解压前拦截损坏/被篡改的包
      if (opts.digest) {
        sendProgress('verifying', 0, 0, 100)
        const want = opts.digest.toLowerCase()
        const got = await sha256OfFile(archivePath)
        console.log('[dl] sha256 校验:', got, '期望:', want, got === want ? '通过' : '不通过')
        if (got !== want) {
          try { unlinkSync(archivePath) } catch {}
          try { unlinkSync(archivePath + '.etag') } catch {}
          throw new Error('校验和失败：文件内容与官方发布不一致（sha256）')
        }
      }
      // 校验通过/无 digest：清理 etag 旁路文件，避免残留陈旧 etag
      try { unlinkSync(archivePath + '.etag') } catch {}
      console.log('[dl] 开始解压:', archivePath, '->', stagingDir)
      event.sender.send('download-progress', progressPayload('extracting', 0, 0, 100))
      const archiveSize = statSync(archivePath).size
      if (archiveSize === 0) throw new Error('下载文件为空')
      // 清理历史崩溃残留的 staging 与旧版本备份目录（app 被杀 / 断电会遗留，大包可达数百 MB）
      try {
        const base = dirname(BACKEND_DIR)
        for (const n of readdirSync(base)) {
          if (n.startsWith('.staging-') || n.startsWith('.old-')) {
            try { rmSync(join(base, n), { recursive: true, force: true }) } catch {}
          }
        }
      } catch {}
      rmSync(stagingDir, { recursive: true, force: true })
      mkdirSync(stagingDir, { recursive: true })
      if (isTarGz) {
        // tar 是顺序格式没有中央目录：先 -tzf 预读条目总数（只读头部，秒级~分钟级），
        // 再 -xzf -v 按 stdout 文件名行计数上报进度，与 zip 路径一致；
        // -t 失败说明包损坏，提前拦截并清理，避免把坏包留给续传复用
        const totalTarEntries = await new Promise<number>((resolve, reject) => {
          const p = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'ignore'] })
          let count = 0
          let buf = ''
          p.stdout.on('data', (d: Buffer) => {
            buf += d.toString()
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            count += lines.filter(l => l.trim().length > 0).length
          })
          const t = setTimeout(() => { p.kill(); reject(new Error('tar解压超时')) }, 5 * 60 * 1000)
          p.on('error', (e) => { clearTimeout(t); reject(e) })
          p.on('exit', code => {
            clearTimeout(t)
            if (code === 0) resolve(count)
            else {
              try { unlinkSync(archivePath) } catch {}
              reject(new Error('下载不完整，压缩包损坏'))
            }
          })
        })
        if (totalTarEntries === 0) throw new Error('解压后内容为空')
        let doneTarEntries = 0
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xzf', archivePath, '-C', stagingDir, '-v'], { stdio: ['ignore', 'pipe', 'ignore'] })
          let buf = ''
          p.stdout.on('data', (d: Buffer) => {
            buf += d.toString()
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            doneTarEntries += lines.filter(l => l.trim().length > 0).length
            event.sender.send('download-progress', progressPayload('extracting', doneTarEntries, totalTarEntries, totalTarEntries > 0 ? Math.round(doneTarEntries / totalTarEntries * 100) : 100))
          })
          // 分支引擎包体可达数百 MB，解压较慢，超时放宽到 30 分钟
          const t = setTimeout(() => { p.kill(); reject(new Error('tar解压超时')) }, 30 * 60 * 1000)
          p.on('error', (e) => { clearTimeout(t); reject(e) })
          p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`)) })
        })
      } else {
        // ZIP 一律用 extract-zip（纯 JS / yauzl）解压：逐条目落地、破坏包立即抛错，
        // 不依赖外部 PowerShell Expand-Archive / unzip（大包会静默截断、部分解压或超时）
      // 先读取中央目录统计总条目数（只读包尾目录，秒级），用于上报解压进度；
      // 中央目录损坏（下载不完整）时提前失败并清理临时文件，避免把坏包留在 temp 里被续传复用
      const totalEntries = await new Promise<number>((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
          if (err) {
            try { unlinkSync(archivePath) } catch {}
            reject(new Error('下载不完整，压缩包损坏'))
            return
          }
          const n = zip.entryCount
          zip.close()
          resolve(n)
        })
      })
        if (totalEntries === 0) throw new Error('解压后内容为空')
        let doneEntries = 0
        await new Promise<void>((resolve, reject) => {
          // 大包（数百 MB，如 TurboQuant / BeeLlama 分支）纯 JS 解压 + 杀毒软件实时扫描
          // 每个 dll/exe 可能很慢，超时放宽到 30 分钟
          const t = setTimeout(() => reject(new Error('解压超时')), 30 * 60 * 1000)
          extractZip(archivePath, {
            dir: stagingDir,
            onEntry: () => {
              doneEntries++
              event.sender.send('download-progress', progressPayload('extracting', doneEntries, totalEntries, Math.round(doneEntries / totalEntries * 100)))
            },
          }).then(() => { clearTimeout(t); resolve() }).catch((e) => { clearTimeout(t); reject(e) })
        })
      }
      // 校验解压结果，避免“解压成功但内容为空”
      const extractedCount = countExtractedFiles(stagingDir)
      console.log('[dl] 解压完成, 文件数:', extractedCount)
      if (extractedCount === 0) throw new Error('解压后内容为空')
      // 部分发布包（如 TensorSharp）zip 内含同名顶层目录，解压后会多套一层；
      // 若解压目录只有一个子目录且无其他内容，则把内容上移一层
      flattenSingleRoot(stagingDir)
      if (countExtractedFiles(stagingDir) === 0) throw new Error('解压后内容为空')
      // 核心可执行文件必须存在（有限深度查找），防止“解压完成但没有主程序”
      const exeNames = ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server', 'llama-cli.exe', 'TensorSharp.Server.exe', 'TensorSharp.Server', 'sd-server.exe', 'sd-server']
      if (!findAnyFile(stagingDir, exeNames)) throw new Error('解压后未找到核心可执行文件，安装包可能不完整')
      // 校验全部通过后才替换正式版本目录（此前版本安装保持原样）。
      // 原子替换：先把旧目录改名成 .old-* 备份（Windows rename 目标已存在会失败，不能直接覆盖），
      // 再 rename staging 进来；新目录未就位前旧目录始终可回滚，绝不出现“版本目录消失”的中间态
      let oldBackup: string | null = null
      if (existsSync(extractPath)) {
        oldBackup = join(dirname(BACKEND_DIR), `.old-${basename(extractPath)}`)
        try { rmSync(oldBackup, { recursive: true, force: true }) } catch {}
        try {
          renameSync(extractPath, oldBackup)
        } catch {
          // 旧目录被占用（后端进程运行中 / 杀毒软件锁定），无法安全替换，报错并保留旧版本
          throw new Error('旧版本目录被占用，无法替换（EBUSY）')
        }
      }
      try {
        renameSync(stagingDir, extractPath)
      } catch (e) {
        // 新目录改名失败：回滚旧目录，保证已安装版本不丢失
        if (oldBackup) { try { renameSync(oldBackup, extractPath) } catch {} }
        throw e
      }
      if (oldBackup) { try { rmSync(oldBackup, { recursive: true, force: true }) } catch {} }
      try { unlinkSync(archivePath) } catch (e) { console.error('清理临时文件失败', e) }
      lastBackendDlOpts = null
      // 全流程成功收尾事件：send 管道 FIFO 保证它排在所有进度事件之后，
      // 渲染端收到 'done' 即清空横幅，避免 invoke 回执与进度事件跨管道乱序导致横幅卡在「解压中」
      event.sender.send('download-progress', progressPayload('done', lastT, lastT, 100, lastSpeed, '安装完成'))
      return { success: true, path: extractPath }
    } catch (err) {
      console.log('[dl] 失败:', err)
      cancelBackendDl = null; pauseBackendDl = null; dlReject = null
      clearInterval(watchdog)
      // 暂停：中止请求但保留临时文件（断点续传依据），并通知渲染端进入暂停态。
      // 记录真实已下载字节数（与文件实际落盘大小取较小值，避免超前后续拼接出空洞）
      if (dlPaused) {
        let savedStart = 0
        try { savedStart = Math.min(lastR, statSync(archivePath).size) } catch {}
        if (lastBackendDlOpts) lastBackendDlOpts.startByte = savedStart
        event.sender.send('download-progress', progressPayload('paused', lastR, lastT, lastT > 0 ? Math.round(lastR / lastT * 100) : 0, lastSpeed, '已暂停，可随时继续'))
        return { success: false, paused: true, cancelled: false, error: '已暂停' }
      }
      // 清理 staging 与临时 zip；正式版本目录（不论新旧）一律保留，失败不回滚也不误删。
      // 临时 zip 必须删除：否则残留的“完整大小但内容损坏”文件会被下次断点续传复用（续传只覆盖尾部），
      // 导致解压持续失败（Z_DATA_ERROR: invalid block type）
      if (existsSync(stagingDir)) {
        try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      }
      try { unlinkSync(archivePath) } catch {}
      try { unlinkSync(archivePath + '.etag') } catch {}
      lastBackendDlOpts = null
      const msg = String(err)
      let cnMsg = msg
      if (msg.includes('ERR_CONNECTION_TIMED_OUT') || msg.includes('Connection timeout') || msg.includes('Probe connection timeout')) cnMsg = '连接超时，请检查网络或代理设置'
      else if (msg.includes('ERR_CONNECTION_REFUSED')) cnMsg = '连接被拒绝'
      else if (msg.includes('ERR_INTERNET_DISCONNECTED')) cnMsg = '网络未连接'
      else if (msg.includes('ERR_NAME_NOT_RESOLVED')) cnMsg = 'DNS 解析失败，请检查网络'
      else if (msg.includes('Download stalled') || msg.includes('下载停滞')) cnMsg = '下载停滞，请检查网络'
      else if (msg.includes('已取消')) cnMsg = '已取消'
      else if (msg.includes('解压超时') || msg.includes('tar解压超时')) cnMsg = '解压超时：包体较大或磁盘/杀毒软件扫描较慢。可重试；若反复超时，请将 backend 目录加入杀毒软件排除列表'
      else if (msg.includes('ENOSPC')) cnMsg = '磁盘空间不足，请清理磁盘后重试'
      else if (msg.includes('EACCES')) cnMsg = '文件写入被拒绝，可能被杀毒软件占用，请将 backend 目录加入排除列表后重试'
      else if (msg.includes('HTTP 4') || msg.includes('HTTP 5')) cnMsg = '服务器返回错误：' + (msg.match(/HTTP \d+/)?.[0] || '')
      else if (msg.includes('下载不完整') || msg.includes('分片下载不完整') || msg.includes('解压后内容为空') || msg.includes('下载文件为空')) cnMsg = '下载不完整，压缩包可能已损坏，请重试'
      else if (msg.includes('校验和失败')) cnMsg = '文件校验失败：与官方 sha256 不一致，可能被代理篡改或下载损坏，已清理，请重试'
      else if (msg.includes('Z_DATA_ERROR') || msg.includes('invalid block type') || msg.includes('incorrect header check')) cnMsg = '解压失败：压缩包内容损坏（通常为上次下载不完整），已清理临时文件，请重新下载'
      else if (msg.includes('压缩包损坏') || msg.includes('tar') || msg.includes('unzip') || msg.includes('zip') || msg.includes('corrupt')) cnMsg = '解压失败，压缩包可能已损坏'
      else if (msg.includes('EBUSY') || msg.includes('EPERM') || msg.includes('ECONNREFUSED')) cnMsg = '文件被占用，请先停止该后端再更新'
      return { success: false, cancelled: dlCancelled, error: cnMsg }
    }
  }
  ipcMain.handle('download-release', (event, opts: { url: string; version: string; assetName: string; digest?: string }) => downloadBackendRelease(event, opts))
  // --- install-sd-cudart: 下载 stable-diffusion.cpp 的 CUDA 运行时包（cudart/cublas）并合并进已安装的引擎目录 ---
  // 主引擎包（sd-master-*-bin-win-cuda12-x64.zip）不含 CUDA 运行时，需此包补充；
  // 与主引擎不同，它不新建 backend 目录，而是把 dll 合并进已有 sd 后端目录
  ipcMain.handle('install-sd-cudart', async (event, opts: { url: string; assetName: string; backendName: string; digest?: string }): Promise<{ success: boolean; installed?: string[]; error?: string }> => {
    const targetDir = join(BACKEND_DIR, String(opts?.backendName || ''))
    if (!opts?.url || !opts?.assetName || !isSafePath(BACKEND_DIR, targetDir) || !existsSync(targetDir) ||
        !findAnyFile(targetDir, ['sd-server.exe', 'sd-server', 'sd-cli.exe', 'sd-cli'])) {
      return { success: false, error: '目标后端目录不存在或不是 stable-diffusion.cpp 引擎' }
    }
    if (opts.assetName.includes('..') || opts.assetName.includes('/') || opts.assetName.includes('\\')) {
      return { success: false, error: '无效的资源名称' }
    }
    const archivePath = join(app.getPath('temp'), opts.assetName)
    const stagingDir = join(dirname(BACKEND_DIR), `.sd-cudart-staging-${Date.now()}`)
    const sendP = (phase: string, r: number, t: number, pct: number, speed?: number) => {
      event.sender.send('sd-cudart-progress', { phase, received: r, total: t, percent: pct, speed })
    }
    try {
      sendP('downloading', 0, 0, 0)
      await new Promise<void>((resolve, reject) => {
        startParallelDownload(opts.url, archivePath, 0,
          (r, t, speed) => sendP('downloading', r, t, t > 0 ? Math.round(r / t * 100) : 0, speed),
          () => resolve(),
          (err) => reject(err),
          () => {})
      })
      if (opts.digest) {
        sendP('verifying', 0, 0, 100)
        const got = await sha256OfFile(archivePath)
        if (got !== opts.digest.toLowerCase()) throw new Error('校验和失败：文件内容与官方发布不一致（sha256）')
      }
      const totalEntries = await new Promise<number>((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
          if (err) { try { unlinkSync(archivePath) } catch {}; reject(new Error('下载不完整，压缩包损坏')); return }
          const n = zip.entryCount
          zip.close(); resolve(n)
        })
      })
      if (totalEntries === 0) throw new Error('解压后内容为空')
      rmSync(stagingDir, { recursive: true, force: true })
      mkdirSync(stagingDir, { recursive: true })
      let done = 0
      await extractZip(archivePath, {
        dir: stagingDir,
        onEntry: () => { done++; sendP('extracting', done, totalEntries, Math.round(done / totalEntries * 100)) }
      })
      flattenSingleRoot(stagingDir)
      // 收集包内全部 dll 并复制进引擎目录（cudart/cublas/cublasLt 等）
      const dllFiles: string[] = []
      const collect = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) collect(p)
          else if (e.name.toLowerCase().endsWith('.dll')) dllFiles.push(p)
        }
      }
      collect(stagingDir)
      if (dllFiles.length === 0) throw new Error('CUDA 运行时包中未找到 dll 文件')
      const installed: string[] = []
      for (const f of dllFiles) {
        const dest = join(targetDir, basename(f))
        await fsPromises.copyFile(f, dest)
        installed.push(basename(f))
      }
      if (!['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'].some(n => existsSync(join(targetDir, n)))) {
        throw new Error('CUDA 运行时安装不完整：缺少 cudart64_12.dll / cublas64_12.dll / cublasLt64_12.dll')
      }
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      try { unlinkSync(archivePath) } catch {}
      sendP('done', 0, 0, 100)
      return { success: true, installed }
    } catch (err) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      try { unlinkSync(archivePath) } catch {}
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
  // 取消：中止下载并删除临时文件（含暂停残留）
  ipcMain.handle('cancel-backend-download', () => {
    if (cancelBackendDl) {
      cancelBackendDl()
      cancelBackendDl = null
    } else if (lastBackendDlOpts) {
      // 暂停后无活动请求：清除暂停残留的临时文件（及 etag 旁路），防止被续传复用
      const tmp = join(app.getPath('temp'), lastBackendDlOpts.assetName)
      try { unlinkSync(tmp) } catch {}
      try { unlinkSync(tmp + '.etag') } catch {}
      lastBackendDlOpts = null
    }
    return { success: true }
  })
  // 暂停：中止请求但保留已下载部分，供「继续」断点续传
  ipcMain.handle('pause-backend-download', () => {
    if (pauseBackendDl) {
      pauseBackendDl()
      pauseBackendDl = null
      return { success: true }
    }
    return { success: false, error: '没有正在进行的下载' }
  })
  // 继续：复用上次下载参数重新发起，主进程自动从临时文件断点续传
  ipcMain.handle('resume-backend-download', (event) => {
    if (!lastBackendDlOpts) return { success: false, error: '没有可恢复的下载' }
    if (cancelBackendDl) return { success: false, error: '已有下载进行中' }
    return downloadBackendRelease(event, lastBackendDlOpts)
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
    const allowedBases = [MODELS_DIR, BACKEND_DIR, CHATS_DIR, CHAT_TEMPLATES_DIR, ...settings.externalModelFolders, ...settings.imageModelFolders, ...settings.ttsModelFolders, ...settings.ocrModelFolders, ...settings.sdModelFolders, ...settings.sdVaeFolders, ...settings.sdLlmFolders]
    if (!allowedBases.some(base => isSafePath(base, folderPath))) return
    // 确保目录存在（例如 chats/images、chats/pdf_exports 是惰性创建的），
    // 否则 shell.openPath 在路径不存在时会静默失败、什么也不打开。
    if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true })
    const err = await shell.openPath(folderPath)
    if (err) console.error('[open-folder] 无法打开目录:', folderPath, err)
    return err
  })
  ipcMain.handle('get-paths', () => ({ models: MODELS_DIR, templates: TEMPLATES_DIR, backend: BACKEND_DIR, chats: CHATS_DIR, chatImages: join(CHATS_DIR, 'images'), chatPdfExports: join(CHATS_DIR, 'pdf_exports'), chatTemplates: CHAT_TEMPLATES_DIR }))
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
      const ggufFiles = data.filter((f: HfFileRaw) => f.type === 'file' && ['.gguf', '.safetensors', '.ckpt', '.pth', '.pt'].some(ext => f.path.toLowerCase().endsWith(ext)))
      if (ggufFiles.length === 0) return { error: '该仓库中没有找到支持的模型文件（.gguf / .safetensors / .ckpt）' }
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
      // 白名单包含全部可注册的模型文件夹（外部 / 图片 / TTS / OCR / sd 三件套），
      // 否则通过设置添加的目录（如 stable-diffusion.cpp 模型文件夹）会被误判为文件缺失
      const allowedRoots = [
        ...s.externalModelFolders,
        ...s.imageModelFolders,
        ...s.ttsModelFolders,
        ...s.ocrModelFolders,
        ...s.sdModelFolders,
        ...s.sdVaeFolders,
        ...s.sdLlmFolders
      ]
      const allowed = allowedRoots.some(f => isSafePath(f, filePath))
      // 不在白名单时返回 false 但不缓存，方便用户后续添加文件夹后立即生效
      if (!allowed) return false
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

  // 原生文件选择对话框（多选）：供 Agent Code 输入框附件选取任意磁盘文件
  ipcMain.handle('select-files', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const r = await dialog.showOpenDialog(win!, { title: '选择文件', properties: ['openFile', 'multiSelections'] })
    if (r.canceled || !r.filePaths.length) return { paths: [] }
    return { paths: r.filePaths }
  })

  // 枚举可用磁盘（Windows A:-Z:）：供文件选择面板「此电脑」视图列出盘符
  ipcMain.handle('list-drives', async () => {
    const drives: string[] = []
    for (let i = 65; i <= 90; i++) {
      const root = String.fromCharCode(i) + ':\\'
      try { if (existsSync(root)) drives.push(root) } catch { /* 不可访问盘符跳过 */ }
    }
    return { drives }
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
        // 指标名可能带 label（如 llamacpp:prompt_tokens_seconds{model="x"}），剥离后按裸名匹配
        if (!isNaN(val)) result[parts[0].split('{')[0]] = val
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
    // TensorSharp 没有 /slots 与 /metrics（llama.cpp 专属），只采集 GPU/CPU 数据
    const kind = runningProcesses.get(id)?.kind
    const [rawSlots, rawMetrics] = kind === 'tensorsharp'
      ? ['', '']
      : await Promise.all([
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
      const ttftMs = Math.round((payload.nPromptTokens / payload.prefillTokS) * 1000)
      payload.ttftMs = ttftMs
      lastTtft.set(id, ttftMs)
    } else {
      // prefill 窗口极短（2s 轮询大概率错过），保持最后一次成功估算值持续展示
      const prev = lastTtft.get(id)
      if (prev !== undefined) payload.ttftMs = prev
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
  ipcMain.handle('get-ui-settings', async () => {
    const s = await loadSettings()
    return { splashEnabled: s.splashEnabled ?? true, soundEnabled: s.soundEnabled ?? true, notificationSound: s.notificationSound ?? 'chime', chatSidebarCollapsed: s.chatSidebarCollapsed ?? false, agentToolCardsExpanded: s.agentToolCardsExpanded ?? true, ttsEngine: s.ttsEngine ?? 'system', ttsModelPath: s.ttsModelPath ?? '', ttsVocoderPath: s.ttsVocoderPath ?? '' }
  })
  ipcMain.handle('set-ui-setting', async (_e, key: string, value: boolean | string) => {
    const s = await loadSettings()
    if (UI_KEYS.has(key)) {
      ;(s as any)[key] = value
      await saveSettings(s)
    }
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
  ipcMain.handle('get-running-processes', async () => {
    return Array.from(runningProcesses.keys())
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

  // --- sdapi-request: 向运行中的 sd-server 发起 sdapi 请求（文生图/图生图/采样器列表等） ---
  ipcMain.handle('sdapi-request', (_e, opts: { port: number; path: string; method?: 'GET' | 'POST'; body?: unknown }): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> => {
    return new Promise((resolve) => {
      const p = String(opts?.path || '')
      // 路径白名单：只放行 sd-server 的 /sdapi/ 端点，防止任意路径请求
      if (!/^\/sdapi\/[a-zA-Z0-9_\-\/]*$/.test(p)) { resolve({ ok: false, error: '仅允许 /sdapi/ 端点' }); return }
      const port = Number(opts?.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) { resolve({ ok: false, error: '无效端口' }); return }
      const method = opts?.method === 'POST' ? 'POST' : 'GET'
      let bodyStr: string | null = null
      if (method === 'POST') {
        try { bodyStr = JSON.stringify(opts?.body ?? {}) } catch { resolve({ ok: false, error: '请求体序列化失败' }); return }
      }
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
      }, (res) => {
        let buf = ''
        res.on('data', (d: Buffer) => { buf += d.toString() })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf)
            resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode, data: parsed })
          } catch {
            resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode, error: buf.slice(0, 500) })
          }
        })
      })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      // 图像生成可能耗时较长（数十秒），超时放宽到 5 分钟
      req.setTimeout(5 * 60 * 1000, () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  })

	  // --- server-props (查询 llama-server /props：多模态能力检测) ---
  ipcMain.handle('server-props', async (_e, port: number): Promise<{ ok: boolean; modalities?: { vision?: boolean; audio?: boolean }; error?: string }> => {
    try {
      const raw = await httpGetText(`http://127.0.0.1:${port}/props`)
      const props = JSON.parse(raw)
      const modalities = props && typeof props.modalities === 'object' ? props.modalities : undefined
      return { ok: true, modalities }
    } catch (e: any) {
      return { ok: false, error: e?.message || '/props 请求失败' }
    }
  })

	  // 按端口反查运行中模型的引擎类型（runModel 时登记），供聊天代理按引擎调整请求体
  function engineKindByPort(port: number): EngineKind | null {
    for (const entry of runningProcesses.values()) {
      if (entry.port === port) return entry.kind ?? 'llamacpp'
    }
    return null
  }

  // ── 聊天代理 model 字段兜底 ──
  // llama.cpp 忽略 model 名，但 TensorSharp 的 /v1/chat/completions 会严格校验 model 必须
  // 与 --model 托管的 GGUF 匹配（否则返回 "model 'X' is not hosted by this server"）。
  // 原生聊天不发送 model 字段、Agent 兜底可能发送占位符 '模型'，统一按端口查询
  // /v1/models 的托管模型 id 自动填充；查询失败不阻断，保持原样转发。
  async function resolveChatModel(port: number, model?: unknown): Promise<string | undefined> {
    if (typeof model === 'string' && model.trim() && model.trim() !== '模型') return model
    const cached = hostedModelCache.get(port)
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.id
    try {
      const raw = await httpGetText(`http://127.0.0.1:${port}/v1/models`)
      const parsed = JSON.parse(raw) as { data?: Array<{ id?: unknown }>; id?: unknown }
      const list = Array.isArray(parsed?.data) ? parsed.data : []
      const id = list[0]?.id ?? parsed?.id
      if (typeof id === 'string' && id.trim()) {
        hostedModelCache.set(port, { id: id.trim(), at: Date.now() })
        return id.trim()
      }
    } catch { /* 查询失败：保持原样转发 */ }
    return undefined
  }

  // --- chat-completion (非流式聊天代理：POST /v1/chat/completions，返回解析后的 JSON) ---
  ipcMain.handle('chat-completion', async (_e, opts: { port: number; body: Record<string, unknown> }): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> => {
    const { port, body } = opts
    const model = await resolveChatModel(port, body.model)
    const finalBody = model ? { ...body, model } : body
    // max_tokens 兜底：llama.cpp 用 -1 表示沿用服务端默认，TensorSharp 对负数/0 会抛
    // ArgumentOutOfRangeException → HTTP 500（实测）。统一剔除非正数，让服务端默认值生效。
    if (typeof finalBody.max_tokens !== 'number' || finalBody.max_tokens <= 0) {
      delete finalBody.max_tokens
    }
    // 思考链兜底：TensorSharp 需显式 think:true 才返回 reasoning_content（llama.cpp 默认返回），
    // 按端口反查引擎自动补上；调用方已显式指定时以调用方为准。
    if (finalBody.think === undefined && engineKindByPort(port) === 'tensorsharp') {
      finalBody.think = true
    }
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify({ ...finalBody, stream: false })
      const req = http.request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        agent: httpAgent
      }, (res) => {
        let respBody = ''
        res.on('data', (c: Buffer) => { respBody += c.toString() })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ ok: false, status: res.statusCode, error: `HTTP 错误 ${res.statusCode}: ${respBody.slice(0, 500)}` })
            return
          }
          try {
            resolve({ ok: true, status: res.statusCode, data: JSON.parse(respBody) })
          } catch (e: any) {
            resolve({ ok: false, error: `解析失败: ${e?.message || String(e)}` })
          }
        })
      })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      req.setTimeout(120000, () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
      req.write(bodyStr)
      req.end()
    })
  })

  // --- chat-completion-stream (流式聊天代理：POST /v1/chat/completions，SSE 转发) ---
  ipcMain.handle('chat-completion-stream', async (e, opts: {
    streamId: string; port: number; body: Record<string, unknown>
  }): Promise<{ success: boolean; error?: string }> => {
    const { streamId, port, body } = opts
    const model = await resolveChatModel(port, body.model)
    const finalBody = model ? { ...body, model } : body
    // max_tokens 兜底：同 chat-completion（TensorSharp 对负数/0 抛 ArgumentOutOfRangeException）
    if (typeof finalBody.max_tokens !== 'number' || finalBody.max_tokens <= 0) {
      delete finalBody.max_tokens
    }
    // 思考链兜底：同 chat-completion（TensorSharp 需 think:true 才返回 reasoning_content）
    if (finalBody.think === undefined && engineKindByPort(port) === 'tensorsharp') {
      finalBody.think = true
    }
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
      // stream_options.include_usage 让 llama-server 在流结束前发送 usage 统计
      const bodyStr = JSON.stringify({ ...finalBody, stream: true, stream_options: { include_usage: true } })
      const streamStartTime = Date.now()
      let firstTokenTime: number | null = null
      let lastUsage: { promptTokens: number; completionTokens: number } | null = null
      let lastFinishReason: string | undefined
      let endMetricsPromise: Promise<{ decodeTokS?: number; completionTokens?: number }> | null = null
      // ── idle 看门狗（借鉴 DeepSeek-Reasonix 的 defaultStreamIdleTimeout）──
      // 流已开始（已收到首个数据块）后，若连续 IDLE_TIMEOUT_MS 无任何新数据，则判定为服务假死并主动中止，
      // 避免半开连接永久阻塞前端转圈。整体请求兜底仍为下方 300000ms。
      const IDLE_TIMEOUT_MS = 120000
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let streamStarted = false
      const resetIdleTimer = (): void => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        idleTimer = setTimeout(() => {
          req.destroy()
          chatStreamInReasoning.delete(streamId)
          chatStreamToolCalls.delete(streamId)
          chatStreamToolProgress.delete(streamId)
          flushStreamNow(streamId)
          e.sender.send('chat-stream-chunk', { streamId, done: true, error: '流式响应空闲超时（服务可能已停止输出）' })
          abortedChatStreams.delete(streamId)
          activeChatStreams.delete(streamId)
          resolve({ success: false, error: 'idle timeout' })
        }, IDLE_TIMEOUT_MS)
      }
      const clearIdleTimer = (): void => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      }
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
                // ── 流式期工具调用进度上报（非 done 事件）──
                // 一旦某个工具的名称已知，就把当前已知的工具名推给前端，用于在 arguments
                // 仍在生成时就显示“正在生成…”卡片并及时收起“思考中”转圈。仅当名称集变化时发送。
                const names = acc.map(a => a.function.name).filter(Boolean).join('|')
                if (names && names !== chatStreamToolProgress.get(streamId)) {
                  chatStreamToolProgress.set(streamId, names)
                  e.sender.send('chat-stream-chunk', {
                    streamId, done: false,
                    toolCallsProgress: acc.filter(a => a.function.name).map(a => ({ name: a.function.name })),
                  })
                }
              }
              // 记录 finish_reason（通常只在最后一个有 choices 的 chunk 中出现）
              if (choice?.finish_reason) lastFinishReason = choice.finish_reason
            } catch { /* 忽略心跳/keepalive/不完整 JSON */ }
          }
        }
        res.on('data', (chunk: Buffer) => {
          if (!streamStarted) { streamStarted = true; resetIdleTimer() }
          else { resetIdleTimer() }
          buf += chunk.toString()
          processBuf()
        })
        res.on('end', () => {
          clearIdleTimer()
          // 处理缓冲区中可能残留的未以 \n\n 结尾的 SSE 事件（如 usage chunk）
          if (buf.trim()) {
            buf += '\n\n'
            processBuf()
          }
          // 先把节流队列里残留的内容 flush 出去，保证内容顺序正确
          flushStreamNow(streamId)
          // 如果流结束时 <think> 尚未闭合，补上闭合标签（同样经队列发送，避免乱序）
          const wasInReasoning = chatStreamInReasoning.get(streamId) ?? false
          if (wasInReasoning) {
            queueStreamDelta(streamId, '</think>')
            flushStreamNow(streamId)
          }
          chatStreamInReasoning.delete(streamId)

          // 先取出累积的 tool_calls，done 事件要立即携带它们，绝不能等 /metrics
          const accToolCalls = chatStreamToolCalls.get(streamId)
          chatStreamToolCalls.delete(streamId)
          chatStreamToolProgress.delete(streamId)

          // 立即发送 done + toolCalls：usage / msFirstToken 已在流内同步解析得到，
          // 唯有 decodeTokS（来自 /metrics 异步请求）可能尚未就绪。done 不等待 /metrics，
          // 前端即可立刻展示工具调用并停止「思考中」转圈。
          const finalTokens = lastUsage?.completionTokens
          const finalUsage = finalTokens != null
            ? { promptTokens: lastUsage?.promptTokens ?? 0, completionTokens: finalTokens }
            : undefined
          e.sender.send('chat-stream-chunk', {
            streamId,
            done: true,
            usage: finalUsage,
            msFirstToken: firstTokenTime ?? undefined,
            decodeTokS: undefined,
            toolCalls: accToolCalls?.length ? accToolCalls.map(tc => ({ id: tc.id, function: tc.function })) : undefined,
            finishReason: lastFinishReason ?? (accToolCalls?.length ? 'tool_calls' : undefined)
          })
          activeChatStreams.delete(streamId)
          resolve({ success: true })

          // /metrics 异步获取（与监控面板同源）；返回后作为「补充事件」发送，
          // 不携带 done，因此不会触发前端二次 finalize / 二次工具执行。
          if (endMetricsPromise) {
            endMetricsPromise
              .then(m => { e.sender.send('chat-stream-chunk', { streamId, metrics: m }) })
              .catch(() => {})
          }
        })
      })
      req.on('error', (err) => {
        clearIdleTimer()
        chatStreamInReasoning.delete(streamId)
	        chatStreamToolCalls.delete(streamId)
	        chatStreamToolProgress.delete(streamId)
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
        clearIdleTimer()
        req.destroy()
	        chatStreamInReasoning.delete(streamId)
	        chatStreamToolCalls.delete(streamId)
	        chatStreamToolProgress.delete(streamId)
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
      const ggufFiles = files.filter((f: any) => f.Type === 'blob' && ['.gguf', '.safetensors', '.ckpt', '.pth', '.pt'].some(ext => String(f.Name).toLowerCase().endsWith(ext)))
      if (ggufFiles.length === 0) return { error: '该仓库中没有找到支持的模型文件（.gguf / .safetensors / .ckpt）' }
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
  const MAX_REPLAY_CHARS = 200_000

  function ownedSession(ownerKey: string): TerminalSession | null {
    const id = sessionsByOwner.get(ownerKey)
    const session = id ? sessions.get(id) : null
    if (!session) sessionsByOwner.delete(ownerKey)
    return session ?? null
  }

  ipcMain.handle('terminal:create', async (_e, opts: { id?: string; cwd?: string; cols?: number; rows?: number; ownerKey?: string }) => {
    const ownerKey = (opts.ownerKey || '').trim() || null
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : app.getPath('home')

    // 若已有该 owner 的活跃 session，直接 attach 并返回 replay
    if (ownerKey) {
      const existing = ownedSession(ownerKey)
      if (existing) {
        if (existing.cols !== cols || existing.rows !== rows) {
          existing.cols = cols
          existing.rows = rows
          try { existing.pty.resize(cols, rows) } catch {}
        }
        return { success: true, id: existing.id, replay: existing.replay, reused: true, shell: existing.shell }
      }
    }

    // 限制同时存在的 PTY 数量
    if (sessions.size >= MAX_PTY_SESSIONS) {
      return { success: false, error: `PTY 数量已达上限（${MAX_PTY_SESSIONS}）` }
    }

    const id = opts.id || `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    try {
      const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
      const pty = await getPty()
      const p = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as any,
      })
      p.onData((data) => {
        const s = sessions.get(id)
        if (!s) return
        s.pendingData.push(data)
        // Replay buffer：累积输出供重新 attach 时回放
        s.replay += data
        if (s.replay.length > MAX_REPLAY_CHARS) {
          s.replay = s.replay.slice(-MAX_REPLAY_CHARS)
        }
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
        if (s?.ownerKey) sessionsByOwner.delete(s.ownerKey)
        sessions.delete(id)
      })
      sessions.set(id, { id, ownerKey, pty: p, cols, rows, cwd, shell, title: shell, pendingData: [], flushTimer: null, paused: false, oscBuf: '', replay: '' })
      if (ownerKey) sessionsByOwner.set(ownerKey, id)
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
    const s = sessions.get(id)
    if (s?.ownerKey) sessionsByOwner.delete(s.ownerKey)
    sessions.delete(id)
  })

  // ── 终端回退模式：无 PTY 时逐条执行命令 ──
  ipcMain.handle('terminal:exec', async (_e, { command, cwd }: { command: string; cwd?: string }) => {
    try {
      const execCwd = cwd && existsSync(cwd) ? cwd : app.getPath('home')
      let stdout = ''
      let stderr = ''
      let exitCode: number | null = null
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [], { shell: true, cwd: execCwd, windowsHide: true })
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.on('error', (err) => reject(err))
        child.on('close', (code) => { exitCode = code; resolve() })
      })
      return { success: true, stdout, stderr, exitCode }
    } catch (err) {
      return { success: false, error: String(err) }
    }
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
        .replace(/\s*\x0a\s*\x0a\s*/g, '\x0a\x0a')
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

  // ── Agent Code 工作台 文件操作 ──
  const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB
  const MAX_READ_TOKENS = 25_000
  const CHARS_PER_TOKEN = 4
  // 超过该大小的文件采用流式逐行读取（仅取所需行），避免整文件载入内存
  const STREAM_READ_THRESHOLD = 32 * 1024 * 1024 // 32 MiB
  // 禁止读取的敏感/系统根目录（绝对路径，匹配前缀即拒绝）
  const FORBID_READ_ROOTS: string[] = [
    'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
    '/etc', '/proc', '/sys', '/boot', '/usr/lib', '/Library'
  ]

  function detectEncoding(buffer: Buffer): 'utf16le' | 'utf8' {
    return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8'
  }

  // 借鉴 DeepSeek-Reasonix read_file 的编码/二进制探测：
  // 1) BOM UTF-16LE (FF FE) → utf16le
  // 2) 无 BOM 的 UTF-16（Windows 源码常见：ASCII 字符呈 X\0X\0 模式）→ utf16le
  // 3) 采样段含 NUL 字节 → 判定为二进制文件（非文本）
  // 返回 { binary, encoding }。encoding 在 binary=true 时无意义。
  function analyzeBuffer(buf: Buffer): { binary: boolean; encoding: 'utf16le' | 'utf8' } {
    const sampleLen = Math.min(buf.length, 256 * 1024)
    const sample = buf.subarray(0, sampleLen)
    // BOM UTF-16
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
      return { binary: false, encoding: 'utf16le' }
    }
    // 无 BOM UTF-16：前若干字节呈 X 0x00 X 0x00 模式（ASCII 透明）
    if (sample.length >= 4 && sample[1] === 0x00 && sample[3] === 0x00 && sample[0] !== 0x00) {
      let utf16ish = 0
      let total = 0
      const probe = Math.min(sample.length, 512)
      for (let i = 0; i + 1 < probe; i += 2) {
        total++
        if (sample[i + 1] === 0x00) utf16ish++
      }
      if (total > 0 && utf16ish / total > 0.8) {
        return { binary: false, encoding: 'utf16le' }
      }
    }
    // NUL 字节 → 二进制（如 .exe/.png/.zip）
    for (let i = 0; i < sampleLen; i++) {
      if (sample[i] === 0x00) return { binary: true, encoding: 'utf8' }
    }
    return { binary: false, encoding: 'utf8' }
  }

  function confineRead(target: string): boolean {
    const norm = resolve(target).toLowerCase()
    return FORBID_READ_ROOTS.some(r => norm.startsWith(r.toLowerCase()))
  }

  // 流式读取指定行范围（仅收集 offset..offset+limit-1 行，不整文件载入），
  // 同时统计总行数（继续读到文件末尾计数，但不保留多余行内容）。
  function readFileLinesStream(filePath: string, encoding: 'utf16le' | 'utf8', offset: number, limit: number): Promise<{ lines: string[]; totalLines: number }> {
    const out: string[] = []
    const wantStart = Math.max(1, offset)
    const wantEnd = wantStart + limit - 1
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: encoding === 'utf16le' ? 'utf16le' : 'utf8' }),
      crlfDelay: Infinity
    })
    let lineNo = 0
    return new Promise<{ lines: string[]; totalLines: number }>((resolve, reject) => {
      rl.on('line', (line: string) => {
        lineNo++
        if (lineNo < wantStart) return
        if (lineNo > wantEnd) { rl.close(); return }
        out.push(line)
      })
      rl.on('close', () => resolve({ lines: out, totalLines: lineNo }))
      rl.on('error', (e: Error) => reject(e))
    })
  }

  function readFileContent(filePath: string): { content: string; encoding: string; fileExists: boolean; binary?: boolean } {
    try {
      const buf = readFileSync(filePath)
      const { binary, encoding } = analyzeBuffer(buf)
      if (binary) return { content: '', encoding: 'utf8', fileExists: true, binary: true }
      const content = buf.toString(encoding as BufferEncoding).replaceAll('\r\n', '\n')
      return { content, encoding, fileExists: true }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: '', encoding: 'utf8', fileExists: false }
      }
      throw e
    }
  }

  function findActualString(fileContent: string, oldString: string): string | null {
    if (fileContent.includes(oldString)) return oldString
    const curly = oldString.replace(/'/g, '\u2018').replace(/'/g, '\u2019').replace(/"/g, '\u201c').replace(/"/g, '\u201d')
    if (fileContent.includes(curly)) return curly
    const straight = curly.replace(/\u2018/g, "'").replace(/\u2019/g, "'").replace(/\u201c/g, '"').replace(/\u201d/g, '"')
    if (straight !== curly && fileContent.includes(straight)) return straight
    return null
  }

  // 友好的"未找到 old_string"提示（借鉴 Reasonix oldStringNotFoundError）：
  // 给出与 old_string 首行最接近的文件行号与内容，并建议重新 Read 再编辑。
  function buildEditNotFoundHint(fileContent: string, oldString: string, filePath: string): string {
    const norm = oldString.replace(/\r\n/g, '\n')
    const firstLine = norm.split('\n')[0] ?? ''
    const lines = fileContent.split('\n')
    if (firstLine.trim()) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(firstLine)) {
          const snippet = lines[i]!.trim().slice(0, 200)
          return `未在文件中找到要替换的字符串。最近匹配行 ${i + 1}: ${snippet}\n请重新 Read 文件获取最新内容后再编辑；若多处相似，请提供更多上下文以精确定位。\n路径: ${filePath}`
        }
      }
    }
    return `未在文件中找到要替换的字符串:\n${oldString}\n请重新 Read 文件获取最新内容后再编辑，并确保 old_string 与文件当前内容完全一致（含空白与行尾）。\n路径: ${filePath}`
  }

  // 跨批冲突检测：记录文件内容快照（hash+mtime+size），edit 前比对以发现上次读取后被其他轮次/外部改动。
  interface FileSnapshot { mtimeMs: number; size: number; hash?: string }
  const fileSnapshots = new Map<string, FileSnapshot>()
  const SNAPSHOT_HASH_MAX = 5 * 1024 * 1024 // 仅对 <=5MB 文件算内容 hash，超出退回 mtime+size
  function computeFileSnapshot(fp: string): FileSnapshot | null {
    try {
      const st = statSync(fp)
      const snap: FileSnapshot = { mtimeMs: st.mtimeMs, size: st.size }
      if (st.size <= SNAPSHOT_HASH_MAX) {
        try { snap.hash = createHash('sha1').update(readFileSync(fp)).digest('hex') } catch { /* 忽略，退回 mtime */ }
      }
      return snap
    } catch { return null }
  }
  function recordFileSnapshot(fp: string): void { const s = computeFileSnapshot(fp); if (s) fileSnapshots.set(fp, s) }
  // 有旧快照且当前与之不一致 → 冲突；无旧快照 → 不判冲突（不强制先 Read）
  function detectFileConflict(fp: string): boolean {
    const prev = fileSnapshots.get(fp); if (!prev) return false
    const cur = computeFileSnapshot(fp); if (!cur) return false
    if (cur.size !== prev.size) return true
    if (prev.hash && cur.hash) return prev.hash !== cur.hash
    return cur.mtimeMs > prev.mtimeMs // 大文件无 hash → 退回 mtime
  }

  /** 用 ~4 chars/token 估算 token 数 */
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  /** 格式化行号：每 10 行显示一次行号，其余用 ":" 占位 */
  function formatLines(lines: string[], startLine: number): string {
    return lines.map((line, i) => {
      const lineNum = startLine + i
      if (lineNum % 10 === 1 || lineNum === startLine || i === lines.length - 1) {
        return `${lineNum}: ${line}`
      }
      return `: ${line}`
    }).join('\n')
  }

  ipcMain.handle('read-file', async (_e, filePath: string, opts?: { maxBytes?: number; offset?: number; limit?: number; raw?: boolean }): Promise<{
    success: boolean
    content?: string
    lines?: number
    totalLines?: number
    startLine?: number
    truncated?: boolean
    error?: string
    errorType?: string
    fileSize?: number
    suggestedCommand?: string
  }> => {
    try {
      filePath = resolveAgentPath(filePath)
      filePath = redirectToWorkspaceIfMissing(filePath)

      // 显式沙箱：拒绝读取禁止目录（借鉴 DeepSeek-Reasonix 的 confineRead / forbidRoots）
      if (confineRead(filePath)) {
        return { success: false, error: `权限不足，禁止读取受保护的系统目录：${filePath}`, errorType: 'PermissionDenied' }
      }

      // 结构化错误：检查路径是否存在、是否为目录、权限等
      let fileStat: import('fs').Stats
      try {
        fileStat = statSync(filePath)
        if (fileStat.isDirectory()) {
          return { success: false, error: `路径是目录，无法作为文件读取。请使用 ListDir 工具列出其内容，或读取其中的具体文件：${filePath}`, errorType: 'IsADirectory' }
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          return { success: false, error: `文件不存在：${filePath}`, errorType: 'FileNotFound' }
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return { success: false, error: `权限不足，无法读取：${filePath}`, errorType: 'PermissionDenied' }
        }
        throw e
      }

      const fileSize = fileStat.size
      if (fileSize > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `文件过大（${(fileSize / 1024 / 1024).toFixed(1)} MiB），最大允许读取 1 GiB`,
          errorType: 'FileTooLarge',
          fileSize
        }
      }

      // 仅「完整读取」（模型 Read 工具无 maxBytes）才更新内容快照作为编辑冲突基准；
      // 带 maxBytes 的部分/预览读取（UI 预览、Edit 前撤销备份读）不刷新快照，
      // 否则会覆盖模型 Read 时建立的基准，使 edit-file 的跨批冲突检测形同虚设。
      if (!(opts?.maxBytes && opts.maxBytes > 0)) recordFileSnapshot(filePath)

      // 预览场景（UI 文件浏览器）：仅读取前 maxBytes 字节
      const maxBytes = opts?.maxBytes ?? 0
      const previewLarge = maxBytes > 0 && fileSize > maxBytes
      let content: string
      let totalLines = 0
      if (previewLarge) {
        const fh = await fsPromises.open(filePath, 'r')
        try {
          const buf = Buffer.alloc(maxBytes)
          const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
          content = buf.slice(0, bytesRead).toString('utf-8')
        } finally {
          await fh.close()
        }
        content = content.replace(/[\uD800-\uDBFF]$/u, '')
        totalLines = content.split('\n').length
      } else {
        const r = readFileContent(filePath)
        if (!r.fileExists) {
          return { success: false, error: `文件不存在：${filePath}`, errorType: 'FileNotFound' }
        }
        // 二进制文件早拒（借鉴 DeepSeek-Reasonix 的 NUL 检测），避免乱码 token 污染上下文
        if (r.binary) {
          return {
            success: false,
            error: `文件为二进制文件（检测到 NUL 字节），read_file 不展示其内容。如需查看，请使用 Bash 的 hexdump 或 base64 命令：${filePath}`,
            errorType: 'BinaryFile',
            fileSize
          }
        }
        // 大文件（> 阈值）采用流式读取，仅取所需行，不整文件载入内存（借鉴 Reasonix 的流式 scan）
        if (fileSize > STREAM_READ_THRESHOLD) {
          const enc = (r.encoding === 'utf16le' ? 'utf16le' : 'utf8') as 'utf16le' | 'utf8'
          const offsetForStream = opts?.offset ?? 1
          const limitForStream = opts?.limit ?? 2000
          const streamed = await readFileLinesStream(filePath, enc, offsetForStream, limitForStream)
          content = streamed.lines.join('\n')
          totalLines = streamed.totalLines
        } else {
          content = r.content
          totalLines = content.split('\n').length
        }
      }

      const allLines = content.split('\n')

      // offset/limit 行级分片
      let offset = opts?.offset ?? 1
      // 未指定 limit 时，默认最多读取 2000 行（参考 grok-build 的「默认截断到 1000 行」），
      // 避免大文件一次性全文读入占用大量上下文；超出 token 预算时仍会引导改用 Grep。
      const DEFAULT_READ_LINES = 2000
      let limit = opts?.limit ?? DEFAULT_READ_LINES

      if (offset < 0) {
        offset = Math.max(1, totalLines + offset + 1)
      }
      offset = Math.max(1, Math.min(offset, totalLines))

      let endLine: number
      if (limit !== undefined && limit > 0) {
        endLine = Math.min(offset + limit - 1, totalLines)
      } else {
        endLine = totalLines
      }

      const selectedLines = allLines.slice(offset - 1, endLine)
      const slicedContent = selectedLines.join('\n')

      // Token 预算预估：超限则引导使用 Grep
      const estimatedTokens = estimateTokens(slicedContent)
      if (estimatedTokens > MAX_READ_TOKENS) {
        return {
          success: false,
          error: `内容过多（约 ${estimatedTokens} tokens，超出 ${MAX_READ_TOKENS} token 预算），`
            + `请缩小 offset/limit 范围，或使用 Grep 按关键字搜索`,
          errorType: 'FileTooLarge',
          fileSize,
          suggestedCommand: `grep(pattern, path: "${filePath}")`
        }
      }

      // 格式化行号：每 10 行显示一次行号。
      // raw=true 时跳过行号前缀，返回纯净原文——供 UI 文件预览（尤其是 Markdown 渲染）
      // 使用，避免 "N: " / ": " 前缀破坏 Markdown 语法（表现为满屏 "::::" 且标题/列表失效）。
      // 工具 Read 结果展示仍走带行号格式（对模型/工具卡片更友好）。
      const formattedContent = opts?.raw ? slicedContent : formatLines(selectedLines, offset)

      return {
        success: true,
        content: formattedContent,
        lines: selectedLines.length,
        totalLines,
        startLine: offset,
        truncated: previewLarge
      }
    } catch (e) {
      return { success: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}`, errorType: 'FileReadError' }
    }
  })

  // 读取文件并以 data URL（base64）形式返回，供渲染进程内联本地图片。
  // 预览面板里的 Markdown 可能引用相对路径图片（assets/xxx.png）；dev 模式下渲染进程
  // 是 http://localhost 源，无法加载 file:// 子资源，故把图片内联为 data: URL 以跨源显示。
  const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    avif: 'image/avif',
  }
  ipcMain.handle('read-file-base64', async (_e, filePath: string): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
    try {
      filePath = resolveAgentPath(filePath)
      const ext = /\.([a-z0-9]+)$/i.exec(filePath)
      const mime = ext ? (MIME_BY_EXT[ext[1]!.toLowerCase()] ?? 'application/octet-stream') : 'application/octet-stream'
      const buf = readFileSync(filePath)
      const base64 = buf.toString('base64')
      return { success: true, dataUrl: `data:${mime};base64,${base64}` }
    } catch (e) {
      return { success: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  ipcMain.handle('write-file', async (_e, filePath: string, content: string): Promise<{ success: boolean; error?: string }> => {
    try {
      filePath = resolveAgentPath(filePath)
      // SECURITY: 拒绝 UNC 路径防 NTLM 凭据泄露
      if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
        return { success: false, error: '不支持 UNC 路径' }
      }
      // SECURITY: 写入必须落在工作区/应用范围内，防止模型把文件写到工作区之外
      if (!isAgentPathInScope(resolve(filePath))) {
        return { success: false, error: '写入被拒绝：目标路径不在工作区/应用范围内，请改用工作区内的相对路径。' }
      }
      mkdirSync(dirname(filePath), { recursive: true })
      // 检测原文件编码并保留
      let encoding: string = 'utf8'
      if (existsSync(filePath)) {
        const buf = readFileSync(filePath)
        encoding = detectEncoding(buf)
      }
      await fsPromises.writeFile(filePath, content, encoding as BufferEncoding)
      recordFileSnapshot(filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  ipcMain.handle('edit-file', async (_e, filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ success: boolean; content?: string; error?: string }> => {
    try {
      filePath = resolveAgentPath(filePath)
      // SECURITY: 编辑目标必须落在工作区/应用范围内
      if (!isAgentPathInScope(resolve(filePath))) return { success: false, error: '编辑被拒绝：目标路径不在工作区/应用范围内。' }
      if (!existsSync(filePath)) return { success: false, error: '文件不存在' }

      // 跨批冲突检测：文件在上次读取/写入后被其他轮次或外部改动（内容 hash 快照比对）
      if (detectFileConflict(filePath)) {
        return { success: false, error: '文件在你上次读取后已被修改（可能由其他工具轮次或外部改动），请重新 Read 获取最新内容与 hashline 后再编辑。' }
      }

      // 文件大小限制
      const stat = statSync(filePath)
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MiB），最大允许编辑 1 GiB` }
      }

      const { content: fileContent, encoding } = readFileContent(filePath)

      // 行尾对齐（借鉴 Reasonix edit_file 的 matchLineEndings / CRLF 归一）：
      // Windows 项目文件常为 CRLF，而模型给出的 old_string/new_string 多用 LF。
      // 若文件行尾与给定串不一致，先把串对齐到文件行尾再匹配/替换，避免"找不到"误失败。
      const fileHasCRLF = fileContent.includes('\r\n')
      const alignLE = (s: string): string => {
        if (s == null) return s
        return fileHasCRLF ? s.replace(/\r\x0a/g, '\x0a').replace(/\x0a/g, '\r\x0a') : s.replace(/\r\x0a/g, '\x0a')
      }
      const oldNorm = alignLE(oldString ?? '')
      const newNorm = alignLE(newString ?? '')

      if (!oldString && fileContent.trim() !== '') {
        return { success: false, error: '文件已存在且非空，无法创建' }
      }

      if (!oldString && !fileContent.trim()) {
        // 空文件 + 空 oldString = 创建新内容
        const updated = newNorm
        await fsPromises.writeFile(filePath, updated, encoding as BufferEncoding)
        recordFileSnapshot(filePath)
        return { success: true, content: updated }
      }

      const actualOldString = findActualString(fileContent, oldNorm)
      if (!actualOldString) {
        // 友好错误提示（借鉴 Reasonix oldStringNotFoundError：给出最近匹配行 + 内容 + 重读建议）
        const hint = buildEditNotFoundHint(fileContent, oldNorm, filePath)
        return { success: false, error: hint }
      }

      // 多匹配检测
      const matches = fileContent.split(actualOldString).length - 1
      if (matches > 1 && !replaceAll) {
        return { success: false, error: `找到 ${matches} 处匹配，请设置 replaceAll=true 或提供更多上下文精确定位` }
      }

      // 用函数形式替换：字符串形式的替换串中 $$/$&/$`/$' 会被 JS 解释为特殊模式，
      // new_string 含这些序列（jQuery $(...)、shell $$、正则 $& 等）时会静默写入损坏的内容。
      const updated = replaceAll
        ? fileContent.replaceAll(actualOldString, () => newNorm)
        : fileContent.replace(actualOldString, () => newNorm)

      await fsPromises.writeFile(filePath, updated, encoding as BufferEncoding)
      recordFileSnapshot(filePath)
      return { success: true, content: updated }
    } catch (e) {
      return { success: false, error: `编辑失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  // ── Agent Code: glob / grep ──
  const GLOB_GREP_IGNORE_DIRS = new Set(['.git', 'node_modules'])

  // gitignore 单一真源：读取项目根 .gitignore，作为 ListDir/Grep 过滤依据
  // （参考 grok-build 的 gitignore.rs：屏蔽项以项目 .gitignore 为权威，而非硬编码目录名）。
  const gitignoreCache = new Map<string, { patterns: GitignorePattern[]; mtime: number }>()
  interface GitignorePattern { negated: boolean; re: RegExp; anchored: boolean }
  function parseGitignoreLine(line: string): GitignorePattern | null {
    let s = line.trim()
    if (!s || s.startsWith('#')) return null
    let negated = false
    if (s.startsWith('!')) { negated = true; s = s.slice(1).trim() }
    const anchored = s.startsWith('/')
    s = s.replace(/^\/+/, '')
    if (!s) return null
    // 转为正则：支持 ** * ? 并保留 /
    let re = ''
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!
      if (c === '*') {
        if (s[i + 1] === '*') {
          // ** 匹配任意层（含 /）
          re += '.*'
          i++
          if (s[i + 1] === '/') i++ // 吃掉 **/ 的斜杠
        } else {
          re += '[^/]*'
        }
      } else if (c === '?') re += '[^/]'
      else if ('+^${}()|[]\\.'.includes(c)) re += '\\' + c
      else re += c
    }
    // 以 / 结尾表示只匹配目录；这里统一按「路径段」匹配，宽松处理
    return { negated, anchored, re: new RegExp('^(?:.*/)?' + re + '(?:/.*)?$') }
  }
  function loadGitignorePatterns(root: string): GitignorePattern[] {
    const igPath = join(root, '.gitignore')
    try {
      const st = statSync(igPath)
      const cached = gitignoreCache.get(root)
      if (cached && cached.mtime === st.mtimeMs) return cached.patterns
      const text = readFileSync(igPath, 'utf-8')
      const patterns = text.split('\n').map(parseGitignoreLine).filter((p): p is GitignorePattern => !!p)
      gitignoreCache.set(root, { patterns, mtime: st.mtimeMs })
      return patterns
    } catch { return [] }
  }
  function isGitignored(relPath: string, patterns: GitignorePattern[]): boolean {
    if (patterns.length === 0) return false
    const p = relPath.split('\\').join('/')
    let ignored = false
    for (const pat of patterns) {
      if (pat.re.test(p)) ignored = !pat.negated
    }
    return ignored
  }

  function escapeRe(s: string): string {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  // 把 glob 模式转换为正则（支持 ** * ? {a,b} [abc]）
  function globToRegExp(pattern: string): RegExp {
    let re = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          re += '.*' // ** 匹配任意（含 /）
          i++
          if (pattern[i + 1] === '/') i++ // 跳过 **/ 中的 /
        } else {
          re += '[^/]*' // * 不匹配 /
        }
      } else if (c === '?') {
        re += '[^/]'
      } else if (c === '{') {
        const end = pattern.indexOf('}', i)
        if (end > i) {
          re += '(' + pattern.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'
          i = end
        } else {
          re += escapeRe(c)
        }
      } else if (c === '[') {
        const end = pattern.indexOf(']', i)
        if (end > i) {
          let cls = pattern.slice(i + 1, end)
          if (cls[0] === '!') cls = '^' + cls.slice(1)
          re += '[' + cls + ']'
          i = end
        } else {
          re += escapeRe(c)
        }
      } else {
        re += escapeRe(c)
      }
    }
    return new RegExp('^' + re + '$')
  }

  // 安全读取文本：跳过超大文件与二进制文件（含空字节）
  function readTextSafe(filePath: string, maxBytes: number): string | null {
    try {
      const st = statSync(filePath)
      if (st.size > maxBytes) return null
      const buf = readFileSync(filePath)
      if (buf.includes(0)) return null // 二进制
      return buf.toString('utf8')
    } catch {
      return null
    }
  }

  ipcMain.handle('glob', async (_e, opts: { pattern: string; path: string; limit?: number }): Promise<{ success: boolean; filenames?: string[]; numFiles?: number; truncated?: boolean; timedOut?: boolean; error?: string }> => {
    try {
      if (!opts || !opts.path) return { success: false, error: '缺少搜索目录' }
      opts.path = resolveAgentPath(opts.path)
      if (opts.path.startsWith('\\\\') || opts.path.startsWith('//')) return { success: false, error: '不支持 UNC 路径' }
      if (!existsSync(opts.path)) return { success: false, error: '目录不存在' }
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 2000))
      // 遍历预算超时（借鉴 DeepSeek-Reasonix glob 的 ctx 可取消）：超大 monorepo 搜 ** 时，
      // 同步递归 walk 会独占事件循环，setTimeout 回调根本没机会执行，故改用
      // Date.now() 截止时间在循环内主动比较——超时后停止继续遍历，
      // 保留已收集结果并返回 timedOut，避免主进程长时间阻塞。
      const GLOB_TIMEOUT_MS = 10_000
      const globDeadline = Date.now() + GLOB_TIMEOUT_MS
      let timedOut = false
      const checkGlobTimeout = (): boolean => {
        if (!timedOut && Date.now() > globDeadline) timedOut = true
        return timedOut
      }
      // 敏感文件过滤：与 grep 共用同一份 isSensitiveName 名单（见下方定义），
      // 避免两处名单各自维护时漂移。
      // 简单文件名回退（借鉴 DeepSeek-Reasonix glob 的 bare-filename fallback）：
      // 模型常只给 "*.ts" / "foo.ts" 这类不含路径分隔符的 pattern，却希望搜到全树任意层级的文件。
      // 由于 globToRegExp 用 [^/]* 匹配 *（不跨 /），裸 "*.ts" 只能命中搜索根直接下层。
      // 这里对「不含路径分隔符且非显式 ** 递归」的 pattern 自动改写为 "**/<pattern>"，
      // 使正则可跨目录深度匹配（等价于在整棵树中查找该文件名）。
      let effectivePattern = opts.pattern
      const hasSep = opts.pattern.includes('/') || opts.pattern.includes('\\')
      const isExplicitRecursive = opts.pattern.includes('**')
      if (!hasSep && !isExplicitRecursive) {
        effectivePattern = '**/' + opts.pattern
      }
      const re = globToRegExp(effectivePattern)
      const giPatterns = loadGitignorePatterns(opts.path)
      const found: string[] = []
      const walk = (dir: string) => {
        if (checkGlobTimeout() || found.length >= limit) return
        let entries: any[]
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (checkGlobTimeout() || found.length >= limit) return
          const full = join(dir, e.name)
          const rel = relative(opts.path, full).split('\\').join('/')
          if (isGitignored(rel, giPatterns)) continue
          if (e.isDirectory()) {
            if (GLOB_GREP_IGNORE_DIRS.has(e.name)) continue
            walk(full)
          } else if (e.isFile()) {
            if (re.test(rel) && !isSensitiveName(e.name)) found.push(full)
          }
        }
      }
      // path 既可为目录，也可为单个文件；为文件时若匹配模式则直接返回该文件
      const rootStat = statSync(opts.path)
      if (rootStat.isFile()) {
        if (re.test(basename(opts.path)) && !isSensitiveName(basename(opts.path))) found.push(opts.path)
      } else {
        walk(opts.path)
      }
      found.sort()
      const truncated = found.length >= limit
      return { success: true, filenames: found, numFiles: found.length, truncated, timedOut }
    } catch (e) {
      return { success: false, error: `搜索失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  ipcMain.handle('list-dir', async (_e, dirPath: string): Promise<{
    success: boolean
    entries?: { name: string; isDir: boolean; fileCount: number; size?: number }[]
    truncated?: boolean
    total?: number
    error?: string
  }> => {
    try {
      if (!dirPath) return { success: false, error: '缺少路径' }
      const resolved = resolve(redirectToWorkspaceIfMissing(resolveAgentPath(dirPath)))
      if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return { success: false, error: '不支持 UNC 路径' }
      if (!existsSync(resolved)) return { success: false, error: '目录不存在' }
      const stat = statSync(resolved)
      if (!stat.isDirectory()) return { success: false, error: '路径不是目录' }
      const entries = readdirSync(resolved, { withFileTypes: true })
      // 默认排除：版本控制/依赖/构建产物等无分析价值的重目录与隐藏文件（兜底），
      // 并叠加项目 .gitignore 的忽略项（gitignore 单一真源，参考 grok-build）。
      const LISTDIR_IGNORE = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.idea', '.vscode', 'target', 'bin', 'obj'])
      const giPatterns = loadGitignorePatterns(resolved)
      const children = entries
        .filter(e => {
          if (!(e.isDirectory() || e.isFile())) return false
          if (LISTDIR_IGNORE.has(e.name)) return false
          if (e.name.startsWith('.')) return false
          if (giPatterns.length && isGitignored(e.name, giPatterns)) return false
          return true
        })
        .map(e => {
          const isDir = e.isDirectory()
          let fileCount = 0
          let size: number | undefined
          if (isDir) {
            try { fileCount = readdirSync(join(resolved, e.name)).length } catch { }
          } else {
            try { size = statSync(join(resolved, e.name)).size } catch { }
          }
          return { name: e.name, isDir, fileCount, size }
        })
        .sort((a, b) => {
          if (a.isDir && !b.isDir) return -1
          if (!a.isDir && b.isDir) return 1
          return a.name.localeCompare(b.name)
        })
      const MAX_ITEMS = 1000
      const truncated = children.length > MAX_ITEMS
      return { success: true, entries: children.slice(0, MAX_ITEMS), truncated, total: children.length }
    } catch (e) {
      return { success: false, error: `列出目录失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  const DEFAULT_MAX_CHARS_PER_LINE = 1_000
  const TYPE_GLOB_MAP: Record<string, string> = {
    py: '*.py', js: '*.js', ts: '*.{ts,tsx}', 'c++': '*.{cpp,cc,cxx}',
    cpp: '*.{cpp,cc,cxx}', cc: '*.{cpp,cc,cxx}', c: '*.{c,h}',
    h: '*.{c,h}', java: '*.java', rs: '*.rs', rust: '*.rs',
    go: '*.go', css: '*.css', html: '*.html', json: '*.json',
    md: '*.md', markdown: '*.md', yaml: '*.{yaml,yml}', yml: '*.{yaml,yml}',
    toml: '*.toml', xml: '*.xml', sql: '*.sql', sh: '*.sh',
    bash: '*.sh', ps1: '*.ps1', powershell: '*.ps1', dockerfile: 'Dockerfile',
    makefile: 'Makefile', gitignore: '.gitignore',
  }

  // 敏感文件过滤（glob / grep 共用单一名单，借鉴 Reasonix 的 secrets.ProtectSensitiveFiles）：
  // 命中的密钥/凭证类文件不进入结果；grep 会读取文件内容，若命中 .env / 私钥
  // 会把它的值展示进上下文，风险更高，必须剔除。更新名单只改这一处。
  const SENSITIVE_FILES = new Set([
    '.env', '.env.local', '.env.development', '.env.production', '.env.example',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts',
    'credentials.json', 'credentials.yml', 'credentials.yaml',
    '.npmrc', '.pypirc', '.netrc', '*.key', '*.pem', '*.p12', '*.pfx', '*.keystore', '*.jks'
  ])
  function matchSimple(name: string, pat: string): boolean {
    if (!pat.includes('*')) return name === pat
    const prefix = pat.slice(0, pat.indexOf('*'))
    const suffix = pat.slice(pat.indexOf('*') + 1)
    return name.startsWith(prefix) && (suffix === '' || name.endsWith(suffix))
  }
  function isSensitiveName(name: string): boolean {
    if (SENSITIVE_FILES.has(name)) return true
    return [...SENSITIVE_FILES].some(p => p.includes('*') && matchSimple(name, p))
  }

  /** 截断过长的行 */
  function trimLine(line: string, maxChars: number): string {
    if (line.length <= maxChars) return line
    return line.slice(0, maxChars) + ` [... truncated ${line.length - maxChars} chars]`
  }

  ipcMain.handle('grep', async (_e, opts: { pattern: string; path: string; glob?: string; output_mode?: string; head_limit?: number; '-i'?: boolean; context?: number; '-n'?: boolean; type?: string; timeout_seconds?: number }): Promise<{ success: boolean; content?: string; numFiles?: number; truncated?: boolean; timedOut?: boolean; error?: string }> => {
    // timeout_seconds 可调（借鉴 Reasonix grep 的 timeout_seconds，1-300s 封顶），
    // 0/省略回退默认 20s，避免大仓库搜索被固定超时截断、也防止模型设极大值挂起。
    const DEFAULT_GREP_TIMEOUT_MS = 20_000
    const reqSec = typeof opts.timeout_seconds === 'number' && opts.timeout_seconds > 0 ? opts.timeout_seconds : 0
    const timeoutMs = reqSec > 0
      ? Math.min(Math.max(reqSec * 1000, 1000), 300_000)
      : DEFAULT_GREP_TIMEOUT_MS
    let timedOut = false
    // 同步遍历/逐文件匹配全程不让出事件循环，setTimeout 置标志永远不会触发，
    // 改用截止时间在循环内主动比较，超时后返回部分结果。
    const grepDeadline = Date.now() + timeoutMs
    const checkGrepTimeout = (): boolean => {
      if (!timedOut && Date.now() > grepDeadline) timedOut = true
      return timedOut
    }

    const returnResult = (result: { success: boolean; content?: string; numFiles?: number; truncated?: boolean; error?: string }) => {
      return { ...result, timedOut }
    }

    try {
      if (!opts || !opts.path) return returnResult({ success: false, error: '缺少搜索目录' })
      opts.path = resolveAgentPath(opts.path)
      if (opts.path.startsWith('\\\\') || opts.path.startsWith('//')) return returnResult({ success: false, error: '不支持 UNC 路径' })
      if (!existsSync(opts.path)) return returnResult({ success: false, error: '目录不存在' })
      const root = opts.path
      const mode = (opts.output_mode || 'files_with_matches') as 'content' | 'files_with_matches' | 'count'
      const headLimit = opts.head_limit === undefined ? 250 : opts.head_limit
      const flags = opts['-i'] ? 'i' : ''
      let regex: RegExp
      try { regex = new RegExp(opts.pattern, flags) } catch (e) { return returnResult({ success: false, error: `无效正则：${e instanceof Error ? e.message : String(e)}` }) }
      let globPattern = opts.glob
      if (!globPattern && opts.type && TYPE_GLOB_MAP[opts.type]) {
        globPattern = TYPE_GLOB_MAP[opts.type]
      }
      const globRe = globPattern ? globToRegExp(globPattern) : null
      const ctx = opts.context ?? 0
      const showLineNumbers = opts['-n'] !== false
      const maxBytes = 5 * 1024 * 1024

      const files: string[] = []
      const giPatterns = loadGitignorePatterns(root)
      const walk = (dir: string) => {
        if (files.length >= 20000) return
        let entries: any[]
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (checkGrepTimeout()) return
          const full = join(dir, e.name)
          const rel = relative(root, full).split('\\').join('/')
          if (isGitignored(rel, giPatterns)) continue
          if (e.isDirectory()) {
            if (GLOB_GREP_IGNORE_DIRS.has(e.name)) continue
            walk(full)
          } else if (e.isFile()) {
            if (globRe && !globRe.test(rel)) continue
            if (isSensitiveName(e.name)) continue
            files.push(full)
          }
        }
      }
      const rootStat = statSync(root)
      if (rootStat.isFile()) {
        if ((!globRe || globRe.test(basename(root))) && !isSensitiveName(basename(root))) files.push(root)
      } else {
        walk(root)
      }
      if (timedOut) return returnResult({ success: true, content: '搜索超时，返回部分结果。请缩小搜索范围或使用更具体的参数。', numFiles: 0, truncated: true })

      // 精确匹配检测：收集 headLimit+1 个结果，区分 exact-fit vs truncation
      const processLimit = headLimit === 0 ? Infinity : headLimit + 1

      if (mode === 'files_with_matches') {
        const matched: string[] = []
        for (const f of files) {
          if (checkGrepTimeout()) break
          if (headLimit !== 0 && matched.length >= processLimit) break
          const text = readTextSafe(f, maxBytes)
          if (text === null) continue
          if (text.split('\n').some(l => regex.test(l))) matched.push(f)
        }
        const truncated = headLimit !== 0 && matched.length > headLimit
        const items = headLimit === 0 ? matched : matched.slice(0, headLimit)
        return returnResult({
          success: true,
          numFiles: items.length,
          truncated,
          content: items.length ? `Found ${items.length} file(s):\n${items.join('\n')}${truncated ? '\n(结果已截断)' : ''}` : 'No files found.'
        })
      }

      if (mode === 'count') {
        const lines: string[] = []
        let total = 0
        for (const f of files) {
          if (checkGrepTimeout()) break
          if (headLimit !== 0 && lines.length >= processLimit) break
          const text = readTextSafe(f, maxBytes)
          if (text === null) continue
          const c = text.split('\n').filter(l => regex.test(l)).length
          if (c > 0) { lines.push(`${f}:${c}`); total += c }
        }
        const truncated = headLimit !== 0 && lines.length > headLimit
        const items = headLimit === 0 ? lines : lines.slice(0, headLimit)
        return returnResult({
          success: true,
          numFiles: items.length,
          truncated,
          content: `Found ${total} matches across ${items.length} file(s):\n${items.join('\n')}${truncated ? '\n(结果已截断)' : ''}`
        })
      }

      // content 模式
      const outLines: string[] = []
      let fileCount = 0
      for (const f of files) {
        if (checkGrepTimeout()) break
        if (headLimit !== 0 && outLines.length >= processLimit) break
        const text = readTextSafe(f, maxBytes)
        if (text === null) continue
        const fileLines = text.split('\n')
        const wanted = new Set<number>()
        for (let i = 0; i < fileLines.length; i++) {
          if (regex.test(fileLines[i]!)) {
            for (let j = Math.max(0, i - ctx); j <= Math.min(fileLines.length - 1, i + ctx); j++) wanted.add(j)
          }
        }
        if (wanted.size === 0) continue
        fileCount++
        const sorted = [...wanted].sort((a, b) => a - b)
        for (const idx of sorted) {
          const line = trimLine(fileLines[idx]!, DEFAULT_MAX_CHARS_PER_LINE)
          outLines.push(showLineNumbers ? `${f}:${idx + 1}:${line}` : `${f}:${line}`)
        }
        if (headLimit !== 0 && outLines.length >= processLimit) break
      }
      const truncated = headLimit !== 0 && outLines.length > headLimit
      const items = headLimit === 0 ? outLines : outLines.slice(0, headLimit)
      return returnResult({
        success: true,
        numFiles: fileCount,
        truncated,
        content: items.length ? `${items.join('\n')}${truncated ? '\n(结果已截断)' : ''}` : 'No matches found.'
      })
    } catch (e) {
      return returnResult({ success: false, error: `搜索失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // ── 文件树浏览 ──
  ipcMain.handle('build-file-tree', async (_e, dir: string, maxDepth = 3): Promise<{ success: boolean; tree?: { name: string; path: string; isDir: boolean; children?: any[] }; error?: string }> => {
    try {
      if (!existsSync(dir)) return { success: false, error: '目录不存在' }
      async function buildTree(dirPath: string, depth: number): Promise<{ name: string; path: string; isDir: boolean; children?: any[] }> {
        const name = basename(dirPath)
        const node: any = { name, path: dirPath, isDir: true, children: [] }
        const entries = readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory() && depth > 0) {
            const child = await buildTree(fullPath, depth - 1)
            node.children.push(child)
          } else if (entry.isFile()) {
            node.children.push({ name: entry.name, path: fullPath, isDir: false })
          }
        }
        node.children.sort((a: any, b: any) => a.name.localeCompare(b.name))
        return node
      }
      const tree = await buildTree(dir, maxDepth)
      return { success: true, tree }
    } catch (e) {
      return { success: false, error: `读取目录失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  ipcMain.handle('expand-file-tree', async (_e, dir: string, limit = 500): Promise<{ success: boolean; children?: { name: string; path: string; isDir: boolean; size?: number }[]; truncated?: boolean; total?: number; error?: string }> => {
    try {
      if (!existsSync(dir)) return { success: false, error: '目录不存在' }
      const entries = readdirSync(dir, { withFileTypes: true })
      const all = entries
        .filter(e => e.isDirectory() || e.isFile())
        .map(e => {
          const isDir = e.isDirectory()
          let size: number | undefined
          if (!isDir) { try { size = statSync(join(dir, e.name)).size } catch { /* ignore */ } }
          return { name: e.name, path: join(dir, e.name), isDir, size }
        })
        .sort((a, b) => {
          if (a.isDir && !b.isDir) return -1
          if (!a.isDir && b.isDir) return 1
          return a.name.localeCompare(b.name)
        })
      const truncated = all.length > limit
      const children = all.slice(0, limit)
      return { success: true, children, truncated, total: all.length }
    } catch (e) {
      return { success: false, error: `展开目录失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  // ── Agent Code 输入框 @ 文件补全：递归扁平列举工作区全部文件（带上限保护）──
  // 跳过 .git / node_modules 等噪声目录；仅收集文件（不含目录）。
  ipcMain.handle('list-flat-files', (_e, dir: string, opts?: { maxDepth?: number; maxFiles?: number }): { success: boolean; files?: { name: string; path: string; relPath: string }[]; truncated?: boolean; total?: number; error?: string } => {
    try {
      if (!dir || !existsSync(dir)) return { success: false, error: '目录不存在' }
      // 路径安全：防止通过异常路径遍历越出工作区
      if (!isSafePath(dir, dir)) return { success: false, error: '访问被拒绝' }
      const maxDepth = Math.max(1, Math.min(opts?.maxDepth ?? 12, 32))
      const maxFiles = Math.max(100, Math.min(opts?.maxFiles ?? 3000, 20000))
      const SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.cache'])
      const root = resolve(dir)
      const files: { name: string; path: string; relPath: string }[] = []
      let truncated = false
      const walk = (cur: string, depth: number) => {
        if (truncated || depth > maxDepth) return
        let entries
        try { entries = readdirSync(cur, { withFileTypes: true }) } catch { return }
        // 目录优先深度遍历，文件收集；保持一定顺序稳定性
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (truncated) return
          const full = join(cur, entry.name)
          if (entry.isDirectory()) {
            if (SKIP.has(entry.name)) continue
            walk(full, depth + 1)
          } else if (entry.isFile()) {
            if (files.length >= maxFiles) { truncated = true; return }
            const rel = relative(root, full).split(sep).join('/')
            files.push({ name: entry.name, path: full, relPath: rel })
          }
        }
      }
      walk(root, 1)
      return { success: true, files, truncated, total: files.length }
    } catch (e) {
      return { success: false, error: `列举文件失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  // ── Agent Code 文件树：自动监听目录变化（免去手动刷新按钮）──
  let agentFileWatcher: import('fs').FSWatcher | null = null
  function startAgentFileWatch(dir: string): { success: boolean; error?: string } {
    try {
      if (agentFileWatcher) { agentFileWatcher.close(); agentFileWatcher = null }
      const watcher = watch(
        dir,
        process.platform === 'win32' || process.platform === 'darwin' ? { recursive: true } : {},
        (_event, filename) => {
          const payload = { dir, filename: typeof filename === 'string' ? filename : '' }
          BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('agent-file-changed', payload) })
        }
      )
      watcher.on('error', () => { /* 目录被删除等瞬时错误，忽略 */ })
      agentFileWatcher = watcher
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  function stopAgentFileWatch(): void {
    if (agentFileWatcher) { try { agentFileWatcher.close() } catch { /* ignore */ } agentFileWatcher = null }
  }
  ipcMain.handle('start-agent-file-watch', (_e, dir: string) => startAgentFileWatch(dir))
  ipcMain.handle('stop-agent-file-watch', () => { stopAgentFileWatch(); return { success: true } })

  // ── 认知地图服务（codeMapService）：codemap-* 通道集中注册 ──
  registerCodeMapIpc(APP_ROOT)
  // ── 代码混合检索服务（retrievalService）：codesearch-* 通道 ──
  registerRetrievalIpc()
  // 长期记忆存储（模块二 · 阶段 2.3）：分类条目沉淀 / 注入 / 矛盾仲裁
  registerMemoryStoreIpc(APP_ROOT)
  // 本地知识库 RAG（knowledgeService）：knowledge-* 通道（BM25 检索 + 落盘）
  registerKnowledgeIpc(APP_ROOT)

  // ── Agent Tracing 落盘 ──
  // 把每次工具执行的审计条目追加到 Agent session/traces/<sessionId>.jsonl，
  // 供进程重启后复现问题（内存环形缓冲重启即丢）。单文件超过上限做一次轮转（.1），最多占 2×上限。
  const AGENT_TRACES_DIR = join(APP_ROOT, 'Agent session', 'traces')
  const TRACE_MAX_BYTES = 4 * 1024 * 1024
  ipcMain.handle('agent-trace-append', (_e, sessionId: string, entry: unknown): { success: boolean; error?: string } => {
    try {
      if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes('..')) return { success: false, error: '无效的 sessionId' }
      if (!existsSync(AGENT_TRACES_DIR)) mkdirSync(AGENT_TRACES_DIR, { recursive: true })
      const file = join(AGENT_TRACES_DIR, `${sessionId}.jsonl`)
      if (!isSafePath(AGENT_TRACES_DIR, file)) return { success: false, error: '访问被拒绝' }
      try { if (existsSync(file) && statSync(file).size > TRACE_MAX_BYTES) renameSync(file, file + '.1') } catch { /* 轮转失败则直接追加 */ }
      writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Agent Code 工作台：项目（含会话）持久化 ──
  // 每个会话独立存储为一个 JSON 文件，统一放在 `Agent session/` 文件夹下：
  //   Agent session/<sessionId>.json  —— 单个会话的全部消息 + 所属项目信息
  // 加载时按 projectId 分组重建出项目列表；空文件夹通过 .gitkeep 保留在仓库中。
  const AGENT_PROJECTS_DIR = join(APP_ROOT, 'Agent session')
  // 遗留单文件（旧版：所有会话塞进一个 agent-projects.json）
  const AGENT_PROJECTS_LEGACY_PATH = join(AGENT_PROJECTS_DIR, 'agent-projects.json')
  const AGENT_PROJECTS_ROOT_LEGACY_PATH = join(APP_ROOT, 'agent-projects.json')

  // 单个会话落盘文件结构：在 AgentSession 基础上附带项目信息，便于按项目分组还原
  interface SessionFile {
    id: string
    title: string
    projectId: string
    projectTitle: string
    workspaceDir: string
    createdAt: number
    messages: AgentMessage[]
  }

  function ensureAgentProjectsDir(): void {
    if (!existsSync(AGENT_PROJECTS_DIR)) mkdirSync(AGENT_PROJECTS_DIR, { recursive: true })
  }

  // 将遗留的单文件（所有会话）拆分为多个独立会话文件，并删除旧单文件
  async function migrateLegacyAgentProjects(): Promise<void> {
    for (const legacy of [AGENT_PROJECTS_LEGACY_PATH, AGENT_PROJECTS_ROOT_LEGACY_PATH]) {
      if (!existsSync(legacy)) continue
      let data: unknown = null
      try { data = JSON.parse(readFileSync(legacy, 'utf-8')) } catch { /* 损坏则直接丢弃 */ }
      if (Array.isArray(data)) {
        ensureAgentProjectsDir()
        let order = 0
        for (const p of data as AgentProject[]) {
          for (const s of p.sessions || []) {
            const file: SessionFile = {
              id: s.id,
              title: s.title,
              projectId: p.id,
              projectTitle: p.title,
              workspaceDir: p.workspaceDir,
              createdAt: Date.now() + order++,
              messages: s.messages || [],
            }
            try {
              await fsPromises.writeFile(join(AGENT_PROJECTS_DIR, `${s.id}.json`), JSON.stringify(file, null, 2))
            } catch { /* 单条失败不影响其他 */ }
          }
        }
      }
      try { unlinkSync(legacy) } catch { /* 旧文件删除失败不影响使用 */ }
    }
  }

  // 读取所有独立会话文件，按 projectId 分组重建出项目列表；无会话文件时尝试迁移遗留单文件
  async function loadAgentProjectsFromDisk(): Promise<AgentProject[]> {
    ensureAgentProjectsDir()
    let files: string[] = []
    try {
      files = readdirSync(AGENT_PROJECTS_DIR).filter(f => f.endsWith('.json') && f !== 'agent-projects.json')
    } catch { return [] }
    const sessions: SessionFile[] = []
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(AGENT_PROJECTS_DIR, f), 'utf-8'))
        if (raw && typeof raw.id === 'string' && Array.isArray(raw.messages)) sessions.push(raw as SessionFile)
      } catch { /* 跳过损坏文件 */ }
    }
    if (sessions.length === 0) {
      if (existsSync(AGENT_PROJECTS_LEGACY_PATH) || existsSync(AGENT_PROJECTS_ROOT_LEGACY_PATH)) {
        await migrateLegacyAgentProjects()
        return loadAgentProjectsFromDisk() // 重新读取刚写好的独立会话文件
      }
      return []
    }
    // 按 projectId 分组
    const byProject = new Map<string, SessionFile[]>()
    for (const s of sessions) {
      const arr = byProject.get(s.projectId) ?? []
      arr.push(s)
      byProject.set(s.projectId, arr)
    }
    const projects: AgentProject[] = []
    const orderInfo: { id: string; minCreated: number }[] = []
    for (const [projectId, sessList] of byProject) {
      sessList.sort((a, b) => a.createdAt - b.createdAt)
      const first = sessList[0]!
      projects.push({
        id: projectId,
        title: first.projectTitle || projectId,
        workspaceDir: first.workspaceDir || '',
        expanded: true,
        sessions: sessList.map(s => ({ id: s.id, title: s.title, messages: s.messages })),
      })
      orderInfo.push({ id: projectId, minCreated: Math.min(...sessList.map(s => s.createdAt)) })
    }
    projects.sort((a, b) => {
      const am = orderInfo.find(o => o.id === a.id)!.minCreated
      const bm = orderInfo.find(o => o.id === b.id)!.minCreated
      return am - bm
    })
    return projects
  }

  ipcMain.handle('load-agent-projects', async (): Promise<AgentProject[]> => {
    try {
      return await loadAgentProjectsFromDisk()
    } catch (e) {
      console.error('[load-agent-projects] 读取失败:', e)
      return []
    }
  })
  ipcMain.handle('save-agent-projects', async (_e, projects: AgentProject[]): Promise<{ success: boolean; error?: string }> => {
    try {
      ensureAgentProjectsDir()
      // 没有任何含会话的项目 → 跳过落盘和 GC，防止误删磁盘数据
      if (!projects || projects.length === 0 || projects.every(p => !p.sessions || p.sessions.length === 0)) {
        return { success: true }
      }
      const liveIds = new Set<string>()
      for (const p of projects || []) {
        for (const s of p.sessions || []) {
          liveIds.add(s.id)
          // 保留已有文件的 createdAt，保证排序稳定（新会话用当前时间戳）
          let createdAt = Date.now()
          const existingPath = join(AGENT_PROJECTS_DIR, `${s.id}.json`)
          try {
            if (existsSync(existingPath)) {
              const ex = JSON.parse(readFileSync(existingPath, 'utf-8'))
              if (typeof ex.createdAt === 'number') createdAt = ex.createdAt
            }
          } catch { /* 忽略，使用新时间戳 */ }
          const file: SessionFile = {
            id: s.id,
            title: s.title,
            projectId: p.id,
            projectTitle: p.title,
            workspaceDir: p.workspaceDir,
            createdAt,
            messages: s.messages || [],
          }
          await fsPromises.writeFile(existingPath, JSON.stringify(file, null, 2))
        }
      }
      // GC：删除已被删除会话残留的孤立文件（排除遗留单文件，含 .tasks.json）
      let allFiles: string[] = []
      try { allFiles = readdirSync(AGENT_PROJECTS_DIR) } catch { allFiles = [] }
      for (const f of allFiles) {
        if (!f.endsWith('.json')) continue
        if (f === 'agent-projects.json') continue
        const sessionId = f.endsWith('.tasks.json') ? f.slice(0, -11) : f.slice(0, -5)
        if (!liveIds.has(sessionId)) {
          try { unlinkSync(join(AGENT_PROJECTS_DIR, f)) } catch { /* ignore */ }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Agent Code 任务清单（Todo / Task）─────────────────
  // 每个会话的任务清单持久化为 <sessionId>.tasks.json（与会话文件同目录），
  // 主进程内用 Map 缓存，惰性加载、每次变更落盘。
  const agentTaskStore = new Map<string, AgentTask[]>()

  function agentTaskFilePath(sessionId: string): string {
    return join(AGENT_PROJECTS_DIR, `${sessionId}.tasks.json`)
  }

  function loadAgentTasks(sessionId: string): AgentTask[] {
    const cached = agentTaskStore.get(sessionId)
    if (cached) return cached
    let tasks: AgentTask[] = []
    try {
      const p = agentTaskFilePath(sessionId)
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (Array.isArray(parsed)) tasks = parsed as AgentTask[]
      }
    } catch (e) {
      console.error('[agent-task] 读取失败:', e)
      tasks = []
    }
    agentTaskStore.set(sessionId, tasks)
    return tasks
  }

  function saveAgentTasks(sessionId: string, tasks: AgentTask[]): void {
    agentTaskStore.set(sessionId, tasks)
    try {
      ensureAgentProjectsDir()
      writeFileSync(agentTaskFilePath(sessionId), JSON.stringify(tasks, null, 2))
    } catch (e) {
      console.error('[agent-task] 保存失败:', e)
    }
  }

  function validateNoDuplicateIds(updates: TodoUpdate[]): string | null {
    const seen = new Set<string>()
    for (const u of updates) {
      if (u.id && seen.has(u.id)) return u.id
      if (u.id) seen.add(u.id)
    }
    return null
  }

  function todoContentFallback(u: TodoUpdate): string {
    if (u.content && u.content.length > 0) return u.content
    return u.id ?? ''
  }

  function todoUpdateToAgentTask(u: TodoUpdate, i: number, now: number): AgentTask {
    return {
      id: u.id || String(i + 1),
      subject: todoContentFallback(u),
      description: u.description ?? '',
      status: u.status || 'pending',
      activeForm: u.activeForm,
      priority: u.priority || 'medium',
      notes: u.notes ?? '',
      createdAt: now,
      updatedAt: now
    }
  }

  ipcMain.handle('agent-todo-write', async (_e, sessionId: string, input: { merge: boolean; todos: TodoUpdate[] }): Promise<{ success: boolean; tasks?: AgentTask[]; error?: string }> => {
    try {
      const updates = input?.todos ?? []

      // Validate duplicate IDs
      const dup = validateNoDuplicateIds(updates)
      if (dup) return { success: false, error: `重复的 todo ID: "${dup}"。每个 todo 必须有唯一 ID。` }

      const now = Date.now()
      const existing = loadAgentTasks(sessionId)

      // Auto-upgrade to merge when state is non-empty and all updates target
      // existing IDs without providing content (model forgot merge:true).
      const autoMerge = !input.merge
        && existing.length > 0
        && updates.length > 0
        && updates.every(u => !(u.content?.length) && existing.some(e => e.id === u.id))

      const effectiveMerge = input.merge || autoMerge

      let tasks: AgentTask[]
      if (effectiveMerge) {
        const byId = new Map(existing.map(t => [t.id, t]))
        for (const u of updates) {
          const existingTask = u.id ? byId.get(u.id) : undefined
          if (existingTask) {
            if (u.content?.length) existingTask.subject = u.content
            if (u.description !== undefined) existingTask.description = u.description
            if (u.status) existingTask.status = u.status as AgentTaskStatus
            if (u.priority) existingTask.priority = u.priority
            if (u.activeForm !== undefined) existingTask.activeForm = u.activeForm
            if (u.notes !== undefined) existingTask.notes = u.notes
            existingTask.updatedAt = now
          } else {
            const task = todoUpdateToAgentTask(u, byId.size, now)
            byId.set(task.id, task)
          }
        }
        tasks = Array.from(byId.values())
      } else {
        // Replace mode: clear and build fresh list
        tasks = updates.map((u, i) => todoUpdateToAgentTask(u, i, now))
      }

      saveAgentTasks(sessionId, tasks)
      return { success: true, tasks }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent-task-get', async (_e, sessionId: string, taskId: string): Promise<{ success: boolean; task?: AgentTask; error?: string }> => {
    const task = loadAgentTasks(sessionId).find(t => t.id === String(taskId))
    return task ? { success: true, task } : { success: false, error: `Task ${taskId} not found` }
  })

  ipcMain.handle('agent-task-list', async (_e, sessionId: string): Promise<{ success: boolean; tasks: AgentTask[] }> => {
    return { success: true, tasks: loadAgentTasks(sessionId) }
  })

  // ── Agent Code Bash 执行 ────────────────────────────
  // 当前工作目录（由渲染进程在切换项目时通过 set-bash-cwd 同步过来）
  let bashCwd: string | null = null
  ipcMain.handle('set-bash-cwd', async (_e, dir: string) => {
    bashCwd = dir || null
    return { success: true }
  })

  // Agent Code 文件工具的“工作区根目录”。渲染进程在切换项目/目录时通过
  // set-agent-workspace 同步过来。模型若给出相对路径，统一在下面各 handler 中解析到
  // 工作区根目录，避免相对路径被错误地解析到应用进程的工作目录（process.cwd()），
  // 从而出现“在 test 同级目录新建目录而非在 test 内创建文件”这类错位。
  let agentWorkspaceRoot: string | null = null
  ipcMain.handle('set-agent-workspace', async (_e, dir: string) => {
    agentWorkspaceRoot = dir || null
    return { success: true }
  })

  // 将超长工具结果完整写入系统临时目录，返回绝对路径，供模型用 Read 查看完整内容。
  // 对应 grok-build 的「showing first/last，完整输出保存至文件」策略。
  ipcMain.handle('write-temp-file', async (_e, content: string, ext = 'txt'): Promise<{ success: boolean; path?: string; error?: string }> => {
    try {
      const dir = join(tmpdir(), 'llama-studio-agent')
      mkdirSync(dir, { recursive: true })
      const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'txt'
      const name = `tool-output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`
      const full = join(dir, name)
      writeFileSync(full, String(content ?? ''), 'utf-8')
      return { success: true, path: full }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  })

  // 清理模型给出的路径参数：去掉首尾空白、包裹的引号、以及（仅当被引号包裹时）
  // 字面的 \r\n\t 转义——避免误吞 Windows 路径里的反斜杠。
  function sanitizeAgentPathArg(raw: string): string {
    let s = String(raw ?? '')
    s = s.trim()
    // 去掉模型常在外面裹的单/双引号
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim()
    }
    // 去掉尾部换行（模型偶尔在 JSON 参数里带 \n）
    s = s.replace(/\r?\n+$/, '')
    // 仅当原参数被引号包裹时才剥离字面转义，避免破坏 Windows 路径反斜杠
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      s = s.replace(/\\r|\\n|\\t/g, '')
    }
    return s
  }

  // 将模型给出的（可能相对的）路径解析到工作区根目录；绝对路径原样返回
  function resolveAgentPath(raw: string): string {
    const p = sanitizeAgentPathArg(raw)
    if (!p) return p
    if (isAbsolute(p)) return p
    if (agentWorkspaceRoot) return resolve(agentWorkspaceRoot, p)
    return p
  }

  // 智能重定向：当解析后的路径不存在，但取文件名放到工作区根下能命中真实文件时，
  // 重定向过去。主要处理模型把「嵌套目录」与「项目根」搞混的情况
  // （如实际文件在 C:\proj\example.md，模型却传 C:\proj\sub\example.md）。
  function redirectToWorkspaceIfMissing(p: string): string {
    if (agentWorkspaceRoot && !existsSync(p)) {
      const alt = resolve(agentWorkspaceRoot, basename(p))
      if (alt !== p && existsSync(alt)) return alt
    }
    return p
  }

  // ── 后台任务管理器 ──────────────────────────────────
  interface BackgroundTask {
    id: string
    command: string
    pid: number
    startTime: number
    stdout: string
    stderr: string
    code: number | null
    status: 'running' | 'completed' | 'killed' | 'timeout'
    totalBytes: number
    truncated: boolean
    outputFile: string
    isBackground: boolean
    autoBackgrounded: boolean
    // 运行期输出缓冲区引用：stdout/stderr 字段只在 close 时回填，而 dev server 等核心场景
    // 永不退出 → 查询接口运行期永远拿到空输出。挂上缓冲区，查询时对 running 任务实时解码。
    live?: {
      outBufs: Buffer[]; outSize: { total: number; dropped?: boolean }
      errBufs: Buffer[]; errSize: { total: number; dropped?: boolean }
    }
  }
  const BASH_OUTPUT_DIR = join(tmpdir(), 'llama-studio-bash')
  try { mkdirSync(BASH_OUTPUT_DIR, { recursive: true }) } catch { /* ok */ }
  const backgroundTasks = new Map<string, BackgroundTask>()
  let bgTaskCounter = 0
  function registerBackgroundTask(command: string, pid: number, isBackground: boolean, autoBackgrounded: boolean): { taskId: string; task: BackgroundTask } {
    const id = `bg-${++bgTaskCounter}`
    const outputFile = join(BASH_OUTPUT_DIR, `${id}.log`)
    const task: BackgroundTask = {
      id, command, pid, startTime: Date.now(),
      stdout: '', stderr: '', code: null,
      status: 'running', totalBytes: 0, truncated: false,
      outputFile, isBackground, autoBackgrounded
    }
    backgroundTasks.set(id, task)
    return { taskId: id, task }
  }

  const DEFAULT_EXEC_TIMEOUT = 120_000
  const DEFAULT_MAX_OUTPUT_CHARS = 100_000
  // 输出缓冲上限：超过后丢弃最旧数据，防止长时间运行/输出巨大的进程把主进程内存撞爆
  const MAX_BUFFERED_OUTPUT_BYTES = 8 * 1024 * 1024
  function pushCapped(bufs: Buffer[], sizeRef: { total: number; dropped?: boolean }, d: Buffer): void {
    bufs.push(d)
    sizeRef.total += d.length
    while (sizeRef.total > MAX_BUFFERED_OUTPUT_BYTES && bufs.length > 1) {
      sizeRef.total -= bufs[0]!.length
      bufs.shift()
      sizeRef.dropped = true
    }
  }
  // 解码时若发生过头部丢弃，在输出开头显式标注，避免模型/用户误信为完整输出
  function decodeCapped(bufs: Buffer[], sizeRef: { total: number; dropped?: boolean }): string {
    const text = decodeCommandOutput(Buffer.concat(bufs))
    return sizeRef.dropped ? `[输出超出 8MB 缓冲上限，较早部分已丢弃，以下为尾部输出]\n${text}` : text
  }

  // 敏感环境变量名过滤（借鉴 Reasonix 的 secrets.ProcessEnv）：执行命令前剔除凭证类
  // 环境变量，避免模型通过 echo $SECRET / %TOKEN% 读取并泄漏进上下文或日志。
  const SENSITIVE_ENV_PATTERN = /(^|[-_])(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|\.ENV|ENV_?FILE)($|[-_])/i
  function sanitizeCommandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (SENSITIVE_ENV_PATTERN.test(k)) continue // 剔除敏感变量
      env[k] = v
    }
    return env
  }

  // 杀进程树（借鉴 Reasonix 的 reapShellProcess / KillTree）：前台命令超时或主动终止时，
  // 仅 kill 主进程会遗留子进程（如 `npm run dev` 派生的 node）。按平台杀整棵树：
  // Windows 用 taskkill /T /F；类 Unix 用 kill(-pid) 杀进程组（需 detached 使组可见）。
  function killProcessTree(pid: number | undefined): void {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
    } catch { /* 进程可能已退出 */ }
  }

  // 应用退出时终止所有仍在运行的后台任务子进程（由 cleanupRunningProcesses 调用），
  // 否则 dev server 等后台命令在 Windows 上不会随父进程退出，残留孤儿进程占用端口
  killAllBackgroundTasks = () => {
    for (const [, task] of backgroundTasks) {
      if (task.status === 'running') killProcessTree(task.pid)
    }
  }

  function spawnCommand(command: string) {
    const isWin = process.platform === 'win32'
    if (isWin) {
      // 关键：用 shell:true 把整条命令作为「字符串」交给 cmd.exe，
      // 而不是把 wrappedCommand 作为单个 argv 元素传给 spawn。
      // 若用 spawn('cmd.exe', ['/c', wrappedCommand])，Node 在 Windows 下会对含空格/
      // 特殊字符的 argv 元素整体加一层双引号，导致模型命令里自带的路径引号
      // （如 dir "C:\工具集合\..."）被外层引号截断，cmd 解析出错：
      // 「文件名、目录名或卷标语法不正确」。shell:true 下 Node 不再额外加引号，
      // cmd 收到的是字面值，引号得以原样保留（与 PowerShell 中直接执行一致）。
      const full = `@chcp 65001 >NUL && ${command}`
      return spawn(full, [], { cwd: bashCwd ?? undefined, windowsHide: true, shell: true, env: sanitizeCommandEnv() })
    }
    // detached: true 使子进程进入独立进程组，超时/终止时可用 kill(-pid) 杀整组，
    // 避免 `npm run dev` 类命令遗留孤儿进程（借鉴 Reasonix 的进程组回收）。
    return spawn('/bin/sh', ['-c', command], { cwd: bashCwd ?? undefined, detached: true, env: sanitizeCommandEnv() })
  }

  ipcMain.handle('execute-command', async (_e, opts: {
    command: string
    timeout?: number
    isBackground?: boolean
    maxOutputChars?: number
    autoBackground?: boolean
  }): Promise<{
    stdout: string
    stderr: string
    code: number
    truncated?: boolean
    totalBytes?: number
    outputFile?: string
    autoBackgrounded?: boolean
    taskId?: string
  }> => {
    const timeout = opts.timeout ?? DEFAULT_EXEC_TIMEOUT
    const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

    // 显式后台执行
    if (opts.isBackground) {
      const child = spawnCommand(opts.command)
      const { taskId, task } = registerBackgroundTask(opts.command, child.pid || 0, true, false)

      const outBufs: Buffer[] = []
      const errBufs: Buffer[] = []
      const outSize = { total: 0 }
      const errSize = { total: 0 }
      task.live = { outBufs, outSize, errBufs, errSize }
      child.stdout?.on('data', (d: Buffer) => { pushCapped(outBufs, outSize, d) })
      child.stderr?.on('data', (d: Buffer) => { pushCapped(errBufs, errSize, d) })
      child.on('close', (code) => {
        task.live = undefined
        const stdout = decodeCapped(outBufs, outSize)
        const stderr = decodeCapped(errBufs, errSize)
        task.stdout = stdout
        task.stderr = stderr
        task.code = code
        task.status = 'completed'
        task.totalBytes = stdout.length
        if (stdout.length > maxOutputChars) {
          task.truncated = true
          task.stdout = stdout.slice(0, maxOutputChars) + `\n[... truncated: showing ${formatChars(maxOutputChars)} of ${formatChars(stdout.length)} chars]`
        }
        try { writeFileSync(task.outputFile, stdout, 'utf-8') } catch { /* ok */ }
      })
      child.on('error', () => { task.status = 'killed'; task.code = 1 })

      return {
        stdout: '',
        stderr: '',
        code: 0,
        taskId,
        autoBackgrounded: false
      }
    }

    // 前台执行（带自动后台转后台功能）
    return new Promise((resolve) => {
      const child = spawnCommand(opts.command)
      const outBufs: Buffer[] = []
      const errBufs: Buffer[] = []
      const outSize = { total: 0 }
      const errSize = { total: 0 }
      let timedOut = false
      let resolved = false
      // auto-background 转后台后的任务引用：close/error 时补写终态
      let bgTask: BackgroundTask | null = null

      const timeoutId = setTimeout(() => {
        timedOut = true
        if (opts.autoBackground) {
          const { taskId, task } = registerBackgroundTask(opts.command, child.pid || 0, false, true)
          const stdout = decodeCapped(outBufs, outSize)
          const stderr = decodeCapped(errBufs, errSize)
          task.stdout = stdout
          task.stderr = stderr
          task.status = 'running'
          task.live = { outBufs, outSize, errBufs, errSize }
          bgTask = task
          resolved = true
          const truncated = stdout.length > maxOutputChars
          resolve({
            stdout: `[Command moved to background (timed out after ${timeout}ms)]\n${truncated ? stdout.slice(0, maxOutputChars) : stdout}`,
            stderr,
            code: -1,
            autoBackgrounded: true,
            taskId,
            truncated,
            totalBytes: stdout.length
          })
        } else {
          killProcessTree(child.pid)
        }
      }, timeout)

      child.stdout?.on('data', (d: Buffer) => { pushCapped(outBufs, outSize, d) })
      child.stderr?.on('data', (d: Buffer) => { pushCapped(errBufs, errSize, d) })
      child.on('error', () => {
        if (resolved) {
          // 已转后台：进程异常时同步任务终态，避免状态永远停在 running
          if (bgTask && bgTask.status === 'running') { bgTask.status = 'killed'; bgTask.code = 1 }
          return
        }
        clearTimeout(timeoutId)
        resolved = true
        resolve({ stdout: '', stderr: 'command execution error', code: 1 })
      })
      child.on('close', (code) => {
        if (resolved) {
          // 已转后台（auto-background）：进程真正结束时补写任务终态并落盘输出，
          // 否则任务状态永远停在超时瞬间的 running 快照（模型会反复轮询误判）。
          // status 已被 kill-background-task 改成 killed 时不覆盖。
          if (bgTask) bgTask.live = undefined
          if (bgTask && bgTask.status === 'running') {
            const stdout = decodeCapped(outBufs, outSize)
            const stderr = decodeCapped(errBufs, errSize)
            bgTask.stdout = stdout
            bgTask.stderr = stderr
            bgTask.code = code
            bgTask.status = 'completed'
            bgTask.totalBytes = stdout.length
            if (stdout.length > maxOutputChars) {
              bgTask.truncated = true
              bgTask.stdout = stdout.slice(0, maxOutputChars) + `\n[... truncated: showing ${formatChars(maxOutputChars)} of ${formatChars(stdout.length)} chars]`
            }
            try { writeFileSync(bgTask.outputFile, stdout, 'utf-8') } catch { /* ok */ }
          }
          return
        }
        clearTimeout(timeoutId)
        resolved = true
        const stdout = decodeCapped(outBufs, outSize)
        const stderr = decodeCapped(errBufs, errSize)
        const totalBytes = stdout.length
        let displayStdout = stdout
        let truncated = false
        let outputFile = ''
        if (stdout.length > maxOutputChars) {
          truncated = true
          outputFile = join(BASH_OUTPUT_DIR, `fg-${Date.now()}.log`)
          try { writeFileSync(outputFile, stdout, 'utf-8') } catch { /* ok */ }
          displayStdout = stdout.slice(0, maxOutputChars) + `\n[... truncated: showing ${formatChars(maxOutputChars)} of ${formatChars(stdout.length)} chars - full output at: ${outputFile}]`
        }
        resolve({
          stdout: displayStdout,
          stderr,
          code: timedOut ? 124 : (code ?? 1),
          truncated,
          totalBytes,
          outputFile: outputFile || undefined
        })
      })
    })
  })

  ipcMain.handle('get-background-task', async (_e, taskId: string): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    code?: number | null
    status?: string
    truncated?: boolean
    totalBytes?: number
    error?: string
  }> => {
    const task = backgroundTasks.get(taskId)
    if (!task) return { success: false, error: `Task ${taskId} not found` }
    // running 任务：从运行期缓冲区实时解码，让模型能看到 dev server 等不退出进程的当前输出；
    // 超长时保留尾部（启动日志/报错通常在尾部）。
    if (task.status === 'running' && task.live) {
      const stdout = decodeCapped(task.live.outBufs, task.live.outSize)
      const stderr = decodeCapped(task.live.errBufs, task.live.errSize)
      const clip = (s: string) => s.length > DEFAULT_MAX_OUTPUT_CHARS
        ? `[... 输出过长，仅显示尾部 ${formatChars(DEFAULT_MAX_OUTPUT_CHARS)}]\n` + s.slice(-DEFAULT_MAX_OUTPUT_CHARS)
        : s
      return {
        success: true,
        stdout: clip(stdout),
        stderr: clip(stderr),
        code: task.code,
        status: task.status,
        truncated: stdout.length > DEFAULT_MAX_OUTPUT_CHARS,
        totalBytes: stdout.length
      }
    }
    return {
      success: true,
      stdout: task.stdout,
      stderr: task.stderr,
      code: task.code,
      status: task.status,
      truncated: task.truncated,
      totalBytes: task.totalBytes
    }
  })

  ipcMain.handle('list-background-tasks', async (): Promise<Array<{
    id: string
    command: string
    status: string
    pid: number
    startTime: number
    autoBackgrounded: boolean
  }>> => {
    return [...backgroundTasks.values()].map(t => ({
      id: t.id,
      command: t.command,
      status: t.status,
      pid: t.pid,
      startTime: t.startTime,
      autoBackgrounded: t.autoBackgrounded
    }))
  })

  ipcMain.handle('kill-background-task', async (_e, taskId: string): Promise<{ success: boolean; error?: string }> => {
    const task = backgroundTasks.get(taskId)
    if (!task) return { success: false, error: `Task ${taskId} not found` }
    if (task.status !== 'running') return { success: false, error: `Task ${taskId} is not running (${task.status})` }
    try {
      killProcessTree(task.pid)
      task.status = 'killed'
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Agent Code 文件删除（安全校验）────────────────────
  // 使用 isSafePath 确保删除操作不会越出项目目录（或 App 根目录）
  const DELETE_BASES = (): string[] => {
    const bases = [APP_ROOT]
    // 注意：bashCwd 不在合法根之列——写/改/删边界永远锁死在工作区根，
    // 不随 cd 移动（渲染层已拒绝越界 cd，此处双重保险）。
    if (agentWorkspaceRoot) bases.push(agentWorkspaceRoot)
    return bases
  }
  // 写/改/删的路径安全边界：限制在 App 根 / 当前 bash 工作目录 / Agent 工作区根之内，
  // 防止模型用越界的绝对/相对路径把文件写到工作区之外（读取另有 confineRead 保护）。
  function isAgentPathInScope(target: string): boolean {
    return DELETE_BASES().some(base => isSafePath(base, target))
  }
  ipcMain.handle('delete-path', async (_e, targetPath: string, recursive: boolean): Promise<{ success: boolean; message?: string; error?: string }> => {
    try {
      const resolved = resolve(resolveAgentPath(targetPath))
      if (!isAgentPathInScope(resolved)) return { success: false, error: '访问被拒绝：路径不在安全范围内' }
      if (!existsSync(resolved)) return { success: false, error: '路径不存在' }
      const isDir = statSync(resolved).isDirectory()
      if (!isDir) {
        unlinkSync(resolved)
        return { success: true, message: `✅ 已删除文件：${resolved}` }
      }
      // isDirectory
      if (!recursive) {
        const contents = readdirSync(resolved)
        if (contents.length > 0) return { success: false, error: '目录非空：如需删除非空目录请设置 recursive: true' }
        rmdirSync(resolved)
      } else {
        rmSync(resolved, { recursive: true, force: true })
      }
      return { success: true, message: `✅ 已删除目录：${resolved}${recursive ? '（含所有子内容）' : ''}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Agent Code：Git 变更（只读 diff 查看）────────────────
  // 在工作区跑 git，返回改动文件清单 + 相对 HEAD 的 unified diff（含未跟踪文件内容）。
  // 严格只读：不做 add/commit/checkout 等写操作。
  function runGit(args: string[], cwd: string, timeoutMs = 15000): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let done = false
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('git', args, { cwd, windowsHide: true, env: sanitizeCommandEnv() })
      } catch (e) {
        resolve({ ok: false, code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
        return
      }
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try { child.kill() } catch { /* ok */ }
        resolve({ ok: false, code: -1, stdout: decodeCommandOutput(Buffer.concat(out)), stderr: 'git 命令超时' })
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => out.push(d))
      child.stderr?.on('data', (d: Buffer) => err.push(d))
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }) })
      child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: code === 0, code: code ?? -1, stdout: decodeCommandOutput(Buffer.concat(out)), stderr: decodeCommandOutput(Buffer.concat(err)) }) })
    })
  }

  // 把 `git diff` 的整段 unified 输出按文件切分为 { 路径 -> diff 块 }。
  // 路径优先取 `+++ b/<path>`；删除文件（+++ /dev/null）时取 `--- a/<path>`。
  function splitGitDiff(diff: string): Record<string, string> {
    const map: Record<string, string> = {}
    if (!diff) return map
    const lines = diff.split('\n')
    let cur: string[] | null = null
    let curPath = ''
    let oldPath = ''
    const flush = () => { if (cur && curPath) map[curPath] = cur.join('\n') }
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        flush()
        cur = [line]; curPath = ''; oldPath = ''
        // 兜底：二进制/模式变更块没有 +++ b/ 行，先从头部 `a/x b/y` 取路径（+++ b/ 会覆盖之，更可靠）
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
        if (m) curPath = m[2]
      } else if (cur) {
        cur.push(line)
        if (line.startsWith('--- a/')) oldPath = line.slice(6)
        else if (line.startsWith('+++ b/')) curPath = line.slice(6)
        else if (line.startsWith('+++ ') && line.includes('/dev/null')) curPath = oldPath
      }
    }
    flush()
    return map
  }

  // 解析 porcelain v1 状态行：'XY path' 或 'XY orig -> new'（重命名取 new）。X=暂存态，Y=工作区态。
  function parseGitPorcelain(text: string): Array<{ path: string; x: string; y: string; untracked: boolean }> {
    const entries: Array<{ path: string; x: string; y: string; untracked: boolean }> = []
    for (const raw of text.split('\n')) {
      if (!raw) continue
      const xy = raw.slice(0, 2)
      let rest = raw.slice(3)
      if (xy === '??') { entries.push({ path: rest, x: '?', y: '?', untracked: true }); continue }
      const arrow = rest.indexOf(' -> ')
      if (arrow >= 0) rest = rest.slice(arrow + 4)
      entries.push({ path: rest, x: xy[0], y: xy[1], untracked: false })
    }
    return entries
  }

  // 二进制 diff 判定：git 的标记行「Binary files a/x and b/x differ」位于行首（列 0）；
  // 文本 diff 的内容行都带 +/-/空格 前缀，故用行首锚定，避免把「内容里出现 Binary files 字样」误判为二进制。
  function isBinaryDiff(diff: string): boolean {
    return /(?:^|\n)Binary files .+ differ/.test(diff)
  }

  ipcMain.handle('git-changes', async (_e, dir: string): Promise<{
    isRepo: boolean
    staged: Array<{ path: string; status: string; staged: boolean; untracked: boolean; binary: boolean; diff: string; content?: string }>
    unstaged: Array<{ path: string; status: string; staged: boolean; untracked: boolean; binary: boolean; diff: string; content?: string }>
    error?: string
  }> => {
    type F = { path: string; status: string; staged: boolean; untracked: boolean; binary: boolean; diff: string; content?: string }
    try {
      const cwd = resolveAgentPath(dir || '')
      if (!cwd || !existsSync(cwd)) return { isRepo: false, staged: [], unstaged: [] }
      // --no-optional-locks：让 git 仅读，不刷新/写入 .git/index，避免触发文件监听造成刷新回环。
      const base = ['-c', 'core.quotepath=false', '--no-optional-locks']
      const inside = await runGit([...base, 'rev-parse', '--is-inside-work-tree'], cwd)
      if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false, staged: [], unstaged: [] }
      const st = await runGit([...base, 'status', '--porcelain=v1', '-uall'], cwd)
      const stagedDiff = await runGit([...base, 'diff', '--cached', '--no-color'], cwd)
      const unstagedDiff = await runGit([...base, 'diff', '--no-color'], cwd)
      const stagedByPath = splitGitDiff(stagedDiff.stdout)
      const unstagedByPath = splitGitDiff(unstagedDiff.stdout)
      const CONTENT_CAP = 200 * 1024
      const staged: F[] = []
      const unstaged: F[] = []
      for (const e of parseGitPorcelain(st.stdout)) {
        if (e.untracked) {
          const abs = join(cwd, e.path)
          let binary = false; let content = ''
          try {
            const buf = readFileSync(abs)
            const a = analyzeBuffer(buf)
            if (a.binary) binary = true
            else content = buf.subarray(0, CONTENT_CAP).toString(a.encoding as BufferEncoding).replace(/\r\n/g, '\n')
          } catch { /* 读不到（目录/权限）→ 忽略内容 */ }
          unstaged.push({ path: e.path, status: '?', staged: false, untracked: true, binary, diff: '', content })
          continue
        }
        // X（暂存态）非空 → 已暂存组；Y（工作区态）非空 → 更改组。同一文件可同时出现在两组。
        if (e.x !== ' ' && e.x !== '?') {
          const diff = stagedByPath[e.path] || ''
          staged.push({ path: e.path, status: e.x, staged: true, untracked: false, binary: isBinaryDiff(diff), diff })
        }
        if (e.y !== ' ' && e.y !== '?') {
          const diff = unstagedByPath[e.path] || ''
          unstaged.push({ path: e.path, status: e.y, staged: false, untracked: false, binary: isBinaryDiff(diff), diff })
        }
      }
      return { isRepo: true, staged, unstaged }
    } catch (e) {
      return { isRepo: false, staged: [], unstaged: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Agent Code：Git 暂存/取消暂存（单文件）────────────
  ipcMain.handle('git-stage-file', async (_e, dir: string, filePath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const cwd = resolveAgentPath(dir || '')
      if (!cwd || !existsSync(cwd)) return { success: false, error: '目录不存在' }
      const r = await runGit(['add', '--', filePath], cwd)
      return { success: r.ok, error: r.ok ? undefined : r.stderr }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('git-unstage-file', async (_e, dir: string, filePath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const cwd = resolveAgentPath(dir || '')
      if (!cwd || !existsSync(cwd)) return { success: false, error: '目录不存在' }
      const r = await runGit(['restore', '--staged', '--', filePath], cwd)
      return { success: r.ok, error: r.ok ? undefined : r.stderr }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

// ── 辅助函数 ──────────────────────────────────────────────
/**
 * 将命令输出的原始 Buffer 解码为字符串，兼容 Windows 中文环境下的两种编码：
 * 优先按 UTF-8 解码（node/git/npm 等现代程序）；若含非法 UTF-8 序列（cmd 内部命令
 * 经管道输出 GBK/CP936），则回退用 GBK 解码，避免中文乱码。
 */
function formatChars(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function decodeCommandOutput(buf: Buffer | string | undefined): string {
  if (typeof buf === 'string') return buf
  if (!buf || buf.length === 0) return ''
  const asUtf8 = buf.toString('utf8')
  // U+FFFD 替换字符说明存在非法 UTF-8 字节，大概率是 GBK 输出
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  try {
    return iconv.decode(buf, 'gbk')
  } catch {
    return asUtf8
  }
}

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

