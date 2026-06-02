import { app, shell, BrowserWindow } from 'electron'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupRunningProcesses } from './ipc'
import { existsSync } from 'fs'
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
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https:') || details.url.startsWith('http:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
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

