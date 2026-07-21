export type TerminalAction = 'clearTerminal' | 'fontSizeUp' | 'fontSizeDown' | 'fontSizeReset'

export type TerminalKeybinds = Record<TerminalAction, string>

export const TERMINAL_ACTIONS: readonly TerminalAction[] = [
  'clearTerminal',
  'fontSizeUp',
  'fontSizeDown',
  'fontSizeReset',
]

export const TERMINAL_ACTION_LABELS: Record<TerminalAction, string> = {
  clearTerminal: '清屏',
  fontSizeUp: '放大字号',
  fontSizeDown: '缩小字号',
  fontSizeReset: '重置字号',
}

export const DEFAULT_TERMINAL_KEYBINDS: TerminalKeybinds = {
  clearTerminal: 'mod+k',
  fontSizeUp: 'mod+=',
  fontSizeDown: 'mod+-',
  fontSizeReset: 'mod+0',
}

const KEYBINDS_KEY = 'terminal-keybinds-v1'

type Combo = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

const CODE_KEY: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  Space: 'space',
}

function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_KEY[code] ?? null
}

export function parseKeybind(binding: string): Combo | null {
  const mac = /Mac/i.test(navigator.platform)
  const parts = binding.toLowerCase().split('+').map(p => p.trim()).filter(Boolean)
  const combo: Combo = { meta: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    if (part === 'mod') { if (mac) combo.meta = true; else combo.ctrl = true }
    else if (part === 'meta' || part === 'cmd') combo.meta = true
    else if (part === 'ctrl') combo.ctrl = true
    else if (part === 'alt') combo.alt = true
    else if (part === 'shift') combo.shift = true
    else combo.key = part
  }
  return combo.key ? combo : null
}

export function matchKeybind(event: KeyboardEvent, binding: string): boolean {
  const combo = parseKeybind(binding)
  if (!combo) return false
  if (event.metaKey !== combo.meta) return false
  if (event.ctrlKey !== combo.ctrl) return false
  if (event.altKey !== combo.alt) return false
  if (event.shiftKey !== combo.shift) return false
  return codeToKey(event.code) === combo.key
}

export function matchTerminalAction(event: KeyboardEvent, keybinds: TerminalKeybinds): TerminalAction | null {
  for (const action of TERMINAL_ACTIONS) {
    if (matchKeybind(event, keybinds[action])) return action
  }
  return null
}

function readKeybinds(): TerminalKeybinds {
  try {
    const raw = localStorage.getItem(KEYBINDS_KEY)
    if (!raw) return { ...DEFAULT_TERMINAL_KEYBINDS }
    const parsed = JSON.parse(raw) as Partial<TerminalKeybinds>
    const result = { ...DEFAULT_TERMINAL_KEYBINDS }
    for (const action of TERMINAL_ACTIONS) {
      if (typeof parsed[action] === 'string' && parsed[action]!.trim()) {
        result[action] = parsed[action]!
      }
    }
    return result
  } catch {
    return { ...DEFAULT_TERMINAL_KEYBINDS }
  }
}

let keybindsCache: TerminalKeybinds = readKeybinds()
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

export function getTerminalKeybinds(): TerminalKeybinds {
  return keybindsCache
}

export function setTerminalKeybind(action: TerminalAction, binding: string): void {
  keybindsCache = { ...keybindsCache, [action]: binding }
  try { localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybindsCache)) } catch {}
  notify()
}

export function resetTerminalKeybinds(): void {
  keybindsCache = { ...DEFAULT_TERMINAL_KEYBINDS }
  try { localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybindsCache)) } catch {}
  notify()
}

export function resetTerminalKeybind(action: TerminalAction): void {
  keybindsCache = { ...keybindsCache, [action]: DEFAULT_TERMINAL_KEYBINDS[action] }
  try { localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybindsCache)) } catch {}
  notify()
}

export function subscribeTerminalStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
