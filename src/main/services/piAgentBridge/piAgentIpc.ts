// pi-agent IPC 注册：renderer ↔ main 的桥（薄包装，逻辑在 PiAgentManager）
import { ipcMain, app, type BrowserWindow } from 'electron'
import { join } from 'path'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { PiAgentManager, createIpcExecutors, type PiAgentSessionOptions } from './manager'
import { warmupPiBridge } from './index'
import { setTrajectoryRoot, listTrajectories, readTrajectory, clearTrajectory } from './trajectory'
import type { MainToolExecutors, AskUserQuestionInput } from './tools/mainTools'

let manager: PiAgentManager | null = null
let currentWindow: BrowserWindow | null = null

// ── 跨进程询问/审批通道：main 工具执行中等待 renderer 弹窗结果 ──
let askSeq = 0
const pendingAsks = new Map<number, { resolve: (v: string) => void; reject: (e: string) => void }>()
let approveSeq = 0
const pendingApproves = new Map<number, { resolve: (v: boolean) => void }>()

function askViaRenderer(questions: AskUserQuestionInput[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++askSeq
    pendingAsks.set(id, { resolve, reject })
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('pi-agent-ask', id, questions)
    } else {
      // 无窗口（异常场景）：自动跳过提问，避免死锁
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
      resolve(false) // 无窗口不执行破坏性操作
    }
  })
}

function getManager(): PiAgentManager {
  if (!manager) {
    const base: MainToolExecutors = createIpcExecutors()
    manager = new PiAgentManager({
      ...base,
      askUser: askViaRenderer,
      approve: approveViaRenderer
    })
  }
  return manager
}

/** 注册 pi-agent IPC 通道。win 用于把会话事件/询问/审批推给 renderer。 */
export function registerPiAgentIpc(win: BrowserWindow): void {
  currentWindow = win
  // 轨迹台账根目录（与 Agent session/traces 同根：打包后 userData，开发时 cwd）
  setTrajectoryRoot(join(app.isPackaged ? app.getPath('userData') : process.cwd(), 'Agent session'))
  const push = (sessionId: string, event: AgentSessionEvent): void => {
    if (!currentWindow || currentWindow.isDestroyed()) return
    // 流式事件瘦身：text_delta/thinking_delta 的 partial 携带「截至当前的完整消息内容」
    // （随输出增长可达数十 KB），每次 webContents.send 都要结构化克隆 + GC，这是流式期间
    // renderer 主线程周期性 200-300ms 卡顿（'message' handler violation）的根源；
    // renderer 只消费 delta/contentIndex，partial 完全无用。
    // 例外：toolcall_start 用 partial.content[i].name 显示「参数生成中」卡片——这里仅
    // 保留各 content 块的 type/name/id（丢弃 text 全文），且保持数组索引不变。
    let slim = event
    if (event.type === 'message_update') {
      const am = (event as { assistantMessageEvent?: { type?: string; partial?: { content?: Array<{ type?: string; name?: string; id?: string }> } } }).assistantMessageEvent
      if (am && typeof am === 'object' && am.partial && typeof am.partial === 'object') {
        const content = Array.isArray(am.partial.content) ? am.partial.content : []
        slim = {
          ...event,
          assistantMessageEvent: {
            ...am,
            partial: am.type === 'toolcall_start'
              ? { content: content.map(b => (b && b.type === 'toolCall' ? { type: b.type, name: b.name, id: b.id } : { type: b?.type ?? '' })) }
              : undefined
          }
        } as unknown as AgentSessionEvent
      }
    }
    currentWindow.webContents.send('pi-agent-event', sessionId, slim)
  }

  ipcMain.handle('pi-agent-create', async (_e, opts: Omit<PiAgentSessionOptions, 'onEvent'>) => {
    // 默认 agentDir 隔离到 userData（避免读写用户机器的 ~/.pi/agent 配置）
    const finalOpts: Omit<PiAgentSessionOptions, 'onEvent'> = {
      ...opts,
      agentDir: opts.agentDir ?? join(app.getPath('userData'), 'pi-agent')
    }
    await getManager().createSession({ ...finalOpts, onEvent: push })
    return { success: true }
  })

  // 预热 pi SDK 运行时（提前加载 ESM 模块 + ModelRuntime，首次对话免初始化等待）。
  // 与 pi-agent-create 的默认 agentDir 保持一致；失败静默，不影响后续任何路径。
  ipcMain.handle('pi-agent-warmup', async () => {
    try {
      await warmupPiBridge(join(app.getPath('userData'), 'pi-agent'))
    } catch {
      /* 预热失败静默：正常路径会重新初始化 */
    }
    return { success: true }
  })

  ipcMain.handle('pi-agent-prompt', async (_e, sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => {
    await getManager().prompt(sessionId, text, images)
    return { success: true }
  })

  ipcMain.handle('pi-agent-abort', async (_e, sessionId: string) => {
    await getManager().abort(sessionId)
    return { success: true }
  })

  ipcMain.handle('pi-agent-dispose', async (_e, sessionId: string) => {
    getManager().disposeSession(sessionId)
    return { success: true }
  })

  ipcMain.handle('pi-agent-undo', async (_e, _sessionId: string, toolCallId: string) => {
    const res = await getManager().undo(toolCallId)
    return { success: res.success, path: res.path, error: res.error }
  })

  ipcMain.handle('pi-agent-list', () => ({ sessionIds: getManager().sessionIds }))

  // ── 轨迹台账查询（阶段 1：完整事件流落盘的读取侧）──
  ipcMain.handle('pi-agent-trajectory-list', () => listTrajectories())
  ipcMain.handle('pi-agent-trajectory-read', (_e, sessionId: string, fromSeq: number) => readTrajectory(sessionId, Number(fromSeq) || 0))
  ipcMain.handle('pi-agent-trajectory-clear', (_e, sessionId: string) => clearTrajectory(sessionId))

  // ── 询问/审批回传（renderer 弹窗后调用）──
  ipcMain.handle('pi-agent-ask-resolve', (_e, id: number, result: string) => {
    const p = pendingAsks.get(id)
    pendingAsks.delete(id)
    p?.resolve(result)
    return { success: true }
  })

  ipcMain.handle('pi-agent-approve-resolve', (_e, id: number, approved: boolean) => {
    const p = pendingApproves.get(id)
    pendingApproves.delete(id)
    p?.resolve(approved === true)
    return { success: true }
  })
}

export function disposePiAgentIpc(): void {
  // 未决的询问/审批全部拒绝，避免挂死的 Promise
  for (const p of pendingAsks.values()) p.reject('应用退出')
  pendingAsks.clear()
  for (const p of pendingApproves.values()) p.resolve(false)
  pendingApproves.clear()
  manager?.disposeAll()
  manager = null
  currentWindow = null
}
