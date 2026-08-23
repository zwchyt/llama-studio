// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 本地知识库 RAG 服务（knowledgeService）—— BM25 关键词检索，全程离线            ║
// ║                                                                              ║
// ║ 分块：段落感知贪心合并（目标 ~1000 字符），段落不从中间截断，                  ║
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
interface KbChunk { docId: string; docName: string; ordinal: number; text: string; title?: string }
interface KbDoc { id: string; name: string; chunkCount: number; chars?: number; chunkMode?: string }
interface KbFile { id: string; name: string; createdAt: string; docs: KbDoc[]; chunks: KbChunk[] }

// ── 内存 BM25 索引（按 kbId 缓存）──
interface KbIndex {
  chunks: { docName: string; ordinal: number; text: string; title: string; tf: Map<string, number>; len: number }[]
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

// ── 块标题：入库时从块首提取（Markdown 标题 / 中文编号标题），否则取首句截断。
// 供两阶段检索使用：模型先看标题目录，再按需读取选中块的正文，避免整块盲读。 ──
export function deriveChunkTitle(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (const l of lines.slice(0, 3)) {
    const md = /^#{1,6}\s+(.{2,60})/.exec(l)
    if (md) return md[1].trim().slice(0, 30)
    const num = /^(?:第[一二三四五六七八九十百\d]+[章节部分讲课]|[（(]?\d{1,3}[）).、]|[一二三四五六七八九十]{1,3}[、..])\s*(\S.{1,50})/.exec(l)
    if (num) return num[1].trim().slice(0, 30)
  }
  const flat = lines.join(' ').replace(/\s+/g, ' ').trim()
  return flat.slice(0, 24) || '（无标题）'
}

// ── 分块：段落感知贪心合并（段落永不被拦腰截断）──
// 1) 按换行拆自然段；2) 依次累加段落，超过 CHUNK_TARGET 即封块；
// 3) 仅当单段自身超长时按句末标点拆句合并；单句仍超长才硬切（病态兜底）。
// 相比旧滑窗方案：无人工重叠、边界即自然段边界、标题与内容对齐。
// ── 用户可控分块选项：mode=切分依据；size=单块目标字符（200-4000）；delimiter 供 delim 模式 ──
export interface KnowledgeChunkOptions {
  mode?: 'auto' | 'heading' | 'delim' | 'single' | 'manual' | 'code'
  size?: number
  delimiter?: string
  /** manual 模式：行号区间（1 起始、含端点），按给出顺序成块 */
  ranges?: number[][]
  /** code 模式：语言（取文件扩展名），决定顶层定义行的识别规则 */
  lang?: string
}

const clampChunkTarget = (n: unknown): number => {
  const v = Math.round(Number(n) || 0)
  return v > 0 ? Math.max(200, Math.min(4000, v)) : CHUNK_TARGET
}

/** 分块方式的中文标签（随文档持久化，列表按文档展示各自的方式） */
const chunkModeLabel = (mode?: string): string => {
  switch (mode) {
    case 'heading': return '标题分块'
    case 'delim': return '分隔符'
    case 'single': return '单块'
    case 'manual': return '手动划块'
    case 'code': return '代码结构'
    default: return '自动分段'
  }
}

const splitLongParagraph = (para: string, target = CHUNK_TARGET): string[] => {
  const sentences = para.split(/(?<=[。！？!?；;])/).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const s of sentences) {
    if (s.length <= target) { out.push(s); continue }
    for (let i = 0; i < s.length; i += target) out.push(s.slice(i, i + target))
  }
  return out
}

/** 顶层定义行识别（代码结构分块用）：命中即开启新块；Python 装饰器行也算新起点 */
const codeDefRegex = (lang?: string): RegExp | null => {
  switch ((lang || '').toLowerCase()) {
    case 'py':
      return /^(async\s+def\b|def\b|class\b|@)/
    case 'js': case 'ts': case 'jsx': case 'tsx': case 'mjs': case 'cjs':
      return /^(export\s+)?(default\s+)?(async\s+)?function\b|^(export\s+)?(abstract\s+)?class\b|^(export\s+)?(const|let|var)\s+[\w$]+\s*=|^(export\s+)?(interface|type|enum)\b/
    default:
      return null
  }
}

