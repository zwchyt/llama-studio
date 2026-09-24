// ── Agent 浏览器预览与截图服务（主进程）──────────────────────────────────
// 职责边界：只做「模型展示 HTML / 打开指定 URL / 截取当前预览页」三件事。
// 不做点击、输入、DOM 读取、任意脚本注入等浏览器自动化。
//
// 安全模型：
//  - 模型生成的 HTML 落到 userData/agent-preview/ 下的独立文件，由 <webview> guest 加载。
//    guest 无 preload、无 nodeIntegration、contextIsolation 默认开启 —— 页面拿不到
//    Node / require / IPC / 文件系统 / shell，等价于访问一个不可信网站。
//  - guest 内发起的导航只放行 http/https，以及预览目录内的 file:（预览页自身），
//    其余协议（javascript: / data: / chrome: …）一律 preventDefault。
//  - 截图只能作用于「渲染进程上报且确认为本会话创建过的 webview guest」的 id，
//    避免渲染进程用任意 webContents id 截主窗口等其它页面。
import { app, nativeImage, webContents, type WebContents } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, resolve, sep, dirname } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { ipcInternal } from '../ipc'
import type {
  BrowserCaptureOptions,
  BrowserCaptureResult,
  BrowserNavigateCommand,
  BrowserShowInput,
  BrowserShowResult
} from '../../shared/browserPreview'

/** 预览 HTML 落盘目录（userData 下，打包后同样可写）；惰性取路径，避免模块求值时 app 未就绪 */
function previewDir(): string {
  return join(app.getPath('userData'), 'agent-preview')
}
/** 单份 HTML 上限：模型偶尔会吐出带内联资源的巨型文档，磁盘与页面都不该接 */
const MAX_HTML_BYTES = 4 * 1024 * 1024
/** 整页截图边长与总像素上限：超长页面会产出上百 MB PNG */
const MAX_SHOT_SIDE = 12000
const MAX_SHOT_PIXELS = 40_000_000
/** 预览目录保留策略：超过 TTL 或超出数量上限的旧文件在启动时清掉 */
const PREVIEW_TTL_MS = 24 * 3600 * 1000
const PREVIEW_KEEP = 60
/** 截图兜底超时：页面无响应时 capturePage 会一直挂着 */
const CAPTURE_TIMEOUT_MS = 15000
/** 面板被关后重新打开：单次等页面挂载的时长与重试轮数 */
const GUEST_WAIT_MS = 6000
const GUEST_RECOVER_ATTEMPTS = 3
/** 渲染进程报的「面板没开起来」类失败 —— 只有这类值得重试 */
const PANEL_NOT_OPEN = /面板/

/** 本会话创建过的 webview guest id（destroyed 时移除） */
const liveGuestIds = new Set<number>()
/** 渲染进程上报的当前活跃预览 guest；面板隐藏时会被置空 */
let activeGuestId: number | null = null

function logInfo(msg: string): void {
  // 日志只报摘要，绝不打印 HTML 内容或带 query 的完整 URL
  console.log(`[agent-browser] ${msg}`)
}

function describeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(无法解析)'
  }
}

/** 预览页可加载的 file: 目录：预览临时目录 + 最近一次主动打开的工作区 HTML 所在目录。
 *  只放行这两个根之下的文件，其它磁盘路径（如 C:\Users\...）一律拒绝。 */
const allowedFileDirs = new Set<string>()

function allowFileDir(filePath: string): void {
  allowedFileDirs.add(resolve(dirname(filePath)))
}

function isAllowedFileTarget(target: string): boolean {
  const base = resolve(previewDir())
  if (target === base || target.startsWith(base + sep)) return true
  for (const dir of allowedFileDirs) {
    if (target === dir || target.startsWith(dir + sep)) return true
  }
  return false
}

