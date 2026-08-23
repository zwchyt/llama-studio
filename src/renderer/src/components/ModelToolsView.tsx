import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Wrench, FileSearch, Hash, MemoryStick, Loader2, Copy, Check, ChevronDown, Search, Cpu, TriangleAlert, GitCompare, FileCode2, Play } from 'lucide-react'
import CustomSelect from './CustomSelect'
import type { GgufMetadata, FitParamsResult } from '../../../shared/types'

// KV 缓存精度选项（透传给 llama-fit-params 的 -ctk/-ctv；f16 为工具默认）
type KvType = 'f16' | 'q8_0' | 'q4_0'
const KV_TYPE_LABELS: Record<KvType, string> = { f16: 'F16（默认）', q8_0: 'Q8_0', q4_0: 'Q4_0' }
import '../styles/model-tools.css'

type ToolTab = 'inspector' | 'tokenizer' | 'fit' | 'compare' | 'template'

// token 色块循环调色板（底色淡、文字同色系深）
const TOKEN_COLORS = [
  '#8b5cf6', '#3b82f6', '#14b8a6', '#f59e0b',
  '#ec4899', '#10b981', '#ef4444', '#06b6d4',
]

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function formatParams(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return String(n)
}

// 空白字符可视化：token 色块中让空格/换行可见
function visualizePiece(piece: string): string {
  return piece.replace(/ /g, '\u00b7').replace(/\n/g, '\u21b5').replace(/\t/g, '\u2192')
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn btn-ghost mtools-copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => { })
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{copied ? '已复制' : label}</span>}
    </button>
  )
}

