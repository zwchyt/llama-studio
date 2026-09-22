import { appendFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import type { TokenUsageEntry, TokenUsageRollupRow, TokenUsageLedger } from '../shared/types'

/**
 * Token 记账簿（与聊天记录完全解耦的独立持久化），拆成「明细流水」与「聚合结果」两层：
 *
 *   chats/state/token-usage/2026-09.jsonl   明细：每次请求一行，按月分片（单文件大小有界）
 *   chats/state/token-usage/_rollup.json    聚合：按「日期 × 小时 × 模型」预聚合，覆盖已封存月份
 *
 * 为什么拆：旧版所有记录塞一个 JSONL，读取要 readFileSync 全量 + 每行 JSON.parse + 排序，
 * 而且是**主进程同步**执行（主进程同时在转发 SSE），文件一大整个应用就会周期性卡死。
 * 拆开后读取成本只与「近两个月明细 + 聚合行数」有关，与历史请求总量无关。
 *
 * 保留窗口 = 当月 + 上月：覆盖「本周 / 上周」可能跨月的窗口，再早的月份在封存时折算进聚合。
 */

const SHARD_RE = /^(\d{4})-(\d{2})\.jsonl$/
const ROLLUP_FILE = '_rollup.json'
const TAIL_BYTES = 1024 * 1024 // 恢复 lastPromptByPort 时只读最新分片尾部，避免全量解析

let ledgerDir = ''
let currentMonth = ''
// 同端口上一次请求的完整输入 token（用于计算新增输入增量）
const lastPromptByPort = new Map<number, number>()

const pad2 = (n: number): string => String(n).padStart(2, '0')
const monthKeyOf = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}
const dayKeyOf = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const prevMonthKey = (now: number): string => {
  const d = new Date(now)
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}
const shardPath = (monthKey: string): string => join(ledgerDir, `${monthKey}.jsonl`)
const rollupPath = (): string => join(ledgerDir, ROLLUP_FILE)

/** 新增输入口径：promptDelta 优先，缺失/上下文重置时回退完整输入 */
function inTokensOf(e: TokenUsageEntry): number {
  return typeof e.promptDelta === 'number' && e.promptDelta > 0
    ? e.promptDelta
    : (typeof e.promptTokens === 'number' ? e.promptTokens : 0)
}

function listShardMonths(): string[] {
  try {
    if (!existsSync(ledgerDir)) return []
    return readdirSync(ledgerDir)
      .map(f => SHARD_RE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => `${m[1]}-${m[2]}`)
      .sort()
  } catch { return [] }
}

/** 逐行解析 JSONL；损坏行直接跳过（记账数据不值得为一行坏数据中断整次读取） */
function parseLines<T>(text: string, pick: (v: unknown) => T | null): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = pick(JSON.parse(t))
      if (v !== null) out.push(v)
    } catch { /* 跳过损坏行 */ }
  }
  return out
}