/** 预览页可加载的协议：远程站 + 本地预览文件；其余（javascript:/data:/file: 越界）拒绝 */
function isAllowedGuestUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return true
    if (u.protocol === 'file:') return isAllowedFileTarget(resolve(fileURLToPath(u)))
    return false
  } catch {
    return false
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 启动清理 + guest 跟踪。由 main/index.ts 在 whenReady 中调用一次。 */
export function initAgentBrowserPreview(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    const id = contents.id
    liveGuestIds.add(id)
    contents.on('destroyed', () => {
      liveGuestIds.delete(id)
      if (activeGuestId === id) activeGuestId = null
    })
    contents.on('will-navigate', (ev, url) => {
      if (!isAllowedGuestUrl(url)) {
        ev.preventDefault()
        logInfo(`已拦截预览页的危险导航协议: ${describeUrl(url)}`)
      }
    })
  })
  cleanupPreviewDir()
}

/** 清理过期/超量预览文件（启动时一次；失败静默，不影响启动） */
function cleanupPreviewDir(): void {
  void (async () => {
    try {
      const dir = previewDir()
      const names = readdirSync(dir)
      const entries: { name: string; mtimeMs: number }[] = []
      for (const name of names) {
        const fp = join(dir, name)
        try {
          const st = statSync(fp)
          if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs })
        } catch { /* 忽略单个文件 */ }
      }
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const { unlink } = await import('fs/promises')
      for (const [i, entry] of entries.entries()) {
        if (i >= PREVIEW_KEEP || Date.now() - entry.mtimeMs > PREVIEW_TTL_MS) {
          void unlink(join(dir, entry.name)).catch(() => { /* 已被删除 */ })
        }
      }
    } catch { /* 目录尚未创建 */ }
  })()
}

