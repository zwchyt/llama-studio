import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface Entry { term: Terminal; fit: FitAddon; container: HTMLElement | null }
interface PendingWrite { data: string[]; timer: ReturnType<typeof setTimeout> | null; raf: number | null }

const registry = new Map<string, Entry>()
const pendingWrites = new Map<string, PendingWrite>()

/**
 * 底部安全行缓冲：fit 计算出的行数可能因像素级误差比实际可视区多算，
 * 导致 TUI 程序（如 agent）把输入行放在“最后一行”时被推出可视区、被输出覆盖。
 * 这里主动把上报给 pty 的行数减 1，并同步缩小 xterm 自身行数，给输入区留物理缓冲。
 */
const TERMINAL_BOTTOM_BUFFER = 1

function fitWithBuffer(e: Entry): void {
  try { e.fit.fit() } catch {}
  if (e.term.rows > TERMINAL_BOTTOM_BUFFER) {
    try { e.term.resize(e.term.cols, e.term.rows - TERMINAL_BOTTOM_BUFFER) } catch {}
  }
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

export function createTerminal(id: string): Terminal {
  if (registry.has(id)) return registry.get(id)!.term
  const term = new Terminal({ fontFamily: 'Consolas, monospace', fontSize: 13, cursorBlink: true })
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
    e.term.open(container)
    e.container = container
  }
  fitWithBuffer(e)
  flushPendingIfReady(id)
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
