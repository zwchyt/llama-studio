// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：EndpointsView —— 外部端点管理页（导航栏「外部端点」）                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 端点＝一个可连接的模型服务来源，两种形态：
//   本机端口 —— 你在别处启动的 llama-server，本应用不拥有它的进程
//   远程 URL —— 任意 OpenAI / Anthropic 兼容端点（base URL + 协议 + key）
// 一个端点可以挂多个模型名，每个模型名建一张模型卡片；卡片只存 endpointId 引用，
// 地址与 key 改一处即可（见 src/renderer/src/utils/endpoint.ts 的解析）。
// 探测一律只读（本机 /props + /v1/models，远程 models 列表），绝不为探活发补全请求。

import { useEffect, useState } from 'react'
import { PlusIcon, ServerIcon, TrashIcon, PlugZapIcon, EyeIcon, EyeOffIcon, PencilIcon, XIcon, TagIcon } from '@animateicons/react/lucide'
import { useStore } from '../store/useStore'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { playEvent } from '../utils/sound'
import { addressOfEndpoint, probeTargetOf } from '../utils/endpoint'
import type { EndpointApi, ModelEndpoint, Template } from '../../../shared/types'
import '../styles/model-endpoints.css'

const API_CHOICES: Array<{ value: EndpointApi; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' }
]

/** 表单草稿：数字与列表都用字符串/数组存，保存时再收敛成 ModelEndpoint */
type Draft = {
  id?: string
  name: string
  kind: 'local-port' | 'remote'
  port: string
  baseUrl: string
  api: EndpointApi
  apiKey: string
  modelIds: string[]
  contextWindow: string
  vision: boolean
}

const emptyDraft = (): Draft => ({
  name: '', kind: 'local-port', port: '8080', baseUrl: '', api: 'openai-completions',
  apiKey: '', modelIds: [''], contextWindow: '', vision: false
})

const draftOf = (ep: ModelEndpoint): Draft => ({
  id: ep.id,
  name: ep.name,
  kind: ep.kind,
  port: String(ep.port ?? 8080),
  baseUrl: ep.baseUrl ?? '',
  api: ep.api ?? 'openai-completions',
  apiKey: ep.apiKey ?? '',
  modelIds: ep.modelIds.length ? [...ep.modelIds] : [''],
  contextWindow: ep.contextWindow ? String(ep.contextWindow) : '',
  vision: ep.vision === true
})

