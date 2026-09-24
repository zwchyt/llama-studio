// pi-agent IPC 注册：renderer ↔ main 的桥。
// 自 2026-09 起改为纯转发层：真正的 pi SDK 与 PiAgentManager 跑在 utility process
// （piWorker.mjs）里，主进程不再直接 import pi 系 ESM 包——它们的模块求值会同步
// 阻塞主进程事件循环数秒，导致启动预热期间整窗"未响应"。
import { ipcMain, app, type BrowserWindow } from 'electron'
import { join } from 'path'
import type { PiAgentSessionOptions } from './manager'
import { setTrajectoryRoot, listTrajectories, readTrajectory, clearTrajectory } from './trajectory'
import { piWorker, setPiWorkerWindow, resolveAsk, resolveApprove, resolveBrowserCommand, disposePiWorker } from './workerClient'
import { setActiveBrowserGuest, showBrowserPreview, captureBrowser } from '../agentBrowserService'
import type { BrowserCaptureOptions, BrowserShowInput } from '../../../shared/browserPreview'
import type { ThinkingLevel } from '../../../shared/types'

/** 注册 pi-agent IPC 通道。win 用于把会话事件/询问/审批推给 renderer。 */
export function registerPiAgentIpc(win: BrowserWindow): void {
  setPiWorkerWindow(win)
  // 轨迹台账根目录（与 Agent session/traces 同根：打包后 userData，开发时 cwd）
  setTrajectoryRoot(join(app.isPackaged ? app.getPath('userData') : process.cwd(), 'Agent session'))

  ipcMain.handle('pi-agent-create', async (_e, opts: Omit<PiAgentSessionOptions, 'onEvent'>) => {
    // 默认 agentDir 隔离到 userData（避免读写用户机器的 ~/.pi/agent 配置）
    const finalOpts = {
      ...opts,
      agentDir: opts.agentDir ?? join(app.getPath('userData'), 'pi-agent')
    }
    await piWorker.create(finalOpts as unknown as Record<string, unknown>)
    return { success: true }
  })

  // 预热 pi SDK：拉起 utility 进程（pi 模块在 worker 里求值，主进程不被阻塞）。
  ipcMain.handle('pi-agent-warmup', async () => {
    try {
      await piWorker.warmup()
    } catch {
      /* 预热失败静默：正常路径会重新初始化 */
    }
    return { success: true }
  })

  ipcMain.handle('pi-agent-prompt', async (_e, sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => {
    await piWorker.prompt(sessionId, text, images)
    return { success: true }
  })

  ipcMain.handle('pi-agent-steer', async (_e, sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => {
    await piWorker.steer(sessionId, text, images)
    return { success: true }
  })

  ipcMain.handle('pi-agent-follow-up', async (_e, sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => {
    await piWorker.followUp(sessionId, text, images)
    return { success: true }
  })

  ipcMain.handle('pi-agent-clear-queue', async (_e, sessionId: string) => {
    await piWorker.clearQueue(sessionId)
    return { success: true }
  })

  ipcMain.handle('pi-agent-abort', async (_e, sessionId: string) => {
    await piWorker.abort(sessionId)
    return { success: true }
  })

  ipcMain.handle('pi-agent-dispose', async (_e, sessionId: string) => {
    await piWorker.dispose(sessionId)
    return { success: true }
  })

  // 动态设置会话级思考程度（发送前由 renderer 调用）
  ipcMain.handle('pi-agent-set-thinking-level', async (_e, sessionId: string, level: ThinkingLevel) => {
    await piWorker.setThinkingLevel(sessionId, level)
    return { success: true }
  })

  ipcMain.handle('pi-agent-undo', async (_e, _sessionId: string, toolCallId: string) => {
    const res = await piWorker.undo(toolCallId)
    return { success: res.success, path: res.path, error: res.error }
  })

  ipcMain.handle('pi-agent-list', async () => piWorker.list())

  // ── 轨迹台账查询（留在主进程，纯文件读取，无 pi 依赖）──
  ipcMain.handle('pi-agent-trajectory-list', () => listTrajectories())
  ipcMain.handle('pi-agent-trajectory-read', (_e, sessionId: string, fromSeq: number) => readTrajectory(sessionId, Number(fromSeq) || 0))
  ipcMain.handle('pi-agent-trajectory-clear', (_e, sessionId: string) => clearTrajectory(sessionId))

  // ── 询问/审批回传（renderer 弹窗后调用）──
  ipcMain.handle('pi-agent-ask-resolve', (_e, id: number, result: string) => {
    resolveAsk(id, result)
    return { success: true }
  })

  ipcMain.handle('pi-agent-approve-resolve', (_e, id: number, approved: boolean) => {
    resolveApprove(id, approved === true)
    return { success: true }
  })

  // ── 浏览器预览（browser_show 导航回执 / 当前预览页 guest id 上报）──
  // 渲染进程回包只取白名单字段：main 不信任它给出的结构。
  ipcMain.handle('pi-agent-browser-resolve', (_e, id: number, result: unknown) => {
    const r = (result ?? {}) as Record<string, unknown>
    resolveBrowserCommand(Number(id), {
      ok: r.ok === true,
      ...(typeof r.title === 'string' ? { title: r.title.slice(0, 200) } : {}),
      ...(typeof r.url === 'string' ? { url: r.url.slice(0, 2000) } : {}),
      ...(typeof r.error === 'string' ? { error: r.error.slice(0, 500) } : {})
    })
    return { success: true }
  })
  // guest id 由主进程的 webview 注册表校验（不是本应用创建的预览页一律拒绝），
  // 因此渲染进程无法用任意 webContents id 去截主窗口等其它页面。
  ipcMain.handle('pi-agent-browser-guest', (_e, id: number | null) => setActiveBrowserGuest(id))
  // 渲染层工具目录（src/renderer/src/tools/Browser*Tool）走的调用口：与 worker 走的
  // 执行器是同一份主进程实现，参数照样在主进程二次校验。
  ipcMain.handle('pi-agent-browser-show', (_e, input: BrowserShowInput) => showBrowserPreview(input))
  ipcMain.handle('pi-agent-browser-capture', (_e, opts: BrowserCaptureOptions) => captureBrowser({ ...opts, withImage: false }))
}

export function disposePiAgentIpc(): void {
  disposePiWorker()
}