/** 超长代码段的行级硬切：逐行累积到目标长度才断，永不切断单条语句 */
const hardSplitLines = (text: string, target: number): string[] => {
  const lines = text.split('\n')
  const out: string[] = []
  let buf: string[] = []
  let len = 0
  for (const line of lines) {
    if (len > 0 && len + line.length + 1 > target) { out.push(buf.join('\n')); buf = []; len = 0 }
    buf.push(line)
    len += line.length + 1
  }
  if (buf.some(l => l.trim())) out.push(buf.join('\n'))
  return out
}

/** 有效字符数：剔除空格/缩进/换行等所有空白字符后的长度（字数统计口径，避免空白虚高） */
function visibleCharLen(s: string): number {
  return s.replace(/\s/g, '').length
}

function chunkText(text: string, opts: KnowledgeChunkOptions = {}): string[] {
  const clean = text.replace(/\r\n/g, '\n').slice(0, DOC_TEXT_CAP)
  const target = clampChunkTarget(opts.size)
  const mode = opts.mode ?? 'auto'
  if (mode === 'single') return clean.trim() ? [clean.trim()] : []

  // manual：用户在预览里点击行号定义的区间，严格按区间成块；未被任何区间覆盖的行并入最后一块（不丢内容）
  if (mode === 'manual') {
    const lines = clean.split('\n')
    const chunks: string[] = []
    const covered = new Set<number>()
    for (const r of Array.isArray(opts.ranges) ? opts.ranges : []) {
      if (!Array.isArray(r) || r.length !== 2) continue
      const s = Math.max(1, Math.round(Number(r[0]) || 1))
      const e = Math.min(lines.length, Math.round(Number(r[1]) || s))
      if (e < s) continue
      for (let i = s; i <= e; i++) covered.add(i)
      const seg = lines.slice(s - 1, e).join('\n').trim()
      if (seg) chunks.push(seg)
    }
    const rest: string[] = []
    for (let i = 1; i <= lines.length; i++) if (!covered.has(i)) rest.push(lines[i - 1])
    const restText = rest.join('\n').trim()
    if (restText) chunks.push(restText)
    return chunks.slice(0, CHUNK_MAX_COUNT)
  }

  // heading / delim：严格遵守用户给定边界，一块一个区段；仅当区段超过 2×target 时按句末标点二次拆分
  if (mode === 'heading' || mode === 'delim') {
    let sections: string[]
    if (mode === 'heading') {
      sections = []
      let cur: string[] = []
      for (const raw of clean.split('\n')) {
        const line = raw.replace(/\s+$/, '').trim()
        if (!line) continue
        if (/^#{1,6}\s+/.test(line) && cur.length > 0) { sections.push(cur.join('\n')); cur = [] }
        cur.push(line)
      }
      if (cur.length > 0) sections.push(cur.join('\n'))
    } else {
      const d = String(opts.delimiter ?? '') || '\n---\n'
      sections = clean.split(d).map(s => s.trim()).filter(Boolean)
    }
    const chunks: string[] = []
    for (const s of sections) chunks.push(...(s.length <= target * 2 ? [s] : splitLongParagraph(s, target)))
    return chunks.slice(0, CHUNK_MAX_COUNT)
  }

  // code：按顶层定义（def/class/function/const= 等）切分，一个定义一块；
  // 相邻小定义贪心合并到 2×target；超长单定义按行累积硬切（永不切断语句）。
  if (mode === 'code') {
    const re = codeDefRegex(opts.lang)
    if (!re) {
      // 无顶层定义语法可识别的语言（css/html 等）：按空行分段 + 行级累积切，不按句号
      const out: string[] = []
      let buf = ''
      for (const para of clean.split(/\n{2,}/)) {
        const t = para.trim()
        if (!t) continue
        for (const piece of (t.length > target * 2 ? hardSplitLines(t, target) : [t])) {
          if (!buf) { buf = piece; continue }
          if (buf.length + piece.length + 2 <= target) buf += '\n\n' + piece
          else { out.push(buf); buf = piece }
        }
      }
      if (buf) out.push(buf)
      return out.slice(0, CHUNK_MAX_COUNT)
    }
    const segments: string[] = []
    let cur: string[] = []
    for (const line of clean.split('\n')) {
      if (re.test(line) && cur.some(l => l.trim())) { segments.push(cur.join('\n')); cur = [] }
      cur.push(line)
    }
    if (cur.some(l => l.trim())) segments.push(cur.join('\n'))
    const chunks: string[] = []
    let buf = ''
    for (const seg of segments) {
      const t = seg.trim()
      if (!t) continue
      if (t.length > target * 2) { if (buf) { chunks.push(buf); buf = '' } chunks.push(...hardSplitLines(t, target)); continue }
      if (!buf) { buf = t; continue }
      if (buf.length + t.length + 2 <= target * 2) buf += '\n\n' + t
      else { chunks.push(buf); buf = t }
    }
    if (buf) chunks.push(buf)
    return chunks.slice(0, CHUNK_MAX_COUNT)
  }

  // auto：缩进归组 + 贪心打包到 target
  const entries: string[] = []
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^\s/.test(raw) && entries.length > 0) {
      const last = entries.length - 1
      entries[last] = `${entries[last]}\n${line.trim()}`
      // 单条目被续行撑超目标长度时，按句子拆开替换原条目（保持其余流程可处理）
      if (entries[last].length > target * 2) {
        const last2 = entries[last]
        entries.splice(last, 1, ...splitLongParagraph(last2, target))
      }
    } else {
      entries.push(line.trim())
    }
  }
  const units: string[] = []
  for (const p of entries) {
    units.push(...(p.length <= target ? [p] : splitLongParagraph(p, target)))
  }
  const chunks: string[] = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + 1 + u.length > target) {
      chunks.push(buf)
      buf = ''
    }
    buf = buf ? `${buf}\n${u}` : u
  }
  if (buf.trim()) chunks.push(buf)
  return chunks.slice(0, CHUNK_MAX_COUNT)
}

