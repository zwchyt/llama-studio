// 外部端点的查表解析。
//
// 模型卡片只存 endpointId（外加这张卡选用的模型名），地址 / 协议 / API key / 上下文窗口都在
// endpoints.json 那一张表上 —— 一个端点挂多个模型就是多张卡共用一个 endpointId，改 key 也只改一处。
// 本机端口型端点没有 base URL，remoteOfCard 返回 undefined，那条链继续按端口走
// （attach 登记、/slots 指标、/props 判视觉）。

import type { CardState, ModelEndpoint, ProbeTarget, RemoteEndpoint } from '../../../shared/types'

/** 这张卡指向的端点记录（不是外部卡 / 端点已被删时 undefined） */
export function endpointOfCard(card: CardState | undefined, endpoints: ModelEndpoint[]): ModelEndpoint | undefined {
  const id = card?.template.endpointId
  if (!card?.template.external || !id) return undefined
  return endpoints.find(e => e.id === id)
}

/** 远程端点 → pi 与聊天代理要的运行态形状；本机端口型返回 undefined */
export function remoteOfCard(card: CardState | undefined, endpoints: ModelEndpoint[]): RemoteEndpoint | undefined {
  const ep = endpointOfCard(card, endpoints)
  if (!ep || ep.kind !== 'remote' || !ep.baseUrl) return undefined
  const modelId = card?.template.endpointModelId || ep.modelIds[0] || ''
  return {
    baseUrl: ep.baseUrl,
    api: ep.api ?? 'openai-completions',
    ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
    ...(modelId ? { modelId } : {}),
    ...(ep.contextWindow ? { contextWindow: ep.contextWindow } : {}),
    ...(ep.vision ? { vision: true } : {})
  }
}

/** 探测目标：本机端口型给 port，远程型给 baseUrl + 协议 + key */
export function probeTargetOf(ep: ModelEndpoint): ProbeTarget {
  return ep.kind === 'local-port'
    ? { port: ep.port ?? 0 }
    : { baseUrl: ep.baseUrl ?? '', api: ep.api, apiKey: ep.apiKey }
}

/** 端点地址（顶栏那行显示、监控页回显都用它） */
export function addressOfEndpoint(ep: ModelEndpoint | undefined): string {
  if (!ep) return ''
  return ep.kind === 'local-port' ? `http://127.0.0.1:${ep.port ?? 0}` : (ep.baseUrl || '')
}

/** 这张卡实际会请求的模型名（卡片选的优先，没选就用端点的第一个） */
export function modelIdOfCard(card: CardState | undefined, ep: ModelEndpoint | undefined): string {
  return card?.template.endpointModelId || ep?.modelIds[0] || ''
}

/** 外部卡还该不该出现在模型下拉里。
 *  端点被删、或这张卡当初选的那个模型名已经从端点列表里撤掉 → 不再列（列表以端点表为准）。
 *  没有 endpointModelId 的老端口接管卡不受模型名列表约束，按端口继续显示。 */
export function isExternalCardListable(card: CardState, endpoints: ModelEndpoint[]): boolean {
  if (!card.template.external) return true
  const ep = endpoints.find(e => e.id === card.template.endpointId)
  if (!ep) return false
  const picked = card.template.endpointModelId
  return !picked || ep.modelIds.includes(picked)
}

/** 下拉这一行的文字：外部行＝模型名（端点名已经升成分组标题），本地卡＝卡片名。
 *  端点名/模型名都现取现用，在「外部端点」页改名后下拉立刻跟着变，不用回去重建卡片。 */
export function pickerNameOf(card: CardState, endpoints: ModelEndpoint[]): string {
  const ep = endpointOfCard(card, endpoints)
  if (!card.template.external || !ep) return card.template.name
  // 端点上一个模型名都没有：退回显示卡片自己的名字，避免出现空行
  return card.template.endpointModelId || ep.modelIds[0] || card.template.name
}

/** 端点上报/手填的模型名中，还没有对应卡片的那几条 —— 它们也要出现在下拉里，
 *  点了才就地建卡（否则在端点页加完名字，模型下拉完全看不到）。 */
export function endpointModelEntries(endpoints: ModelEndpoint[], cards: CardState[]): Array<{ endpoint: ModelEndpoint; modelId: string }> {
  const taken = new Set(
    cards.filter(c => c.template.external && c.template.endpointId)
      .map(c => `${c.template.endpointId}|${c.template.endpointModelId ?? ''}`)
  )
  const out: Array<{ endpoint: ModelEndpoint; modelId: string }> = []
  for (const ep of endpoints) {
    for (const raw of ep.modelIds) {
      const modelId = raw.trim()
      if (!modelId || taken.has(`${ep.id}|${modelId}`)) continue
      out.push({ endpoint: ep, modelId })
    }
  }
  return out
}

/** 模型下拉的一行：要么对应一张已有卡片，要么是端点上还没建卡的模型名 */
export type ModelPickerRow = {
  key: string
  name: string
  card?: CardState
  endpoint?: ModelEndpoint
  modelId?: string
}
export type ModelPickerGroup = { title: string; rows: ModelPickerRow[] }
