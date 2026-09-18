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
// ║ 缓存：请求级 LRU 结果缓存（键 = limit + 查询串），只缓存 status=ready 的结果； ║
// ║      索引内容变化（对账发现增删/重分块）即整体失效，不会返回陈旧结果。         ║
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
  postings: Map<string, number[]>     // term → chunk id 列表（倒排索引）
  totalLen: number
  fileHashes: Map<string, string>     // relPath → 已索引的内容哈希（与地图对账）
  nextId: number
  building: boolean
  built: boolean
}

const indexes = new Map<string, WsIndex>()

// ── 请求级结果缓存 ──
// Agent 探索项目时会对同一工作区反复发起相同检索（上下文被裁剪后会重问同一问题），
// 命中时直接返回上次结果，省掉「索引对账 + BM25 全量打分 + 结果结构化克隆」。
// 关键取舍：
//   · 键必须含 limit —— 同一查询不同 limit 输出的是不同截断，混用会串味；
//   · 只缓存 status=ready —— building/no-map 是瞬时状态，缓存会把「稍后可用」冻死；
//   · 返回同一个对象引用（IPC 出站会结构化克隆、调用方只读，故不深拷贝，
//     否则每命中一次就复制一份结果，缓存收益会被复制成本吃掉）。
const RESULT_CACHE_MAX = 256

interface ResultCache {
  entries: Map<string, CodeSearchResponse>
  hits: number
  misses: number
}

const resultCaches = new Map<string, ResultCache>()
let resultCacheEnabled = true

function cacheOf(key: string): ResultCache {
  let c = resultCaches.get(key)
  if (!c) {
    c = { entries: new Map(), hits: 0, misses: 0 }
    resultCaches.set(key, c)
  }
  return c
}

/** LRU 读取：命中时把条目移到队尾（Map 保持插入序，故首键即最久未用） */
function cacheGet(key: string, cacheKey: string): CodeSearchResponse | undefined {
  const c = cacheOf(key)
  const hit = c.entries.get(cacheKey)
  if (hit === undefined) { c.misses++; return undefined }
  c.entries.delete(cacheKey)
  c.entries.set(cacheKey, hit)
  c.hits++
  return hit
}

function cacheSet(key: string, cacheKey: string, value: CodeSearchResponse): void {
  const c = cacheOf(key)
  c.entries.set(cacheKey, value)
  while (c.entries.size > RESULT_CACHE_MAX) {
    const oldest = c.entries.keys().next()
    if (oldest.done) break
    c.entries.delete(oldest.value)
  }
}

/** 结果缓存计量（命中/未命中/当前容量），供诊断与离线性能测试读取 */
export interface ResultCacheStats {
  enabled: boolean
  size: number
  hits: number
  misses: number
}

export function getResultCacheStats(dir: string): ResultCacheStats {
  const c = resultCaches.get(resolve(dir))
  return { enabled: resultCacheEnabled, size: c?.entries.size ?? 0, hits: c?.hits ?? 0, misses: c?.misses ?? 0 }
}

/**
 * 清空结果缓存（不传 dir 则清空全部工作区）。
 * 调用时机：索引内容变化、工作区被删除、以及离线性能测试需要在冷缓存下起测。
 */
export function clearResultCache(dir?: string): void {
  if (dir === undefined) { resultCaches.clear(); return }
  resultCaches.delete(resolve(dir))
}

/**
 * 开关结果缓存。
 * 生产恒为开启；关闭仅供离线性能测试构造「未优化」对照 ——
 * 否则无法在同一份代码上分离出缓存带来的收益。
 */
export function setResultCacheEnabled(enabled: boolean): void {
  resultCacheEnabled = enabled
  if (!enabled) resultCaches.clear()
}

/** 工作区被删除/不再被任何项目引用时清理内存索引（与 codeMapService.deleteSnapshotForWorkspace 配对调用） */
export function disposeIndexForWorkspace(dir: string): void {
  const key = resolve(dir)
  indexes.delete(key)
  resultCaches.delete(key)
}

