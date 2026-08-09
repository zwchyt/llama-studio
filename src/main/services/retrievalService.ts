// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 代码混合检索服务（retrievalService）—— 模块三「RAG 系统」主进程实现            ║
// ║                                                                              ║
// ║ 分块：复用认知地图的符号行号做「逻辑单元分块」（函数/类方法边界，非按行切）；   ║
// ║       前导注释归入所属单元，超大单元二次切片（带面包屑），碎块向前合并。       ║
// ║ 检索：BM25 词法通道（标识符驼峰/下划线拆分 + CJK 二元组，覆盖中文注释）        ║
// ║       + 符号精确加权（整词命中符号名强加分），单接口对外。                     ║
// ║ 重排：文件角色权重（测试/数据降权）+ 新鲜度微加分 + 单文件多样性约束。         ║
// ║ 增量：不建独立监视器——每次查询前与认知地图做哈希对账，只重分块变更文件         ║
// ║      （删除立即摘除；单次对账文件数设上限，超出部分下次查询继续补齐）。        ║
// ║ 索引仅驻内存（不落盘）：重启后首次查询触发重建，构建期间返回 building 状态。   ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { ipcMain } from 'electron'
import { join, resolve } from 'path'
import { readFileSync } from 'fs'
import type { CodeMapFileSkeleton, CodeSearchHit, CodeSearchResponse } from '../../shared/types'
import { getMapFiles, getMapState } from './codeMapService'

// ── 分块参数 ──
const CHUNK_MAX_LINES = 120        // 单块行数上限，超出按此窗口二次切片
const CHUNK_MIN_LINES = 5          // 小于此行数的碎块向前一块合并
const CHUNK_WINDOW_NO_SYMBOL = 60  // 无符号文件（css/json 等）的固定窗口行数
const SNIPPET_CAP = 240            // 命中块摘要的最大字符数
const FILE_SIZE_CAP = 512 * 1024   // 与地图一致：超大文件不分块
// ── 检索参数 ──
const BM25_K1 = 1.2
const BM25_B = 0.75
const RESULT_LIMIT_DEFAULT = 8
const RESULT_LIMIT_MAX = 20
const PER_FILE_CAP = 2             // 多样性约束：单文件最多进入结果的块数
// 低置信判定（双指标）：BM25 绝对分随查询长度/idf 浮动，单阈值不可靠，
// 补「idf 加权查询词覆盖率」：未命中词按最大 idf 计入分母，生僻词（乱语/错词）
// 落空会大幅拉低覆盖率；仅靠常见词（低 idf）拼凑的命中判为低置信。
const LOW_CONFIDENCE_SCORE = 5.0
const LOW_CONFIDENCE_COVERAGE = 0.45
const SYMBOL_EXACT_BOOST = 1.6     // 查询整词命中块符号名
const BODY_EXACT_BOOST = 1.25      // 查询整词出现在块正文
const FRESH_BOOST = 1.1            // 文件 24h 内有改动
const RESYNC_FILES_PER_QUERY = 50  // 单次查询前重同步的文件数上限（余量下次补齐）
const BUILD_BATCH = 20             // 全量建索引时每批处理文件数（批间让出事件循环）

interface Chunk {
  relPath: string
  startLine: number
  endLine: number
  symbol: string
  kind: string
  snippet: string
  tf: Map<string, number>
  len: number
  mtimeMs: number
}

interface WsIndex {
  dir: string
  chunks: Map<number, Chunk>
  byFile: Map<string, number[]>       // relPath → chunk id 列表
  df: Map<string, number>             // term → 含该词的块数（增量维护）
  totalLen: number
  fileHashes: Map<string, string>     // relPath → 已索引的内容哈希（与地图对账）
  nextId: number
  building: boolean
  built: boolean
}

const indexes = new Map<string, WsIndex>()

function getOrCreateIndex(dir: string): WsIndex {
  const key = resolve(dir)
  let idx = indexes.get(key)
  if (!idx) {
    idx = { dir: key, chunks: new Map(), byFile: new Map(), df: new Map(), totalLen: 0, fileHashes: new Map(), nextId: 1, building: false, built: false }
    indexes.set(key, idx)
  }
  return idx
}

