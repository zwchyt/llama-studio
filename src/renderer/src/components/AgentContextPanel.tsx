import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { AgentProject, AgentSession } from '../../../shared/types'
import { estimateTextTokens, coveredPrefixCount } from '../utils/contextBudget'
import { estimateContextMeasured } from '../utils/contextBreakdown'
import { useBubbleTip } from './useBubbleTip'

interface AgentContextPanelProps {
  templateId: string | null   // 正在运行的模型模板 id（用于查 metrics）；未启动为 null
  startedAt?: number         // 模型启动时间，用于运行时间统计
  requests: number           // 本会话累计请求数（渲染层当前恒为 0，有值才显示）
  cumTokens: number          // 本会话累计 tokens（同上）
  session?: AgentSession     // 当前会话（用于估算上下文构成与增长）
  project?: AgentProject      // 当前项目（系统提示 / 知识库来源）
  onClose?: () => void
}

const COMPRESS_THRESHOLD = 0.8   // 压缩阈值参考线（本地 LLM 仅作警告，不改变行为）
const GROWTH_POINTS = 12         // 增长柱状图最多显示的轮数
const TOOL_ROWS = 6              // 工具占用默认显示条数

/** 压缩记录触发来源文案：与压缩卡片同一套口径（那份在 AgentCodeViewLayout，此处独立以免循环依赖） */
const COMPACT_REASON_LABEL: Record<string, string> = {
  manual: '手动',
  threshold: '自动 · 水位',
  overflow: '自动 · 溢出',
}

// 运行时间格式化为 HH:MM:SS
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':')
}

/** token 数的紧凑写法：1.42M / 78.4k / 840 */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 10_000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n).toLocaleString()
}