/** 旧版单文件记账簿 → 按月拆成分片后删除原文件（幂等；已有分片则不覆盖） */
function migrateLegacySingleFile(): void {
  const legacy = join(dirname(ledgerDir), 'token-usage.jsonl')
  if (!existsSync(legacy)) return
  try {
    const byMonth = new Map<string, string[]>()
    for (const line of readFileSync(legacy, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      let ts: unknown
      try { ts = (JSON.parse(t) as { ts?: unknown })?.ts } catch { continue }
      if (typeof ts !== 'number') continue
      const mk = monthKeyOf(ts)
      const arr = byMonth.get(mk)
      if (arr) arr.push(t)
      else byMonth.set(mk, [t])
    }
    for (const [mk, lines] of byMonth) {
      const p = shardPath(mk)
      if (existsSync(p)) continue
      writeFileSync(p, `${lines.join('\n')}\n`, 'utf-8')
    }
    unlinkSync(legacy)
  } catch { /* 迁移失败则保留原文件，下次启动重试 */ }
}

/** 启动恢复：只读最新分片尾部，重建 lastPromptByPort（避免重启后首个请求记成全量） */
function restoreLastPrompt(): void {
  try {
    const months = listShardMonths()
    if (!months.length) return
    const newest = shardPath(months[months.length - 1])
    const stat = statSync(newest)
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const len = stat.size - start
    const buf = Buffer.alloc(len)
    const fd = openSync(newest, 'r')
    try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
    const lines = buf.toString('utf-8').split('\n')
    // 截断点可能落在某行中间：丢弃首条半行（仅导致该端口首个请求回退为全量记账）
    if (start > 0) lines.shift()
    for (const e of parseLines<TokenUsageEntry>(lines.join('\n'), (v) => {
      const p = v as Partial<TokenUsageEntry>
      return typeof p?.port === 'number' && typeof p?.promptTokens === 'number'
        ? { ts: p.ts as number, port: p.port, promptTokens: p.promptTokens, completionTokens: p.completionTokens ?? 0 }
        : null
    })) {
      lastPromptByPort.set(e.port, e.promptTokens)
    }
  } catch { /* 启动恢复失败不阻断 */ }
}

export function initTokenLedger(stateDir: string): void {
  ledgerDir = join(stateDir, 'token-usage')
  if (!existsSync(ledgerDir)) mkdirSync(ledgerDir, { recursive: true })
  migrateLegacySingleFile()
  currentMonth = monthKeyOf(Date.now())
  restoreLastPrompt()
}

export function getTokenLedgerPath(): string {
  return ledgerDir
}

/** 明细保留窗口：当月 + 上月 */
function retainedMonths(now: number): Set<string> {
  return new Set([monthKeyOf(now), prevMonthKey(now)])
}

function readRollup(): { sealedMonths: Set<string>; rows: TokenUsageRollupRow[] } {
  try {
    if (!existsSync(rollupPath())) return { sealedMonths: new Set(), rows: [] }
    const raw = JSON.parse(readFileSync(rollupPath(), 'utf-8')) as unknown
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as { sealedMonths?: unknown; rows?: unknown } : { rows: raw }
    const rows = Array.isArray(obj.rows)
      ? obj.rows.filter((r): r is TokenUsageRollupRow =>
          !!r && typeof (r as TokenUsageRollupRow).date === 'string'
          && typeof (r as TokenUsageRollupRow).hour === 'number'
          && typeof (r as TokenUsageRollupRow).requests === 'number')
      : []
    const sealedMonths = new Set(Array.isArray(obj.sealedMonths) ? obj.sealedMonths.filter((m): m is string => typeof m === 'string') : [])
    return { sealedMonths, rows }
  } catch {
    return { sealedMonths: new Set(), rows: [] }
  }
}

const rollupKeyOf = (r: Pick<TokenUsageRollupRow, 'date' | 'hour' | 'modelPath' | 'templateId' | 'port'>): string =>
  `${r.date}|${r.hour}|${r.modelPath ?? ''}|${r.templateId ?? ''}|${r.port}`

/**
 * 封存：把超出保留窗口的月份分片折算进 `_rollup.json`，然后删除分片。
 * 幂等 —— 已封存过的月份（记录在 sealedMonths 里）不会重复累加；失败时保留分片下次重试。
 */
export function sealOldMonths(now: number = Date.now()): void {
  if (!ledgerDir) return
  try {
    const keep = retainedMonths(now)
    const stale = listShardMonths().filter(m => !keep.has(m))
    if (!stale.length) return

    const { sealedMonths, rows } = readRollup()
    const index = new Map<string, TokenUsageRollupRow>()
    for (const r of rows) index.set(rollupKeyOf(r), r)

    let changed = false
    for (const mk of stale) {
      if (!sealedMonths.has(mk)) {
        let text = ''
        try { text = readFileSync(shardPath(mk), 'utf-8') } catch { continue }
        // 旧记录可能没有 promptDelta：按「端口 + 模型」分组、时间序推导增量（与读取口径一致）
        const entries = parseLines<TokenUsageEntry>(text, (v) => {
          const p = v as Partial<TokenUsageEntry>
          return typeof p?.ts === 'number' && typeof p?.port === 'number'
            ? { ts: p.ts, port: p.port, templateId: p.templateId, modelPath: p.modelPath ?? null, promptTokens: p.promptTokens ?? 0, promptDelta: p.promptDelta, completionTokens: p.completionTokens ?? 0 }
            : null
        }).sort((a, b) => a.ts - b.ts)
        const lastByGroup = new Map<string, number>()
        for (const e of entries) {
          if (typeof e.promptDelta !== 'number') {
            const gk = `${e.port}:${e.modelPath ?? ''}`
            const prev = lastByGroup.get(gk)
            const delta = prev === undefined ? e.promptTokens : e.promptTokens - prev
            e.promptDelta = delta > 0 ? delta : e.promptTokens
            lastByGroup.set(gk, e.promptTokens)
          }
          const key = {
            date: dayKeyOf(e.ts), hour: new Date(e.ts).getHours(),
            modelPath: e.modelPath ?? null, templateId: e.templateId, port: e.port,
          }
          const k = rollupKeyOf(key)
          let row = index.get(k)
          if (!row) { row = { ...key, requests: 0, promptTokens: 0, completionTokens: 0 }; index.set(k, row) }
          row.requests += 1
          row.promptTokens += inTokensOf(e)
          row.completionTokens += e.completionTokens
        }
        sealedMonths.add(mk)
        changed = true
      }
    }
    if (!changed) return

    writeFileSync(rollupPath(), JSON.stringify({ sealedMonths: [...sealedMonths].sort(), rows: [...index.values()] }), 'utf-8')
    // 聚合已落盘，分片可以删了（即使上一步写过、这次没变，也顺手清掉残留分片）
    for (const mk of stale) { try { rmSync(shardPath(mk), { force: true }) } catch { /* 下次再删 */ } }
  } catch { /* 封存失败不阻断启动/生成 */ }
}

export function appendTokenUsage(entry: TokenUsageEntry): void {
  if (!ledgerDir) return
  try {
    // 新增输入 = 本次完整输入 - 同端口上一次完整输入；
    // 首次请求或上下文已重置（差值为负，如切换会话/模型）时按完整输入记
    const prev = lastPromptByPort.get(entry.port)
    const delta = prev === undefined ? entry.promptTokens : entry.promptTokens - prev
    const finalEntry: TokenUsageEntry = {
      ...entry,
      promptDelta: delta > 0 ? delta : entry.promptTokens,
    }
    lastPromptByPort.set(entry.port, entry.promptTokens)

    // 跨月时先封存（只在月份变化那一次触发，不是每请求都做）
    const mk = monthKeyOf(entry.ts)
    if (mk !== currentMonth) {
      currentMonth = mk
      sealOldMonths(entry.ts)
    }
    if (!existsSync(ledgerDir)) mkdirSync(ledgerDir, { recursive: true })
    appendFileSync(shardPath(mk), `${JSON.stringify(finalEntry)}\n`, 'utf-8')
  } catch { /* 记账失败不阻断生成 */ }
}

/** 读取：近两个月明细 + 已封存月份的聚合。成本与历史总量无关。 */
export function readTokenUsage(): TokenUsageLedger {
  if (!ledgerDir || !existsSync(ledgerDir)) return { entries: [], rollup: [] }
  const keep = retainedMonths(Date.now())
  const entries: TokenUsageEntry[] = []
  for (const mk of listShardMonths()) {
    if (!keep.has(mk)) continue
    try {
      const text = readFileSync(shardPath(mk), 'utf-8')
      entries.push(...parseLines<TokenUsageEntry>(text, (v) => {
        const p = v as Partial<TokenUsageEntry>
        return typeof p?.ts === 'number' ? p as TokenUsageEntry : null
      }))
    } catch { /* 单个分片读失败不影响其余 */ }
  }
  // 旧记录（无 promptDelta）按「端口 + 模型」分组、按时间序推导
  if (entries.some(e => typeof e.promptDelta !== 'number')) {
    entries.sort((a, b) => a.ts - b.ts)
    const lastByGroup = new Map<string, number>()
    for (const e of entries) {
      if (typeof e.promptDelta === 'number') continue
      const gk = `${e.port}:${e.modelPath ?? ''}`
      const prev = lastByGroup.get(gk)
      const delta = prev === undefined ? e.promptTokens : e.promptTokens - prev
      e.promptDelta = delta > 0 ? delta : e.promptTokens
      lastByGroup.set(gk, e.promptTokens)
    }
  }
  entries.sort((a, b) => a.ts - b.ts)
  return { entries, rollup: readRollup().rows }
}

export function clearTokenUsage(): void {
  if (!ledgerDir) return
  try {
    if (existsSync(ledgerDir)) {
      for (const f of readdirSync(ledgerDir)) {
        try { rmSync(join(ledgerDir, f), { recursive: true, force: true }) } catch { /* 单个失败继续 */ }
      }
    }
    lastPromptByPort.clear()
  } catch { /* ignore */ }
}