// ── 惰性构建 / 取内存索引 ──
function getIndex(kb: KbFile): KbIndex {
  const cached = indexes.get(kb.id)
  if (cached) return cached
  const idx: KbIndex = { chunks: [], df: new Map(), totalLen: 0 }
  for (const c of kb.chunks) {
    // 文档名+块标题的词也计入 tf：让「拿文件名/标题当查询词」能命中对应块；
    // 同文档多块共享这些词会被 IDF 自然压权，不会淹没正文关键词
    const headTokens = tokenize(`${c.docName} ${c.title ?? ''}`)
    const tokens = [...tokenize(c.text), ...headTokens]
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    idx.chunks.push({ docName: c.docName, ordinal: c.ordinal, text: c.text, title: c.title ?? '', tf, len: tokens.length })
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
  // 整句精确命中加权：BM25 是词袋模型不认短语——「git reset --soft HEAD~1」与讲其它 reset 变体的块词频几乎相同。
  // 原文逐字包含完整查询串的块视为强命中，分数放大以与近义变体块拉开差距（配合下方相对阈值剪枝）
  const PHRASE_BOOST = 2.5
  const normQ = query.toLowerCase().replace(/\s+/g, ' ').trim()
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
    if (normQ.length >= 4 && c.text.toLowerCase().replace(/\s+/g, ' ').includes(normQ)) score *= PHRASE_BOOST
    scored.push({ i, score, coverage: qIdfTotal > 0 ? matchedIdf / qIdfTotal : 0 })
  }
  scored.sort((a, b) => b.score - a.score)
  // 相对阈值：低于最高分 10% 的块视为噪音（只沾到常见词/文档名共享词），不进目录
  const RELATIVE_NOISE_RATIO = 0.15
  const bestScore = scored[0]?.score ?? 0
  const cutoff = bestScore * RELATIVE_NOISE_RATIO
  const hits: KnowledgeHit[] = []
  for (const { i, score } of scored) {
    if (hits.length >= limit) break
    if (score < cutoff) break
    const c = idx.chunks[i]
    hits.push({ docName: c.docName, ordinal: c.ordinal, text: c.text, title: c.title || deriveChunkTitle(c.text), score: Math.round(score * 100) / 100 })
  }
  const lowConfidence = hits.length === 0
    || (scored[0]?.score ?? 0) < LOW_CONFIDENCE_SCORE
    || (scored[0]?.coverage ?? 0) < LOW_CONFIDENCE_COVERAGE
  return { hits, lowConfidence }
}

// ── 库概要（供 Agent 工具描述注入库名+文档清单，让模型知道绑定的库里有什么）──
export function describeKnowledgeBase(kbId: string): { name: string; docs: string[] } | null {
  const kb = loadKb(kbId)
  if (!kb) return null
  return { name: kb.name, docs: kb.docs.map(d => d.name) }
}

