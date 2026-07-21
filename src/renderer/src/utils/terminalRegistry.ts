import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface Entry { term: Terminal; fit: FitAddon; container: HTMLElement | null }
interface PendingWrite { data: string[]; timer: ReturnType<typeof setTimeout> | null; raf: number | null }

const registry = new Map<string, Entry>()
const pendingWrites = new Map<string, PendingWrite>()

function fitWithBuffer(e: Entry): void {
  const c = e.container
  if (c && (c.clientWidth === 0 || c.clientHeight === 0)) return
  try { e.fit.fit() } catch {}
}

const MAX_PENDING_BYTES = 256 * 1024

function flushWrite(_id: string, pw: PendingWrite, e: Entry): void {
  if (pw.timer) { clearTimeout(pw.timer); pw.timer = null }
  if (pw.raf) { cancelAnimationFrame(pw.raf); pw.raf = null }
  if (pw.data.length === 0) return
  const merged = pw.data.join('')
  pw.data = []
  try { e.term.write(merged) } catch {}
}

/**
 * 当 xterm 实例就绪后将缓存的数据回写。
 * 解决两类问题：
 *  1. 首屏输出竞态——pty 在实例创建前就产生了数据；
 *  2. 视图切换期间缓冲——切换走终端视图时实例被销毁，期间到达的输出先入缓冲，切回时回写。
 */
function flushPendingIfReady(id: string): void {
  const e = registry.get(id)
  if (!e) return
  const pw = pendingWrites.get(id)
  if (!pw || pw.data.length === 0) return
  flushWrite(id, pw, e)
}

/** 从指定元素的 computed style 中读取 --color-terminal-* CSS 变量构建 xterm 主题 */
function buildTerminalTheme(container: HTMLElement): Record<string, string> | undefined {
  let cssVar: (name: string) => string
  try {
    const styles = getComputedStyle(container)
    cssVar = (name: string) => styles.getPropertyValue(name).trim()
  } catch {
    return undefined
  }
  const v = (name: string, fallback: string) => cssVar(name) || fallback
  return {
    background: v('--color-terminal-bg', '#1e1e1e'),
    foreground: v('--color-terminal-fg', '#d4d4d4'),
    cursor: v('--color-terminal-cursor', '#f8f8f8'),
    cursorAccent: v('--color-terminal-cursor-accent', '#1e1e1e'),
    selectionBackground: v('--color-terminal-selection', '#339cff47'),
    black: v('--color-terminal-black', '#363636'),
    red: v('--color-terminal-red', '#f67576'),
    green: v('--color-terminal-green', '#85df7b'),
    yellow: v('--color-terminal-yellow', '#fa994c'),
    blue: v('--color-terminal-blue', '#3d8dff'),
    magenta: v('--color-terminal-magenta', '#b06dff'),
    cyan: v('--color-terminal-cyan', '#6dcbf4'),
    white: v('--color-terminal-white', '#adadad'),
    brightBlack: v('--color-terminal-bright-black', '#747474'),
    brightRed: v('--color-terminal-bright-red', '#f99'),
    brightGreen: v('--color-terminal-bright-green', '#87d9a4'),
    brightYellow: v('--color-terminal-bright-yellow', '#ffb26b'),
    brightBlue: v('--color-terminal-bright-blue', '#55a2ff'),
    brightMagenta: v('--color-terminal-bright-magenta', '#a888f2'),
    brightCyan: v('--color-terminal-bright-cyan', '#8ee5e5'),
    brightWhite: v('--color-terminal-bright-white', '#f8f8f8'),
  }
}

export function createTerminal(id: string, container?: HTMLElement): Terminal {
  if (registry.has(id)) return registry.get(id)!.term
  const theme = container ? buildTerminalTheme(container) : undefined
  const term = new Terminal({ fontFamily: 'Consolas, monospace', fontSize: 13, cursorBlink: true, theme })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  registry.set(id, { term, fit, container: null })
  flushPendingIfReady(id)
  return term
}