function getOrCreateIndex(dir: string): WsIndex {
  const key = resolve(dir)
  let idx = indexes.get(key)
  if (!idx) {
    idx = { dir: key, chunks: new Map(), byFile: new Map(), df: new Map(), postings: new Map(), totalLen: 0, fileHashes: new Map(), nextId: 1, building: false, built: false }
    indexes.set(key, idx)
  }
  return idx
}

// ── 分词：ASCII 标识符（整词 + 驼峰/下划线子词）+ 命令行 flag + CJK 二元组（覆盖中文注释/查询）──
// flag（-m / --amend）单独成词并保留前导短横线。旧实现只抓 [A-Za-z0-9_$]+，于是
// `--amend` 被降级成裸词 `amend`、`-m` 更因为单字符被长度过滤整条丢掉——结果是
// 「git commit --amend -m」切出来只剩 [git, commit, amend]，和「随便提一句 amend」
// 在检索眼里完全等价，CLI 查询里最有区分度的那部分信息全没了。
// 现在 flag 走独立分支：保留前缀（`--amend` ≠ `amend`，df 不同、idf 不同），
// 同时仍补一个去前缀的裸词，保证只写 `amend` 的文档还能被 `--amend` 命中。
// 前导 (?<![\w-]) 是为了不误伤连字符词：`well-known` 里 `-known` 前是字母 l，不当作 flag。
const TOKEN_RE = /(?<![\w-])(--?[A-Za-z][A-Za-z0-9-]*)|([A-Za-z0-9_$]+)|([\u4e00-\u9fff]+)/g

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const flag = m[1]
    if (flag !== undefined) {
      out.push(flag.toLowerCase())
      const bare = flag.replace(/^-+/, '').toLowerCase()
      if (bare.length >= 2) out.push(bare)
      continue
    }
    const tok = m[2] ?? m[3] ?? ''
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
  const removing = new Set(ids)
  const terms = new Set<string>()
  for (const id of ids) {
    const c = idx.chunks.get(id)
    if (!c) continue
    for (const term of c.tf.keys()) {
      terms.add(term)
      const d = (idx.df.get(term) ?? 1) - 1
      if (d <= 0) idx.df.delete(term)
      else idx.df.set(term, d)
    }
    idx.totalLen -= c.len
    idx.chunks.delete(id)
  }
  // 倒排表按「受影响词」各过滤一次，而不是每块过滤一遍 —— 否则热词的长表会被反复重扫
  for (const term of terms) {
    const arr = idx.postings.get(term)
    if (!arr) continue
    const next = arr.filter((x) => !removing.has(x))
    if (next.length) idx.postings.set(term, next)
    else idx.postings.delete(term)
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
    for (const term of c.tf.keys()) {
      idx.df.set(term, (idx.df.get(term) ?? 0) + 1)
      // id 单调递增，且重分块时先移除旧 id 再追加 → 倒排表始终保持升序
      const arr = idx.postings.get(term)
      if (arr) arr.push(id)
      else idx.postings.set(term, [id])
    }
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

// 查询前与地图哈希对账：变更/新增文件重分块，删除文件摘除；单次上限外的余量下次补齐。
// 返回值 = 索引内容是否发生变化 —— 结果缓存必须据此整体失效（见 handleCodeSearchQuery）。
function resyncIndex(idx: WsIndex, files: ReadonlyMap<string, CodeMapFileSkeleton>): boolean {
  let changed = false
  let done = 0
  for (const rel of [...idx.fileHashes.keys()]) {
    if (!files.has(rel)) { removeFileChunks(idx, rel); changed = true } // 删除：立即摘除（墓碑等效）
  }
  for (const [rel, skel] of files) {
    if (done >= RESYNC_FILES_PER_QUERY) break
    if (idx.fileHashes.get(rel) !== skel.hash) {
      indexFile(idx, rel, skel)
      done++
      changed = true
    }
  }
  return changed
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

/**
 * 查询期 scratch 缓冲：跨查询复用内部容器，避免每次检索都新建一批 Set / Map / 数组。
 *
 * 复用是安全的：`search()` 是同步函数、不递归、中途不让出事件循环，因此同一次调用期间
 * 这些容器不会被另一次调用踩到；返回给调用方的只有 `hits`（每次都新建），
 * 所以被结果缓存存下来的返回值不会被后续查询改写。
 *
 * `pool` 与 `scored` 分开：`scored` 每次截断到本次命中数，`pool` 只增不减，
 * 用于复用评分槽位对象本身（避免每次查询重新分配 N 个 `{id,score,coverage}`）。
 */
interface SearchScratch {
  qSet: Set<string>
  qIdf: Map<string, number>
  candidateIds: Set<number>
  scored: { id: number; score: number; coverage: number }[]
  pool: { id: number; score: number; coverage: number }[]
  perFile: Map<string, number>
}
const scratch: SearchScratch = {
  qSet: new Set(), qIdf: new Map(), candidateIds: new Set(),
  scored: [], pool: [], perFile: new Map(),
}

function search(idx: WsIndex, query: string, limit: number): { hits: CodeSearchHit[]; lowConfidence: boolean } {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return { hits: [], lowConfidence: true }
  const s = scratch
  const qSet = s.qSet
  qSet.clear()
  for (const t of qTokens) qSet.add(t)
  // 查询中的「完整标识符」（长度 ≥4 的原始词）用于精确加权
  const exactIdents = [...new Set(
    [...query.matchAll(/[A-Za-z_$][\w$]{3,}/g)].map(m => m[0].toLowerCase())
  )]
  const N = idx.chunks.size
  if (N === 0) return { hits: [], lowConfidence: true }
  const avgdl = idx.totalLen / N
  const now = Date.now()
  // 预算每个查询词的 idf（未入库词 df=0 → idf 最大），供加权覆盖率用
  const qIdf = s.qIdf
  qIdf.clear()
  let qIdfTotal = 0
  for (const term of qSet) {
    const df = idx.df.get(term) ?? 0
    const v = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    qIdf.set(term, v)
    qIdfTotal += v
  }
  // 倒排索引：按查询词收集候选 chunk id（OR 语义），只对候选集评分
  const candidateIds = s.candidateIds
  candidateIds.clear()
  for (const term of qSet) {
    const arr = idx.postings.get(term)
    if (arr) for (const id of arr) candidateIds.add(id)
  }
  const scored = s.scored
  scored.length = 0
  const pool = s.pool
  let slot = 0
  for (const id of candidateIds) {
    const c = idx.chunks.get(id)
    if (!c) continue
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
    const cell = pool[slot] ?? (pool[slot] = { id: 0, score: 0, coverage: 0 })
    cell.id = id; cell.score = score; cell.coverage = coverage
    scored.push(cell)
    slot++
  }
  scored.sort((a, b) => b.score - a.score)
  // 多样性约束：单文件最多 PER_FILE_CAP 块
  const perFile = s.perFile
  perFile.clear()
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
    if (!idx.building) void buildIndex(idx, files).catch((err) => console.warn('[retrieval] 建索引失败：', err)) // 后台建索引，本次先返回 building
    return Promise.resolve({ status: 'building', results: [], lowConfidence: true, indexedChunks: idx.chunks.size })
  }
  // 增量对账：只重分块哈希变更的文件。索引内容一旦变化，结果缓存整体失效 ——
  // 这是缓存正确性的唯一保证（对账必须先于缓存查询）。
  if (resyncIndex(idx, files)) clearResultCache(idx.dir)
  const cap = Math.max(1, Math.min(Math.floor(limit ?? RESULT_LIMIT_DEFAULT), RESULT_LIMIT_MAX))
  const q = String(query).slice(0, 2000)
  const cacheKey = `${cap}|${q}`
  if (resultCacheEnabled) {
    const hit = cacheGet(idx.dir, cacheKey)
    if (hit !== undefined) return Promise.resolve(hit)
  }
  const { hits, lowConfidence } = search(idx, q, cap)
  const res: CodeSearchResponse = { status: 'ready', results: hits, lowConfidence, indexedChunks: idx.chunks.size }
  if (resultCacheEnabled) cacheSet(idx.dir, cacheKey, res)
  return Promise.resolve(res)
}
