import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Terminal, Gauge, Loader2, Cpu, Zap, HardDrive, BarChart3, Play, Square, ChevronDown, History, Trash2, Trophy } from 'lucide-react'
import CustomSelect from './CustomSelect'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList } from 'recharts'
import '../styles/benchmark.css'

type BenchMode = 'quick' | 'stress' | 'ppl'

interface LogEntry { stream: string; text: string }

interface BenchTestResult {
  model_filename: string; model_type: string; model_size: number; model_n_params: number
  n_batch: number; n_threads: number; n_gpu_layers: number; gpu_info: string
  n_prompt: number; n_gen: number; avg_ts: number; stddev_ts: number; avg_ns: number; stddev_ns: number
}

interface ParsedBenchResult {
  prompt: BenchTestResult | null
  generation: BenchTestResult | null
  modelInfo: { name: string; type: string; sizeGB: number; nParams: number; gpu: string; threads: number }
}

function parseJsonOutput(text: string): ParsedBenchResult | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const items = JSON.parse(text.substring(start, end + 1)) as Record<string, unknown>[]
    if (!Array.isArray(items) || items.length === 0 || !items[0].model_filename) return null
    const first = items[0]
    const prompt = items.find(t => Number(t.n_prompt) > 0 && Number(t.n_gen) === 0)
    const generation = items.find(t => Number(t.n_prompt) === 0 && Number(t.n_gen) > 0)
    const fallback = items.find(t => Number(t.n_prompt) > 0 && Number(t.n_gen) > 0)
    return {
      prompt: prompt ? (prompt as unknown as BenchTestResult) : null,
      generation: generation ? (generation as unknown as BenchTestResult) : (fallback as unknown as BenchTestResult) || null,
      modelInfo: {
        name: String(first.model_filename || ''),
        type: String(first.model_type || ''),
        sizeGB: Number(first.model_size) / (1024 * 1024 * 1024),
        nParams: Number(first.model_n_params) || 0,
        gpu: String(first.gpu_info || ''),
        threads: Number(first.n_threads) || 0,
      }
    }
  } catch { return null }
}

// ── 困惑度评测（llama-perplexity）：解析 "Final estimate: PPL = X +/- Y" 与逐块 "[1]v,[2]v" ──
interface PplResult { value: number; err: number | null; chunks: number[] }

function parsePplOutput(text: string): PplResult | null {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '')
  const m = clean.match(/Final estimate:\s*PPL\s*=\s*([\d.]+)(?:\s*\+\/-\s*([\d.]+))?/)
  if (!m) return null
  const chunks: number[] = []
  const re = /\[(\d+)\]([\d.]+)/g
  let cm: RegExpExecArray | null
  while ((cm = re.exec(clean)) !== null) chunks.push(parseFloat(cm[2]))
  return { value: parseFloat(m[1]), err: m[2] ? parseFloat(m[2]) : null, chunks }
}

function pplRating(ppl: number): { label: string; color: string } {
  if (ppl < 7) return { label: '极佳', color: '#22c55e' }
  if (ppl < 10) return { label: '优秀', color: '#16a34a' }
  if (ppl < 15) return { label: '良好', color: '#eab308' }
  if (ppl < 25) return { label: '一般', color: '#f97316' }
  return { label: '较差', color: '#ef4444' }
}

// 从失败日志中提取可读的失败原因（如语料 token 数不足），返回 null 表示无已知模式
function explainPplFailure(log: string): string | null {
  const plain = log.replace(/\u001b\[[0-9;]*m/g, '')
  const haveM = plain.match(/the data file you provided tokenizes to only (\d+) tokens/)
  const needM = plain.match(/you need at least (\d+) tokens to evaluate perplexity with a context of (\d+)/)
  if (haveM && needM) {
    const have = parseInt(haveM[1], 10)
    const ctx = parseInt(needM[2], 10)
    const maxCtx = Math.max(Math.floor(have / 2) - (Math.floor(have / 2) % 32), 32)
    return `语料不足：当前语料仅分词出 ${have} tokens，上下文 ${ctx} 时评测困惑度至少需要 ${needM[1]} tokens。请更换更大的语料文件（建议数百 KB 以上，官方 wiki.test.raw 可横向对比），或将「上下文」调低到 ${maxCtx} 再试`
  }
  if (/failed to open file/i.test(plain)) return '语料文件无法打开：文件可能已被移动或删除'
  if (/unable to load model|failed to load model/i.test(plain)) return '模型加载失败：请检查模型文件是否有效'
  return null
}

// ── 困惑度对比图（recharts 柱状图）的数据行 ──
interface PplChartRow { model: string; short: string; ppl: number; backend: string; count: number; ts: number }

// 悬停提示框：完整模型名 + 评级 + 后端与评测次数
function PplTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PplChartRow }> }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  const rating = pplRating(r.ppl)
  return (
    <div className="benchmark-ppl-tooltip">
      <div className="benchmark-ppl-tooltip-name">
        {r.model}
        {r.count > 1 && <span>（{r.count} 次评测取最低）</span>}
      </div>
      <div className="benchmark-ppl-tooltip-val">PPL <b style={{ color: rating.color }}>{r.ppl.toFixed(2)}</b><span className="benchmark-ppl-tooltip-pill" style={{ color: rating.color, borderColor: rating.color }}>{rating.label}</span></div>
      <div className="benchmark-ppl-tooltip-sub">{r.backend} · {new Date(r.ts).toLocaleString('zh-CN')}</div>
    </div>
  )
}

