import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Terminal, Gauge, Loader2, Cpu, Zap, HardDrive, BarChart3, Play, Square, ChevronDown } from 'lucide-react'
import CustomSelect from './CustomSelect'
import '../styles/benchmark.css'

type BenchMode = 'quick' | 'stress'

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
  const [concurrent, setConcurrent] = useState(4)
  const [nRequests, setNRequests] = useState(50)
  const [running, setRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [configCollapsed, setConfigCollapsed] = useState(false)
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
    if (benchmarkResult.summary.length > 0) {
      setSummary(benchmarkResult.summary)
    }
  }, [])

  const activeBackend = backends.find(b => b.name === selectedBackend)
  const benchExe = mode === 'quick' ? 'llama-bench.exe' : 'llama-batched-bench.exe'
  const hasBenchExe = !!activeBackend?.path

  useEffect(() => {
    if (backends.length > 0 && !selectedBackend) setSelectedBackend(backends[0].name)
  }, [backends, selectedBackend])
  useEffect(() => {
    if (models.length > 0 && !selectedModel) setSelectedModel(models[0].path)
  }, [models, selectedModel])

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
      if (mode === 'quick') {
        const result = parseJsonOutput(fullLog)
        if (result) {
          setParsed(result)
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

  async function handleRun() {
    if (!activeBackend || !selectedModel) return
    const id = crypto.randomUUID()
    benchIdRef.current = id
    logsRef.current = []
    setRunning(true); setShowResults(true); setLogs([]); setParsed(null); setSummary([]); setBenchmarkResult(null); setConfigCollapsed(true)
    const args: string[] = ['-m', selectedModel, '-o', 'json']
    if (mode === 'quick') {
      args.push('-t', String(threads), '-b', String(batchSize), '-n', String(nTokens), '-p', String(nPrompt))
    } else {
      args.push('-c', String(concurrent), '-r', String(nRequests), '-n', String(nTokens), '-b', String(batchSize))
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
  const collapsedSummary = `${mode === 'quick' ? '快速跑分' : '压力测试'} · ${selectedBackend || '—'} · ${selectedModelInfo?.name || '未选择模型'}`

  const testBatch = pt?.n_batch ?? gt?.n_batch ?? batchSize
  const testPrompt = pt?.n_prompt ?? nPrompt
  const testGen = gt?.n_gen ?? nTokens

  return (
    <div className="benchmark-view">
      <div className="benchmark-header">
        <Gauge size={22} />
        <h2>性能基准测试</h2>
      </div>

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
            <div className="benchmark-config-row">
              <label>测试模式</label>
              <div className="benchmark-mode-tabs">
                <button className={`benchmark-mode-tab ${mode === 'quick' ? 'active' : ''}`} onClick={() => setMode('quick')} disabled={running}>快速跑分</button>
                <button className={`benchmark-mode-tab ${mode === 'stress' ? 'active' : ''}`} onClick={() => setMode('stress')} disabled={running}>压力测试</button>
              </div>
            </div>
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
              {mode === 'quick' ? (
                <>
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
                </>
              ) : (
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
                </>
              )}
            </div>
            <div className="benchmark-config-actions">
              <button className="benchmark-btn benchmark-btn-run" onClick={handleRun} disabled={running || !hasBenchExe || !selectedModel}>
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
                  <span className="benchmark-model-name">正在测试...</span>
                </div>
              )}
            </div>

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
                    <Loader2 size={18} className="benchmark-spinner" />
                    <span>测试进行中，等待结果...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {summary.length > 0 && (
          <div className="benchmark-summary">
            <h3>压力测试摘要</h3>
            {summary.map((line, i) => <div key={i} className="benchmark-summary-line">{line}</div>)}
          </div>
        )}

        <div className="benchmark-log-header">
          <Terminal size={14} />
          <span>运行日志</span>
          {running && <Loader2 size={14} className="benchmark-spinner" />}
        </div>
        <div className="benchmark-log" ref={logRef}>
          {logs.length === 0 && !running && <div className="benchmark-log-placeholder">配置参数后点击"开始测试"运行基准测试</div>}
          {logs.map((entry, i) => <div key={i} className={`benchmark-log-line benchmark-log-${entry.stream}`}>{entry.text}</div>)}
          {running && <div className="benchmark-log-cursor">▋</div>}
        </div>
      </div>
    </div>
  )
}
