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
import { playEvent } from '../../../utils/sound'
import { endpointOfCard, probeTargetOf, remoteOfCard } from '../../../utils/endpoint'
import type { CardState, ModelEndpoint, Template } from '../../../../../shared/types'

export function useAgentModelControl() {
  const handleModelAction = useCallback(async (card: CardState) => {
    // 外部端点卡（服务/端点不由本应用启动）：点它＝探测并启用，再点＝停用/断开。
    // 既没有后端可 spawn，也没有进程可杀。地址与 key 都按 endpointId 从端点表取。
    if (card.template.external) {
      const st = useStore.getState()
      const ep = endpointOfCard(card, st.modelEndpoints)
      const remote = remoteOfCard(card, st.modelEndpoints)
      if (card.status === 'running') {
        st.setCardStatus(card.template.id, 'idle')
        st.clearModelMetrics(card.template.id)
        if (st.activeChatPort === card.template.serverPort) st.clearActiveChat()
        // 远程端点从不登记主进程运行表，自然也没有登记要摘
        if (ep?.kind === 'local-port') void window.api.detachEndpoint(card.template.id).catch(() => {})
        notify(!ep ? '已停用（这张卡没有关联端点了，请到「外部端点」页重新添加）'
          : remote ? `已停用 ${ep.name}` : `已断开 :${ep.port}（那边的服务没有被关掉）`)
        return
      }
      if (!ep) {
        notify(`「${card.template.name}」没有关联的端点记录了，请到「外部端点」页重新添加`, 'error')
        playEvent('error')
        return
      }
      if (remote) {
        const p = await safeCall(() => window.api.probeEndpoint(probeTargetOf(ep)), '端点探测失败')
        if (!p?.ok) {
          notify(`端点不可用：${p?.error ?? '探测失败'}`, 'error')
          playEvent('error')
          return
        }
        st.setCardStatus(card.template.id, 'running')
        st.setCardReady(card.template.id, true)
        notify(`已启用端点 ${ep.name}`)
        return
      }
      // 本机端口型以端点记录里的端口为准（在端点页改过端口后，卡片上的字段可能还是旧值）
      const res = await safeCall(() => window.api.attachEndpoint(card.template.id, ep.port ?? card.template.serverPort), '接管失败')
      if (!res?.success) {
        notify(`接管失败：${res?.error ?? '未探测到服务'}`, 'error')
        playEvent('error')
        return
      }
      st.setCardStatus(card.template.id, 'running')
      st.setCardReady(card.template.id, true)
      notify(`已接管 :${card.template.serverPort} 上的服务`)
      return
    }
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
          playEvent('error')
        }
      }, 400)
    }
  }, [])

  // 端点上有模型名还没建卡时的入口：点下拉里那条 = 就地建一张引用该端点的卡，再按外部卡语义启用。
  // 卡片名字用「端点名 · 模型名」，端点页那边按模型名建卡用的是同一套写法。
  const pickEndpointModel = useCallback(async (ep: ModelEndpoint, modelId: string) => {
    const st = useStore.getState()
    const existing = st.cards.find(c => c.template.external && c.template.endpointId === ep.id && c.template.endpointModelId === modelId)
    if (existing) return handleModelAction(existing)
    const now = new Date().toISOString()
    const tpl: Template = {
      id: crypto.randomUUID(),
      name: `${ep.name} · ${modelId}`,
      // 本机端口型留端口（接管登记与 /slots 指标都按端口走）；远程型没有端口
      serverPort: ep.kind === 'local-port' ? (ep.port ?? 0) : 0,
      args: {},
      ...(ep.kind === 'local-port' ? { paramSet: 'llamacpp' as const } : {}),
      external: true,
      endpointId: ep.id,
      endpointModelId: modelId,
      createdAt: now,
      updatedAt: now
    }
    st.addCard(tpl)
    await safeCall(() => window.api.saveTemplate(tpl), '保存模型卡片失败')
    const card = useStore.getState().cards.find(c => c.template.id === tpl.id)
    if (!card) {
      notify(`「${tpl.name}」卡片没能建出来，请到「外部端点」页重试`, 'error')
      playEvent('error')
      return
    }
    await handleModelAction(card)
  }, [handleModelAction])

  return { handleModelAction, pickEndpointModel }
}