// ── 三种测试模式的文案元信息（页签标签 + 面板导语）──
const MODE_META: Record<BenchMode, { label: string; title: string; desc: string }> = {
  quick: {
    label: '快速跑分',
    title: '单流速度基线',
    desc: '用 llama-bench 分别测量提示词处理（pp）与 Token 生成（tg）的速度。换量化、调 GPU 卸载层数之后先跑这一项，是判断「快不快」的第一参考。',
  },
  stress: {
    label: '压力测试',
    title: '并发吞吐表现',
    desc: '用 llama-batched-bench 模拟多个请求同时到达，观察并发下的整体吞吐是否还能站得住。适合评估「多人同时用」时的体验下限。',
  },
  ppl: {
    label: '困惑度评测',
    title: '模型质量评分',
    desc: '用 llama-perplexity 对真实语料计算困惑度（PPL），数值越低代表模型的预测越贴近文本本身。和基准速度互补：一个回答「多快」，一个回答「损失了多少质量」。',
  },
}

function convertStoredResult(stored: { prompt: Record<string, unknown> | null; generation: Record<string, unknown> | null; modelInfo: Record<string, unknown> }): ParsedBenchResult {
  return {
    prompt: stored.prompt ? (stored.prompt as unknown as BenchTestResult) : null,
    generation: stored.generation ? (stored.generation as unknown as BenchTestResult) : null,
    modelInfo: stored.modelInfo as unknown as ParsedBenchResult['modelInfo'],
  }
}

function formatParams(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return String(n)
}

// ── 历史结果：快速跑分的横向对比（localStorage 持久化，上限 20 条）──
interface BenchHistoryEntry {
  ts: number
  model: string
  quant: string
  backend: string
  ngl: number
  threads: number
  batch: number
  ppTokS: number | null
  tgTokS: number | null
  ppl: number | null
  ctx?: number
}

const BENCH_HISTORY_KEY = 'llama-studio-bench-history'
const BENCH_HISTORY_MAX = 20

