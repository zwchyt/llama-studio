import { app, shell, BrowserWindow, Menu } from 'electron'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupRunningProcesses } from './ipc'
import { appendFileSync } from 'fs'
import { existsSync } from 'fs'

process.noDeprecation = true

import { mkdirSync } from 'fs'
try { mkdirSync(join(tmpdir(), 'hexllama-cache'), { recursive: true }) } catch {}
app.commandLine.appendSwitch('--disk-cache-dir', join(tmpdir(), 'hexllama-cache'))
app.commandLine.appendSwitch('--disable-gpu-cache')
app.commandLine.appendSwitch('--disable-disk-cache')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function resolveIcon(): string | undefined {
  const candidates = [
    join(process.cwd(), 'assets', 'icon.png'),                  
    join(__dirname, '../../assets/icon.png'),                    
    join(app.getAppPath(), 'assets', 'icon.png')                 
  ]
  return candidates.find(existsSync)
}
function createWindow(): void {
  const icon = resolveIcon()
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f5',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
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
    if (input.key === 'F12') {
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
}
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.hexllama')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpcHandlers()
  createWindow()
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
})