function writePreviewHtml(html: string): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof html !== 'string' || !html.trim()) return { ok: false, error: 'html 内容为空' }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return { ok: false, error: `HTML 超过 ${Math.floor(MAX_HTML_BYTES / 1024 / 1024)}MB 上限，请精简后重试` }
  }
  try {
    const dir = previewDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = `preview-${Date.now()}-${randomBytes(4).toString('hex')}.html`
    const fp = join(dir, name)
    writeFileSync(fp, html, 'utf8')
    return { ok: true, url: pathToFileURL(fp).href }
  } catch (e) {
    return { ok: false, error: `写入预览文件失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 校验 browser_show 入参并准备导航指令（HTML 在此落盘）。
 * 主进程独立校验，不信任模型与渲染进程给出的值。
 */
export function prepareBrowserShow(input: BrowserShowInput): { ok: true; cmd: BrowserNavigateCommand; base: BrowserShowResult } | { ok: false; result: BrowserShowResult } {
  const kind = input?.type
  const title = typeof input?.title === 'string' ? input.title.trim().slice(0, 120) : ''
  if (kind === 'html') {
    const written = writePreviewHtml(input.html)
    if (!written.ok) return { ok: false, result: { ok: false, type: 'html', title, error: written.error } }
    return {
      ok: true,
      cmd: { kind: 'html', url: written.url, title: title || undefined },
      base: { ok: true, type: 'html', title }
    }
  }
  if (kind === 'url') {
    const checked = checkHttpUrl(input.url)
    if (!checked.ok) return { ok: false, result: { ok: false, type: 'url', title, error: checked.error } }
    return {
      ok: true,
      cmd: { kind: 'url', url: checked.url, title: title || undefined },
      base: { ok: true, type: 'url', title }
    }
  }
  if (kind === 'file') {
    // 直接预览项目里已写好的 HTML：不要求模型把源码再传一遍（它刚用 Write 写完，
    // 再抄一次既浪费 token 也容易让它干脆放弃调用）。路径解析与安全边界在主进程做。
    const resolved = ipcInternal.handleResolvePreviewFile?.(String(input.path ?? '')) ?? { error: '路径解析未就绪' }
    if (!resolved.path) return { ok: false, result: { ok: false, type: 'file', title, error: resolved.error ?? '路径无效' } }
    allowFileDir(resolved.path)
    return {
      ok: true,
      cmd: { kind: 'file', url: pathToFileURL(resolved.path).href, title: title || undefined },
      base: { ok: true, type: 'file', title }
    }
  }
  return { ok: false, result: { ok: false, type: 'url', title: '', error: 'type 只能是 "html"、"url" 或 "file"' } }
}

function checkHttpUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url 不能为空' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'URL 格式非法（需带协议，例如 https://example.com）' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `仅允许 http/https 协议，收到 ${u.protocol}` }
  }
  if (!u.hostname) return { ok: false, error: 'URL 缺少主机名' }
  return { ok: true, url: u.href }
}

/** 渲染进程上报当前活跃预览 guest（null = 面板已隐藏/页面已卸载） */
export function setActiveBrowserGuest(rawId: unknown): { ok: boolean; error?: string } {
  if (rawId === null || rawId === undefined || rawId === 0) {
    activeGuestId = null
    return { ok: true }
  }
  const id = Number(rawId)
  if (!Number.isInteger(id) || !liveGuestIds.has(id)) {
    return { ok: false, error: '该 webContents 不是本应用创建的预览页' }
  }
  activeGuestId = id
  // 记下这个页面：模型再来截图时若面板已被关掉，就按这个地址把它重新打开。
  // 用户在地址栏自己开的页面同样适用（这里以面板实际停留的 URL 为准）。
  const guest = webContents.fromId(id)
  const url = guest?.getURL() ?? ''
  if (url && url !== 'about:blank') {
    lastPreview = { kind: url.startsWith('file:') ? 'html' : 'url', url }
  }
  return { ok: true }
}

function activeGuest(): WebContents | null {
  if (activeGuestId === null) return null
  if (!liveGuestIds.has(activeGuestId)) return null
  const guest = webContents.fromId(activeGuestId)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
  const url = guest.getURL()
  if (!url || url === 'about:blank') return null
  return guest
}

/** 最近一次成功打开的预览页：面板被用户关掉后，工具靠它把页面重新打开 */
let lastPreview: { kind: 'html' | 'url' | 'file'; url: string; title?: string } | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等渲染进程把 webview 挂上并上报 guest id（面板从关闭到可见之间有挂载延迟） */
async function waitForGuest(timeoutMs: number): Promise<WebContents | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const guest = activeGuest()
    if (guest) return guest
    if (Date.now() > until) return null
    await sleep(120)
  }
}

/**
 * 确保预览页当前可见：面板被关（webview 已卸载、guest id 已清）时重新下发展开面板并导航的指令，
 * 反复尝试直到页面真的出现在预览区。模型不需要为此先调 browser_show。
 */
async function ensurePreviewVisible(): Promise<WebContents | null> {
  const existing = activeGuest()
  if (existing) return existing
  if (!lastPreview) return null
  for (let attempt = 0; attempt < GUEST_RECOVER_ATTEMPTS; attempt++) {
    const navigated = await requestRendererNavigate(lastPreview)
    const guest = await waitForGuest(GUEST_WAIT_MS)
    if (guest) {
      // 重定向过就以最终地址为准，下次恢复不再多跳一次
      if (navigated?.ok && navigated.url) lastPreview = { ...lastPreview, url: navigated.url }
      return guest
    }
  }
  return null
}

/** 整页截图：CDP 取文档尺寸后一次性捕获视口外内容；失败即返回错误，绝不退回视口图 */
async function captureFullPage(guest: WebContents): Promise<{ png: Buffer } | { error: string }> {
  const dbg = guest.debugger
  try {
    dbg.attach('1.3')
  } catch {
    return { error: '整页截图需要 CDP 调试通道，当前页面未能建立' }
  }
  try {
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width?: number; height?: number }
      contentSize?: { width?: number; height?: number }
    }
    const size = metrics?.cssContentSize ?? metrics?.contentSize
    const width = Math.ceil(Number(size?.width) || 0)
    const height = Math.ceil(Number(size?.height) || 0)
    if (!width || !height) return { error: '无法获取页面完整尺寸' }
    if (width > MAX_SHOT_SIDE || height > MAX_SHOT_SIDE || width * height > MAX_SHOT_PIXELS) {
      return { error: `页面完整尺寸 ${width}×${height} 超出截图上限（单边 ${MAX_SHOT_SIDE}px）` }
    }
    const shot = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    })) as { data?: string }
    const png = Buffer.from(String(shot?.data ?? ''), 'base64')
    if (!png.length) return { error: '整页截图返回空数据' }
    return { png }
  } catch (e) {
    return { error: `整页截图失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    try { dbg.detach() } catch { /* 未 attach 或已分离 */ }
  }
}