function loadBenchHistory(): BenchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(BENCH_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function saveBenchHistory(list: BenchHistoryEntry[]): void {
  try { localStorage.setItem(BENCH_HISTORY_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

function speedRating(tokPerS: number, nParams: number): { label: string; color: string; ratio: number } {
  const ratio = tokPerS / Math.max(nParams / 1_000_000_000, 0.1)
  if (ratio > 100) return { label: '极速', color: '#22c55e', ratio }
  if (ratio > 50) return { label: '优秀', color: '#16a34a', ratio }
  if (ratio > 20) return { label: '良好', color: '#eab308', ratio }
  if (ratio > 10) return { label: '一般', color: '#f97316', ratio }
  return { label: '较慢', color: '#ef4444', ratio }
}

function AnimatedBar({ score, color }: { score: number; color: string }) {
  const [w, setW] = useState(0)
  useEffect(() => { requestAnimationFrame(() => setW(Math.min(score, 100))) }, [score])
  const display = Math.round(Math.min(score, 100))
  return (
    <div className="benchmark-speed-bar-row">
      <div className="benchmark-bar-container">
        <div className="benchmark-bar-fill" style={{ width: `${w}%`, background: color }} />
      </div>
      <span
        className="benchmark-bar-score"
        style={{ color }}
      >{display}</span>
    </div>
  )
}

export default function BenchmarkView() {
  const { backends, models, benchmarkResult, setBenchmarkResult } = useStore(
    s => ({ backends: s.backends, models: s.models, benchmarkResult: s.benchmarkResult, setBenchmarkResult: s.setBenchmarkResult }),
    shallow
  )

  const [mode, setMode] = useState<BenchMode>((benchmarkResult?.mode as BenchMode) || 'quick')
  const [selectedBackend, setSelectedBackend] = useState(benchmarkResult?.selectedBackend || '')
  const [selectedModel, setSelectedModel] = useState(benchmarkResult?.selectedModel || '')
  const [threads, setThreads] = useState(8)
  const [batchSize, setBatchSize] = useState(512)
  const [nTokens, setNTokens] = useState(128)
  const [nPrompt, setNPrompt] = useState(512)
  const [ngl, setNgl] = useState(99)
  const [concurrent, setConcurrent] = useState(4)
  const [nRequests, setNRequests] = useState(50)
  const [pplCorpus, setPplCorpus] = useState<{ path: string; name: string } | null>(null)
  const [pplCtx, setPplCtx] = useState(512)
  const [pplChunks, setPplChunks] = useState(2)
  const [pplResult, setPplResult] = useState<PplResult | null>(null)
  const [history, setHistory] = useState<BenchHistoryEntry[]>(() => loadBenchHistory())

  // ── 困惑度对比图：按模型聚合历史 PPL（同模型多次取最低值），升序 = 越好的排越前 ──
  const pplChart = useMemo<PplChartRow[]>(() => {
    const byModel = new Map<string, { model: string; ppl: number; backend: string; count: number; ts: number }>()
    for (const h of history) {
      if (h.ppl === null) continue
      const prev = byModel.get(h.model)
      if (!prev) byModel.set(h.model, { model: h.model, ppl: h.ppl, backend: h.backend, count: 1, ts: h.ts })
      else {
        prev.count++
        if (h.ppl < prev.ppl) { prev.ppl = h.ppl; prev.backend = h.backend; prev.ts = h.ts }
      }
    }
    return [...byModel.values()]
      .sort((a, b) => a.ppl - b.ppl)
      .map(r => ({ ...r, short: r.model.length > 18 ? r.model.slice(0, 17) + '…' : r.model }))
  }, [history])
  // 历史按类型拆分：速度类（快速/压力）与困惑度各自成表，避免互相空列
  const speedHistory = useMemo(() => history.filter(h => h.ppl === null), [history])
  const pplHistory = useMemo(() => history.filter(h => h.ppl !== null), [history])
  const [running, setRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [configCollapsed, setConfigCollapsed] = useState(false)
  // 日志收起状态持久化：切换视图/重启后保持上次状态
  const [logCollapsed, setLogCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('llama-studio-bench-log-collapsed') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('llama-studio-bench-log-collapsed', logCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [logCollapsed])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [parsed, setParsed] = useState<ParsedBenchResult | null>(null)
  const [summary, setSummary] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const benchIdRef = useRef<string>('')
  const logsRef = useRef<LogEntry[]>([])

  useEffect(() => {
    if (!benchmarkResult || !benchmarkResult.showResults) return
    setShowResults(true)
    if (benchmarkResult.mode === 'quick' && benchmarkResult.parsed) {
      setParsed(convertStoredResult(benchmarkResult.parsed))
    }
    if (benchmarkResult.mode === 'ppl' && benchmarkResult.ppl) {
      setPplResult(benchmarkResult.ppl)
    }
    if (benchmarkResult.summary.length > 0) {
      setSummary(benchmarkResult.summary)
    }
  }, [])

  const activeBackend = backends.find(b => b.name === selectedBackend)
  const benchExe = mode === 'quick' ? 'llama-bench.exe' : mode === 'ppl' ? 'llama-perplexity.exe' : 'llama-batched-bench.exe'
  const modeLabel = mode === 'quick' ? '快速跑分' : mode === 'stress' ? '压力测试' : '困惑度评测'
  const hasBenchExe = !!activeBackend?.path

  useEffect(() => {
    if (backends.length > 0 && !selectedBackend) setSelectedBackend(backends[0].name)
  }, [backends, selectedBackend])
  useEffect(() => {
    if (models.length > 0 && !selectedModel) setSelectedModel(models[0].path)
  }, [models, selectedModel])

  // 离开视图时终止仍在运行的测试进程，避免后台残留（如困惑度长任务）
  useEffect(() => {
    return () => {
      if (benchIdRef.current) void window.api.stopBenchmark(benchIdRef.current)
    }
  }, [])

  useEffect(() => {
    if (!running) return
    window.api.onBenchmarkLog((data) => {
      if (data.id !== benchIdRef.current) return
      const entry = { stream: data.stream, text: data.text }
      logsRef.current = [...logsRef.current, entry]
      setLogs(prev => [...prev, entry])
    })
    window.api.onBenchmarkDone((data) => {
      if (data.id !== benchIdRef.current) return
      setRunning(false)
      const fullLog = logsRef.current.map(l => l.text).join('\n')
      if (mode === 'ppl') {
        const r = parsePplOutput(fullLog)
        if (!r) {
          const reason = explainPplFailure(fullLog)
          const entry = { stream: 'stderr', text: reason || '未在输出中找到 PPL 结果（评测可能失败或被中断）' }
          logsRef.current = [...logsRef.current, entry]
          setLogs(prev => [...prev, entry])
          return
        }
        setPplResult(r)
        const entry: BenchHistoryEntry = {
          ts: Date.now(),
          model: selectedModel.split(/[\\/]/).pop() || selectedModel,
          quant: selectedModelInfo?.name || '',
          backend: selectedBackend,
          ngl,
          threads: 0,
          batch: 0,
          ppTokS: null,
          tgTokS: null,
          ppl: r.value,
          ctx: pplCtx,
        }
        setHistory(prev => {
          const next = [entry, ...prev].slice(0, BENCH_HISTORY_MAX)
          saveBenchHistory(next)
          return next
        })
        setBenchmarkResult({
          mode: 'ppl',
          parsed: null,
          summary: [`PPL = ${r.value}${r.err !== null ? ` ± ${r.err}` : ''}（${r.chunks.length} chunks · ctx ${pplCtx}）`],
          showResults: true,
          selectedBackend,
          selectedModel,
          ppl: r,
        })
      } else if (mode === 'quick') {
        const result = parseJsonOutput(fullLog)
        if (result) {
          setParsed(result)
          // 追加历史记录（参数优先取实测结果里的真实值）
          const entry: BenchHistoryEntry = {
            ts: Date.now(),
            model: result.modelInfo.name.split(/[\\/]/).pop() || result.modelInfo.name,
            quant: result.modelInfo.type,
            backend: selectedBackend,
            ngl: result.prompt?.n_gpu_layers ?? result.generation?.n_gpu_layers ?? ngl,
            threads: result.modelInfo.threads,
            batch: result.prompt?.n_batch ?? result.generation?.n_batch ?? batchSize,
            ppTokS: result.prompt ? result.prompt.avg_ts : null,
            tgTokS: result.generation ? result.generation.avg_ts : null,
            ppl: null,
          }
          setHistory(prev => {
            const next = [entry, ...prev].slice(0, BENCH_HISTORY_MAX)
            saveBenchHistory(next)
            return next
          })
          setBenchmarkResult({
            mode: 'quick',
            parsed: { prompt: result.prompt as unknown as Record<string, unknown> | null, generation: result.generation as unknown as Record<string, unknown> | null, modelInfo: result.modelInfo as unknown as Record<string, unknown> },
            summary: [],
            showResults: true,
            selectedBackend,
            selectedModel,
          })
        }
      } else {
        const s = fullLog.split('\n').filter(l => {
          const t = l.trim()
          return t && (t.includes('avg time') || t.includes('peak memory') || t.includes('TTFT') || t.includes('TPOT') || t.includes('throughput') || t.includes('tokens/s') || t.includes('batched'))
        })
        setSummary(s)
        setBenchmarkResult({
          mode: 'stress',
          parsed: null,
          summary: s,
          showResults: true,
          selectedBackend,
          selectedModel,
        })
      }
    })
    window.api.onBenchmarkError((data) => {
      if (data.id !== benchIdRef.current) return
      setRunning(false)
      const entry = { stream: 'stderr', text: `错误: ${data.error}` }
      logsRef.current = [...logsRef.current, entry]
      setLogs(prev => [...prev, entry])
    })
    return () => {
      window.api.removeBenchmarkLogListener()
      window.api.removeBenchmarkDoneListener()
      window.api.removeBenchmarkErrorListener()
    }
  }, [running, mode])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])
  useEffect(() => { if (parsed && resultRef.current) setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100) }, [parsed])

  async function handlePickCorpus() {
    const r = await window.api.selectFiles()
    const p = r.paths?.[0]
    if (p) setPplCorpus({ path: p, name: p.split(/[\\/]/).pop() || p })
  }

  async function handleRun() {
    if (!activeBackend || !selectedModel) return
    if (running) return
    if (mode === 'ppl' && !pplCorpus) return
    const id = crypto.randomUUID()
    benchIdRef.current = id
    logsRef.current = []
    setRunning(true); setShowResults(true); setLogs([]); setParsed(null); setSummary([]); setPplResult(null); setBenchmarkResult(null); setConfigCollapsed(true)
    const args: string[] = ['-m', selectedModel]
    if (mode === 'quick') {
      args.push('-o', 'json')
      args.push('-t', String(threads), '-b', String(batchSize), '-n', String(nTokens), '-p', String(nPrompt), '-ngl', String(ngl))
    } else if (mode === 'stress') {
      args.push('-c', String(concurrent), '-r', String(nRequests), '-n', String(nTokens), '-b', String(batchSize), '-ngl', String(ngl))
    } else {
      args.push('-f', pplCorpus!.path, '-c', String(pplCtx), '--chunks', String(pplChunks), '-ngl', String(ngl))
    }
    const res = await window.api.runBenchmark({ id, backendPath: activeBackend.path, exe: benchExe, args })
    if (!res.success) {
      const entry = { stream: 'stderr', text: `启动失败: ${res.error}` }
      logsRef.current = [entry]; setLogs([entry]); setRunning(false)
    }
  }

  async function handleStop() {
    if (!benchIdRef.current) return
    await window.api.stopBenchmark(benchIdRef.current)
    setRunning(false)
    setLogs(prev => [...prev, { stream: 'stdout', text: '--- 测试已手动停止 ---' }])
  }

  const mi = parsed?.modelInfo
  const pt = parsed?.prompt
  const gt = parsed?.generation

  const selectedModelInfo = models.find(m => m.path === selectedModel)
  const collapsedSummary = `${modeLabel} · ${selectedBackend || '—'} · ${selectedModelInfo?.name || '未选择模型'}`

  const testBatch = pt?.n_batch ?? gt?.n_batch ?? batchSize
  const testPrompt = pt?.n_prompt ?? nPrompt
  const testGen = gt?.n_gen ?? nTokens

  return (
    <div className="benchmark-view">
      <header className="page-header benchmark-header">
        <div>
          <h1 className="page-title">性能基准测试</h1>
          <p className="page-subtitle">
            速度、并发与质量三个维度，全部由本地后端实测——不联网、不上传，数据只属于这台机器。
          </p>
        </div>
        <div className="page-actions">
          {running && (
            <span className="benchmark-running-chip">
              <Loader2 size={13} className="benchmark-spinner" />
              测试进行中
            </span>
          )}
        </div>
      </header>

      <nav className="benchmark-mode-tabs" role="tablist" aria-label="测试模式">
        {(['quick', 'stress', 'ppl'] as BenchMode[]).map(m => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`benchmark-mode-tab ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
            disabled={running}
          >
            {MODE_META[m].label}
          </button>
        ))}
      </nav>

      <section className="benchmark-mode-intro">
        <h2 className="benchmark-mode-title">{MODE_META[mode].title}</h2>
        <p className="benchmark-mode-desc">{MODE_META[mode].desc}</p>
      </section>

      <div className="benchmark-config">
        <button
          className="benchmark-config-toggle"
          onClick={() => setConfigCollapsed(c => !c)}
          aria-expanded={!configCollapsed}
        >
          <ChevronDown size={16} className={`benchmark-chevron ${configCollapsed ? 'collapsed' : ''}`} />
          <span className="benchmark-config-toggle-title">测试配置</span>
          <span className="benchmark-config-toggle-summary">{collapsedSummary}</span>
        </button>
        <div className={`benchmark-config-body-wrapper ${configCollapsed ? 'collapsed' : ''}`}>
          <div className="benchmark-config-body">
            <div className="benchmark-config-row-split">
              <div className="benchmark-config-row">
                <label>后端版本</label>
                <CustomSelect
                  className="benchmark-select-wrapper"
                  buttonClass="benchmark-select-button"
                  value={selectedBackend}
                  onChange={setSelectedBackend}
                  options={backends.map(b => ({ value: b.name, label: b.name }))}
                  disabled={running}
                  aria-label="后端版本"
                />
              </div>
              <div className="benchmark-config-row">
                <label>模型文件</label>
                <CustomSelect
                  className="benchmark-select-wrapper"
                  buttonClass="benchmark-select-button"
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={models.map(m => ({ value: m.path, label: `${m.name} (${m.folder})` }))}
                  disabled={running}
                  aria-label="模型文件"
                />
              </div>
            </div>
            <div className="benchmark-config-params">
              {mode === 'quick' ? (                <>
                  <div className="benchmark-param">
                    <label>线程数</label>
                    <input type="number" value={threads} min={1} max={64} onChange={e => setThreads(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>批次大小</label>
                    <input type="number" value={batchSize} min={1} max={4096} onChange={e => setBatchSize(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>提示长度</label>
                    <input type="number" value={nPrompt} min={1} max={8192} onChange={e => setNPrompt(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>生成 Token</label>
                    <input type="number" value={nTokens} min={1} max={4096} onChange={e => setNTokens(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>GPU 卸载层 (-ngl)</label>
                    <input type="number" value={ngl} min={0} max={999} onChange={e => setNgl(parseInt(e.target.value) || 0)} disabled={running} />
                  </div>
                </>
              ) : mode === 'stress' ? (
                <>
                  <div className="benchmark-param">
                    <label>并发请求</label>
                    <input type="number" value={concurrent} min={1} max={128} onChange={e => setConcurrent(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>总请求数</label>
                    <input type="number" value={nRequests} min={1} max={100000} onChange={e => setNRequests(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>生成 Token</label>
                    <input type="number" value={nTokens} min={1} max={4096} onChange={e => setNTokens(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>批次大小</label>
                    <input type="number" value={batchSize} min={1} max={4096} onChange={e => setBatchSize(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>GPU 卸载层 (-ngl)</label>
                    <input type="number" value={ngl} min={0} max={999} onChange={e => setNgl(parseInt(e.target.value) || 0)} disabled={running} />
                  </div>
                </>
              ) : (
                <>
                  <div className="benchmark-param benchmark-param-wide">
                    <label>评测语料文件</label>
                    <button className="benchmark-btn benchmark-btn-stop" onClick={handlePickCorpus} disabled={running}>
                      {pplCorpus ? pplCorpus.name : '选择语料 (.txt / .raw)'}
                    </button>
                  </div>
                  <div className="benchmark-param">
                    <label>上下文 (-c)</label>
                    <input type="number" value={pplCtx} min={256} max={32768} onChange={e => setPplCtx(parseInt(e.target.value) || 512)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>分块数 (--chunks)</label>
                    <input type="number" value={pplChunks} min={1} max={512} onChange={e => setPplChunks(parseInt(e.target.value) || 1)} disabled={running} />
                  </div>
                  <div className="benchmark-param">
                    <label>GPU 卸载层 (-ngl)</label>
                    <input type="number" value={ngl} min={0} max={999} onChange={e => setNgl(parseInt(e.target.value) || 0)} disabled={running} />
                  </div>
                </>
              )}
            </div>
            <div className="benchmark-config-actions">
              <button className="benchmark-btn benchmark-btn-run" onClick={handleRun} disabled={running || !hasBenchExe || !selectedModel || (mode === 'ppl' && !pplCorpus)}>
                <Play size={14} /> 开始测试
              </button>
              <button className="benchmark-btn benchmark-btn-stop" onClick={handleStop} disabled={!running}>
                <Square size={14} /> 停止
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="benchmark-body">
        {showResults && (
          <div className="benchmark-results-area" ref={resultRef}>
            <div className="benchmark-model-card">
              {mi ? (
                <>
                  <div className="benchmark-model-card-row">
                    <HardDrive size={18} />
                    <span className="benchmark-model-name">{mi.name.split('\\').pop()?.split('/').pop() || mi.name}</span>
                    <span className="benchmark-model-type-hint">架构类型</span>
                    <span className="benchmark-model-badge">{mi.type}</span>
                  </div>
                  <div className="benchmark-model-card-meta">
                    <span><strong>{mi.sizeGB.toFixed(2)} GB</strong> 大小</span>
                    <span><strong>{formatParams(mi.nParams)}</strong> 参数</span>
                    <span><strong>{mi.gpu || 'N/A'}</strong> GPU</span>
                    <span className="benchmark-model-card-params-label">测试参数</span>
                    <span><strong>{mi.threads}</strong> 线程</span>
                    <span><strong>{testBatch}</strong> 批次大小</span>
                    <span><strong>{testPrompt}</strong> 提示长度</span>
                    <span><strong>{testGen}</strong> 生成 Token</span>
                  </div>
                </>
              ) : (
                <div className="benchmark-model-card-row">
                  <HardDrive size={18} />
                  <span className="benchmark-model-name">{mode === 'ppl' && !running ? `${selectedModel.split(/[\\/]/).pop() || ''} · 评测完成` : '正在测试...'}</span>
                </div>
              )}
            </div>

            {mode !== 'ppl' && (
            <div className="benchmark-speed-cards">
              {parsed && mi ? (
                <>
                  {pt && (() => {
                    const r = speedRating(pt.avg_ts, mi.nParams)
                    return (
                      <div className="benchmark-speed-card" key="prompt">
                        <div className="benchmark-speed-card-header">
                          <Zap size={18} style={{ color: r.color }} />
                          <span>提示词处理</span>
                          <span className="benchmark-rating" style={{ background: r.color }}>{r.label}</span>
                          <span className="benchmark-speed-value-group">
                            <span className="benchmark-speed-value" style={{ color: r.color }}>{pt.avg_ts.toFixed(2)}</span>
                            <span className="benchmark-speed-unit">tok/s</span>
                          </span>
                        </div>
                        <div className="benchmark-speed-card-footer">
                          <AnimatedBar score={Math.min(r.ratio, 100)} color={r.color} />
                          <div className="benchmark-speed-card-detail">
                            <span>{pt.n_prompt} tokens · {(pt.avg_ns / 1_000_000).toFixed(1)} ms</span>
                            <span>±{pt.stddev_ts.toFixed(2)} tok/s</span>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  {gt && (() => {
                    const r = speedRating(gt.avg_ts, mi.nParams)
                    return (
                      <div className="benchmark-speed-card" key="gen">
                        <div className="benchmark-speed-card-header">
                          <Cpu size={18} style={{ color: r.color }} />
                          <span>Token 生成</span>
                          <span className="benchmark-rating" style={{ background: r.color }}>{r.label}</span>
                          <span className="benchmark-speed-value-group">
                            <span className="benchmark-speed-value" style={{ color: r.color }}>{gt.avg_ts.toFixed(2)}</span>
                            <span className="benchmark-speed-unit">tok/s</span>
                          </span>
                        </div>
                        <div className="benchmark-speed-card-footer">
                          <AnimatedBar score={Math.min(r.ratio, 100)} color={r.color} />
                          <div className="benchmark-speed-card-detail">
                            <span>{gt.n_gen} tokens · {(gt.avg_ns / 1_000_000).toFixed(1)} ms</span>
                            <span>±{gt.stddev_ts.toFixed(2)} tok/s</span>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  {pt && gt && (() => {
                    const totalTokens = pt.n_prompt + gt.n_gen
                    const totalNs = pt.avg_ns + gt.avg_ns
                    const overallTokS = totalTokens / (totalNs / 1_000_000_000)
                    const ratio = pt.avg_ts / gt.avg_ts
                    const r = speedRating(overallTokS, mi.nParams)
                    return (
                      <div className="benchmark-speed-card" key="overall">
                        <div className="benchmark-speed-card-header">
                          <BarChart3 size={18} style={{ color: '#8b5cf6' }} />
                          <span>综合吞吐</span>
                          <span className="benchmark-rating" style={{ background: r.color }}>{r.label}</span>
                          <span className="benchmark-speed-value-group">
                            <span className="benchmark-speed-value" style={{ color: '#8b5cf6' }}>{overallTokS.toFixed(2)}</span>
                            <span className="benchmark-speed-unit">tok/s</span>
                          </span>
                        </div>
                        <div className="benchmark-speed-card-footer">
                          <div className="benchmark-stat-row">
                            <div><div className="benchmark-stat-number">{totalTokens}</div><div className="benchmark-stat-label">总 tokens</div></div>
                            <div><div className="benchmark-stat-number">{(totalNs / 1_000_000).toFixed(0)}</div><div className="benchmark-stat-label">总耗时 (ms)</div></div>
                            <div><div className="benchmark-stat-number">{ratio.toFixed(0)}x</div><div className="benchmark-stat-label">提示词/生成比</div></div>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </>
              ) : mode === 'quick' && (
                <div className="benchmark-speed-card benchmark-speed-card-placeholder">
                  <div className="benchmark-speed-card-header">
                    {running ? <Loader2 size={18} className="benchmark-spinner" /> : <Zap size={18} />}
                    <span>{running ? '测试进行中，等待结果...' : '暂无跑分结果 · 配置参数后点击「开始测试」'}</span>
                  </div>
                </div>
              )}
            </div>
            )}
            {mode === 'ppl' && (
              <div className="benchmark-speed-cards">
                {pplResult && (() => {
                  const r = pplRating(pplResult.value)
                  return (
                    <div className="benchmark-speed-card">
                      <div className="benchmark-speed-card-header">
                        <Gauge size={18} style={{ color: r.color }} />
                        <span>困惑度 (Perplexity)</span>
                        <span className="benchmark-rating" style={{ background: r.color }}>{r.label}</span>
                        <span className="benchmark-speed-value-group">
                          <span className="benchmark-speed-value" style={{ color: r.color }}>{pplResult.value.toFixed(2)}</span>
                          <span className="benchmark-speed-unit">PPL</span>
                        </span>
                      </div>
                      <div className="benchmark-speed-card-footer">
                        <div className="benchmark-stat-row">
                          <div><div className="benchmark-stat-number">{pplResult.chunks.length}</div><div className="benchmark-stat-label">分块数</div></div>
                          <div><div className="benchmark-stat-number">{pplResult.err !== null ? `±${pplResult.err}` : '—'}</div><div className="benchmark-stat-label">标准差</div></div>
                          <div><div className="benchmark-stat-number">{pplCtx}</div><div className="benchmark-stat-label">上下文</div></div>
                        </div>
                      </div>
                    </div>
                  )
                })()}
                {!pplResult && (
                  <div className="benchmark-speed-card benchmark-speed-card-placeholder">
                    <div className="benchmark-speed-card-header">
                      {running ? <Loader2 size={18} className="benchmark-spinner" /> : <Gauge size={18} />}
                      <span>{running ? '正在计算困惑度，请稍候...' : '暂无评测结果 · 选择语料后点击「开始测试」'}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {summary.length > 0 && (
          <div className="benchmark-summary">
            <h3>压力测试摘要</h3>
            {summary.map((line, i) => <div key={i} className="benchmark-summary-line">{line}</div>)}
          </div>
        )}

        {/* 历史结果对比：仅速度类条目（快速/压力）；困惑度条目归入下方专属区。最佳 pp/tg 高亮 */}
        {speedHistory.length > 0 && (
          <div className="benchmark-history">
            <div className="benchmark-history-header">
              <History size={14} />
              <span>速度历史对比（{speedHistory.length}）</span>
              <button
                className="benchmark-history-clear"
                onClick={() => setHistory(prev => { const next = prev.filter(h => h.ppl !== null); saveBenchHistory(next); return next })}
                disabled={running}
              ><Trash2 size={13} /> 清空</button>
            </div>
            <div className="benchmark-history-table">
              <div className="benchmark-history-row head">
                <span>时间</span><span>模型</span><span>量化</span><span>ngl</span><span>线程/批次</span><span>提示词 tok/s</span><span>生成 tok/s</span><span></span>
              </div>
              {(() => {
                const bestPp = Math.max(...speedHistory.map(h => h.ppTokS ?? 0))
                const bestTg = Math.max(...speedHistory.map(h => h.tgTokS ?? 0))
                return speedHistory.map(h => (
                  <div key={h.ts} className="benchmark-history-row">
                    <span>{new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span title={`${h.model} · ${h.backend}`}>{h.model}</span>
                    <span>{h.quant || '—'}</span>
                    <span>{h.ngl}</span>
                    <span>{`${h.threads} / ${h.batch}`}</span>
                    <span className={h.ppTokS !== null && h.ppTokS === bestPp && bestPp > 0 ? 'best' : ''}>{h.ppTokS !== null ? h.ppTokS.toFixed(1) : '—'}</span>
                    <span className={h.tgTokS !== null && h.tgTokS === bestTg && bestTg > 0 ? 'best' : ''}>{h.tgTokS !== null ? h.tgTokS.toFixed(1) : '—'}</span>
                    <button
                      className="benchmark-history-del"
                      onClick={() => setHistory(prev => { const next = prev.filter(x => x.ts !== h.ts); saveBenchHistory(next); return next })}
                    >✕</button>
                  </div>
                ))
              })()}
            </div>
          </div>
        )}

        {/* 困惑度跨模型对比柱状图（常驻：不依赖结果卡片，历史里有 PPL 数据就显示）*/}
        {pplChart.length > 0 && (
          <div className="benchmark-ppl-chart">
            <div className="benchmark-history-header">
              <Gauge size={14} />
              <span>困惑度对比（{pplChart.length} 个模型 · 越低越好）</span>
            </div>
            <div className="benchmark-ppl-chart-box">
              <ResponsiveContainer width="100%" height={Math.max(220, Math.min(pplChart.length * 72, 360))}>
                <BarChart data={pplChart} margin={{ top: 26, right: 16, left: -6, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,.18)" />
                  <XAxis
                    dataKey="short"
                    interval={0}
                    tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                    angle={pplChart.length > 5 ? -18 : 0}
                    textAnchor={pplChart.length > 5 ? 'end' : 'middle'}
                    height={pplChart.length > 5 ? 52 : 34}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} width={46} domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.15)]} />
                  <Tooltip content={<PplTooltip />} cursor={{ fill: 'rgba(128,128,128,.08)' }} />
                  <Bar dataKey="ppl" radius={[6, 6, 0, 0]} maxBarSize={64}>
                    {pplChart.map(r => <Cell key={r.model} fill={pplRating(r.ppl).color} />)}
                    <LabelList dataKey="ppl" position="top" formatter={(v: unknown) => Number(v).toFixed(2)} style={{ fill: 'var(--text)', fontSize: 11, fontWeight: 700 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="benchmark-ppl-chart-note"><Trophy size={12} /> 排名按最低 PPL 升序，颜色代表评级档位（绿 → 红）</div>
            </div>
            {pplHistory.length > 0 && (
              <div className="benchmark-history-table benchmark-ppl-runs">
                <div className="benchmark-history-row head ppl">
                  <span>时间</span><span>模型</span><span>量化</span><span>ngl</span><span>上下文</span><span>PPL</span>
                  <span>
                    {pplHistory.length > 1 && (
                      <button
                        className="benchmark-history-clear"
                        title="清空全部困惑度记录"
                        onClick={() => setHistory(prev => { const next = prev.filter(h => h.ppl === null); saveBenchHistory(next); return next })}
                        disabled={running}
                      ><Trash2 size={13} /></button>
                    )}
                  </span>
                </div>
                {pplHistory.map(h => (
                  <div key={h.ts} className="benchmark-history-row ppl">
                    <span>{new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span title={`${h.model} · ${h.backend}`}>{h.model}</span>
                    <span>{h.quant || '—'}</span>
                    <span>{h.ngl}</span>
                    <span>{h.ctx ?? '—'}</span>
                    <span className="best">{h.ppl?.toFixed(2)}</span>
                    <button
                      className="benchmark-history-del"
                      onClick={() => setHistory(prev => { const next = prev.filter(x => x.ts !== h.ts); saveBenchHistory(next); return next })}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="benchmark-log-header"
          onClick={() => setLogCollapsed(c => !c)}
          aria-expanded={!logCollapsed}
        >
          <ChevronDown size={14} className={`benchmark-chevron ${logCollapsed ? 'collapsed' : ''}`} />
          <Terminal size={14} />
          <span>运行日志</span>
          {logs.length > 0 && <span className="benchmark-log-count">{logs.length}</span>}
          {running && <Loader2 size={14} className="benchmark-spinner" />}
        </button>
        <div className={`benchmark-log-wrapper ${logCollapsed ? 'collapsed' : ''}`}>
          <div className="benchmark-log-inner">
            <div className="benchmark-log" ref={logRef}>
              {logs.length === 0 && !running && <div className="benchmark-log-placeholder">配置参数后点击"开始测试"运行基准测试</div>}
              {logs.map((entry, i) => <div key={i} className={`benchmark-log-line benchmark-log-${entry.stream}`}>{entry.text}</div>)}
              {running && <div className="benchmark-log-cursor">▋</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