/** 压缩记录只要「时:分」 */
function fmtClock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export default function AgentContextPanel({ templateId, startedAt, requests, cumTokens, session, project, onClose }: AgentContextPanelProps) {
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()
  const metrics = useStore(s => (templateId ? s.modelMetrics[templateId] : undefined))
  const template = useStore(s => (templateId ? s.cards.find(c => c.template.id === templateId)?.template : undefined))
  const gradId = useId().replace(/:/g, '')
  // 仅用 setter 每秒触发一次重渲染以刷新运行时间；tick 值本身不参与渲染，故跳过声明
  const [, setTick] = useState(0)

  // 运行时间需要每秒刷新
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  // 上下文占用数据来自模型服务端 metrics（self-dev 真相源），而非 Pi：Pi 仅作运行时，
  // 其自动压缩已禁用（index.ts compaction.enabled=false），真实上下文由自研 memory/summary
  // 注入历史决定。因此这里读 modelMetrics.nPromptTokens 即为当前真实 KV 占用，不应改成读 Pi
  // 的 turn_end.usage（那只是单轮 token，非会话级上下文）。
  const nCtx = metrics?.nCtx || 0
  const used = metrics?.nPromptTokens || 0
  const cache = metrics?.nPromptTokensCache || 0
  const hitRate = used > 0 ? (cache / used) * 100 : 0
  const pct = nCtx > 0 ? Math.min(100, (used / nCtx) * 100) : 0
  const warning = pct >= COMPRESS_THRESHOLD * 100
  const toCompress = Math.max(0, Math.floor(nCtx * COMPRESS_THRESHOLD) - used)
  const uptime = startedAt ? fmtDuration(Date.now() - startedAt) : '—'
  const noModel = !templateId

  // 较上轮涨幅：metrics 每两秒广播一次，但 used 只在请求之间变，所以「值变了」即「换了一轮」
  const prevUsedRef = useRef<number | null>(null)
  const [deltaPct, setDeltaPct] = useState<number | null>(null)
  useEffect(() => {
    prevUsedRef.current = null
    setDeltaPct(null)
  }, [session?.id])
  useEffect(() => {
    if (used <= 0) return
    const prev = prevUsedRef.current
    if (prev != null && prev > 0 && prev !== used) setDeltaPct(((used - prev) / prev) * 100)
    prevUsedRef.current = used
  }, [used])

  // 上下文构成：本地估算分项，再用差额对齐到真实总量（见 util 注释）
  const measured = estimateContextMeasured(session, project)
  const displayTotal = used > 0 ? used : measured.total
  const otherTok = used > 0 ? Math.max(0, used - measured.total) : 0
  const categories = useMemo<Array<{ key: string; label: string; tokens: number; color: string }>>(
    () => [
      ...measured.categories,
      { key: 'other', label: '其他（内置指引/知识库/开销）', tokens: otherTok, color: '#6b7280' },
    ],
    [measured, otherTok],
  )
  const catPct = (tokens: number) => (displayTotal > 0 ? (tokens / displayTotal) * 100 : 0)

  // 工具占用排行（含搜索与展开）
  const toolRows = useMemo(
    () => Object.entries(measured.toolByName).sort((a, b) => b[1] - a[1]),
    [measured],
  )
  const toolMax = toolRows.length ? toolRows[0]![1] : 0
  const toolTotal = useMemo(() => toolRows.reduce((a, [, v]) => a + v, 0), [toolRows])
  const [toolQuery, setToolQuery] = useState('')
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const shownTools = useMemo(() => {
    const q = toolQuery.trim().toLowerCase()
    const list = q ? toolRows.filter(([name]) => name.toLowerCase().includes(q)) : toolRows
    return q || toolsExpanded ? list : list.slice(0, TOOL_ROWS)
  }, [toolRows, toolQuery, toolsExpanded])

  // 生成速度折线：decodeTokS 是 30 点环形缓冲，直接映射成折线
  const spark = useMemo(() => {
    const vals = (metrics?.decodeTokS ?? []).filter(v => v > 0)
    if (vals.length < 2) return null
    const W = 244, H = 52, pad = 5
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    const pts = vals.map((v, i) => [
      (i / (vals.length - 1)) * W,
      H - pad - ((v - min) / span) * (H - pad * 2),
    ] as const)
    const path = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')
    return {
      line: 'M' + path,
      area: `M0,${H} L` + path + ` L${W},${H} Z`,
      last: pts[pts.length - 1]!,
      peak: max,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      now: vals[vals.length - 1]!,
    }
  }, [metrics?.decodeTokS])

  // 上下文增长：按轮累计估算，再整体缩放到真实占用，保证最后一根柱子等于真实值。
  // 依赖故意用「消息条数 / 压缩边界 / 真实占用」而不是 session 对象：流式输出时 session
  // 每来一段就换引用，跟着它算等于每帧全量重扫一遍所有消息文本。这里一轮只算一次。
  const sessionRef = useRef(session)
  sessionRef.current = session
  const msgCount = session?.messages?.length ?? 0
  const coveredCount = session?.memory?.coveredCount ?? 0
  const growth = useMemo(() => {
    const s = sessionRef.current
    const msgs = s?.messages ?? []
    if (msgs.length === 0) return null
    const start = coveredPrefixCount(s?.memory, msgs)
    const rounds: number[] = []
    let acc = 0
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i]!
      acc += estimateTextTokens(m.content || '')
      for (const tc of m.toolCalls ?? []) {
        acc += estimateTextTokens(tc.args ?? '') + estimateTextTokens(tc.result ?? '')
      }
      const next = msgs[i + 1]
      if (!next || next.role === 'user') rounds.push(acc)
    }
    const tail = rounds.slice(-GROWTH_POINTS)
    if (tail.length < 2) return null
    const est = tail[tail.length - 1] || 0
    const k = used > 0 && est > 0 ? used / est : 1
    const vals = tail.map(v => Math.round(v * k))
    let peakIdx = 0
    let peakJump = 0
    for (let i = 1; i < vals.length; i++) {
      const jump = vals[i]! - vals[i - 1]!
      if (jump > peakJump) { peakJump = jump; peakIdx = i }
    }
    return { vals, peakIdx, peakJump, startRound: rounds.length - tail.length + 1 }
  }, [msgCount, coveredCount, used])

  const compactions = session?.memory?.compactions ?? []

  return (
    <div className="agent-task-card agent-card-ctx ctxp">
      {tipNode}

      <div className="ctxp-head">
        <h2>上下文窗口</h2>
        <span className={`ctxp-pill${warning ? ' warn' : ''}`}>
          {noModel ? '未启动' : warning ? '上下文紧张' : '上下文充足'}
        </span>
        <span className="ctxp-win">{nCtx > 0 ? `${nCtx.toLocaleString()} token` : '—'}</span>
        {onClose && (
          <button className="ctxp-x" onClick={onClose} aria-label="关闭上下文窗口" type="button">×</button>
        )}
      </div>

      <div className="ctxp-body">
        <div className="ctxp-ov">
          <div className="ctxp-num">
            <b>{used.toLocaleString()}</b>
            <span>/ {nCtx.toLocaleString()} token</span>
            <em>{pct.toFixed(0)}%<small>已用</small></em>
          </div>
          <div className="ctxp-barwrap">
            <span className="ctxp-barlabel" style={{ left: `${COMPRESS_THRESHOLD * 100}%` }}>
              压缩线 {COMPRESS_THRESHOLD * 100}%
            </span>
            <div className="ctxp-bar">
              <i
                style={{
                  width: `${pct}%`,
                  background: warning
                    ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
                    : 'linear-gradient(90deg,#3b82f6,#10b981)',
                }}
              />
              <u style={{ left: `${COMPRESS_THRESHOLD * 100}%` }} />
            </div>
          </div>
          <div className="ctxp-notes">
            {noModel ? (
              <span>请先启动模型</span>
            ) : (
              <>
                <span>距压缩 <b>{toCompress.toLocaleString()}</b> token</span>
                <span>剩余 <b>{Math.max(0, 100 - Math.round(pct))}</b>% 窗口</span>
                {deltaPct != null && <span className="delta">▲ 较上轮 {deltaPct.toFixed(1)}%</span>}
                <span className="sp">{warning ? '已超压缩线' : `缓存命中 ${fmtTok(cache)}`}</span>
              </>
            )}
          </div>
        </div>

        <div className="ctxp-kpis">
          <div className="ctxp-kpi">
            <div className="lb"><span>首字延迟</span><span className="dl">上一次</span></div>
            <div className="vl">
              {metrics?.ttftMs != null ? (metrics.ttftMs / 1000).toFixed(2) : '—'}<small>s</small>
            </div>
            <div className="sb">{metrics?.ttftMs != null ? `${Math.round(metrics.ttftMs)} 毫秒` : '尚无请求'}</div>
          </div>
          <div className="ctxp-kpi">
            <div className="lb"><span>解码速度</span><span className="dl">最近 30 次</span></div>
            <div className="vl">{spark ? spark.now.toFixed(1) : '—'}<small>tok/s</small></div>
            <div className="sb">峰值 {spark ? spark.peak.toFixed(1) : '—'}</div>
          </div>
          <div className="ctxp-kpi">
            <div className="lb"><span>预填充</span><span className="dl">最近一次</span></div>
            <div className="vl">
              {metrics?.prefillTokS != null ? Math.round(metrics.prefillTokS).toLocaleString() : '—'}<small>tok/s</small>
            </div>
            <div className="sb">提示词处理速度</div>
          </div>
          <div className="ctxp-kpi">
            <div className="lb"><span>已解码</span><span className="dl">本轮</span></div>
            <div className="vl">{fmtTok(metrics?.nDecoded ?? 0)}<small>tok</small></div>
            <div className="sb">{metrics?.isProcessing ? '正在生成' : '未在生成'}</div>
          </div>
          <div className="ctxp-kpi">
            <div className="lb"><span>运行时间</span><span className="dl">模型</span></div>
            <div className="vl">{uptime}</div>
            <div className="sb">启动至今</div>
          </div>
        </div>

        <div className="ctxp-cols">
          <div className="ctxp-sec">
            <div className="ctxp-sechead">
              <h3>上下文构成</h3><span className="ctxp-chip">估算</span>
              <span className="cnt">{categories.filter(c => c.tokens > 0).length} 类</span>
            </div>

            {displayTotal > 0 ? (
              <>
                <div className="ctxp-stack">
                  {categories.map(c => (
                    <span
                      key={c.key}
                      className="ctxp-seg"
                      style={{ width: `${catPct(c.tokens)}%`, background: c.color }}
                      {...tip(`${c.label}：${c.tokens.toLocaleString()} token（${catPct(c.tokens).toFixed(0)}%）`)}
                    />
                  ))}
                </div>
                <div className="ctxp-legend">
                  {categories.map(c => (
                    <div key={c.key} className="ctxp-leg">
                      <i style={{ background: c.color }} />
                      <b>{c.label}</b>
                      <u>{c.tokens.toLocaleString()}</u>
                      <em>{catPct(c.tokens).toFixed(0)}%</em>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="ctxp-empty">暂无会话内容</div>
            )}

            {toolRows.length > 0 && (
              <>
                <div className="ctxp-subhead">
                  <span className="t">工具占用</span>
                  <input
                    className="ctxp-search"
                    value={toolQuery}
                    onChange={e => setToolQuery(e.target.value)}
                    placeholder="过滤工具…"
                    aria-label="过滤工具"
                  />
                  {toolRows.length > TOOL_ROWS && !toolQuery && (
                    <button className="ctxp-more" type="button" onClick={() => setToolsExpanded(v => !v)}>
                      {toolsExpanded ? '收起' : '展开全部'}
                    </button>
                  )}
                </div>
                <div className="ctxp-ranks">
                  {shownTools.map(([name, tok]) => (
                    <div key={name} className="ctxp-rank">
                      <b>{name}</b>
                      <span className="tk"><i style={{ width: `${toolMax > 0 ? (tok / toolMax) * 100 : 0}%` }} /></span>
                      <em>{tok.toLocaleString()}</em>
                      <s>{toolTotal > 0 ? ((tok / toolTotal) * 100).toFixed(0) : 0}%</s>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="ctxp-sec">
            <div className="ctxp-panel">
              <div className="ctxp-ph">
                <span className="t">生成速度 · 最近 30 次</span>
                <span className="v">{spark ? spark.now.toFixed(1) : '—'}<small>tok/s</small></span>
              </div>
              {spark ? (
                <svg className="ctxp-spark" viewBox="0 0 244 52" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity=".26" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path className="area" d={spark.area} style={{ fill: `url(#${gradId})` }} />
                  <path className="line" d={spark.line} />
                  <circle cx={spark.last[0]} cy={spark.last[1]} r="2.4" fill="#3b82f6" />
                </svg>
              ) : (
                <div className="ctxp-empty">还没有采样</div>
              )}
              <div className="ctxp-pf">
                <span>峰值 <b>{spark ? spark.peak.toFixed(1) : '—'}</b></span>
                <span>平均 <b>{spark ? spark.avg.toFixed(1) : '—'}</b></span>
                <span>首字 <b>{metrics?.ttftMs != null ? (metrics.ttftMs / 1000).toFixed(2) + 's' : '—'}</b></span>
                <span>预填充 <b>{metrics?.prefillTokS != null ? Math.round(metrics.prefillTokS).toLocaleString() : '—'}</b></span>
              </div>
            </div>

            <div className="ctxp-panel">
              <div className="ctxp-ph"><span className="t">缓存命中率</span></div>
              <div className="ctxp-ringrow">
                <svg width="58" height="58" viewBox="0 0 58 58">
                  <circle cx="29" cy="29" r="24" fill="none" stroke="var(--surface-hover)" strokeWidth="5.5" />
                  <circle
                    cx="29" cy="29" r="24" fill="none" stroke="#10b981" strokeWidth="5.5"
                    strokeLinecap="round" transform="rotate(-90 29 29)"
                    strokeDasharray={2 * Math.PI * 24}
                    strokeDashoffset={2 * Math.PI * 24 * (1 - Math.min(1, hitRate / 100))}
                  />
                  <text className="ctxp-ring-txt" x="29" y="28" textAnchor="middle" dominantBaseline="middle">
                    {used > 0 ? `${hitRate.toFixed(1)}%` : '—'}
                  </text>
                  <text className="ctxp-ring-sub" x="29" y="37" textAnchor="middle" dominantBaseline="middle">CACHE</text>
                </svg>
                <div className="ctxp-ringinfo">
                  <div className="a">{cache.toLocaleString()} <span>/ {used.toLocaleString()}</span></div>
                  <div className="b">未命中 {Math.max(0, used - cache).toLocaleString()}</div>
                  <div className="b">命中部分无需重新预填充</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {growth && (
          <div className="ctxp-growth">
            <div className="ctxp-sechead">
              <h3>上下文增长</h3><span className="ctxp-chip">估算</span>
              <span className="cnt">
                最近 {growth.vals.length} 轮
                {growth.peakJump > 0
                  ? ` · 第 ${growth.startRound + growth.peakIdx} 轮涨得最多（+${fmtTok(growth.peakJump)}）`
                  : ''}
              </span>
            </div>
            <div className="ctxp-gbars">
              {growth.vals.map((v, i) => (
                <div
                  key={i}
                  className={`ctxp-gbar${growth.peakJump > 0 && i === growth.peakIdx ? ' peak' : ''}`}
                  {...tip(`第 ${growth.startRound + i} 轮 · ${v.toLocaleString()} token`)}
                >
                  <i style={{ height: `${(v / Math.max(1, growth.vals[growth.vals.length - 1]!)) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="ctxp-gaxis">
              {growth.vals.map((_, i) => <span key={i}>{growth.startRound + i}</span>)}
            </div>
          </div>
        )}

        <div className="ctxp-records">
          <div className="ctxp-sechead">
            <h3>压缩记录</h3>
            <span className="cnt">共 {compactions.length} 次</span>
          </div>
          {compactions.length === 0 ? (
            <div className="ctxp-empty">尚无压缩记录</div>
          ) : (
            <>
              <div className="ctxp-rhead">
                <span>次序</span><span>时间</span><span>触发</span>
                <span className="hidecol">覆盖</span><span className="hidecol2">token 变化</span><span>结果</span>
              </div>
              {compactions.map((r, i) => (
                <div className="ctxp-rrow" key={`${r.at}-${i}`}>
                  <span className="i">第 {i + 1} 次</span>
                  <span className="tm">{fmtClock(r.at)}</span>
                  <span className="rs">{COMPACT_REASON_LABEL[r.reason] ?? r.reason}</span>
                  <span className="num hidecol">{r.ok && r.coveredCount > 0 ? `${r.coveredCount} 条` : '—'}</span>
                  <span className="chg hidecol2">
                    {r.tokensBefore != null && r.tokensAfter != null
                      ? <>{fmtTok(r.tokensBefore)}<i>→</i>{fmtTok(r.tokensAfter)}</>
                      : '—'}
                  </span>
                  {r.ok
                    ? <span className="ok">成功</span>
                    : <span className="err" {...(r.errorMessage ? tip(r.errorMessage) : {})}>失败</span>}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="ctxp-meta">
        <span>{template?.name ?? '未选择模型'}</span>
        {template?.backendVersion && (<><span className="dot" /><span>引擎 {template.backendVersion}</span></>)}
        {template?.serverPort ? (<><span className="dot" /><span>端口 {template.serverPort}</span></>) : null}
        {requests > 0 && (<><span className="dot" /><span>请求 {requests} 次</span></>)}
        {cumTokens > 0 && (<><span className="dot" /><span>累计 {fmtTok(cumTokens)}</span></>)}
        <span className="sp">运行 {uptime}</span>
      </div>
    </div>
  )
}
