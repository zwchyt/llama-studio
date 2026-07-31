// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 本地知识库 RAG 服务（knowledgeService）—— BM25 关键词检索，全程离线            ║
// ║                                                                              ║
// ║ 分块：面向散文的滑窗切分（目标 ~1000 字符、重叠 ~200），优先在段落/换行/句末   ║
// ║       边界断开；单文档块数设上限防失控。                                       ║
// ║ 检索：复用 retrievalService 的 tokenize（驼峰/下划线拆分 + CJK 二元组），       ║
// ║       精简 BM25 打分（idf + k1/b），附 idf 加权覆盖率做低置信兜底。            ║
// ║ 持久化：每个知识库一个 JSON（KNOWLEDGE_DIR/<kbId>.json），含文档与全部分块。   ║
// ║ 索引：按 kbId 惰性构建、驻内存缓存；文档增删时失效，下次查询重建。             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { ipcMain } from 'electron'
import { join, resolve, sep } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import type { KnowledgeBaseMeta, KnowledgeHit } from '../../shared/types'
import { tokenize } from './retrievalService'

// ── 分块参数 ──
const CHUNK_TARGET = 1000       // 单块目标字符数
const CHUNK_OVERLAP = 200       // 相邻块重叠字符数
const CHUNK_MAX_COUNT = 2000    // 单文档块数上限
const DOC_TEXT_CAP = 4 * 1024 * 1024 // 单文档文本上限（4MB）
// ── 检索参数 ──
const BM25_K1 = 1.2
const BM25_B = 0.75
const QUERY_LIMIT_DEFAULT = 4
const QUERY_LIMIT_MAX = 12
const LOW_CONFIDENCE_SCORE = 3.0
const LOW_CONFIDENCE_COVERAGE = 0.4

// ── 持久化数据结构 ──
interface KbChunk { docId: string; docName: string; ordinal: number; text: string }
interface KbDoc { id: string; name: string; chunkCount: number }
interface KbFile { id: string; name: string; createdAt: string; docs: KbDoc[]; chunks: KbChunk[] }

// ── 内存 BM25 索引（按 kbId 缓存）──
interface KbIndex {
  chunks: { docName: string; ordinal: number; text: string; tf: Map<string, number>; len: number }[]
  df: Map<string, number>
  totalLen: number
}

let KNOWLEDGE_DIR = ''
const indexes = new Map<string, KbIndex>()

function ensureDir(): void {
  if (KNOWLEDGE_DIR && !existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true })
}

function isSafeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !/[\\/]/.test(id) && !id.includes('..')
}

function kbPath(id: string): string {
  return join(KNOWLEDGE_DIR, `${id}.json`)
}

function loadKb(id: string): KbFile | null {
  if (!isSafeId(id)) return null
  const fp = kbPath(id)
  if (!existsSync(fp)) return null
  const rBase = resolve(KNOWLEDGE_DIR)
  const rTarget = resolve(fp)
  if (rTarget !== rBase && !rTarget.startsWith(rBase + sep)) return null
  try { return JSON.parse(readFileSync(fp, 'utf-8')) as KbFile } catch { return null }
}

function saveKb(kb: KbFile): void {
  ensureDir()
  writeFileSync(kbPath(kb.id), JSON.stringify(kb, null, 2))
}

function metaOf(kb: KbFile): KnowledgeBaseMeta {
  return { id: kb.id, name: kb.name, createdAt: kb.createdAt, docCount: kb.docs.length, chunkCount: kb.chunks.length }
}

// ── 分块：优先在段落/换行/句末边界断开，带重叠滑窗 ──
function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').slice(0, DOC_TEXT_CAP)
  const chunks: string[] = []
  let pos = 0
  const len = clean.length
  while (pos < len && chunks.length < CHUNK_MAX_COUNT) {
    let end = Math.min(pos + CHUNK_TARGET, len)
    if (end < len) {
      // 在目标点附近向后回溯，寻找自然断点（段落 > 换行 > 句末标点 > 空格）
      const window = clean.slice(pos, end)
      const cut = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
        window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
        window.lastIndexOf(' ')
      )
      // 断点须落在块的后半段，避免切得太碎
      if (cut > CHUNK_TARGET * 0.5) end = pos + cut + 1
    }
    const piece = clean.slice(pos, end).trim()
    if (piece) chunks.push(piece)
    if (end >= len) break
    pos = Math.max(end - CHUNK_OVERLAP, pos + 1)
  }
  return chunks
}