// ── 本机全部知识库清单（供 Agent 工具参数 kb 的 enum 注入：模型从真实库名中选择）──
export function listKnowledgeBases(): { id: string; name: string }[] {
  if (!KNOWLEDGE_DIR || !existsSync(KNOWLEDGE_DIR)) return []
  const out: { id: string; name: string }[] = []
  for (const f of readdirSync(KNOWLEDGE_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const kb = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, f), 'utf-8')) as KbFile
      if (kb?.id && kb?.name) out.push({ id: kb.id, name: kb.name })
    } catch { /* 忽略坏文件 */ }
  }
  return out
}

// ── 按引用读取选中块的完整内容（两阶段检索第二段：模型先 knowledge_search 看标题目录，
// 再用 docName+ordinal 精确读取需要的块，避免把无关块灌进上下文）──
export function readKnowledgeChunks(
  kbId: string,
  refs: { docName?: string; ordinal?: number }[]
): { hits: { docName: string; ordinal: number; title: string; text: string }[]; error?: string } {
  const kb = loadKb(kbId)
  if (!kb) return { hits: [], error: '知识库不存在' }
  const list = Array.isArray(refs) ? refs.slice(0, 8) : []
  if (list.length === 0) return { hits: [], error: '未指定要读取的块' }
  const out: { docName: string; ordinal: number; title: string; text: string }[] = []
  for (const r of list) {
    if (typeof r?.ordinal !== 'number' || !Number.isInteger(r.ordinal) || r.ordinal < 0) continue
    const name = typeof r.docName === 'string' ? r.docName : ''
    const c = kb.chunks.find(x => x.ordinal === r.ordinal && (name ? x.docName === name : true))
    if (c && !out.some(o => o.docName === c.docName && o.ordinal === c.ordinal)) {
      out.push({ docName: c.docName, ordinal: c.ordinal, title: c.title || deriveChunkTitle(c.text), text: c.text })
    }
  }
  return { hits: out }
}