/** 截取当前预览页。fullPage=true 走整页，失败时明确报错而不是退回视口图。 */
export async function captureBrowser(opts: BrowserCaptureOptions): Promise<BrowserCaptureResult> {
  const fullPage = opts?.fullPage === true
  // 面板被关掉（含用户手动关）时不直接报错：先把预览区重新打开，打开失败才返回错误
  const guest = await ensurePreviewVisible()
  if (!guest) {
    return {
      ok: false,
      error: lastPreview
        ? '多次尝试重新打开浏览器面板均未成功，请确认右侧面板可以展开后再截图'
        : '当前还没有打开过任何预览页面，请先用 browser_show 打开页面'
    }
  }
  try {
    const png = await withTimeout(
      (async () => {
        if (fullPage) {
          const r = await captureFullPage(guest)
          if ('error' in r) throw new Error(r.error)
          return r.png
        }
        const img = await guest.capturePage()
        const buf = img.toPNG()
        if (!buf.length) throw new Error('截图返回空数据')
        return buf
      })(),
      CAPTURE_TIMEOUT_MS,
      '截图'
    )
    const dims = nativeImage.createFromBuffer(png).getSize()
    const saved = ipcInternal.handleSaveBrowserScreenshot?.(png)
    if (!saved?.ref) {
      return { ok: false, error: saved?.error ?? '截图保存失败' }
    }
    logInfo(`已截图 ${fullPage ? '整页' : '视口'} ${dims.width}×${dims.height} ${describeUrl(guest.getURL())}`)
    return {
      ok: true,
      imageId: saved.ref,
      mimeType: 'image/png',
      width: dims.width || undefined,
      height: dims.height || undefined,
      fullPage,
      // 模型支持图像输入时才把 PNG 一并带回（工具文本结果里仍只有引用与尺寸）
      ...(opts.withImage ? { imageBase64: png.toString('base64') } : {})
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[agent-browser] 截图失败:', msg)
    return { ok: false, error: msg }
  }
}

/** 供 browser_show 工具使用：校验 + 准备指令，再由 workerClient 推给渲染进程执行导航 */
export async function showBrowserPreview(input: BrowserShowInput): Promise<BrowserShowResult> {
  const prepared = prepareBrowserShow(input)
  if (!prepared.ok) return prepared.result
  const { cmd, base } = prepared
  // 面板从未打开过时，AgentBrowser 要先挂载一次（渲染进程侧等注册）；只在「面板没开起来」
  // 这种失败上重试，页面自身加载失败（域名解析不了等）重试没有意义，直接如实返回。
  let navigated: Partial<BrowserShowResult> | null = null
  for (let attempt = 0; attempt < GUEST_RECOVER_ATTEMPTS; attempt++) {
    navigated = await requestRendererNavigate(cmd)
    if (navigated?.ok) break
    if (navigated && !PANEL_NOT_OPEN.test(navigated.error ?? '')) break
    await sleep(400)
  }
  if (!navigated || !navigated.ok) {
    return { ...base, ok: false, url: cmd.url, error: navigated?.error ?? '浏览器面板未能打开' }
  }
  lastPreview = { kind: cmd.kind, url: navigated.url || cmd.url, ...(cmd.title ? { title: cmd.title } : {}) }
  return {
    ...base,
    ok: true,
    url: navigated.url || cmd.url,
    title: navigated.title || base.title || ''
  }
}

// 由 workerClient 注入（它持有主窗口 webContents 与未决请求表）：避免本模块重复管理窗口引用
let navigateToRenderer: ((cmd: BrowserNavigateCommand) => Promise<Partial<BrowserShowResult> | null>) | null = null
export function setBrowserNavigateHandler(fn: typeof navigateToRenderer): void {
  navigateToRenderer = fn
}
async function requestRendererNavigate(cmd: BrowserNavigateCommand): Promise<Partial<BrowserShowResult> | null> {
  if (!navigateToRenderer) return null
  try {
    return await navigateToRenderer(cmd)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
