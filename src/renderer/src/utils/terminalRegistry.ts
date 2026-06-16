import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface Entry { term: Terminal; fit: FitAddon; container: HTMLElement | null }
interface PendingWrite { data: string[]; timer: ReturnType<typeof setTimeout> | null; raf: number | null }

const registry = new Map<string, Entry>()
const pendingWrites = new Map<string, PendingWrite>()

function flushWrite(id: string, pw: PendingWrite, e: Entry): void {
  if (pw.timer) { clearTimeout(pw.timer); pw.timer = null }
  if (pw.raf) { cancelAnimationFrame(pw.raf); pw.raf = null }
  if (pw.data.length === 0) return
  const merged = pw.data.join('')
  pw.data = []
  try { e.term.write(merged) } catch {}
}

export function createTerminal(id: string): Terminal {
  if (registry.has(id)) return registry.get(id)!.term
  const term = new Terminal({ fontFamily: 'Consolas, monospace', fontSize: 13, cursorBlink: true })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  registry.set(id, { term, fit, container: null })
  return term
}

export function attach(id: string, container: HTMLElement): void {
  const e = registry.get(id)
  if (!e) return
  if (e.container !== container) {
    e.term.open(container)
    e.container = container
  }
  try { e.fit.fit() } catch {}
}

export function detach(_id: string): void {
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
  try { e.fit.fit() } catch {}
}

export function writeToTerminal(id: string, data: string): void {
  const e = registry.get(id)
  if (!e) return
  let pw = pendingWrites.get(id)
  if (!pw) {
    pw = { data: [], timer: null, raf: null }
    pendingWrites.set(id, pw)
  }
  pw.data.push(data)
  const totalBytes = pw.data.reduce((sum, d) => sum + d.length, 0)
  if (totalBytes > 256 * 1024) {
    flushWrite(id, pw, e)
    return
  }
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