// ── 查询单库（主进程内部复用：pi Agent 的 knowledge_search 工具直调，不经 IPC）──
export function queryKnowledgeBase(kbId: string, query: string, limit?: number): { hits: KnowledgeHit[]; lowConfidence: boolean } {
  if (!query || typeof query !== 'string') return { hits: [], lowConfidence: true }
  const kb = loadKb(kbId)
  if (!kb) return { hits: [], lowConfidence: true }
  const idx = getIndex(kb)
  const cap = Math.max(1, Math.min(Math.floor(limit ?? QUERY_LIMIT_DEFAULT), QUERY_LIMIT_MAX))
  return search(idx, query.slice(0, 2000), cap)
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

  ipcMain.handle('knowledge-add-doc', async (_e, kbId: string, doc: { name: string; text: string; chunking?: KnowledgeChunkOptions }) => {
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
    const chunkOpts = doc?.chunking && typeof doc.chunking === 'object' ? doc.chunking : {}
    const pieces = chunkText(text, { ...chunkOpts, lang: (name.split('.').pop() || '').toLowerCase() })
    if (pieces.length === 0) return { success: false, error: '分块结果为空' }
    pieces.forEach((p, i) => kb.chunks.push({ docId, docName: name, ordinal: i, text: p, title: deriveChunkTitle(p) }))
    // chars = 有效字符数（剔除空格/缩进/换行等空白），供文档列表/预览展示统计
    const cleanedLen = visibleCharLen(text.replace(/\r\n/g, '\n').slice(0, DOC_TEXT_CAP))
    // 记录该文档实际使用的分块方式（每个文档可不同，列表按文档展示）
    const modeLabel = chunkModeLabel(chunkOpts.mode)
    kb.docs.push({ id: docId, name, chunkCount: pieces.length, chars: cleanedLen, chunkMode: modeLabel })
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
    return queryKnowledgeBase(kbId, query, limit)
  })

  // ── 文档内容预览：按 ordinal 拼接该文档全部分块还原全文 ──
  ipcMain.handle('knowledge-doc-content', async (_e, kbId: string, docId: string) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false as const, error: '知识库不存在' }
    const doc = kb.docs.find(d => d.id === docId)
    if (!doc) return { success: false as const, error: '文档不存在' }
    const chunks = kb.chunks
      .filter(c => c.docId === docId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(c => ({ ordinal: c.ordinal, text: c.text }))
    const text = chunks.map(c => c.text).join('\n\n')
    return { success: true as const, name: doc.name, chunkCount: chunks.length, chars: visibleCharLen(text), text, chunks }
  })

  // ── 导出：整个库序列化为 JSON（含 docs + 全部分块，可跨机器导入）──
  ipcMain.handle('knowledge-export', async (_e, kbId: string) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false, error: '知识库不存在' }
    const payload = {
      app: 'llama-studio', type: 'knowledge-base', version: 1,
      name: kb.name, createdAt: kb.createdAt,
      docs: kb.docs, chunks: kb.chunks.map(({ docId, docName, ordinal, text }) => ({ docId, docName, ordinal, text }))
    }
    return { success: true, name: kb.name, json: JSON.stringify(payload, null, 2) }
  })

  // ── 导入：解析导出 JSON 建新库（全新 id 防碰撞；重名自动加后缀；docName 以 docs 列表回填）──
  ipcMain.handle('knowledge-import', async (_e, json: string) => {
    try {
      const raw = JSON.parse(String(json ?? '')) as { name?: unknown; docs?: unknown; chunks?: unknown }
      if (!raw || !Array.isArray(raw.docs) || !Array.isArray(raw.chunks)) return { success: false, error: '文件格式不正确（缺少 docs/chunks 字段）' }
      const name = String(raw.name ?? '').trim().slice(0, 100) || '导入的知识库'
      let finalName = name
      const existingNames = new Set<string>()
      for (const f of readdirSync(KNOWLEDGE_DIR)) {
        if (!f.endsWith('.json')) continue
        try { existingNames.add((JSON.parse(readFileSync(join(KNOWLEDGE_DIR, f), 'utf-8')) as KbFile).name) } catch { /* ignore */ }
      }
      if (existingNames.has(finalName)) {
        let i = 2
        while (existingNames.has(`${name} (${i})`)) i++
        finalName = `${name} (${i})`
      }
      const idMap = new Map<string, string>()
      const docs: KbDoc[] = []
      for (const d of raw.docs as { id?: unknown; name?: unknown; chunkCount?: unknown; chars?: unknown; chunkMode?: unknown }[]) {
        if (!d || typeof d.id !== 'string') continue
        const nid = randomUUID()
        idMap.set(d.id, nid)
        docs.push({
          id: nid,
          name: String(d.name ?? '未命名文档').trim().slice(0, 200) || '未命名文档',
          chunkCount: Math.max(0, Math.floor(Number(d.chunkCount) || 0)),
          chars: Number(d.chars) > 0 ? Number(d.chars) : undefined,
          chunkMode: typeof d.chunkMode === 'string' ? d.chunkMode : undefined
        })
      }
      const chunks: KbChunk[] = []
      for (const c of raw.chunks as { docId?: unknown; ordinal?: unknown; text?: unknown }[]) {
        if (!c || typeof c.docId !== 'string' || typeof c.text !== 'string' || !c.text.trim()) continue
        const nid = idMap.get(c.docId)
        if (!nid) continue
        chunks.push({ docId: nid, docName: '', ordinal: Math.max(0, Math.floor(Number(c.ordinal) || 0)), text: c.text.slice(0, DOC_TEXT_CAP) })
      }
      for (const c of chunks) c.docName = docs.find(d => d.id === c.docId)?.name ?? '未命名文档'
      if (docs.length === 0 || chunks.length === 0) return { success: false, error: '文件中没有可导入的文档内容' }
      const kb: KbFile = { id: randomUUID(), name: finalName, createdAt: new Date().toISOString(), docs, chunks }
      saveKb(kb)
      indexes.delete(kb.id)
      return { success: true, meta: metaOf(kb) }
    } catch (err) {
      return { success: false, error: '解析失败：' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // ── 重命名知识库 ──
  ipcMain.handle('knowledge-rename', async (_e, kbId: string, name: string) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false, error: '知识库不存在' }
    const nn = String(name ?? '').trim().slice(0, 100)
    if (!nn) return { success: false, error: '名称不能为空' }
    kb.name = nn
    saveKb(kb)
    return { success: true, meta: metaOf(kb) }
  })

  // ── 重命名文档：同步更新所有块的冗余 docName ──
  ipcMain.handle('knowledge-rename-doc', async (_e, kbId: string, docId: string, name: string) => {
    const kb = loadKb(kbId)
    if (!kb) return { success: false, error: '知识库不存在' }
    const nn = String(name ?? '').trim().slice(0, 200)
    if (!nn) return { success: false, error: '名称不能为空' }
    const doc = kb.docs.find(d => d.id === docId)
    if (!doc) return { success: false, error: '文档不存在' }
    doc.name = nn
    for (const c of kb.chunks) if (c.docId === docId) c.docName = nn
    saveKb(kb)
    indexes.delete(kbId)
    return { success: true }
  })
}
