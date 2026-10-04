// pi-agent utility process ?????????
// ???? out/main/piWorker.mjs?ESM utility process????????? IPC ??
// ??? postMessage ?? worker??? worker ? pi ???? / ?? RPC / ask-approve
// ???????????pi SDK?ESM-only??????????????????
// ???????????????????????
import { app, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createIpcExecutors } from './ipcExecutors'
import { showBrowserPreview, setBrowserNavigateHandler } from '../agentBrowserService'
import type { MainToolExecutors, AskUserQuestionInput } from './tools/mainTools'
import type { BrowserNavigateCommand, BrowserShowResult } from '../../../shared/browserPreview'

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
// 浏览器预览指令：main 校验并准备好 URL 后推给渲染进程的浏览器面板执行导航，
// 等页面加载完成/失败再回包（与 ask/approve 同一类「等渲染进程」的未决表）。
let browserSeq = 0
const BROWSER_NAV_TIMEOUT_MS = 30000
const pendingBrowsers = new Map<number, { resolve: (v: Partial<BrowserShowResult> | null) => void; timer: ReturnType<typeof setTimeout> }>()

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
    setBrowserNavigateHandler(navigateViaRenderer)
    toolExecutors = {
      ...createIpcExecutors(),
      askUser: askViaRenderer,
      approve: approveViaRenderer,
      // browser_show 要渲染进程的浏览器面板执行导航，与 ask/approve 同类；
      // browser_capture 纯主进程（webview guest 由主进程直接截图）。
      browserShow: showBrowserPreview
    } as MainToolExecutors
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

/** browser_show 的渲染进程往返：把已校验的导航指令交给浏览器面板，等加载回执。
 *  永不悬挂 —— 无窗口立刻回 null，超时回错误，worker 退出时统一兜底。 */
function navigateViaRenderer(cmd: BrowserNavigateCommand): Promise<Partial<BrowserShowResult> | null> {
  return new Promise((resolve) => {
    if (!currentWindow || currentWindow.isDestroyed()) {
      resolve(null)
      return
    }
    const id = ++browserSeq
    const timer = setTimeout(() => {
      const p = pendingBrowsers.get(id)
      if (!p) return
      pendingBrowsers.delete(id)
      p.resolve({ ok: false, error: '页面加载超时' })
    }, BROWSER_NAV_TIMEOUT_MS)
    pendingBrowsers.set(id, { resolve, timer })
    currentWindow.webContents.send('pi-agent-browser', id, cmd)
  })
}

export function resolveBrowserCommand(id: number, result: Partial<BrowserShowResult>): void {
  const p = pendingBrowsers.get(id)
  if (!p) return
  pendingBrowsers.delete(id)
  clearTimeout(p.timer)
  p.resolve(result)
}

function failPendingBrowsers(): void {
  for (const p of pendingBrowsers.values()) {
    clearTimeout(p.timer)
    p.resolve({ ok: false, error: '浏览器面板不可用（窗口已关闭或会话已结束）' })
  }
  pendingBrowsers.clear()
}

/** worker → renderer event push。
 *
 * delta 合帧缓冲：text_delta / thinking_delta 是逐 token 事件，高速吐字时（60-100 t/s）
 * 会以同等频率逐条 webContents.send —— IPC 序列化/反序列化 + renderer 事件分发碎成
 * 100+ 次/秒，且 Chromium 对 IPC 的合批时机不可控，进一步加剧到达侧的不均匀。
 * 这里把两类增量按 FLUSH_MS 窗口合并成一条再发：IPC 次数降为 ~1/窗口，批次均匀，
 * 内容拼接后语义与逐 token 完全等价（renderer 的 piAgentAdapter 只按 delta 文本追加）。
 *
 * 时序保证：任何非增量事件（toolcall_start/end、thinking_start/end、turn_* 等）
 * 发送前必须先同步冲刷两个缓冲 —— 增量与边界事件的到达顺序严格保持原样，
 * 「参数生成中→完整」「思考闭合补发」等边界语义不受合并影响。
 */
const DELTA_FLUSH_MS = 24
let textDeltaBuf = ''
let thinkDeltaBuf = ''
/** toolcall_delta 的参数快照（只留最新一帧）。pi 在流式期间已经把半截 JSON 尽力解析成
 *  arguments 对象放进 partial，这里截成 {id,name,args} 合帧转发，让待办卡片能在参数生成
 *  过程中逐条上屏，而不是干等 toolcall_end（整段参数可能有几百 token）。 */
let toolArgsBuf: { id: string; name: string; args: string } | null = null
/** 参数快照体积上限：Write/Edit 的整文件内容远超此量，逐 token 转发没有意义，直接跳过 */
const TOOL_ARGS_MAX_CHARS = 8000
/** Write/Edit 的流式改动统计：主进程只数换行，每帧只回传两个数（整份内容过 IPC 会拖渲染层），
 *  精确的 +N -M 仍由渲染层在 toolcall_end 拿到完整参数后用 LCS 覆盖。 */
let toolStatBuf: { id: string; name: string; added: number; removed: number } | null = null
const lineCountOf = (s: unknown): number => (typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0)

function editStreamStat(name: string, args: Record<string, unknown>): { added: number; removed: number } | null {
  if (name === 'Write') {
    const added = lineCountOf(args.content)
    return added > 0 ? { added, removed: 0 } : null
  }
  if (name !== 'Edit') return null
  let added = 0
  let removed = 0
  const acc = (o: unknown, n: unknown): void => { removed += lineCountOf(o); added += lineCountOf(n) }
  if (typeof args.old_string === 'string' || typeof args.new_string === 'string') acc(args.old_string, args.new_string)
  else if (Array.isArray(args.edits)) {
    for (const e of args.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
      if (e) acc(e.oldText, e.newText)
    }
  }
  return added > 0 || removed > 0 ? { added, removed } : null
}
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null
let deltaSid = ''

