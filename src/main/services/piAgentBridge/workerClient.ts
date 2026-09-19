// pi-agent utility process ?????????
// ???? out/main/piWorker.mjs?ESM utility process????????? IPC ??
// ??? postMessage ?? worker??? worker ? pi ???? / ?? RPC / ask-approve
// ???????????pi SDK?ESM-only??????????????????
// ???????????????????????
import { app, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createIpcExecutors } from './ipcExecutors'
import type { MainToolExecutors, AskUserQuestionInput } from './tools/mainTools'

interface WorkerInbound { kind: string; id?: number; action?: string; args?: Record<string, unknown>; agentDir?: string; toolNames?: string[]; event?: Record<string, unknown>; ok?: boolean; value?: unknown }
interface WorkerOutbound { kind: string; id?: number; sessionId?: string; event?: unknown; ok?: boolean; value?: unknown; level?: 'log' | 'warn' | 'error'; args?: unknown[]; name?: string; message?: string }

let worker: UtilityProcess | null = null
let ready = false
let initError: string | null = null
let currentWindow: BrowserWindow | null = null
let agentDirCache = ''
let toolExecutors: MainToolExecutors | null = null
let cmdSeq = 0
const pendingCmds = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let askSeq = 0
const pendingAsks = new Map<number, { resolve: (v: string) => void }>()
let approveSeq = 0
const pendingApproves = new Map<number, { resolve: (v: boolean) => void }>()

/** piWorker.mjs ???????????? resourcesPath?asar ???dev ?? out/main? */
function resolveWorkerEntry(): string {
  if (app.isPackaged) {
    const p = join(process.resourcesPath, 'piWorker.mjs')
    if (existsSync(p)) return p
  }
  return join(__dirname, 'piWorker.mjs')
}

function getToolExecutors(): MainToolExecutors {
  if (!toolExecutors) {
    toolExecutors = { ...createIpcExecutors(), askUser: askViaRenderer, approve: approveViaRenderer } as MainToolExecutors
  }
  return toolExecutors as MainToolExecutors
}

function askViaRenderer(questions: AskUserQuestionInput[]): Promise<string> {
  return new Promise((resolve) => {
    const id = ++askSeq
    pendingAsks.set(id, { resolve })
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('pi-agent-ask', id, questions)
    } else {
      pendingAsks.delete(id)
      resolve('No user available to answer. Continue with the task using your best judgment.')
    }
  })
}

function approveViaRenderer(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++approveSeq
    pendingApproves.set(id, { resolve })
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('pi-agent-approve', id, { toolName, args })
    } else {
      pendingApproves.delete(id)
      resolve(false)
    }
  })
}

export function resolveAsk(id: number, result: string): void {
  const p = pendingAsks.get(id)
  pendingAsks.delete(id)
  p?.resolve(result)
}
export function resolveApprove(id: number, approved: boolean): void {
  const p = pendingApproves.get(id)
  pendingApproves.delete(id)
  p?.resolve(approved)
}

/** ? worker ? pi ?????? renderer??????????? piAgentIpc.push ???? */
function pushEvent(sessionId: string, event: unknown): void {
  if (!currentWindow || currentWindow.isDestroyed()) return
  const e = event as { type?: string; assistantMessageEvent?: { type?: string; partial?: { content?: Array<{ type?: string; name?: string; id?: string }> } } }
  let slim = event
  if (e && e.type === 'message_update') {
    const am = e.assistantMessageEvent
    if (am && typeof am === 'object' && am.partial && typeof am.partial === 'object') {
      const content = Array.isArray(am.partial.content) ? am.partial.content : []
      slim = {
        ...(e as object),
        assistantMessageEvent: {
          ...am,
          partial: am.type === 'toolcall_start'
            ? { content: content.map(b => (b && b.type === 'toolCall' ? { type: b.type, name: b.name, id: b.id } : { type: b?.type ?? '' })) }
            : undefined
        }
      }
    }
  }
  currentWindow.webContents.send('pi-agent-event', sessionId, slim)
}

async function dispatchTool(name: string, args: unknown[]): Promise<unknown> {
  const exec = getToolExecutors() as unknown as Record<string, (...a: never[]) => Promise<unknown> | unknown>
  const fn = exec[name]
  if (typeof fn !== 'function') throw new Error(`???????: ${name}`)
  if (name === 'askUser' || name === 'approve') throw new Error(`${name} ??? tool-event ??`)
  return await (fn as (...a: unknown[]) => Promise<unknown>)(...(args as unknown[]))
}