// ── 分词：ASCII 标识符（整词 + 驼峰/下划线子词）+ CJK 二元组（覆盖中文注释/查询）──
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z0-9_$]+|[\u4e00-\u9fff]+/g)) {
    const tok = m[0]
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (tok.length === 1) { out.push(tok); continue }
      for (let i = 0; i + 1 < tok.length; i++) out.push(tok.slice(i, i + 2))
    } else {
      const lower = tok.toLowerCase()
      if (lower.length >= 2) out.push(lower)
      const parts = tok.split(/_+/).flatMap(p => p.split(/(?<=[a-z0-9])(?=[A-Z])/))
      if (parts.length > 1) {
        for (const p of parts) {
          const pl = p.toLowerCase()
          if (pl.length >= 2 && pl !== lower) out.push(pl)
        }
      }
    }
  }
  return out
}

function buildTf(tokens: string[]): { tf: Map<string, number>; len: number } {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return { tf, len: tokens.length }
}

// 前导注释行归入下一个逻辑单元：从符号行向上吞并连续的注释/空行（注释优先，空行止步）
function extendUpForComments(lines: string[], symLine1: number): number {
  let i = symLine1 - 2 // 符号行的上一行（0-based）
  while (i >= 0) {
    const l = lines[i].trim()
    if (/^(\/\/|\/\*|\*|#|--|<!--)/.test(l)) { i--; continue }
    break
  }
  return i + 2 // 回到 1-based 的块起始行
}

// ── 逻辑单元分块 ──
function chunkFile(relPath: string, content: string, skel: CodeMapFileSkeleton): Chunk[] {
  const lines = content.split('\n')
  const total = lines.length
  const out: Chunk[] = []
  const push = (startLine: number, endLine: number, symbol: string, kind: string): void => {
    if (endLine < startLine) return
    const body = lines.slice(startLine - 1, endLine).join('\n')
    if (!body.trim()) return
    const { tf, len } = buildTf(tokenize(body))
    if (len === 0) return
    out.push({
      relPath, startLine, endLine, symbol, kind,
      snippet: body.trim().slice(0, SNIPPET_CAP),
      tf, len, mtimeMs: skel.mtimeMs,
    })
  }

  // 参与分块边界的符号：有行号的声明（section 亦可作 markdown 分节边界）
  const bounds = skel.symbols
    .filter(s => s.line >= 1 && s.line <= total)
    .sort((a, b) => a.line - b.line)

  if (bounds.length === 0) {
    // 无符号文件（css/json/yaml 等）：固定窗口分块
    for (let s = 1; s <= total; s += CHUNK_WINDOW_NO_SYMBOL) {
      push(s, Math.min(s + CHUNK_WINDOW_NO_SYMBOL - 1, total), '(段落)', 'block')
    }
    return out
  }

  // 符号边界分块：块 i = [边界 i 上探注释后的起点 .. 边界 i+1 起点前一行]
  const starts = bounds.map(b => extendUpForComments(lines, b.line))
  // 模块头（首个符号之前）：import 段等，单独成块（kind=module）
  if (starts[0] > 1) push(1, starts[0] - 1, '(模块头)', 'module')
  for (let i = 0; i < bounds.length; i++) {
    const start = starts[i]
    const end = i + 1 < bounds.length ? Math.max(starts[i + 1] - 1, start) : total
    const sym = bounds[i]
    const span = end - start + 1
    if (span <= CHUNK_MAX_LINES) {
      // 碎块合并：过小且与前一块同文件相邻 → 并入前块
      const prev = out[out.length - 1]
      if (span < CHUNK_MIN_LINES && prev && prev.endLine === start - 1 && (prev.endLine - prev.startLine + 1) + span <= CHUNK_MAX_LINES) {
        const merged = lines.slice(prev.startLine - 1, end).join('\n')
        const { tf, len } = buildTf(tokenize(merged))
        prev.endLine = end
        prev.symbol = `${prev.symbol}+${sym.name}`
        prev.tf = tf
        prev.len = len
        prev.snippet = merged.trim().slice(0, SNIPPET_CAP)
      } else {
        push(start, end, sym.name, sym.kind)
      }
    } else {
      // 超大单元：按窗口二次切片，面包屑带分片序号（首片含签名与前导注释）
      let part = 1
      for (let s = start; s <= end; s += CHUNK_MAX_LINES) {
        push(s, Math.min(s + CHUNK_MAX_LINES - 1, end), part === 1 ? sym.name : `${sym.name}（续${part}）`, sym.kind)
        part++
      }
    }
  }
  return out
}

// ── 索引增删（df / totalLen 增量维护）──

function removeFileChunks(idx: WsIndex, relPath: string): void {
  const ids = idx.byFile.get(relPath)
  if (!ids) return
  for (const id of ids) {
    const c = idx.chunks.get(id)
    if (!c) continue
    for (const term of c.tf.keys()) {
      const d = (idx.df.get(term) ?? 1) - 1
      if (d <= 0) idx.df.delete(term)
      else idx.df.set(term, d)
    }
    idx.totalLen -= c.len
    idx.chunks.delete(id)
  }
  idx.byFile.delete(relPath)
  idx.fileHashes.delete(relPath)
}

function indexFile(idx: WsIndex, relPath: string, skel: CodeMapFileSkeleton): void {
  removeFileChunks(idx, relPath)
  if (skel.size > FILE_SIZE_CAP) { idx.fileHashes.set(relPath, skel.hash); return }
  let content: string
  try { content = readFileSync(join(idx.dir, relPath), 'utf-8') } catch { return }
  const chunks = chunkFile(relPath, content, skel)
  const ids: number[] = []
  for (const c of chunks) {
    const id = idx.nextId++
    idx.chunks.set(id, c)
    ids.push(id)
    for (const term of c.tf.keys()) idx.df.set(term, (idx.df.get(term) ?? 0) + 1)
    idx.totalLen += c.len
  }
  idx.byFile.set(relPath, ids)
  idx.fileHashes.set(relPath, skel.hash)
}

// 全量构建：遍历地图全部文件，分批让出事件循环
async function buildIndex(idx: WsIndex, files: ReadonlyMap<string, CodeMapFileSkeleton>): Promise<void> {
  if (idx.building) return
  idx.building = true
  try {
    let batch = 0
    for (const [rel, skel] of files) {
      indexFile(idx, rel, skel)
      if (++batch >= BUILD_BATCH) { batch = 0; await new Promise<void>(r => setImmediate(r)) }
    }
    idx.built = true
  } finally {
    idx.building = false
  }
}

// 查询前与地图哈希对账：变更/新增文件重分块，删除文件摘除；单次上限外的余量下次补齐
function resyncIndex(idx: WsIndex, files: ReadonlyMap<string, CodeMapFileSkeleton>): void {
  let done = 0
  for (const rel of [...idx.fileHashes.keys()]) {
    if (!files.has(rel)) removeFileChunks(idx, rel) // 删除：立即摘除（墓碑等效）
  }
  for (const [rel, skel] of files) {
    if (done >= RESYNC_FILES_PER_QUERY) break
    if (idx.fileHashes.get(rel) !== skel.hash) {
      indexFile(idx, rel, skel)
      done++
    }
  }
}

// ── 检索：BM25 + 精确加权 + 重排序 ──

// 文件角色权重：源码 > 文档 > 测试 > 数据/配置
function fileRoleWeight(relPath: string): number {
  const p = relPath.toLowerCase()
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.\w+$/.test(p)) return 0.8
  if (p.endsWith('.md')) return 0.9
  if (/\.(json|ya?ml|toml)$/.test(p)) return 0.7
  return 1
}

function search(idx: WsIndex, query: string, limit: number): { hits: CodeSearchHit[]; lowConfidence: boolean } {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return { hits: [], lowConfidence: true }
  const qSet = new Set(qTokens)
  // 查询中的「完整标识符」（长度 ≥4 的原始词）用于精确加权
  const exactIdents = [...new Set(
    [...query.matchAll(/[A-Za-z_$][\w$]{3,}/g)].map(m => m[0].toLowerCase())
  )]
  const N = idx.chunks.size
  if (N === 0) return { hits: [], lowConfidence: true }
  const avgdl = idx.totalLen / N
  const now = Date.now()
  // 预算每个查询词的 idf（未入库词 df=0 → idf 最大），供加权覆盖率用
  const qIdf = new Map<string, number>()
  let qIdfTotal = 0
  for (const term of qSet) {
    const df = idx.df.get(term) ?? 0
    const v = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    qIdf.set(term, v)
    qIdfTotal += v
  }
  const scored: { id: number; score: number; coverage: number }[] = []
  for (const [id, c] of idx.chunks) {
    let score = 0
    let matchedIdf = 0
    for (const term of qSet) {
      const tf = c.tf.get(term)
      if (!tf) continue
      matchedIdf += qIdf.get(term) ?? 0
      const df = idx.df.get(term) ?? 1
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * c.len / avgdl))
    }
    if (score <= 0) continue
    const coverage = qIdfTotal > 0 ? matchedIdf / qIdfTotal : 0
    // 精确通道加权：整词命中符号名 > 整词出现在正文
    for (const ident of exactIdents) {
      if (c.symbol.toLowerCase().includes(ident)) { score *= SYMBOL_EXACT_BOOST; break }
      if (c.tf.has(ident)) { score *= BODY_EXACT_BOOST; break }
    }
    score *= fileRoleWeight(c.relPath)
    if (now - c.mtimeMs < 24 * 3600 * 1000) score *= FRESH_BOOST
    scored.push({ id, score, coverage })
  }
  scored.sort((a, b) => b.score - a.score)
  // 多样性约束：单文件最多 PER_FILE_CAP 块
  const perFile = new Map<string, number>()
  const hits: CodeSearchHit[] = []
  for (const { id, score } of scored) {
    if (hits.length >= limit) break
    const c = idx.chunks.get(id)!
    const used = perFile.get(c.relPath) ?? 0
    if (used >= PER_FILE_CAP) continue
    perFile.set(c.relPath, used + 1)
    hits.push({
      relPath: c.relPath, startLine: c.startLine, endLine: c.endLine,
      symbol: c.symbol, kind: c.kind,
      score: Math.round(score * 100) / 100, snippet: c.snippet,
    })
  }
  const lowConfidence = hits.length === 0
    || (scored[0]?.score ?? 0) < LOW_CONFIDENCE_SCORE
    || (scored[0]?.coverage ?? 0) < LOW_CONFIDENCE_COVERAGE
  return { hits, lowConfidence }
}