function sendDeltaEvent(sessionId: string, event: unknown): void {
  if (!currentWindow || currentWindow.isDestroyed()) return
  currentWindow.webContents.send('pi-agent-event', sessionId, event)
}

function flushDeltas(): void {
  deltaFlushTimer = null
  if (textDeltaBuf) {
    sendDeltaEvent(deltaSid, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: textDeltaBuf } })
    textDeltaBuf = ''
  }
  if (thinkDeltaBuf) {
    sendDeltaEvent(deltaSid, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: thinkDeltaBuf } })
    thinkDeltaBuf = ''
  }
  if (toolArgsBuf) {
    sendDeltaEvent(deltaSid, { type: 'toolcall_args', ...toolArgsBuf })
    toolArgsBuf = null
  }
  if (toolStatBuf) {
    sendDeltaEvent(deltaSid, { type: 'toolcall_stat', ...toolStatBuf })
    toolStatBuf = null
  }
}

function queueDelta(sessionId: string, kind: 'text' | 'thinking', delta: string): void {
  // 跨会话防御：换了会话（旧会话缓冲未冲刷）先冲掉，避免增量串会话
  if (deltaFlushTimer && sessionId !== deltaSid) flushDeltas()
  deltaSid = sessionId
  if (kind === 'text') textDeltaBuf += delta
  else thinkDeltaBuf += delta
  if (!deltaFlushTimer) deltaFlushTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
}

/** 参数快照同窗合帧：只保留最新一帧（半截 JSON 的旧快照没有回放价值） */
function queueToolArgs(sessionId: string, snap: { id: string; name: string; args: string }): void {
  if (deltaFlushTimer && sessionId !== deltaSid) flushDeltas()
  deltaSid = sessionId
  toolArgsBuf = snap
  if (!deltaFlushTimer) deltaFlushTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
}

/** 改动统计同窗合帧：只留最新一帧，且调用方已保证只在数值变化时才入队 */
function queueToolStat(sessionId: string, snap: { id: string; name: string; added: number; removed: number }): void {
  if (deltaFlushTimer && sessionId !== deltaSid) flushDeltas()
  deltaSid = sessionId
  toolStatBuf = snap
  if (!deltaFlushTimer) deltaFlushTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
}

/** ? worker ? pi ?????? renderer??????????? piAgentIpc.push ???? */
function pushEvent(sessionId: string, event: unknown): void {
  const e = event as {
    type?: string
    assistantMessageEvent?: {
      type?: string
      delta?: unknown
      contentIndex?: number
      partial?: { content?: Array<{ type?: string; name?: string; id?: string; arguments?: unknown }> }
    }
  }
  // 增量类 message_update 走合帧缓冲（见 DELTA_FLUSH_MS 注释）；其余事件原样直发
  if (e && e.type === 'message_update' && e.assistantMessageEvent &&
      (e.assistantMessageEvent.type === 'text_delta' || e.assistantMessageEvent.type === 'thinking_delta') &&
      typeof e.assistantMessageEvent.delta === 'string') {
    queueDelta(sessionId, e.assistantMessageEvent.type === 'text_delta' ? 'text' : 'thinking', e.assistantMessageEvent.delta)
    return
  }
  // 工具参数流式生成中：pi 已把半截 JSON 尽力解析成 arguments 对象，截当前块的最新快照
  // 走同一合帧窗口。完整参数仍由后面的 toolcall_end 给出（它先冲刷本缓冲，顺序不乱）。
  if (e && e.type === 'message_update' && e.assistantMessageEvent?.type === 'toolcall_delta') {
    const am = e.assistantMessageEvent
    const block = am.partial?.content?.[am.contentIndex ?? -1]
    if (block && block.type === 'toolCall' && block.name) {
      if (block.name === 'Write' || block.name === 'Edit') {
        // 文件改动工具：只回传统计数字，别把整份内容搬过 IPC；数值没变就不入队
        const stat = editStreamStat(block.name, (block.arguments ?? {}) as Record<string, unknown>)
        if (stat && (!toolStatBuf || toolStatBuf.added !== stat.added || toolStatBuf.removed !== stat.removed)) {
          queueToolStat(sessionId, { id: block.id || '', name: block.name, ...stat })
        }
      } else {
        try {
          const args = JSON.stringify(block.arguments ?? {})
          if (args.length <= TOOL_ARGS_MAX_CHARS) queueToolArgs(sessionId, { id: block.id || '', name: block.name, args })
        } catch { /* 含不可序列化值：跳过快照，等 toolcall_end */ }
      }
    }
    return
  }
  // 非增量事件：先冲刷排队的增量，保持「文本 → 边界事件」的原始到达顺序
  if (deltaFlushTimer) flushDeltas()
  if (!currentWindow || currentWindow.isDestroyed()) return
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
    failPendingBrowsers()
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
  failPendingBrowsers()
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
  compact: (sessionId: string, customInstructions?: string) =>
    sendCmd<{ success: boolean; summary?: string; error?: string }>('compact', { sessionId, customInstructions }),
  undo: (toolCallId: string) => sendCmd<{ success: boolean; path?: string; error?: string }>('undo', { toolCallId }),
  list: () => sendCmd<{ sessionIds: string[] }>('list', {})
}