function handleWorkerMessage(raw: unknown): void {
  const msg = raw as WorkerOutbound
  if (!msg || typeof msg !== 'object') return
  switch (msg.kind) {
    case 'ready': ready = true; initError = null; break
    case 'init-error':
      initError = msg.message ?? '???????'
      ready = false
      console.error('[pi-worker] init-error:', initError)
      break
    case 'event':
      if (typeof msg.sessionId === 'string') pushEvent(msg.sessionId, msg.event)
      break
    case 'cmd-result': {
      const id = msg.id as number
      const p = pendingCmds.get(id)
      pendingCmds.delete(id)
      if (p) {
        if (msg.ok) p.resolve(msg.value)
        else {
          const v = msg.value as { message?: string; stack?: string } | undefined
          const err = new Error(v?.message ?? 'pi worker ????')
          if (v?.stack) err.stack = v.stack
          p.reject(err)
        }
      }
      break
    }
    case 'tool-call': {
      const id = msg.id as number
      const name = String(msg.name)
      const args = Array.isArray(msg.args) ? msg.args : []
      dispatchTool(name, args)
        .then((value) => worker?.postMessage({ kind: 'tool-result', id, ok: true, value }))
        .catch((err) => worker?.postMessage({ kind: 'tool-result', id, ok: false, value: { message: err instanceof Error ? err.message : String(err) } }))
      break
    }
    case 'tool-event': {
      const id = msg.id as number
      const evt = (msg.event ?? {}) as Record<string, unknown>
      const respond = (value: unknown): void => { worker?.postMessage({ kind: 'tool-event', id, event: value }) }
      if (evt.type === 'ask') askViaRenderer(evt.questions as AskUserQuestionInput[]).then(respond)
      else if (evt.type === 'approve') approveViaRenderer(String(evt.toolName), (evt.args ?? {}) as Record<string, unknown>).then(respond)
      else respond(undefined)
      break
    }
    case 'log': {
      const level = msg.level ?? 'log'
      const args = (msg.args ?? []).map((a) => (a && typeof a === 'object' && 'message' in (a as object) ? (a as { message: string }).message : a))
      ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[pi-worker]', ...args)
      break
    }
  }
}

/** ?? utility ???????? init??????????? */
export function ensurePiWorker(): Promise<void> {
  if (worker && ready) return Promise.resolve()
  if (worker && initError) return Promise.reject(new Error(`pi worker ?????: ${initError}`))
  if (worker) {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (ready) return resolve()
        if (initError) return reject(new Error(`pi worker ?????: ${initError}`))
        setTimeout(check, 100)
      }
      check()
    })
  }
  agentDirCache = join(app.getPath('userData'), 'pi-agent')
  const entry = resolveWorkerEntry()
  const child = utilityProcess.fork(entry, [], { serviceName: 'pi-agent-worker', stdio: 'pipe' })
  worker = child
  child.on('message', handleWorkerMessage)
  child.on('exit', (code) => {
    console.error(`[pi-worker] ?? code=${code}?????`)
    ready = false
    worker = null
    for (const p of pendingCmds.values()) p.reject(new Error('pi worker ?????'))
    pendingCmds.clear()
    for (const p of pendingAsks.values()) p.resolve('pi worker ???????????')
    pendingAsks.clear()
    for (const p of pendingApproves.values()) p.resolve(false)
    pendingApproves.clear()
  })
  child.stdout?.on('data', (d) => console.log('[pi-worker:stdout]', String(d).trimEnd()))
  child.stderr?.on('data', (d) => console.error('[pi-worker:stderr]', String(d).trimEnd()))
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('pi worker ????')), 30000)
    const onMsg = (raw: unknown): void => {
      const m = raw as WorkerOutbound
      if (m?.kind === 'ready') { clearTimeout(timeout); child.off('message', onMsg); resolve() }
      else if (m?.kind === 'init-error') { clearTimeout(timeout); child.off('message', onMsg); reject(new Error(`pi worker ?????: ${m.message}`)) }
    }
    child.on('message', onMsg)
    child.postMessage({ kind: 'init', agentDir: agentDirCache } satisfies WorkerInbound)
  })
}

/** ??????-????? worker?? cmd-result ??? */
async function sendCmd<T = unknown>(action: string, args: Record<string, unknown>): Promise<T> {
  await ensurePiWorker()
  if (!worker) throw new Error('pi worker ???')
  return await new Promise<T>((resolve, reject) => {
    const id = ++cmdSeq
    pendingCmds.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ kind: 'cmd', id, action, args } satisfies WorkerInbound)
  })
}

/** ????????pi ??/????????? registerPiAgentIpc ??? */
export function setPiWorkerWindow(win: BrowserWindow | null): void { currentWindow = win }

/** ?????????? utility ?????? Promise ????? */
export function disposePiWorker(): void {
  for (const p of pendingAsks.values()) p.resolve('????')
  pendingAsks.clear()
  for (const p of pendingApproves.values()) p.resolve(false)
  pendingApproves.clear()
  for (const p of pendingCmds.values()) p.reject(new Error('????'))
  pendingCmds.clear()
  try { worker?.kill() } catch { /* ignore */ }
  worker = null
  ready = false
  currentWindow = null
}

// ??????? PiAgentManager ???????piAgentIpc ??????
export const piWorker = {
  warmup: () => ensurePiWorker().then(() => ({ success: true })),
  create: (opts: Record<string, unknown>) => sendCmd('create', { opts }),
  prompt: (sessionId: string, text: string, images?: unknown) => sendCmd('prompt', { sessionId, text, images }),
  steer: (sessionId: string, text: string, images?: unknown) => sendCmd('steer', { sessionId, text, images }),
  followUp: (sessionId: string, text: string, images?: unknown) => sendCmd('followUp', { sessionId, text, images }),
  clearQueue: (sessionId: string) => sendCmd('clearQueue', { sessionId }),
  abort: (sessionId: string) => sendCmd('abort', { sessionId }),
  dispose: (sessionId: string) => sendCmd('dispose', { sessionId }),
  setThinkingLevel: (sessionId: string, level: unknown) => sendCmd('setThinkingLevel', { sessionId, level }),
  undo: (toolCallId: string) => sendCmd<{ success: boolean; path?: string; error?: string }>('undo', { toolCallId }),
  list: () => sendCmd<{ sessionIds: string[] }>('list', {})
}