// ── IPC 注册（由 ipc.ts 的 registerIpcHandlers 调用）──

export function registerRetrievalIpc(): void {
  ipcMain.handle('codesearch-query', (_e, dir, query, limit) => handleCodeSearchQuery(dir, query, limit))
}

/** codesearch-query handler 的核心逻辑（提取供 pi bridge 直调） */
export function handleCodeSearchQuery(dir: string, query: string, limit?: number): Promise<CodeSearchResponse> {
  const empty = (status: CodeSearchResponse['status']): CodeSearchResponse =>
    ({ status, results: [], lowConfidence: true, indexedChunks: 0 })
  if (!dir || !query || typeof query !== 'string') return Promise.resolve(empty('no-map'))
  const files = getMapFiles(dir)
  if (!files) {
    // 地图 building 中或未触发：检索暂不可用，调用方降级到 Grep
    return Promise.resolve(empty(getMapState(dir) === 'building' ? 'building' : 'no-map'))
  }
  const idx = getOrCreateIndex(dir)
  if (!idx.built) {
    if (!idx.building) void buildIndex(idx, files) // 后台建索引，本次先返回 building
    return Promise.resolve({ status: 'building', results: [], lowConfidence: true, indexedChunks: idx.chunks.size })
  }
  resyncIndex(idx, files) // 增量对账：只重分块哈希变更的文件
  const cap = Math.max(1, Math.min(Math.floor(limit ?? RESULT_LIMIT_DEFAULT), RESULT_LIMIT_MAX))
  const { hits, lowConfidence } = search(idx, String(query).slice(0, 2000), cap)
  return Promise.resolve({ status: 'ready', results: hits, lowConfidence, indexedChunks: idx.chunks.size })
}
