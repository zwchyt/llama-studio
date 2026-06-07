import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, createWriteStream, statSync, rmdirSync, renameSync, promises as fsPromises
} from 'fs'
import { join, extname, basename, dirname, resolve, sep } from 'path'
import { spawn, ChildProcess } from 'child_process'
import https from 'https'
import http from 'http'
import { app } from 'electron'
import extract from 'extract-zip'
import { graphics } from 'systeminformation/lib/graphics'

interface GitHubAsset { name: string; browser_download_url: string; size: number }
interface GitHubRelease {
  tag_name: string
  name: string
  html_url: string
  published_at: string
  assets: GitHubAsset[]
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
type GpuData = Awaited<ReturnType<typeof graphics>>
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
const SETTINGS_PATH = join(APP_ROOT, 'settings.json')
for (const dir of [MODELS_DIR, TEMPLATES_DIR, BACKEND_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
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
    const defaultPath = join(APP_ROOT, 'resources', 'commands.json')
    if (existsSync(defaultPath)) schema = tryLoad(defaultPath)
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
interface AppSettings { externalModelFolders: string[]; metricsPolling?: boolean }
let settingsCache: AppSettings | null = null
async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], metricsPolling: true }; return settingsCache }
    const data = JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], metricsPolling: true }; return settingsCache }
}
async function saveSettings(s: AppSettings): Promise<void> {
  await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2))
  settingsCache = s
}
function loadSettingsSync(): AppSettings {
  if (settingsCache) return settingsCache
  try {
    if (!existsSync(SETTINGS_PATH)) { settingsCache = { externalModelFolders: [], metricsPolling: true }; return settingsCache }
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    settingsCache = {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      metricsPolling: data.metricsPolling !== undefined ? data.metricsPolling : true
    }
    return settingsCache
  } catch { settingsCache = { externalModelFolders: [], metricsPolling: true }; return settingsCache }
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
function fetchJson(url: string, depth = 0): Promise<unknown> {
  if (depth > 10) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'llamabox/1.0.0', Accept: 'application/json' } }
    const get = url.startsWith('https') ? https.get : http.get
    const req = get(url, opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.destroy()
        const loc = res.headers.location
        if (!loc.startsWith('http:') && !loc.startsWith('https:')) return reject(new Error('Invalid redirect protocol'))
        fetchJson(loc, depth + 1).then(resolve).catch(reject)
        return
      }
      const MAX = 5 * 1024 * 1024
      let size = 0
      let data = ''
      res.on('data', (c) => {
        size += c.length
        if (size > MAX) {
          res.destroy()
          return reject(new Error('Response too large'))
        }
        data += c
      })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    })
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')))
    req.on('error', reject)
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
  let currentReq: ReturnType<typeof https.get> | null = null
  const flags = startByte > 0 ? 'a' : 'w'
  const file = createWriteStream(destPath, { flags })

  let speedBytes = 0
  let lastSpeedCheck = Date.now()
  let currentSpeed = 0

  const attempt = (currentUrl: string, redirectCount = 0) => {
    if (redirectCount > 10) { if (!destroyed) onError(new Error('Too many redirects')); return }
    const get = currentUrl.startsWith('https') ? https.get : http.get
    const headers: Record<string, string> = { 'User-Agent': 'hexllama/1.0' }
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`
    let lastDataTime = Date.now()
    let stallCheck: ReturnType<typeof setInterval> | null = null
    const clearStall = () => { if (stallCheck) { clearInterval(stallCheck); stallCheck = null } }
    currentReq = get(currentUrl, { headers }, (res) => {
      if (destroyed) { res.destroy(); return }
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.destroy()
        const loc = res.headers.location!
        if (!loc.startsWith('http:') && !loc.startsWith('https:')) { if (!destroyed) onError(new Error('Invalid redirect protocol')); return }
        return attempt(loc, redirectCount + 1)
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        if (!destroyed) onError(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const contentLength = parseInt(res.headers['content-length'] || '0', 10)
      const totalBytes = contentLength + startByte
      let receivedBytes = startByte

      lastDataTime = Date.now()
      clearStall()
      stallCheck = setInterval(() => {
        if (destroyed) { clearStall(); return }
        if (Date.now() - lastDataTime > 30000) {
          clearStall()
          res.destroy()
          if (!destroyed) onError(new Error('Download stalled'))
        }
      }, 5000)

      res.on('data', (chunk: Buffer) => {
        if (destroyed) return
        file.write(chunk)
        receivedBytes += chunk.length
        speedBytes += chunk.length
        lastDataTime = Date.now()

        const now = Date.now()
        const elapsed = (now - lastSpeedCheck) / 1000
        if (elapsed >= 0.5) {
          currentSpeed = speedBytes / elapsed
          speedBytes = 0
          lastSpeedCheck = now
        }
        onProgress(receivedBytes, totalBytes, currentSpeed)
      })

      res.on('end', () => { clearStall(); if (!destroyed) file.end(() => { if (!destroyed) onDone() }) })
      res.on('error', (err) => { clearStall(); if (!destroyed) { file.destroy(); onError(err) } })
      res.on('close', () => { clearStall() })
    })
    currentReq.setTimeout(15000, () => {
      if (destroyed) return
      try { currentReq?.destroy() } catch {}
      if (!destroyed) onError(new Error('Connection timeout'))
    })
    currentReq.on('error', (err) => {
      clearStall()
      if (!destroyed) { file.destroy(); onError(err) }
    })
  }
  attempt(url)
  return () => {
    if (destroyed) return
    destroyed = true
    currentReq?.destroy()

    file.end()
  }
}

let piWebProcess: ChildProcess | null = null
let piWebUrl = ''
let piWebState: 'idle' | 'starting' | 'running' | 'stopping' | 'error' = 'idle'
let piWebStopRequested = false
let piWebWindow: BrowserWindow | null = null
let metricsPollingEnabled = true
let metricsInterval: ReturnType<typeof setInterval> | null = null
let cachedGpuData: GpuData | null = null
let lastGpuFetch = 0
let gpuLoggedFail = false
const GPU_CACHE_TTL = 30000
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
  if (piWebProcess) {
    killProcessTreeAsync(piWebProcess)
    piWebProcess = null
  }
  piWebUrl = ''
  piWebState = 'idle'
  if (piWebWindow && !piWebWindow.isDestroyed()) {
    piWebWindow.close()
    piWebWindow = null
  }
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
  ipcMain.handle('delete-model', (_e, filePath: string) => {
    try {
      if (!isSafePath(MODELS_DIR, filePath)) return { success: false, error: 'Access denied' }
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
      if (!isSafePath(MODELS_DIR, oldPath)) return { success: false, error: 'Access denied' }
      const dir = dirname(oldPath)
      const newPath = join(dir, newName + extname(oldPath))
      if (!isSafePath(MODELS_DIR, newPath)) return { success: false, error: 'Access denied' }
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
      if (t.phase === 'downloading') return { success: false, error: 'Already downloading' }
    }
    const folder = opts.modelFolder || opts.repoId?.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!isSafePath(MODELS_DIR, destDir)) return { success: false, error: 'Access denied' }
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    if (!isSafePath(MODELS_DIR, finalPath)) return { success: false, error: 'Access denied' }
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
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('Download error:', err) }
    )
    downloadTasks.set(id, task)
    broadcastProgress(task, true)
    return { success: true, id }
  })
  ipcMain.handle('pause-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'downloading') return { success: false, error: 'Not downloading' }
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
    if (!task || task.phase !== 'paused') return { success: false, error: 'Not paused' }
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
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('Resume error:', err) }
    )
    broadcastProgress(task, true)
    return { success: true }
  })
  ipcMain.handle('cancel-model-download', (_event, id: string) => {
    const task = downloadTasks.get(id)
    if (!task) return { success: false, error: 'Not found' }
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
      if (depth > 3) return null
      try {
        const files = await fsPromises.readdir(dir, { withFileTypes: true })
        const names = process.platform === 'win32'
          ? ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server']
          : ['llama-server', 'main', 'server']
        for (const f of files) {
          if (!f.isDirectory() && names.includes(f.name.toLowerCase())) return f.name
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
      if (!isSafePath(BACKEND_DIR, backendPath)) return { success: false, error: 'Access denied' }
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
    const defaultPath = join(APP_ROOT, 'resources', 'commands.json')
    try {
      if (existsSync(defaultPath)) return JSON.parse(await fsPromises.readFile(defaultPath, 'utf-8'))
    } catch { }
    return null
  })
  ipcMain.handle('save-backend-commands', (_e, backendName: string, schema: unknown) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      if (!isSafePath(BACKEND_DIR, backendPath)) return { success: false, error: 'Access denied' }
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
      const id = (template.id as string) || crypto.randomUUID()
      if (/[\\/]/.test(id) || id.includes('..')) return { success: false, error: 'Invalid template ID' }
      writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify({ ...template, id }, null, 2))
      return { success: true, id }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('delete-template', (_e, id: string) => {
    const fp = join(TEMPLATES_DIR, `${id}.json`)
    if (!isSafePath(TEMPLATES_DIR, fp)) return { success: false, error: 'Access denied' }
    try { if (existsSync(fp)) unlinkSync(fp) } catch { }
    return { success: true }
  })
  ipcMain.handle('import-template', async () => {
    try {
      const r = await dialog.showOpenDialog({ title: 'Import Template', filters: [{ name: 'JSON Template', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths.length) return null
      const data = JSON.parse(readFileSync(r.filePaths[0], 'utf-8'))
      const id = crypto.randomUUID(); data.id = id
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
    if (runningProcesses.has(opts.id)) return { success: false, error: 'Already running' }
    const exePath = join(opts.backendPath, opts.exe)
    if (!isSafePath(BACKEND_DIR, exePath)) return { success: false, error: 'Access denied' }
    if (!existsSync(exePath)) return { success: false, error: `Executable not found: ${exePath}` }
    try {
      const { allowed, boolean } = loadSchemaArgs(opts.backendPath)
      const safeArgs = validateArgs(opts.args, allowed, boolean)
      const proc = spawn(exePath, safeArgs, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      proc.stderr?.on('data', (d) => {
        const text = d.toString()
        console.error('[llama-server]', text)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('model-log', { id: opts.id, stream: 'stderr', text })
        })
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
          const msg = `Process exited with code ${code}`
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
        return { success: false, error: 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.' }
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
    return { success: killed || !port, error: killed || !port ? undefined : 'Not running' }
  })
  let cancelBackendDl: (() => void) | null = null

  ipcMain.handle('check-updates', async () => {
    try {
      const release = await fetchJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest') as GitHubRelease
      if (!release || !release.assets) return { error: 'Invalid response from GitHub' }
      const isMac = process.platform === 'darwin'
      const isLinux = process.platform === 'linux'
      const arch = process.arch
      const platformAssets = release.assets.filter((a: GitHubAsset) => {
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
      return { tagName: release.tag_name, name: release.name, url: release.html_url, publishedAt: release.published_at, isNewer, assets: platformAssets.map((a: GitHubAsset) => ({ name: a.name, downloadUrl: a.browser_download_url, size: a.size })) }
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('download-release', async (event, opts: { url: string; version: string; assetName: string }) => {
    if (!opts.version || /[\\/:*?"<>|]/.test(opts.version) || opts.version.includes('..')) {
      return { success: false, error: 'Invalid version' }
    }
    if (!opts.assetName || opts.assetName.includes('..') || opts.assetName.includes('/') || opts.assetName.includes('\\')) {
      return { success: false, error: 'Invalid asset name' }
    }
    const archivePath = join(app.getPath('temp'), opts.assetName)
    const extractPath = join(BACKEND_DIR, opts.version)
    if (!isSafePath(BACKEND_DIR, extractPath)) return { success: false, error: 'Access denied' }
    const isTarGz = opts.assetName.toLowerCase().endsWith('.tar.gz')
    try {
      event.sender.send('download-progress', { percent: 0, phase: 'downloading' })
      await new Promise<void>((resolve, reject) => {
        cancelBackendDl = startDownload(opts.url, archivePath, 0,
          (r, t) => event.sender.send('download-progress', { percent: t > 0 ? Math.round(r / t * 100) : 0, phase: 'downloading' }),
          resolve, reject)
      })
      cancelBackendDl = null
      event.sender.send('download-progress', { percent: 100, phase: 'extracting' })
      if (!existsSync(extractPath)) mkdirSync(extractPath, { recursive: true })
      if (isTarGz) {
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xzf', archivePath, '-C', extractPath], { stdio: 'pipe' })
          p.on('error', reject)
          p.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)))
        })
      } else {
        await extract(archivePath, { dir: extractPath })
      }
      try { unlinkSync(archivePath) } catch (e) { console.error('Failed to cleanup temp file', e) }
      return { success: true, path: extractPath }
    } catch (err) {
      cancelBackendDl = null
      try { unlinkSync(archivePath) } catch (e) { console.error('Failed to cleanup temp file', e) }
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('cancel-backend-download', () => {
    if (cancelBackendDl) {
      cancelBackendDl()
      cancelBackendDl = null
    }
    return { success: true }
  })
  ipcMain.handle('open-folder', async (_e, folderPath: string) => {
    const settings = await loadSettings()
    const allowedBases = [MODELS_DIR, BACKEND_DIR, ...settings.externalModelFolders]
    if (!allowedBases.some(base => isSafePath(base, folderPath))) return
    shell.openPath(folderPath)
  })
  ipcMain.handle('get-paths', () => ({ models: MODELS_DIR, templates: TEMPLATES_DIR, backend: BACKEND_DIR }))
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
      const data = await fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=24&sort=downloads&direction=-1`) as HfModelRaw[]
      return data.map(m => ({ id: m.id, author: m.author || m.id.split('/')[0] || '', name: m.id.split('/').pop() || m.id, downloads: m.downloads || 0, likes: m.likes || 0, tags: m.tags || [], lastModified: m.lastModified || '' }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-get-files', async (_e, repoId: string) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models/${encodeURIComponent(repoId)}/tree/main`) as HfFileRaw[]
      return data.filter((f: HfFileRaw) => f.type === 'file' && f.path.endsWith('.gguf')).map((f: HfFileRaw) => ({
        name: f.path,
        size: f.size || 0,
        downloadUrl: `https://huggingface.co/${encodeURIComponent(repoId)}/resolve/main/${encodeURIComponent(f.path)}`
      }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-download-model', (_event, opts: { repoId: string; filename: string; downloadUrl: string }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const existing = downloadTasks.get(id)!
      if (existing.phase === 'downloading') return { success: false, error: 'Already downloading' }
    }
    const folder = opts.repoId.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!isSafePath(MODELS_DIR, destDir)) return { success: false, error: 'Access denied' }
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    if (!isSafePath(MODELS_DIR, finalPath)) return { success: false, error: 'Access denied' }
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
      (err) => { task.phase = 'error'; task.speed = 0; broadcast(true); console.error('HF download error:', err) }
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
  ipcMain.handle('select-directory', async () => {
    const r = await dialog.showOpenDialog({ title: 'Select Directory', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { path: null }
    return { path: r.filePaths[0] }
  })

  // --- pi-web ---
  const PI_WEB_DIR = app.isPackaged ? join(process.resourcesPath, 'pi-web') : join(APP_ROOT, 'pi-web')
  const PI_WEB_PORT = 30141
  const lastDecodeCount = new Map<string, { count: number; time: number }>()

  async function startPiWeb(): Promise<string> {
    if (piWebState === 'starting' || piWebState === 'running') {
      if (piWebWindow && !piWebWindow.isDestroyed()) piWebWindow.focus()
      return piWebUrl
    }
    if (piWebProcess) {
      const old = piWebProcess
      piWebProcess = null
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        old.once('exit', finish)
        killProcessTreeAsync(old).then(finish, finish)
        setTimeout(finish, 3000)
      })
    }
    piWebStopRequested = false
    piWebState = 'starting'
    piWebUrl = ''
    let nextBin: string
    try {
      nextBin = require.resolve('next/dist/bin/next', { paths: [PI_WEB_DIR] })
    } catch {
      try {
        const nextPkg = require.resolve('next/package.json', { paths: [PI_WEB_DIR] })
        nextBin = join(dirname(nextPkg), 'dist', 'bin', 'next')
      } catch {
        nextBin = join(PI_WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next')
      }
    }
    return new Promise((resolve, reject) => {
      const nextMode = app.isPackaged ? 'start' : 'dev'
      const proc = spawn('node', [nextBin, nextMode, '-p', String(PI_WEB_PORT)], {
        cwd: PI_WEB_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: app.isPackaged ? 'production' : 'development',
          NEXT_DISABLE_TURBOPACK: '1',
          NODE_OPTIONS: '--max-old-space-size=512',
        },
        windowsHide: true,
      })
      let resolved = false
      const startupTimeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        killProcessTreeAsync(proc)
        piWebProcess = null
        piWebUrl = ''
        piWebState = 'error'
        reject(new Error('pi-web startup timed out after 60 seconds'))
      }, 60000)
      const cancelTimeout = () => clearTimeout(startupTimeout)
      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (!resolved && text.includes('Ready')) {
          resolved = true
          piWebUrl = `http://localhost:${PI_WEB_PORT}`
          const checkUrl = piWebUrl
            ; (async () => {
              for (let i = 0; i < 30; i++) {
                if (piWebState !== 'starting') { cancelTimeout(); return }
                try {
                  const r = await fetch(`${checkUrl}/api/models`)
                  if (r.ok) {
                    if (piWebState !== 'starting') { cancelTimeout(); return }
                    piWebState = 'running'
                    cancelTimeout()
                    resolve(piWebUrl)
                    return
                  }
                } catch { }
                await new Promise(r => setTimeout(r, 1000))
              }
              if (piWebState === 'starting') {
                piWebState = 'error'
                cancelTimeout()
                reject(new Error('pi-web health check failed: server not responding'))
              }
            })()
        }
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        console.error('[pi-web stderr]', chunk.toString())
      })
      proc.on('error', (err) => {
        cancelTimeout()
        piWebProcess = null
        piWebUrl = ''
        if (!piWebStopRequested) piWebState = 'error'
        if (!resolved) { resolved = true; reject(err) }
      })
      proc.on('exit', (code) => {
        cancelTimeout()
        piWebProcess = null
        piWebUrl = ''
        console.error(`[pi-web] process exited with code ${code} (state: ${piWebState})`)
        if (!piWebStopRequested) {
          piWebState = resolved ? 'idle' : 'error'
        }
        piWebStopRequested = false
        if (!resolved) { resolved = true; reject(new Error(`pi-web exited with code ${code}`)) }
      })
      piWebProcess = proc
    })
  }

  function stopPiWeb(): void {
    piWebState = 'stopping'
    piWebStopRequested = true
    if (piWebProcess) {
      killProcessTreeAsync(piWebProcess)
      piWebProcess = null
      piWebUrl = ''
    }
    piWebState = 'idle'
    if (piWebWindow && !piWebWindow.isDestroyed()) {
      piWebWindow.close()
      piWebWindow = null
    }
  }

  function openPiWebWindow(): void {
    if (!piWebUrl) return
    if (piWebWindow && !piWebWindow.isDestroyed()) {
      piWebWindow.focus()
      return
    }
    const icon = [join(__dirname, '../../assets/icon.png'), join(app.getAppPath(), 'assets', 'icon.png')].find(existsSync)
    piWebWindow = new BrowserWindow({
      width: 1280, height: 800, show: true, autoHideMenuBar: true,
      title: 'Hexllama - pi-web',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#ffffff',
      ...(icon ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--window-mode=piweb']
      }
    })
    piWebWindow.loadURL(piWebUrl)
    piWebWindow.on('closed', () => { piWebWindow = null })
  }

  ipcMain.handle('start-pi-web', async () => {
    try {
      const url = await startPiWeb()
      return { success: true, url }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('stop-pi-web', () => { stopPiWeb() })
  ipcMain.handle('open-pi-web-window', () => { openPiWebWindow() })
  ipcMain.handle('get-pi-web-status', () => ({ running: piWebState === 'running', url: piWebUrl }))

  // --- metrics ---
  async function httpGetText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { agent: httpAgent }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c.toString(); if (body.length > 1e6) { req.destroy(); reject(new Error('response too large')) } })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')) })
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
    try { cachedGpuData = await graphics(); lastGpuFetch = now; gpuLoggedFail = false } catch (err) {
      if (!gpuLoggedFail) { console.warn('[gpu] graphics() failed:', err); gpuLoggedFail = true }
    }
  }

  async function collectMetrics(id: string, port: number): Promise<Record<string, unknown>> {
    const [rawSlots, rawMetrics] = await Promise.all([
      httpGetText(`http://127.0.0.1:${port}/slots`).catch(() => ''),
      httpGetText(`http://127.0.0.1:${port}/metrics`).catch(() => ''),
    ])
    const gpuController = cachedGpuData?.controllers?.[0]
    const payload: Record<string, unknown> = { id, lastUpdated: Date.now() }
    const slots = rawSlots ? tryParseJson(rawSlots) : null
    if (slots && Array.isArray(slots) && slots.length > 0) {
      const s = slots[0]
      if (s.n_ctx !== undefined) payload.nCtx = s.n_ctx
      if (s.n_prompt_tokens !== undefined) payload.nPromptTokens = s.n_prompt_tokens
      if (s.n_prompt_tokens_processed !== undefined) payload.nPromptTokensProcessed = s.n_prompt_tokens_processed
      if (s.n_prompt_tokens_cache !== undefined) payload.nPromptTokensCache = s.n_prompt_tokens_cache
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
            if (delta >= 0) payload.reqPerSec = delta / dt
          }
        }
        lastDecodeCount.set(id, { count: prom['llamacpp:n_decode_total'], time: now })
      }
      if (prom['llamacpp:kv_cache_tokens'] !== undefined) payload.nPromptTokensCache = prom['llamacpp:kv_cache_tokens']
      if (prom['llamacpp:kv_cache_usage_ratio'] !== undefined && prom['llamacpp:kv_cache_tokens'] !== undefined && prom['llamacpp:kv_cache_usage_ratio'] > 0) {
        payload.nCtx = Math.round(prom['llamacpp:kv_cache_tokens'] / prom['llamacpp:kv_cache_usage_ratio'])
      }
    }
    if (gpuController) {
      payload.vramTotalMb = gpuController.memoryTotal || 0
      payload.vramUsedMb = gpuController.memoryUsed ?? null
    }
    if (typeof payload.nPromptTokens === 'number' && payload.nPromptTokens > 0 &&
      typeof payload.prefillTokS === 'number' && payload.prefillTokS > 0) {
      payload.ttftMs = Math.round((payload.nPromptTokens / payload.prefillTokS) * 1000)
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
        const payload = await collectMetrics(id, port)
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
        const entry = await collectMetrics(id, port)
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
            res.resume()
            if (res.statusCode === 200) {
              resolved = true
              resolve()
            } else {
              reject(new Error(`status ${res.statusCode}`))
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

  // load initial settings (cache is already populated synchronously above)
  metricsPollingEnabled = settingsCache!.metricsPolling ?? true
  if (metricsPollingEnabled) startMetricsInterval()

  ipcMain.handle('hf-open-models-dir', () => shell.openPath(MODELS_DIR))
  ipcMain.handle('onDownloadProgress', () => { })
  ipcMain.handle('removeDownloadListener', () => { })
}
