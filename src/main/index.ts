import { app, shell, BrowserWindow, Menu, ipcMain, session, protocol, net } from 'electron'
import { join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { tmpdir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupRunningProcesses, ipcInternal } from './ipc'
import { registerPiAgentIpc, disposePiAgentIpc } from './services/piAgentBridge/piAgentIpc'
import { initAgentBrowserPreview } from './services/agentBrowserService'
import { appendFileSync } from 'fs'
import { existsSync } from 'fs'
import { mkdirSync } from 'fs'

process.noDeprecation = true

// ── 崩溃/异常探针：全部落盘 userData/debug.log，dev 模式下主进程弹框前留下栈证据 ──
function crashLog(msg: string): void {
  try { appendFileSync(join(app.getPath('userData'), 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}
app.on('render-process-gone', (_e, webContents, details) => {
  crashLog(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode} url=${webContents.getURL()} crashed=${details.reason !== 'clean-exit'}`)
  console.error('[render-process-gone]', details)
})
process.on('uncaughtException', (err) => {
  crashLog('[main uncaughtException] ' + (err?.stack ?? String(err)))
})
process.on('unhandledRejection', (reason) => {
  crashLog('[main unhandledRejection] ' + (reason instanceof Error ? reason.stack ?? reason.message : String(reason)))
})

try { mkdirSync(join(tmpdir(), 'llama-studio-cache'), { recursive: true }) } catch {}
app.commandLine.appendSwitch('--disk-cache-dir', join(tmpdir(), 'llama-studio-cache'))
app.commandLine.appendSwitch('--disable-gpu-cache')
app.commandLine.appendSwitch('--disable-disk-cache')
// 禁用 WebRTC 的 STUN/TURN 网络请求，消除控制台 "Failed to resolve address for stun.*" 日志
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp')

// 单实例锁：打包后的应用保持单实例；dev 模式放宽，避免残留进程占用锁导致新实例秒退
const gotLock = app.requestSingleInstanceLock()
if (!gotLock && app.isPackaged) {
  app.quit()
}

function resolveIcon(): string | undefined {
  const candidates = [
    join(process.cwd(), 'assets', 'llama-studio-icon.png'),
    join(__dirname, '../../assets/llama-studio-icon.png'),
    join(app.getAppPath(), 'assets', 'llama-studio-icon.png'),
    // 打包后 assets 不在应用目录内，图标通过 extraResources 随安装包分发
    join(process.resourcesPath, 'assets', 'llama-studio-icon.png')
  ]
  return candidates.find(existsSync)
}
function createWindow(): BrowserWindow {
  const icon = resolveIcon()
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#e5e5e5',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // 打包版彻底禁用 DevTools（F12 / Ctrl+Shift+I 均无效），开发模式保留
      devTools: !app.isPackaged
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const msg = `[did-fail-load] code=${code} desc=${desc} url=${url}\n`
    console.error(msg.trim())
    try { appendFileSync(join(app.getPath('userData'), 'debug.log'), msg) } catch {}
  })
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && !app.isPackaged) {
      mainWindow.webContents.toggleDevTools()
    }
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https:') || details.url.startsWith('http:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' }
    ])
    // 在可编辑区域或选中文本时显示菜单（让用户能右键复制选中的消息片段）
    if (params.isEditable || params.selectionText) {
      menu.popup({ window: mainWindow })
    }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      const RENDERER_DIR = resolve(join(__dirname, '../renderer'))
      const allowed =
        (parsed.protocol === 'file:' && fileURLToPath(url).startsWith(RENDERER_DIR)) ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1'
      if (!allowed) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

/** 预览资源自定义协议：预览 iframe 走 about:srcdoc，Chromium 不允许它加载 file:// 本地资源
 *  （控制台报 Not allowed to load local resource）。改由主进程用 app:// 提供工作区内的文件。
 *  必须在 app ready 之前声明为特权 scheme：standard 让相对路径能解析（预览页注入了
 *  <base href="app://local/<dir>/">），secure 让它不被当成不安全来源，supportFetchAPI
 *  让 fetch / 字体 / 样式都走得通。 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/** 渲染进程的 CSP（与 src/renderer/index.html 的 <meta> 一致，且**不含 'unsafe-eval'**）。
 *  meta 版只在文档里生效，而 Electron 的开发者安全检查看的是响应头，没头就报「no CSP set」；
 *  同时 unsafe-eval 是那条警告单独列出的第二种情况，带上它等于没修。
 *  app: 是上面那个预览资源协议，预览 iframe 继承这份策略，不放行它 css/js 全加载不到。 */
const RENDERER_CSP = [
  "default-src 'self' app: http://localhost:*",
  "connect-src 'self' app: http://* https://*",
  "frame-src * http://localhost:*",
  "script-src 'self' 'unsafe-inline' app:",
  "style-src 'self' 'unsafe-inline' https: app:",
  "font-src 'self' data: https: app:",
  "img-src 'self' data: blob: https://* app:",
  "media-src 'self' blob: app:",
].join('; ')

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.llama-studio')
  // ── CSP 响应头 ──（dev 走 localhost 开发服务器，打包走 file://，统一补上）
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] },
    })
  })
  // ── 预览资源：app://local/<绝对路径> → 工作区内的真实文件 ──
  // 越界 / 不存在一律 404（范围判定在 ipc.ts 的 resolvePreviewAsset，锁死在工作区内）。
  protocol.handle('app', (request) => {
    const filePath = ipcInternal.resolvePreviewAsset?.(new URL(request.url).pathname)
    if (!filePath) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
  // ── 窗口控制 IPC ──
  ipcMain.handle('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize()
  })
  ipcMain.handle('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // ── 拦截 webview guest contents 的新窗口请求，在当前 webview 中导航 ──
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https:') || url.startsWith('http:')) {
          setImmediate(() => contents.loadURL(url).catch(() => {}))
        }
        return { action: 'deny' }
      })
    }
  })
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpcHandlers()
  initAgentBrowserPreview()
  const win = createWindow()
  registerPiAgentIpc(win)
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
app.on('will-quit', () => {
  cleanupRunningProcesses()
  disposePiAgentIpc()
})