// ── Tab 1：GGUF 检查器 ─────────────────────────────────────
function InspectorTab({ modelPath, setModelPath }: { modelPath: string; setModelPath: (p: string) => void }) {
  const models = useStore(s => s.models)
  const [meta, setMeta] = useState<GgufMetadata | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [kvFilter, setKvFilter] = useState('')
  const [templateOpen, setTemplateOpen] = useState(false)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!modelPath) { setMeta(null); setError(''); return }
    const seq = ++reqSeq.current
    setLoading(true); setError(''); setTemplateOpen(false)
    window.api.readGgufMeta(modelPath).then(res => {
      if (seq !== reqSeq.current) return
      setLoading(false)
      if ('error' in res) { setMeta(null); setError(res.error) }
      else setMeta(res)
    }).catch(err => {
      if (seq !== reqSeq.current) return
      setLoading(false); setMeta(null); setError(String(err))
    })
  }, [modelPath])

  const filteredKv = useMemo(() => {
    if (!meta) return []
    const q = kvFilter.trim().toLowerCase()
    if (!q) return meta.kv
    return meta.kv.filter(e => e.key.toLowerCase().includes(q))
  }, [meta, kvFilter])

  const basicItems: { label: string; value: string }[] = meta ? [
    { label: '架构', value: meta.architecture || '—' },
    { label: '参数量', value: formatParams(meta.paramCount) },
    { label: '量化类型', value: meta.fileTypeName || '—' },
    { label: '上下文长度', value: meta.contextLength ? meta.contextLength.toLocaleString() : '—' },
    { label: '层数', value: meta.blockCount !== undefined ? String(meta.blockCount) : '—' },
    { label: '注意力头数', value: meta.headCount !== undefined ? `${meta.headCount}${meta.headCountKv !== undefined ? ` / KV ${meta.headCountKv}` : ''}` : '—' },
    { label: 'Embedding 维度', value: meta.embeddingLength !== undefined ? String(meta.embeddingLength) : '—' },
    { label: '词表大小', value: meta.vocabSize ? meta.vocabSize.toLocaleString() : '—' },
    ...(meta.expertCount ? [{ label: '专家数 (MoE)', value: String(meta.expertCount) }] : []),
    { label: '文件大小', value: formatBytes(meta.fileSize) },
    { label: 'GGUF 版本 / tensor 数', value: `v${meta.version} / ${meta.tensorCount}` },
  ] : []

  return (
    <div className="mtools-tab-body">
      <div className="mtools-form-row">
        <label>模型文件</label>
        <CustomSelect
          className="mtools-select-wrapper"
          value={modelPath}
          onChange={setModelPath}
          options={[
            { value: '', label: '选择要检查的 GGUF 模型' },
            ...models.map(m => ({ value: m.path, label: `${m.name} (${m.folder})` })),
          ]}
          disabled={loading}
          aria-label="模型文件"
        />
      </div>

      {loading && <div className="mtools-loading"><Loader2 size={16} className="mtools-spin" /> 正在解析 GGUF 头部…</div>}
      {error && <div className="mtools-error">{error}</div>}

      {meta && !loading && (
        <div className="mtools-scroll">
          {/* 基本信息卡片 */}
          <div className="mtools-card">
            <div className="mtools-card-title">
              <FileSearch size={14} />
              <span>{meta.modelName || meta.path.split(/[/\\]/).pop()}</span>
            </div>
            <div className="mtools-info-grid">
              {basicItems.map(item => (
                <div className="mtools-info-item" key={item.label}>
                  <span className="mtools-info-label">{item.label}</span>
                  <span className="mtools-info-value">{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 量化类型分布 */}
          {meta.tensorTypes.length > 0 && (
            <div className="mtools-card">
              <div className="mtools-card-title"><Cpu size={14} /><span>量化类型分布</span></div>
              <div className="mtools-ttype-list">
                {meta.tensorTypes.map(t => {
                  const pct = meta.paramCount > 0 ? (t.params / meta.paramCount) * 100 : 0
                  return (
                    <div className="mtools-ttype-row" key={t.type}>
                      <span className="mtools-ttype-name">{t.type}</span>
                      <div className="mtools-ttype-bar"><div className="mtools-ttype-fill" style={{ width: `${Math.max(pct, 1)}%` }} /></div>
                      <span className="mtools-ttype-meta">{t.count} tensors · {pct.toFixed(1)}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Chat Template 折叠区 */}
          {meta.chatTemplate && (
            <div className="mtools-card">
              <div className="mtools-collapse-header">
                <button className="mtools-collapse-toggle" onClick={() => setTemplateOpen(o => !o)} aria-expanded={templateOpen}>
                  <ChevronDown size={14} className={`mtools-chevron ${templateOpen ? '' : 'collapsed'}`} />
                  <span>Chat Template</span>
                  <span className="mtools-collapse-hint">{meta.chatTemplate.length.toLocaleString()} 字符</span>
                </button>
                <CopyButton text={meta.chatTemplate} label="复制" />
              </div>
              {templateOpen && <pre className="mtools-template-pre">{meta.chatTemplate}</pre>}
            </div>
          )}

          {/* 完整 KV 表 */}
          <div className="mtools-card">
            <div className="mtools-card-title">
              <span>元数据 KV（{meta.kvCount}）</span>
              <div className="mtools-kv-search">
                <Search size={13} />
                <input value={kvFilter} onChange={e => setKvFilter(e.target.value)} placeholder="过滤 key…" />
              </div>
            </div>
            <div className="mtools-kv-table">
              {filteredKv.map(entry => (
                <div className="mtools-kv-row" key={entry.key}>
                  <span className="mtools-kv-key" title={entry.key}>{entry.key}</span>
                  <span className="mtools-kv-type">{entry.type}</span>
                  <span className="mtools-kv-value" title={entry.value !== null ? String(entry.value) : undefined}>
                    {entry.arrayLength !== undefined
                      ? `[${entry.arrayPreview?.slice(0, 8).map(v => JSON.stringify(v)).join(', ')}${entry.arrayLength > 8 ? ', …' : ''}] 共 ${entry.arrayLength.toLocaleString()} 项`
                      : String(entry.value)}
                  </span>
                </div>
              ))}
              {filteredKv.length === 0 && <div className="mtools-kv-empty">无匹配条目</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab 2：Token 可视化器 ──────────────────────────────────
function TokenizerTab({ modelPath, setModelPath }: { modelPath: string; setModelPath: (p: string) => void }) {
  const { models, cards, activeBackend, backends } = useStore(
    s => ({ models: s.models, cards: s.cards, activeBackend: s.activeBackend, backends: s.backends }),
    shallow
  )
  const runningCards = cards.filter(c => c.status === 'running' && c.template.serverPort)
  // /tokenize 是 llama.cpp 专属端点，TensorSharp 运行时不支持服务模式分词
  const runningIsTensorSharp = runningCards.some(c => backends.find(b => b.name === c.template.backendVersion)?.kind === 'tensorsharp')
  const [mode, setMode] = useState<'server' | 'file'>(runningCards.length > 0 && !runningIsTensorSharp ? 'server' : 'file')
  const [serverPort, setServerPort] = useState<string>(runningCards[0]?.template.serverPort ? String(runningCards[0].template.serverPort) : '')
  const [text, setText] = useState('')
  const [tokens, setTokens] = useState<{ id: number; piece: string }[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const reqSeq = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 运行卡片变化时补默认端口
  useEffect(() => {
    if (!serverPort && runningCards.length > 0) setServerPort(String(runningCards[0].template.serverPort))
  }, [runningCards.length])

  const doTokenize = useCallback(async (input: string) => {
    const seq = ++reqSeq.current
    if (!input) { setTokens([]); setError(''); setLoading(false); return }
    setLoading(true); setError('')
    const opts = mode === 'server'
      ? { port: parseInt(serverPort, 10) || 0, text: input }
      : { backendPath: activeBackend?.path || '', modelPath, text: input }
    const res = await window.api.tokenizeText(opts).catch(err => ({ success: false, error: String(err), tokens: [] }))
    if (seq !== reqSeq.current) return
    setLoading(false)
    if (!res.success) { setError(res.error || '分词失败'); setTokens([]) }
    else setTokens(res.tokens)
  }, [mode, serverPort, activeBackend?.path, modelPath])

  // 服务模式：500ms 防抖自动分词；文件模式：仅按钮触发（避免重复加载词表）
  useEffect(() => {
    if (mode !== 'server') return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { doTokenize(text) }, 500)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [text, mode, doTokenize])

  const canRun = mode === 'server'
    ? !!serverPort
    : !!modelPath && !!activeBackend?.path

  const charCount = text.length
  const ratio = tokens.length > 0 && charCount > 0 ? (charCount / tokens.length).toFixed(2) : '—'

  return (
    <div className="mtools-tab-body">
      <div className="mtools-form-row">
        <label>分词来源</label>
        <div className="mtools-mode-tabs">
          <button className={`mtools-mode-tab ${mode === 'server' ? 'active' : ''}`} onClick={() => setMode('server')}>
            运行中模型{runningCards.length > 0 ? ` (${runningCards.length})` : ''}
          </button>
          <button className={`mtools-mode-tab ${mode === 'file' ? 'active' : ''}`} onClick={() => setMode('file')}>选择 GGUF 文件</button>
        </div>
        {runningIsTensorSharp && (
          <span className="mtools-hint">TensorSharp 引擎不提供 /tokenize 端点，服务模式仅支持 llama.cpp 运行实例。</span>
        )}
      </div>

      {mode === 'server' ? (
        <div className="mtools-form-row">
          <label>运行实例</label>
          {runningCards.length > 0 ? (
            <CustomSelect
              className="mtools-select-wrapper"
              value={serverPort}
              onChange={setServerPort}
              options={runningCards.map(c => ({ value: String(c.template.serverPort), label: `${c.template.name} (端口 ${c.template.serverPort})` }))}
              aria-label="运行实例"
            />
          ) : (
            <span className="mtools-hint">当前没有运行中的模型，请先在「我的模板」中启动，或切换到文件模式</span>
          )}
        </div>
      ) : (
        <div className="mtools-form-row">
          <label>模型文件</label>
          <CustomSelect
            className="mtools-select-wrapper"
            value={modelPath}
            onChange={setModelPath}
            options={[
              { value: '', label: '选择 GGUF 模型（仅加载词表）' },
              ...models.map(m => ({ value: m.path, label: `${m.name} (${m.folder})` })),
            ]}
            disabled={loading}
            aria-label="模型文件"
          />
        </div>
      )}

      <textarea
        className="mtools-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={mode === 'server' ? '输入文本，自动分词…' : '输入文本后点击「分词」按钮…'}
        rows={5}
      />

      <div className="mtools-token-stats">
        {mode === 'file' && (
          <button className="btn btn-primary mtools-run-btn" onClick={() => doTokenize(text)} disabled={!canRun || loading || !text}>
            {loading ? <Loader2 size={14} className="mtools-spin" /> : <Hash size={14} />}
            分词
          </button>
        )}
        <span className="mtools-stat"><b>{tokens.length.toLocaleString()}</b> tokens</span>
        <span className="mtools-stat"><b>{charCount.toLocaleString()}</b> 字符</span>
        <span className="mtools-stat"><b>{ratio}</b> 字符/token</span>
        {loading && mode === 'server' && <Loader2 size={13} className="mtools-spin" />}
      </div>

      {error && <div className="mtools-error">{error}</div>}

      <div className="mtools-scroll">
        {tokens.length > 0 && (
          <div className="mtools-token-flow">
            {tokens.map((t, i) => {
              const color = TOKEN_COLORS[i % TOKEN_COLORS.length]
              return (
                <span
                  key={i}
                  className="mtools-token-chip"
                  style={{ background: `${color}1c`, color, borderColor: `${color}40` }}
                  title={`id: ${t.id}`}
                >
                  {visualizePiece(t.piece) || `#${t.id}`}
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab 3：显存装载计算器（直接调用后端 llama-fit-params.exe 实测拟合）──
// 不做任何本地估算：由工具真实加载模型、探测显卡显存并按预算余量拟合出 -c/-ngl。
// 上下文长度输入上限（1M token，防误输天文数字）
const CTX_MAX = 1048576

function FitTab({ modelPath, setModelPath }: { modelPath: string; setModelPath: (p: string) => void }) {
  const { models, activeBackend } = useStore(
    s => ({ models: s.models, activeBackend: s.activeBackend }),
    shallow
  )
  const { meta, error: metaError, loading: loadingMeta } = useGgufMeta(modelPath)
  // 上下文输入框显示值与生效值分离（失焦才钳位）；空/0 = 不传 -c，由工具自动拟合最大上下文
  const [ctxText, setCtxText] = useState('4096')
  const [kvType, setKvType] = useState<KvType>('f16')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<FitParamsResult | null>(null)
  const [showLog, setShowLog] = useState(false)
  const reqSeq = useRef(0)

  const ctxSize = useMemo(() => {
    const n = parseInt(ctxText, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, CTX_MAX) : 0
  }, [ctxText])

  const backendReady = !!activeBackend?.path

  const doFit = useCallback(async () => {
    if (!modelPath || !backendReady) return
    const seq = ++reqSeq.current
    setRunning(true); setError(''); setResult(null)
    const res = await window.api.fitParams({
      backendPath: activeBackend!.path, modelPath,
      ctxSize: ctxSize > 0 ? ctxSize : undefined,
      kvType,
    }).catch(err => ({ success: false, error: String(err), log: '' }) as FitParamsResult)
    if (seq !== reqSeq.current) return
    setRunning(false)
    if (!res.success) { setError(res.error || '拟合失败'); setResult(null) }
    else setResult(res)
  }, [modelPath, backendReady, activeBackend, ctxSize, kvType])

  const nLayerTotal = meta?.blockCount ?? null
  // -ot 张量卸载规则（MoE 模型显存不足时工具会输出专家张量驻留内存的正则列表）
  const otRules = result?.fittedArgs?.match(/-ot\s+"([^"]*)"/)?.[1]?.split(',').filter(Boolean) ?? null
  // 结论分级：-ngl=-1 全量载入；>0 部分卸载；=0 放不下；未输出 -ngl 视为中性
  const verdict = !result ? null
    : result.gpuLayers === -1 ? 'ok'
      : (result.gpuLayers ?? 0) > 0 ? 'warn'
        : result.gpuLayers === 0 ? 'bad' : 'info'

  return (
    <div className="mtools-tab-body">
      <div className="mtools-form-row">
        <label>模型文件</label>
        <CustomSelect
          className="mtools-select-wrapper"
          value={modelPath}
          onChange={setModelPath}
          options={[
            { value: '', label: '选择要计算的 GGUF 模型' },
            ...models.map(m => ({ value: m.path, label: `${m.name} (${m.folder})` })),
          ]}
          aria-label="模型文件"
        />
      </div>

      {!backendReady && (
        <div className="mtools-error">未检测到可用后端，请先在「后端」页选择/下载后端版本（需包含 llama-fit-params.exe）。</div>
      )}

      <div className="mtools-form-row">
        <label>上下文长度</label>
        <input
          className="mtools-number-input"
          type="number"
          min={0}
          step={256}
          placeholder="自动拟合"
          value={ctxText}
          onChange={e => setCtxText(e.target.value)}
          onBlur={() => {
            const n = parseInt(ctxText, 10)
            const c = Number.isFinite(n) && n > 0 ? Math.min(n, CTX_MAX) : 0
            setCtxText(c > 0 ? String(c) : '')
          }}
        />
        <span className="mtools-hint">token；清空或 0 = 按实际显存自动拟合最大上下文{meta?.contextLength ? `（训练上限 ${meta.contextLength.toLocaleString()}）` : ''}</span>
        <label style={{ marginLeft: 'auto' }}>KV 精度</label>
        <CustomSelect
          className="mtools-kv-select"
          value={kvType}
          onChange={v => setKvType(v as KvType)}
          options={(Object.keys(KV_TYPE_LABELS) as KvType[]).map(k => ({ value: k, label: KV_TYPE_LABELS[k] }))}
          aria-label="KV 缓存精度"
        />
      </div>

      <div className="mtools-form-row">
        <span className="mtools-hint">工具会真实加载模型并按当前显卡实测拟合，给出可直接使用的启动参数</span>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={doFit} disabled={!modelPath || !backendReady || running}>
          {running ? <Loader2 size={14} className="mtools-spin" /> : <Play size={14} />}
          {running ? '拟合中…' : '计算'}
        </button>
      </div>

      {loadingMeta && <div className="mtools-loading"><Loader2 size={16} className="mtools-spin" /> 读取模型元数据中…</div>}
      {metaError && <div className="mtools-error">{metaError}</div>}
      {error && <div className="mtools-error">{error}</div>}

      {result && (
        <div className="mtools-scroll">
          {/* 结论横幅（按工具返回的 -ngl 分级）*/}
          {verdict && (
            <div className={`mtools-vram-verdict ${verdict}`}>
              {verdict === 'ok' ? <Check size={16} /> : verdict === 'info' ? <MemoryStick size={16} /> : <TriangleAlert size={16} />}
              <span>
                {verdict === 'ok'
                  ? '可全量载入 GPU'
                  : verdict === 'warn'
                    ? otRules
                      ? `显存不足以全量载入：已生成 -ot 规则将 ${otRules.length} 组专家张量留在内存，其余上 GPU`
                      : `显存不足以全量载入，工具建议卸载 ${result.gpuLayers}${nLayerTotal ? ` / ${nLayerTotal}` : ''} 层`
                    : verdict === 'bad'
                      ? '当前配置无法放入 GPU 显存，建议减小上下文 / 换更小量化或纯 CPU 运行'
                      : '工具未输出 -ngl 调整建议（当前默认配置应可直接运行）'}
              </span>
            </div>
          )}

          {/* 拟合参数卡 */}
          {result.fittedArgs && (
            <div className="mtools-card">
              <div className="mtools-card-title">
                <MemoryStick size={14} /><span>llama-fit-params 拟合参数</span>
                <CopyButton text={result.fittedArgs} label="复制参数" />
              </div>
              <code className="mtools-fit-args">{result.fittedArgs}</code>
              <div className="mtools-fit-grid">
                {result.ctxSize !== undefined && (
                  <div className="mtools-fit-item"><span className="mtools-fit-label">拟合上下文（-c）</span><span className="mtools-fit-value">{result.ctxSize > 0 ? result.ctxSize.toLocaleString() : '模型默认'}</span></div>
                )}
                {result.gpuLayers !== undefined && (
                  <div className="mtools-fit-item"><span className="mtools-fit-label">GPU 卸载层数（-ngl）</span><span className="mtools-fit-value">{result.gpuLayers === -1 ? `全部层${nLayerTotal ? `（${nLayerTotal}）` : ''}` : `${result.gpuLayers}${nLayerTotal ? ` / ${nLayerTotal}` : ''}`}</span></div>
                )}
                {otRules && (
                  <div className="mtools-fit-item"><span className="mtools-fit-label">内存驻留张量组（-ot）</span><span className="mtools-fit-value" title={otRules.join('\n')}>{otRules.length}</span></div>
                )}
              </div>
            </div>
          )}
          {!result.fittedArgs && (
            <div className="mtools-hint">工具未返回拟合参数：可能当前配置无需调整即可运行。</div>
          )}

          {/* 完整日志折叠 */}
          {result.log && (
            <div className="mtools-collapse-header">
              <button className="mtools-collapse-toggle" onClick={() => setShowLog(o => !o)} aria-expanded={showLog}>
                <ChevronDown size={14} className={`mtools-chevron ${showLog ? '' : 'collapsed'}`} />
                完整日志
              </button>
            </div>
          )}
          {showLog && result.log && <pre className="mtools-fit-args mtools-fit-log">{result.log}</pre>}
        </div>
      )}
    </div>
  )
}

// ── 共用：按路径加载 GGUF 头部元数据（带请求序列号防乱序）──
function useGgufMeta(path: string): { meta: GgufMetadata | null; error: string; loading: boolean } {
  const [meta, setMeta] = useState<GgufMetadata | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    if (!path) { setMeta(null); setError(''); return }
    const s = ++seq.current
    setLoading(true); setError('')
    window.api.readGgufMeta(path).then(res => {
      if (s !== seq.current) return
      setLoading(false)
      if ('error' in res) { setMeta(null); setError(res.error) }
      else setMeta(res)
    }).catch(e => {
      if (s !== seq.current) return
      setLoading(false); setMeta(null); setError(String(e))
    })
  }, [path])
  return { meta, error, loading }
}

// ── Tab 4：模型对比器（双 GGUF 元数据并排 diff，纯前端）──────────
function CompareTab() {
  const models = useStore(s => s.models)
  const [pathA, setPathA] = useState('')
  const [pathB, setPathB] = useState('')
  const a = useGgufMeta(pathA)
  const b = useGgufMeta(pathB)

  // 对比行：两侧都有元数据时才生成；差异行高亮
  const rows = useMemo(() => {
    if (!a.meta || !b.meta) return []
    const A = a.meta, B = b.meta
    const bpw = (m: GgufMetadata): string => m.paramCount > 0 ? ((m.fileSize * 8) / m.paramCount).toFixed(2) : '—'
    const mk = (label: string, va: string, vb: string): { label: string; va: string; vb: string; diff: boolean } =>
      ({ label, va, vb, diff: va !== vb })
    return [
      mk('架构', A.architecture || '—', B.architecture || '—'),
      mk('参数量', formatParams(A.paramCount), formatParams(B.paramCount)),
      mk('量化类型', A.fileTypeName || '—', B.fileTypeName || '—'),
      mk('每权重位数 (bpw)', bpw(A), bpw(B)),
      mk('文件大小', formatBytes(A.fileSize), formatBytes(B.fileSize)),
      mk('训练上下文上限', A.contextLength?.toLocaleString() || '—', B.contextLength?.toLocaleString() || '—'),
      mk('层数', A.blockCount !== undefined ? String(A.blockCount) : '—', B.blockCount !== undefined ? String(B.blockCount) : '—'),
      mk('注意力头 / KV 头', `${A.headCount ?? '—'} / ${A.headCountKv ?? A.headCount ?? '—'}`, `${B.headCount ?? '—'} / ${B.headCountKv ?? B.headCount ?? '—'}`),
      mk('Embedding 维度', A.embeddingLength !== undefined ? String(A.embeddingLength) : '—', B.embeddingLength !== undefined ? String(B.embeddingLength) : '—'),
      mk('词表大小', A.vocabSize?.toLocaleString() || '—', B.vocabSize?.toLocaleString() || '—'),
      mk('专家数 (MoE)', A.expertCount ? String(A.expertCount) : '—', B.expertCount ? String(B.expertCount) : '—'),
      mk('GGUF 版本 / tensor 数', `v${A.version} / ${A.tensorCount}`, `v${B.version} / ${B.tensorCount}`),
      mk('Chat 模板', A.chatTemplate ? `${A.chatTemplate.length.toLocaleString()} 字符` : '无', B.chatTemplate ? `${B.chatTemplate.length.toLocaleString()} 字符` : '无'),
    ]
  }, [a.meta, b.meta])

  const diffCount = rows.filter(r => r.diff).length
  const opts = (exclude: string): { value: string; label: string }[] => [
    { value: '', label: '选择 GGUF 模型' },
    ...models.filter(m => m.path !== exclude).map(m => ({ value: m.path, label: `${m.name} (${m.folder})` })),
  ]

  return (
    <div className="mtools-tab-body">
      <div className="mtools-form-row">
        <label>模型 A</label>
        <CustomSelect className="mtools-select-wrapper" value={pathA} onChange={setPathA} options={opts(pathB)} aria-label="模型 A" />
      </div>
      <div className="mtools-form-row">
        <label>模型 B</label>
        <CustomSelect className="mtools-select-wrapper" value={pathB} onChange={setPathB} options={opts(pathA)} aria-label="模型 B" />
      </div>

      {(a.loading || b.loading) && <div className="mtools-loading"><Loader2 size={16} className="mtools-spin" /> 正在解析 GGUF 头部…</div>}
      {a.error && <div className="mtools-error">模型 A: {a.error}</div>}
      {b.error && <div className="mtools-error">模型 B: {b.error}</div>}
      {!pathA && !pathB && <div className="mtools-hint">选择两个模型，并排对比元数据差异（不加载权重，秒出结果）。</div>}

      {rows.length > 0 && a.meta && b.meta && (
        <div className="mtools-scroll">
          <div className="mtools-card">
            <div className="mtools-card-title">
              <GitCompare size={14} />
              <span>元数据对比</span>
              <span className="mtools-collapse-hint">{diffCount} 项差异</span>
            </div>
            <div className="mtools-cmp-table">
              <div className="mtools-cmp-row head">
                <span></span>
                <span title={a.meta.path}>{a.meta.modelName || a.meta.path.split(/[/\\]/).pop()}</span>
                <span title={b.meta.path}>{b.meta.modelName || b.meta.path.split(/[/\\]/).pop()}</span>
              </div>
              {rows.map(r => (
                <div key={r.label} className={`mtools-cmp-row ${r.diff ? 'diff' : ''}`}>
                  <span>{r.label}</span>
                  <span>{r.va}</span>
                  <span>{r.vb}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab 5：Chat 模板分析（llama-template-analysis.exe）──────────
// 报告解析：能力表（supports_*）+ 多组 Diff 段 + 推理变量检查

interface TplDiffSection { title: string; left: string; right: string }
interface TplReport { caps: { key: string; value: boolean }[]; diffs: TplDiffSection[]; reasoning: string }

const TPL_CAP_LABELS: Record<string, string> = {
  supports_tools: '工具定义注入',
  supports_tool_calls: '工具调用消息',
  supports_system_role: 'system 角色',
  supports_parallel_tool_calls: '并行工具调用',
  supports_typed_content: '类型化内容',
  supports_string_content: '字符串内容',
}

function parseTemplateReport(report: string): TplReport {
  const caps: { key: string; value: boolean }[] = []
  const capRe = /^(supports_\w+):\s*(true|false)/gm
  let m: RegExpExecArray | null
  while ((m = capRe.exec(report)) !== null) caps.push({ key: m[1], value: m[2] === 'true' })
  const diffs: TplDiffSection[] = []
  // 字段值可能跨行，用下一个已知字面量做惰性锚点
  const secRe = new RegExp(
    "=== Diff: ([^\\r\\n]+?) ===\\r?\\n" +
    "Common Prefix: '([\\s\\S]*?)'\\r?\\n" +
    "Common Suffix: '([\\s\\S]*?)'\\r?\\n" +
    "Left \\(difference\\): '([\\s\\S]*?)'\\r?\\n" +
    "Right \\(difference\\): '([\\s\\S]*?)'\\r?\\n",
    'g'
  )
  while ((m = secRe.exec(report)) !== null) diffs.push({ title: m[1].trim(), left: m[4], right: m[5] })
  const reason = report.match(/=== Checking Reasoning Variables ===\r?\n([\s\S]*?)\r?\n=+/)
  return { caps, diffs, reasoning: reason ? reason[1].trim() : '' }
}

function TemplateTab({ modelPath, setModelPath }: { modelPath: string; setModelPath: (p: string) => void }) {
  const models = useStore(s => s.models)
  const activeBackend = useStore(s => s.activeBackend)
  const [mode, setMode] = useState<'model' | 'custom'>('model')
  const [customTpl, setCustomTpl] = useState('')
  const { meta, error: metaError, loading: loadingMeta } = useGgufMeta(mode === 'model' ? modelPath : '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState('')
  const [rawOpen, setRawOpen] = useState(false)
  const reqSeq = useRef(0)

  const template = mode === 'model' ? (meta?.chatTemplate || '') : customTpl
  const canRun = !!template.trim() && !!activeBackend?.path && !running

  async function handleAnalyze(): Promise<void> {
    if (!canRun || !activeBackend) return
    const seq = ++reqSeq.current
    setRunning(true); setError(''); setReport('')
    const res = await window.api.analyzeTemplate({ backendPath: activeBackend.path, template })
      .catch(err => ({ success: false, error: String(err), report: undefined }))
    if (seq !== reqSeq.current) return
    setRunning(false)
    if (!res.success || !res.report) setError(res.error || '分析失败')
    else setReport(res.report)
  }

  const parsed = useMemo(() => report ? parseTemplateReport(report) : null, [report])

  return (
    <div className="mtools-tab-body">
      <div className="mtools-form-row">
        <label>模板来源</label>
        <div className="mtools-mode-tabs">
          <button className={`mtools-mode-tab ${mode === 'model' ? 'active' : ''}`} onClick={() => setMode('model')}>模型内置模板</button>
          <button className={`mtools-mode-tab ${mode === 'custom' ? 'active' : ''}`} onClick={() => setMode('custom')}>自定义粘贴</button>
        </div>
      </div>

      {mode === 'model' ? (
        <div className="mtools-form-row">
          <label>模型文件</label>
          <CustomSelect
            className="mtools-select-wrapper"
            value={modelPath}
            onChange={setModelPath}
            options={[
              { value: '', label: '选择 GGUF 模型（读其内置 Chat 模板）' },
              ...models.map(m => ({ value: m.path, label: `${m.name} (${m.folder})` })),
            ]}
            disabled={loadingMeta}
            aria-label="模型文件"
          />
        </div>
      ) : (
        <textarea
          className="mtools-textarea"
          value={customTpl}
          onChange={e => setCustomTpl(e.target.value)}
          placeholder="粘贴 Jinja 格式的 Chat 模板…"
          rows={6}
        />
      )}

      <div className="mtools-token-stats">
        <button className="btn btn-primary mtools-run-btn" onClick={handleAnalyze} disabled={!canRun}>
          {running ? <Loader2 size={14} className="mtools-spin" /> : <Play size={14} />}
          分析模板
        </button>
        {mode === 'model' && meta && (
          <span className="mtools-stat">{meta.chatTemplate ? <><b>{meta.chatTemplate.length.toLocaleString()}</b> 字符</> : '该模型无内置模板'}</span>
        )}
        {!activeBackend?.path && <span className="mtools-hint">需先在设置中选择后端版本</span>}
      </div>

      {loadingMeta && <div className="mtools-loading"><Loader2 size={16} className="mtools-spin" /> 读取模型元数据中…</div>}
      {metaError && <div className="mtools-error">{metaError}</div>}
      {error && <div className="mtools-error">{error}</div>}

      {parsed && (
        <div className="mtools-scroll">
          {/* 能力表 */}
          {parsed.caps.length > 0 && (
            <div className="mtools-card">
              <div className="mtools-card-title"><FileCode2 size={14} /><span>模板能力</span></div>
              <div className="mtools-tpl-caps">
                {parsed.caps.map(c => (
                  <span key={c.key} className={`mtools-tpl-cap ${c.value ? 'yes' : 'no'}`}>
                    {c.value ? <Check size={12} /> : <span className="mtools-tpl-cap-x">✕</span>}
                    {TPL_CAP_LABELS[c.key] || c.key}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 差异段：只展示有实际差异的组 */}
          {parsed.diffs.some(d => d.left || d.right) && (
            <div className="mtools-card">
              <div className="mtools-card-title"><GitCompare size={14} /><span>场景差异（有/无某输入时渲染结果的变化）</span></div>
              <div className="mtools-tpl-diffs">
                {parsed.diffs.filter(d => d.left || d.right).map((d, i) => (
                  <div key={i} className="mtools-tpl-diff">
                    <div className="mtools-tpl-diff-title">{d.title}</div>
                    {d.left && <div className="mtools-tpl-diff-row"><span className="tag left">有</span><pre>{d.left}</pre></div>}
                    {d.right && <div className="mtools-tpl-diff-row"><span className="tag right">无</span><pre>{d.right}</pre></div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 推理变量 */}
          {parsed.reasoning && (
            <div className="mtools-card">
              <div className="mtools-card-title"><Cpu size={14} /><span>推理（thinking）变量检查</span></div>
              <div className="mtools-hint">{parsed.reasoning}</div>
            </div>
          )}

          {/* 原始报告折叠区 */}
          <div className="mtools-card">
            <div className="mtools-collapse-header">
              <button className="mtools-collapse-toggle" onClick={() => setRawOpen(o => !o)} aria-expanded={rawOpen}>
                <ChevronDown size={14} className={`mtools-chevron ${rawOpen ? '' : 'collapsed'}`} />
                <span>原始分析报告</span>
                <span className="mtools-collapse-hint">{report.length.toLocaleString()} 字符</span>
              </button>
              <CopyButton text={report} label="复制" />
            </div>
            {rawOpen && <pre className="mtools-template-pre">{report}</pre>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 主视图 ────────────────────────────────────────────────
export default function ModelToolsView() {
  const { modelToolsTarget, setModelToolsTarget } = useStore(
    s => ({ modelToolsTarget: s.modelToolsTarget, setModelToolsTarget: s.setModelToolsTarget }),
    shallow
  )
  const [tab, setTab] = useState<ToolTab>('inspector')
  // 三个标签页共享同一个模型选择，切换标签页无需重选
  const [modelPath, setModelPath] = useState('')

  // 外部跳转预选（模型列表「检查」按钮）
  useEffect(() => {
    if (!modelToolsTarget) return
    setTab(modelToolsTarget.tab)
    setModelPath(modelToolsTarget.modelPath)
    setModelToolsTarget(null)
  }, [modelToolsTarget, setModelToolsTarget])

  const TABS: { key: ToolTab; label: string; icon: React.ReactNode }[] = [
    { key: 'inspector', label: 'GGUF 检查器', icon: <FileSearch size={14} /> },
    { key: 'tokenizer', label: 'Token 可视化', icon: <Hash size={14} /> },
    { key: 'fit', label: '显存计算器', icon: <MemoryStick size={14} /> },
    { key: 'compare', label: '模型对比', icon: <GitCompare size={14} /> },
    { key: 'template', label: '模板分析', icon: <FileCode2 size={14} /> },
  ]

  return (
    <div className="mtools-view">
      <div className="mtools-header">
        <Wrench size={22} />
        <h2>模型工具</h2>
        <div className="mtools-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`mtools-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      {tab === 'inspector' && <InspectorTab modelPath={modelPath} setModelPath={setModelPath} />}
      {tab === 'tokenizer' && <TokenizerTab modelPath={modelPath} setModelPath={setModelPath} />}
      {tab === 'fit' && <FitTab modelPath={modelPath} setModelPath={setModelPath} />}
      {tab === 'compare' && <CompareTab />}
      {tab === 'template' && <TemplateTab modelPath={modelPath} setModelPath={setModelPath} />}
    </div>
  )
}