// ── 惰性构建 / 取内存索引 ──
function getIndex(kb: KbFile): KbIndex {
  const cached = indexes.get(kb.id)
  if (cached) return cached
  const idx: KbIndex = { chunks: [], df: new Map(), totalLen: 0 }
  for (const c of kb.chunks) {
    const tokens = tokenize(c.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    idx.chunks.push({ docName: c.docName, ordinal: c.ordinal, text: c.text, tf, len: tokens.length })
    idx.totalLen += tokens.length
    for (const term of tf.keys()) idx.df.set(term, (idx.df.get(term) ?? 0) + 1)
  }
  indexes.set(kb.id, idx)
  return idx
}

// ── 精简 BM25 检索（面向文档块）──
function search(idx: KbIndex, query: string, limit: number): { hits: KnowledgeHit[]; lowConfidence: boolean } {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return { hits: [], lowConfidence: true }
  const qSet = new Set(qTokens)
  const N = idx.chunks.length
  if (N === 0) return { hits: [], lowConfidence: true }
  const avgdl = idx.totalLen / N || 1
  // 预算每个查询词 idf（供加权覆盖率用）
  const qIdf = new Map<string, number>()
  let qIdfTotal = 0
  for (const term of qSet) {
    const df = idx.df.get(term) ?? 0
    const v = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    qIdf.set(term, v)
    qIdfTotal += v
  }
  const scored: { i: number; score: number; coverage: number }[] = []
  for (let i = 0; i < N; i++) {
    const c = idx.chunks[i]
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
    scored.push({ i, score, coverage: qIdfTotal > 0 ? matchedIdf / qIdfTotal : 0 })
  }
  scored.sort((a, b) => b.score - a.score)
  const hits: KnowledgeHit[] = []
  for (const { i, score } of scored) {
    if (hits.length >= limit) break
    const c = idx.chunks[i]
    hits.push({ docName: c.docName, ordinal: c.ordinal, text: c.text, score: Math.round(score * 100) / 100 })
  }
  const lowConfidence = hits.length === 0
    || (scored[0]?.score ?? 0) < LOW_CONFIDENCE_SCORE
    || (scored[0]?.coverage ?? 0) < LOW_CONFIDENCE_COVERAGE
  return { hits, lowConfidence }
}

// ── IPC 注册（由 ipc.ts 的 registerIpcHandlers 调用）──
export function registerKnowledgeIpc(appRoot: string): void {
  KNOWLEDGE_DIR = join(appRoot, 'knowledge')
  ensureDir()

  ipcMain.handle('knowledge-list', async (): Promise<KnowledgeBaseMeta[]> => {
    ensureDir()
    const out: KnowledgeBaseMeta[] = []
    for (const f of readdirSync(KNOWLEDGE_DIR)) {
      if (!f.endsWith('.json')) continue
      const kb = loadKb(f.slice(0, -5))
      if (kb) out.push(metaOf(kb))
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return out
  })

  ipcMain.handle('knowledge-create', async (_e, name: string) => {
    const trimmed = String(name ?? '').trim().slice(0, 100) || '未命名知识库'
    const kb: KbFile = { id: randomUUID(), name: trimmed, createdAt: new Date().toISOString(), docs: [], chunks: [] }
    saveKb(kb)
    return { success: true, meta: metaOf(kb) }
  })

  ipcMain.handle('knowledge-delete', async (_e, id: string) => {
    if (!isSafeId(id)) return { success: false, error: '无效的知识库 ID' }
    const fp = kbPath(id)
    const rBase = resolve(KNOWLEDGE_DIR)
    if (resolve(fp) !== rBase && !resolve(fp).startsWith(rBase + sep)) return { success: false, error: '访问被拒绝' }
    try { if (existsSync(fp)) unlinkSync(fp) } catch { /* ignore */ }
    indexes.delete(id)
    return { success: true }
  })

  ipcMain.handle('knowledge-add-doc', async (_e, kbId: string, doc: { name: string; text: string }) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false, error: '知识库不存在' }
    const name = String(doc?.name ?? '').trim().slice(0, 200) || '未命名文档'
    const text = String(doc?.text ?? '')
    if (!text.trim()) return { success: false, error: '文档内容为空' }
    // 去重同名：先移除旧同名文档的块
    const dupIds = new Set(kb.docs.filter(d => d.name === name).map(d => d.id))
    if (dupIds.size > 0) {
      kb.docs = kb.docs.filter(d => !dupIds.has(d.id))
      kb.chunks = kb.chunks.filter(c => !dupIds.has(c.docId))
    }
    const docId = randomUUID()
    const pieces = chunkText(text)
    if (pieces.length === 0) return { success: false, error: '分块结果为空' }
    pieces.forEach((p, i) => kb.chunks.push({ docId, docName: name, ordinal: i, text: p }))
    kb.docs.push({ id: docId, name, chunkCount: pieces.length })
    saveKb(kb)
    indexes.delete(kbId) // 失效，下次查询重建
    return { success: true, chunkCount: pieces.length, meta: metaOf(kb) }
  })

  ipcMain.handle('knowledge-delete-doc', async (_e, kbId: string, docId: string) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false, error: '知识库不存在' }
    kb.docs = kb.docs.filter(d => d.id !== docId)
    kb.chunks = kb.chunks.filter(c => c.docId !== docId)
    saveKb(kb)
    indexes.delete(kbId)
    return { success: true, meta: metaOf(kb) }
  })

  // 返回单库文档列表（供视图展示，含每文档块数）
  ipcMain.handle('knowledge-get', async (_e, kbId: string) => {
    const kb = loadKb(kbId)
    if (!kb) return null
    return { id: kb.id, name: kb.name, createdAt: kb.createdAt, docs: kb.docs }
  })

  ipcMain.handle('knowledge-query', async (_e, kbId: string, query: string, limit?: number): Promise<{ hits: KnowledgeHit[]; lowConfidence: boolean }> => {
    if (!query || typeof query !== 'string') return { hits: [], lowConfidence: true }
    const kb = loadKb(kbId)
    if (!kb) return { hits: [], lowConfidence: true }
    const idx = getIndex(kb)
    const cap = Math.max(1, Math.min(Math.floor(limit ?? QUERY_LIMIT_DEFAULT), QUERY_LIMIT_MAX))
    return search(idx, query.slice(0, 2000), cap)
  })
}
