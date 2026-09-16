// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentModelControl —— 模型卡片「启动 / 停止」编排                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的 handleModelAction（逻辑与注释未变）。
// 依赖全部来自 useStore.getState()（命令式读取，避免订阅导致的整树重渲染），
// 因此本 hook 不接收任何参数、也无需依赖数组以外的注入。
//
// 启动路径：按 commandsSchema 拼装命令行（schema 缺失时退回白名单兜底），
// 调 window.api.runModel；失败时延迟 400ms 检查 modelDiagnostics，避免与
// 主进程随后推送的诊断信息重复弹窗。
// 停止路径：先乐观置 idle + 清指标，stopModel 失败则回滚为 running。

import { useCallback } from 'react'
import { useStore } from '../../../store/useStore'
import { notify } from '../../../store/notificationStore'
import { safeCall } from '../../../utils/safeCall'
import type { CardState } from '../../../../../shared/types'

export function useAgentModelControl() {
  const handleModelAction = useCallback(async (card: CardState) => {
    if (card.status === 'running') {
      const { setCardStatus, clearModelMetrics, activeChatPort, clearActiveChat } = useStore.getState()
      setCardStatus(card.template.id, 'idle')
      clearModelMetrics(card.template.id)
      if (activeChatPort === card.template.serverPort) clearActiveChat()
      const res = await safeCall(() => window.api.stopModel(card.template.id), '停止模型失败')
      if (res === null) { setCardStatus(card.template.id, 'running'); return }
      if (!res.success) notify(`停止失败：${res.error}`, 'error')
      return
    }
    const { backends, activeBackend, commandsSchema, clearModelLogs } = useStore.getState()
    let targetBackend = backends.find(b => b.name === card.template.backendVersion)
    if (!targetBackend && activeBackend) targetBackend = activeBackend
    if (!targetBackend || !targetBackend.exe) {
      notify('未找到后端或无可执行文件。', 'error')
      return
    }
    const args: string[] = []
    const tArgs = card.template.args || {}
    if (card.template.modelPath) args.push('-m', card.template.modelPath)
    if (commandsSchema) {
      for (const cat of commandsSchema.categories) {
        for (const cmd of cat.commands) {
          if (cmd.arg === '--port' || cmd.arg === '--model') continue
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true || val === 'true' || val === '1') args.push(cmd.arg) }
            else if (cmd.type === 'select' && cmd.options && !cmd.options.includes(String(val))) continue
            else args.push(cmd.arg, String(val))
          }
        }
      }
    } else {
      const fallbackAllowed = new Set(['--host', '--no-webui', '--ctx-size', '-c', '--gpu-layers', '-ngl', '--threads', '-t', '--batch-size', '-b', '--flash-attn', '-fa', '--mlock', '--mmap', '--verbose'])
      for (const [k, v] of Object.entries(tArgs)) {
        if (!fallbackAllowed.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    if (card.template.serverPort) args.push('--port', String(card.template.serverPort))
    const port = card.template.serverPort || 8080
    useStore.getState().setCardStatus(card.template.id, 'running')
    const res = await safeCall(() => window.api.runModel({
      id: card.template.id,
      backendPath: targetBackend.path,
      exe: targetBackend.exe!,
      args,
      openBrowser: false,
      port
    }), '启动模型失败')
    if (res === null) { useStore.getState().setCardStatus(card.template.id, 'error'); return }
    if (res.success) {
      clearModelLogs(card.template.id)
      useStore.getState().setCardStatus(card.template.id, 'running', res.pid)
    } else {
      useStore.getState().setCardStatus(card.template.id, 'error')
      setTimeout(() => {
        if (!useStore.getState().modelDiagnostics[card.template.id]) {
          notify(`运行失败：${res.error}`, 'error')
        }
      }, 400)
    }
  }, [])

  return { handleModelAction }
}