/** 把草稿收敛成落盘记录；不合法时返回原因 */
function toEndpoint(d: Draft): { ok: true; value: ModelEndpoint } | { ok: false; error: string } {
  const name = d.name.trim() || (d.kind === 'local-port' ? `本机 :${d.port}` : '未命名端点')
  const modelIds = [...new Set(d.modelIds.map(m => m.trim()).filter(Boolean))]
  if (d.kind === 'local-port') {
    const port = Number(d.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口号需是 1-65535' }
    return {
      ok: true,
      value: {
        id: d.id ?? '', name, kind: 'local-port', port, modelIds,
        createdAt: '', updatedAt: ''
      }
    }
  }
  const baseUrl = d.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' }
  const ctx = Number(d.contextWindow)
  if (d.contextWindow && (!Number.isInteger(ctx) || ctx < 1024)) return { ok: false, error: '上下文窗口要么留空（按 128000 算），要么填不小于 1024 的整数' }
  return {
    ok: true,
    value: {
      id: d.id ?? '', name, kind: 'remote', baseUrl, api: d.api,
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      modelIds,
      ...(d.contextWindow ? { contextWindow: ctx } : {}),
      ...(d.vision ? { vision: true } : {}),
      createdAt: '', updatedAt: ''
    }
  }
}

export default function EndpointsView() {
  const endpoints = useStore(s => s.modelEndpoints)
  const setModelEndpoints = useStore(s => s.setModelEndpoints)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 端点 id → 最近一次探测结果（只在本次停留期间有效，进页面不自动打网络） */
  const [probeState, setProbeState] = useState<Record<string, 'ok' | 'fail'>>({})

  const reload = async (): Promise<void> => {
    const list = await safeCall(() => window.api.listModelEndpoints(), '读取端点列表失败')
    if (list) setModelEndpoints(list)
  }

  // 进页面就以磁盘为准刷一次：老卡片是在 list-templates 时被迁移成端点记录的，
  // 应用启动时若已缓存过一份空表，这里补上。
  useEffect(() => { void reload() }, [])

  const patch = (p: Partial<Draft>): void => setDraft(d => (d ? { ...d, ...p } : d))

  /** 探测当前草稿：结果里的模型名并进模型列表，供直接建卡 */
  const probeDraft = async (): Promise<void> => {
    const built = toEndpoint(draft ?? emptyDraft())
    if (!built.ok) { notify(built.error, 'error'); return }
    const ep = built.value
    setBusy(true)
    const p = await safeCall(() => window.api.probeEndpoint(probeTargetOf(ep)), '探测失败')
    setBusy(false)
    if (!p) return
    if (!p.ok) { notify(p.error ?? '未探测到服务', 'error'); playEvent('error'); return }
    playEvent('success')
    // 只并模型名：本机端口型的 ctx 与视觉在发送时按 /props、/slots 实时取，不存这份
    const merged = [...new Set([...ep.modelIds, ...(p.modelIds ?? [])])]
    setDraft(d => (d ? { ...d, modelIds: merged.length ? merged : [''] } : d))
    if (draft?.id) setProbeState(s => ({ ...s, [draft.id as string]: 'ok' }))
    notify(p.modelIds?.length ? `探测通过，端点上报 ${p.modelIds.length} 个模型名` : '探测通过', 'success')
  }

  /** 探测列表里已保存的端点 */
  const probeSaved = async (ep: ModelEndpoint): Promise<void> => {
    const p = await safeCall(() => window.api.probeEndpoint(probeTargetOf(ep)), '探测失败')
    if (!p) return
    setProbeState(s => ({ ...s, [ep.id]: p.ok ? 'ok' : 'fail' }))
    notify(p.ok ? `${ep.name}：可用${p.modelIds?.length ? `，${p.modelIds.length} 个模型名` : ''}` : `${ep.name}：${p.error ?? '探测不通'}`, p.ok ? 'success' : 'error')
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const built = toEndpoint(draft)
    if (!built.ok) { notify(built.error, 'error'); return }
    const res = await safeCall(() => window.api.saveModelEndpoint(built.value), '保存端点失败')
    if (!res?.success) { notify(`保存端点失败：${res?.error ?? ''}`, 'error'); return }
    await reload()
    notify(draft.id ? '已更新端点' : '已添加端点', 'success')
    setDraft(null)
  }

  const remove = async (ep: ModelEndpoint): Promise<void> => {
    const res = await safeCall(() => window.api.deleteModelEndpoint(ep.id), '删除端点失败')
    if (!res?.success) { notify(`删除失败：${res?.error ?? ''}`, 'error'); return }
    await reload()
    if (draft?.id === ep.id) setDraft(null)
    const refs = useStore.getState().cards.filter(c => c.template.endpointId === ep.id)
    notify(refs.length ? `已删除端点；${refs.length} 张引用它的卡片会失效，需要时重新添加` : '已删除端点', 'info')
  }

  /** 为端点的某个模型名建一张卡片（卡片只存 endpointId 引用） */
  const createCard = async (ep: ModelEndpoint, modelId: string): Promise<void> => {
    const st = useStore.getState()
    if (st.cards.some(c => c.template.endpointId === ep.id && (c.template.endpointModelId || ep.modelIds[0]) === (modelId || ep.modelIds[0]))) {
      notify('这张卡已经建过了，去模型下拉里选它即可', 'info')
      return
    }
    const now = new Date().toISOString()
    const tpl: Template = {
      id: crypto.randomUUID(),
      name: modelId ? `${ep.name} · ${modelId}` : ep.name,
      // 本机端口卡保留端口（接管与指标都按端口走）；远程卡没有端口
      serverPort: ep.kind === 'local-port' ? (ep.port ?? 0) : 0,
      args: {},
      ...(ep.kind === 'local-port' ? { paramSet: 'llamacpp' as const } : {}),
      external: true,
      endpointId: ep.id,
      ...(modelId ? { endpointModelId: modelId } : {}),
      createdAt: now,
      updatedAt: now
    }
    st.addCard(tpl)
    await safeCall(() => window.api.saveTemplate(tpl), '保存模型卡片失败')
    notify(`已建卡片「${tpl.name}」，在模型下拉里点它即可启用`, 'success')
  }

  const editing = !!draft

  return (
    <div className="model-endpoints-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">外部端点</h1>
          <p className="page-subtitle">挂上不由本应用启动的模型服务：本机已运行的端口，或任意 OpenAI / Anthropic 兼容地址</p>
        </div>
        {!editing && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setDraft(emptyDraft()); setShowKey(false) }}>
            <PlusIcon size={13} /> 新建端点
          </button>
        )}
      </div>

      <div className="me-section">
        <div className="me-section-title"><ServerIcon size={14} /> 已保存端点</div>
        {endpoints.length === 0 && !editing && (
          <div className="me-empty">还没有端点。新建一个，探测通过后按模型名建卡片，模型下拉里就会出现它。</div>
        )}
        <div className="me-list">
          {endpoints.map(ep => (
            <div key={ep.id} className="me-row">
              <span className={`me-dot ${probeState[ep.id] ?? 'unknown'}`} title={probeState[ep.id] === 'ok' ? '上次探测可用' : probeState[ep.id] === 'fail' ? '上次探测不通' : '本次未探测'} />
              <div className="me-row-main">
                <div className="me-row-name">{ep.name}<span className="me-tag">{ep.kind === 'local-port' ? '本机端口' : '远程'}</span></div>
                <div className="me-row-meta">{addressOfEndpoint(ep)}{ep.kind === 'remote' ? ` · ${API_CHOICES.find(a => a.value === ep.api)?.label ?? ep.api ?? ''}` : ''} · {ep.modelIds.length} 个模型名</div>
              </div>
              <button className="btn btn-ghost btn-icon" title="探测" onClick={() => void probeSaved(ep)}><PlugZapIcon size={13} /></button>
              <button className="btn btn-ghost btn-icon" title="建卡片（用第一个模型名）" onClick={() => void createCard(ep, ep.modelIds[0] ?? '')} disabled={!ep.modelIds.length}><TagIcon size={13} /></button>
              <button className="btn btn-ghost btn-icon" title="编辑" onClick={() => { setDraft(draftOf(ep)); setShowKey(false) }}><PencilIcon size={13} /></button>
              <button className="btn btn-ghost btn-icon text-danger" title="删除" onClick={() => void remove(ep)}><TrashIcon size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      {draft && (
        <div className="me-section me-form">
          <div className="me-section-title">
            {draft.id ? '编辑端点' : '新建端点'}
            <button className="btn btn-ghost btn-icon me-close" title="收起" onClick={() => setDraft(null)}><XIcon size={13} /></button>
          </div>

          <div className="me-field">
            <label>名称</label>
            <input className="me-input" value={draft.name} placeholder="本机 8080 / 公司网关…" onChange={e => patch({ name: e.target.value })} />
          </div>

          <div className="me-field">
            <label>来源</label>
            <div className="me-seg">
              <button className={`me-seg-btn${draft.kind === 'local-port' ? ' active' : ''}`} onClick={() => patch({ kind: 'local-port' })}>本机端口</button>
              <button className={`me-seg-btn${draft.kind === 'remote' ? ' active' : ''}`} onClick={() => patch({ kind: 'remote' })}>远程 URL</button>
            </div>
          </div>

          {draft.kind === 'local-port' ? (
            <div className="me-field">
              <label>端口</label>
              <div className="me-inline">
                <span className="me-prefix">127.0.0.1:</span>
                <input className="me-input me-input-port" value={draft.port} inputMode="numeric" spellCheck={false}
                  onChange={e => patch({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
              </div>
              <p className="me-hint">服务得已经在别处启动。这里不启动、也不停止它，断开只是取消本应用的登记。</p>
            </div>
          ) : (
            <>
              <div className="me-field">
                <label>接口地址（Base URL）</label>
                <input className="me-input" value={draft.baseUrl} placeholder="http://127.0.0.1:8080/v1" spellCheck={false}
                  onChange={e => patch({ baseUrl: e.target.value })} />
                <p className="me-hint">填到版本路径为止，例如 http://127.0.0.1:8080/v1 或 https://api.example.com/v1</p>
              </div>
              <div className="me-field">
                <label>API 类型</label>
                <select className="me-input" value={draft.api} onChange={e => patch({ api: e.target.value as EndpointApi })}>
                  {API_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div className="me-field">
                <label>API Key</label>
                <div className="me-inline">
                  <input className="me-input me-key" type={showKey ? 'text' : 'password'} value={draft.apiKey} placeholder="本机服务可留空" spellCheck={false}
                    onChange={e => patch({ apiKey: e.target.value })} />
                  <button className="btn btn-ghost btn-icon" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey(v => !v)}>
                    {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                  </button>
                </div>
                <p className="me-hint">明文存在 endpoints.json 里（本机应用，没有接系统密钥链）。</p>
              </div>
              <div className="me-field">
                <label>上下文窗口</label>
                <input className="me-input me-input-port" value={draft.contextWindow} inputMode="numeric" placeholder="128000" spellCheck={false}
                  onChange={e => patch({ contextWindow: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
                <p className="me-hint">远程端点没有 /props，这个值只能手填；留空按 128000 算。</p>
              </div>
              <label className="me-check">
                <input type="checkbox" checked={draft.vision} onChange={e => patch({ vision: e.target.checked })} />
                该端点支持图像输入（勾了截图工具才会把图发给模型）
              </label>
            </>
          )}

          <div className="me-field">
            <label>Model ID</label>
            <div className="me-models">
              {draft.modelIds.map((m, i) => (
                <div key={i} className="me-model-row">
                  <input className="me-input" value={m} placeholder={draft.kind === 'local-port' ? '可留空（llama-server 不校验模型名）' : '例如 qwen3-32b'} spellCheck={false}
                    onChange={e => patch({ modelIds: draft.modelIds.map((x, j) => (j === i ? e.target.value : x)) })} />
                  <button className="btn btn-ghost btn-icon" title="建卡片" onClick={() => {
                    const built = toEndpoint(draft)
                    if (!built.ok) { notify(built.error, 'error'); return }
                    if (!draft.id) { notify('先保存端点，再按模型名建卡片', 'error'); return }
                    const ep = endpoints.find(x => x.id === draft.id)
                    if (ep) void createCard(ep, m.trim())
                  }}><TagIcon size={13} /></button>
                  <button className="btn btn-ghost btn-icon text-danger" title="删除这一行" onClick={() => patch({ modelIds: draft.modelIds.filter((_, j) => j !== i) })}>
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => patch({ modelIds: [...draft.modelIds, ''] })}><PlusIcon size={12} /> 添加 Model ID</button>
            <p className="me-hint">点「探测」会把端点上报的模型名并进来。一个模型名对应一张模型卡片。</p>
          </div>

          <div className="me-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => void probeDraft()} disabled={busy}>{busy ? '探测中…' : '探测'}</button>
            <button className="btn btn-primary btn-sm" onClick={() => void save()}>保存</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