export function attach(id: string, container: HTMLElement): void {
  const e = registry.get(id)
  if (!e) return
  if (e.container !== container) {
    // 仅在尚未 open 或容器变化时 open，避免对已 open 的实例重复调用 term.open（切换视图时会用新容器重新挂载）
    // 若尚未设置 theme（无 container 创建），在首次 open 时尝试从实际容器读取
    if (!e.term.options.theme) {
      const theme = buildTerminalTheme(container)
      if (theme) e.term.options.theme = theme
    }
    e.term.open(container)
    e.container = container
  }
  fitWithBuffer(e)
  flushPendingIfReady(id)
}

// ── 字号管理 ──
const FONT_SIZE_KEY = 'terminal-font-size'
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 28
export const TERMINAL_FONT_SIZE_DEFAULT = 13

function clampFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)))
}

export function getTerminalFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY)
    if (raw == null) return TERMINAL_FONT_SIZE_DEFAULT
    return clampFontSize(Number(raw))
  } catch {
    return TERMINAL_FONT_SIZE_DEFAULT
  }
}

export function setTerminalFontSize(size: number): void {
  const clamped = clampFontSize(size)
  try { localStorage.setItem(FONT_SIZE_KEY, String(clamped)) } catch { /* ignore */ }
  for (const [id] of registry) {
    const e = registry.get(id)
    if (e) {
      try { e.term.options.fontSize = clamped } catch {}
    }
  }
}

/** 刷新指定终端实例的主题（亮/暗切换时调用） */
export function updateTerminalTheme(id: string): void {
  const e = registry.get(id)
  if (!e || !e.container) return
  const theme = buildTerminalTheme(e.container)
  if (theme) e.term.options.theme = theme
}

export function disposeTerminal(id: string): void {
  const pw = pendingWrites.get(id)
  if (pw) {
    if (pw.timer) clearTimeout(pw.timer)
    if (pw.raf) cancelAnimationFrame(pw.raf)
    pendingWrites.delete(id)
  }
  const e = registry.get(id)
  if (!e) return
  try { e.term.dispose() } catch {}
  registry.delete(id)
}

export function fitTerminal(id: string): void {
  const e = registry.get(id)
  if (!e) return
  fitWithBuffer(e)
}

/** 检查指定 id 的 xterm 实例是否已创建就绪 */
export function isTerminalReady(id: string): boolean {
  return registry.has(id)
}

/** 直接写入（绕过 coalescing buffer），用于 replay 回放 */
export function writeDirectToTerminal(id: string, data: string): void {
  const e = registry.get(id)
  if (e) { try { e.term.write(data) } catch {} }
}

/**
 * 分离 xterm 实例但不销毁 PTY（与 disposeTerminal 不同）。
 * 用于 MRU 策略：释放 xterm 内存，保留 ownerKey 关联的 PTY 进程。
 */
export function detachTerminal(id: string): void {
  const pw = pendingWrites.get(id)
  if (pw) {
    if (pw.timer) clearTimeout(pw.timer)
    if (pw.raf) cancelAnimationFrame(pw.raf)
    pendingWrites.delete(id)
  }
  const e = registry.get(id)
  if (!e) return
  try { e.term.dispose() } catch {}
  registry.delete(id)
}

export function writeToTerminal(id: string, data: string): void {
  let pw = pendingWrites.get(id)
  if (!pw) {
    pw = { data: [], timer: null, raf: null }
    pendingWrites.set(id, pw)
  }
  pw.data.push(data)
  const e = registry.get(id)
  const totalBytes = pw.data.reduce((sum, d) => sum + d.length, 0)
  if (totalBytes > MAX_PENDING_BYTES) {
    if (e) {
      flushWrite(id, pw, e)
    } else {
      // 实例未就绪时只保留最近的缓冲，避免内存无限增长
      while (pw.data.length > 1 && pw.data.reduce((s, d) => s + d.length, 0) > MAX_PENDING_BYTES) {
        pw.data.shift()
      }
    }
    return
  }
  if (!e) return // 实例尚未创建，先缓存在 pendingWrites，待 attach 时回写
  if (!pw.raf) {
    pw.raf = requestAnimationFrame(() => {
      if (pw) {
        pw.raf = null
        flushWrite(id, pw, e)
      }
    })
  }
  if (!pw.timer) {
    pw.timer = setTimeout(() => {
      if (pw) {
        pw.timer = null
        if (pw.raf) { cancelAnimationFrame(pw.raf); pw.raf = null }
        flushWrite(id, pw, e)
      }
    }, 50)
  }
}
