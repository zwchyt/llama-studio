// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 本地知识库 RAG 服务（knowledgeService）—— BM25 关键词检索，全程离线            ║
// ║                                                                              ║
// ║ 分块：段落感知贪心合并（目标 ~1000 字符），段落不从中间截断，                  ║
// ║       边界断开；单文档块数设上限防失控。                                       ║
// ║ 检索：复用 retrievalService 的 tokenize（驼峰/下划线拆分 + 命令行 flag + CJK 二元组），      ║
// ║       精简 BM25 打分（idf + k1/b）+ 词序（相邻词对）加权，附 idf 加权覆盖率做低置信兜底。   ║
// ║       跨库合并走 RRF 排名融合（各库 idf 量纲不同，裸分不可跨库比较）。                      ║
// ║ 持久化：每个知识库一个 JSON（KNOWLEDGE_DIR/<kbId>.json），含文档与全部分块。   ║
// ║ 索引：按 kbId 惰性构建、驻内存缓存；文档增删时失效，下次查询重建。             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { ipcMain } from 'electron'
import { join, resolve, sep } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import type { KnowledgeBaseMeta, KnowledgeHit } from '../../shared/types'
import { tokenize } from './retrievalService'
// 排序与剪枝策略放在共享模块：工具侧的跨库合并要用同一份实现（避免两处漂移）
import { RELATIVE_NOISE_RATIO, MIN_HIT_SCORE, mergeKbHits } from '../../shared/tools/knowledgeSpecs'

// ── 分块参数 ──
const CHUNK_TARGET = 1000       // 单块目标字符数
const CHUNK_MAX_COUNT = 2000    // 单文档块数上限
const DOC_TEXT_CAP = 4 * 1024 * 1024 // 单文档文本上限（4MB）
// ── 检索参数 ──
const BM25_K1 = 1.2
const BM25_B = 0.75
// 参与打分的查询词数上限。长查询（用户整句 / 整段）会同时从两个方向拖垮检索：
//   1) 稀释——低 idf 的词（如何/应该/什么）几乎每块都命中，贡献的是小分却把所有块的
//      分数一起抬高，真正相关的块拉不开差距，下方 bestScore × 0.15 的剪枝随之失效；
//      中文更甚：tokenize 对中文是逐字二元组，长句会切出大量跨词边界的假词
//      （「如何配置」→「何配」「置知」），噪声随句长增长。
//   2) 覆盖率——coverage = matchedIdf / 查询词 idf 之和，词越多分母越大，几个词没命中
//      就跌破 LOW_CONFIDENCE_COVERAGE，明明找到了对的块却被标低置信。
// 把词集收敛到有界规模可同时解决两者。取 12：关键词式查询（几个词 / 中文几个二元组）
// 远达不到这个数，整句问题必然触发；而 BM25 里十来个高 idf 词之后再加的多是噪声。
const QUERY_TERM_KEEP = 12
// 低置信时回给模型的「建议关键词」个数：从库内真实存在的查询词里按 idf 取前几个。
// 目的是把「建议换个更具体的词重搜」变成「建议改用这些词重搜」——否则模型只能自己猜。
const SUGGEST_TERM_COUNT = 4
// 与工具 spec（knowledgeSpecs.createKnowledgeSearchSpec）声明一致：缺省 8 条目录，上限 12
const QUERY_LIMIT_DEFAULT = 8
const QUERY_LIMIT_MAX = 12
const LOW_CONFIDENCE_SCORE = 3.0
const LOW_CONFIDENCE_COVERAGE = 0.4
// 查询词平均 idf 低于此值即视为「这批词没有区分度」：idf < 0.5 约等于该词出现在 60% 以上的块里。
// 此时 MIN_HIT_SCORE 这个绝对下限会误杀——全库得分都低是因为词太常见，不是内容不相关。
// 实测：拿文档名本身当查询（「Mermaid 渲染格式」）在对应库里 0 命中，原因见 search() 里的判据注释。
const LOW_IDF_AVG = 0.5
// 排序优势判据：top 分是第二名的多少倍以上，就认为本次检索有明确区分度。
// 为什么需要它：上面两个阈值都是「绝对量」，单独用会误判——coverage 尤其明显，
// 查询词一多，命中再准也匹配不全所有词，coverage 天然偏低，于是「top 15、第二名 3.5、
// 第三名 0.5」这种一眼就能看出答案的结果也会被标成低置信。
// 排序优势可以推翻绝对判据：比值够大说明「top 明显优于其余」，这正是我们要的把握度。
const DOMINANT_MARGIN = 2.0
// 但比值大本身不代表可信：所有分数都极低时（0.5 vs 0.1 = 5 倍）那只是噪声里的相对高低。
// 因此只有 top 分达到这个下限，排序优势才算数。
const DOMINANT_MIN_SCORE = 1.0
// 每条命中回带的「命中词」上限（按 idf 降序取前几个）。
// 用途：界面要能说明「为什么这条会被搜出来」——检索走的是词/二元组匹配，
// 块可能只命中其中一两个词，只靠整条查询串做高亮会一个都匹配不到。
const MATCHED_TERM_KEEP = 8

// ── 词序（短语邻接）加权 ──
// BM25 是词袋模型：词与词之间没有顺序概念。「git commit --amend -m」和
// 「commit branch / commit merge / commit checkout...」（Mermaid gitGraph 语法示例）
// 在它眼里都是「git×N commit×M」——实测前者只拿到 5.09，后者靠 commit 出现 9 次拿到 10.59。
// 旧实现只在块「逐字包含完整查询串」时给一个定值 ×2.5，两个问题：
//   1) 全有全无——词序部分吻合的块拿不到任何表示；
//   2) 定值太小——拼不过高词频，正确块加权后仍是 5.09 < 10.59，照样排第二。
// 现在改成按「相邻词对」计分：查询按空白切成词，两两相邻的词在块里也相邻出现才算命中，
// 按命中比例给加成。词序吻合得越多加成越高，全中时分数最多放大 1+PHRASE_BOOST_MAX 倍。
const PHRASE_BOOST_MAX = 3.0
// 两个相邻查询词之间允许夹杂的非字母数字字符数：覆盖 `--`、空格、换行、markdown 反引号等
const ADJACENCY_GAP = 4
// 参与邻接检查的相邻词对上限（长查询只取前几对，避免正则开销随查询长度线性增长）
const ADJACENCY_PAIR_MAX = 8
// 只对原始 BM25 分最高的这些块做邻接检查并重排。块文本正则扫描是开销大头，
// 而「块内相邻出现了查询词」的块必然因为词都命中而已经排在前列，无需全量扫描。
const ADJACENCY_CANDIDATES = 64
// 库级质量软衰减的参考分：库内最高分低于它时，该库的融合权重按比例削弱。
// 否则「本库只有一条勉强过线的弱命中」会靠排名第一拿到与「强命中库」同等的融合权重。
const FUSION_SCALE = 6.0

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 把查询切成相邻词对的正则：每对要求「前词 + 至多 ADJACENCY_GAP 个非字母数字字符 + 后词」。
    单词查询退化为整串包含（与旧行为一致），且沿用旧的 length>=4 门槛避免短词噪声。 */
function buildPhraseMatchers(query: string): RegExp[] {
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, ADJACENCY_PAIR_MAX + 1)
  if (words.length === 0) return []
  if (words.length === 1) {
    const w = words[0]!
    return w.length >= 4 ? [new RegExp(escapeRe(w), 'i')] : []
  }
  const res: RegExp[] = []
  for (let i = 0; i + 1 < words.length && res.length < ADJACENCY_PAIR_MAX; i++) {
    res.push(new RegExp(`${escapeRe(words[i]!)}[^A-Za-z0-9]{0,${ADJACENCY_GAP}}${escapeRe(words[i + 1]!)}`, 'i'))
  }
  return res
}

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

// ── KB 元数据缓存（M11）：列表/重名检测只需元信息，却会全量解析含全部分块的大 JSON。
// 按 (kbId → 文件 mtime) 缓存 meta，文件未变时零解析；保存/改名后 mtime 变化自动失效。──
const kbMetaCache = new Map<string, { meta: KnowledgeBaseMeta; mtimeMs: number }>()
function cachedKbMeta(id: string): KnowledgeBaseMeta | null {
  const fp = kbPath(id)
  let mtimeMs = -1
  try { mtimeMs = statSync(fp).mtimeMs } catch { return null }
  const hit = kbMetaCache.get(id)
  if (hit && hit.mtimeMs === mtimeMs) return hit.meta
  const kb = loadKb(id)
  if (!kb) return null
  const meta = metaOf(kb)
  kbMetaCache.set(id, { meta, mtimeMs })
  return meta
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
// M12：容量上限（Map 插入序即最旧，简易 LRU）——重建成本低，防多库场景无界驻留
const KB_INDEX_MAX = 16
function evictIndexes(): void {
  while (indexes.size >= KB_INDEX_MAX) {
    const oldest = indexes.keys().next().value
    if (oldest === undefined) break
    indexes.delete(oldest)
  }
}

function getIndex(kb: KbFile): KbIndex {
  const cached = indexes.get(kb.id)
  if (cached) return cached
  evictIndexes()
  const idx: KbIndex = { chunks: [], df: new Map(), totalLen: 0 }
  for (const c of kb.chunks) {
    // 文档名属于「文档级」信息，只能计入该文档的首块；块标题由本块正文提取，属于块自身内容。
    // 之前把文档名计进每一块，会让文件名里的词 df = 块数 = N、idf 塌到 ~0.5/N
    // （实测 30 块的库 idf=0.02，正常应约 1.5），后果有两个：
    //   1) 「拿文件名当查询词」反而搜不出东西——与这段代码原本的目的正好相反；
    //   2) 文件名里恰好也出现在正文中的词（如 Mermaid 库的 mermaid/渲染/格式）被一起压权，
    //      正文里明明很有区分度的词被压成噪声，整个库得分低到过不了 MIN_HIT_SCORE。
    // 只计首块后 df 回到「文档数」量级，idf 恢复正常，文件名查询会命中该文档首块。
    const headTokens = tokenize(`${c.ordinal === 0 ? c.docName : ''} ${c.title ?? ''}`)
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
function search(idx: KbIndex, query: string, limit: number): { hits: KnowledgeHit[]; lowConfidence: boolean; suggestedQuery: string } {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return { hits: [], lowConfidence: true, suggestedQuery: '' }
  const N = idx.chunks.length
  if (N === 0) return { hits: [], lowConfidence: true, suggestedQuery: '' }
  const avgdl = idx.totalLen / N || 1
  // 词序匹配器：查询按空白切词、相邻词两两成对（理由见文件头 PHRASE_BOOST_MAX 处注释）
  const phraseRes = buildPhraseMatchers(query)

  // 查询词集：先按 df 过滤并算好 idf（截断与覆盖率都要用）。
  // df=0 的词在库里根本不存在，参与打分只会占坑——而且它们 idf 最高，截断时还会把
  // 真正能命中的词挤出去，所以直接剔除。
  const qIdf = new Map<string, number>()
  const qTerms = new Set(qTokens)
  for (const term of qTerms) {
    const df = idx.df.get(term) ?? 0
    if (df <= 0) continue
    qIdf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)))
  }
  if (qIdf.size === 0) return { hits: [], lowConfidence: true, suggestedQuery: '' }
  // 查询侧词数控制：超过上限只留 idf 最高的 QUERY_TERM_KEEP 个词参与打分（理由见文件头常量处注释）。
  // coverage 的分母也取这个收敛后的词集——否则长查询的分母被无关词撑大，
  // 命中正确块也会因覆盖率偏低被误标低置信。
  const effective = qIdf.size > QUERY_TERM_KEEP
    ? new Set([...qIdf.entries()].sort((a, b) => b[1] - a[1]).slice(0, QUERY_TERM_KEEP).map(([t]) => t))
    : new Set(qIdf.keys())
  let qIdfTotal = 0
  for (const term of effective) qIdfTotal += qIdf.get(term) ?? 0

  const scored: { i: number; score: number; coverage: number; adjacent: number }[] = []
  for (let i = 0; i < N; i++) {
    const c = idx.chunks[i]
    let score = 0
    let matchedIdf = 0
    for (const term of effective) {
      const tf = c.tf.get(term)
      if (!tf) continue
      const idf = qIdf.get(term) ?? 0
      matchedIdf += idf
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * c.len / avgdl))
    }
    if (score <= 0) continue
    scored.push({ i, score, coverage: qIdfTotal > 0 ? matchedIdf / qIdfTotal : 0, adjacent: 0 })
  }
  scored.sort((a, b) => b.score - a.score)
  // 词序加权放在打分之后、只作用于前列候选：块文本正则扫描是开销大头，
  // 而「相邻出现了查询词」的块必然因为词都命中而已经在前面，没必要全量扫。
  if (phraseRes.length > 0) {
    let boosted = false
    for (let k = 0; k < Math.min(scored.length, ADJACENCY_CANDIDATES); k++) {
      const s = scored[k]!
      const c = idx.chunks[s.i]!
      let hitPairs = 0
      for (const re of phraseRes) if (re.test(c.text)) hitPairs++
      if (hitPairs === 0) continue
      s.adjacent = hitPairs / phraseRes.length
      s.score *= 1 + PHRASE_BOOST_MAX * s.adjacent
      boosted = true
    }
    if (boosted) scored.sort((a, b) => b.score - a.score)
  }
  // 双重剪枝：相对阈值（最高分 × 15%，只沾到常见词/文档名共享词的块不进目录）
  // + 绝对下限 MIN_HIT_SCORE。只有相对阈值时，「整库都弱」会把一堆弱块放进来
  // （bestScore 本身低 → 阈值低 → 只沾一个常见词的块也过线）。
  const bestScore = scored[0]?.score ?? 0
  // 但绝对下限在「查询词全是库内常见词」时会反过来误杀：所有 idf 都趋近 0 时全库得分都极低，
  // 门槛会把整个库判成「未命中」——分数低是因为词太常见，不代表内容不相关。
  // 实测：拿文档名本身当查询（「Mermaid 渲染格式」），这几个词因为被计入了每个块的
  // headTokens（getIndex 把 docName/title 的词也放进 tf）而 df = 块数 = 30、idf 塌到 0.02，
  // 全库得分 0.04 远低于门槛 1.0 → 该库 0 命中，而它恰恰是唯一相关的库。
  // 判据要同时满足两条：
  //   1) 平均 idf 过低 —— 词本身没有区分度，低分是词的性质而非内容不相关；
  //   2) 绝对下限确实是压死结果的那一刀（bestScore 本就低于门槛）。
  // 第二条保证本就能出结果的查询行为完全不变——只在这一刀会清空结果时才放开。
  // 放开后结果仍会被标成低置信（bestScore < LOW_CONFIDENCE_SCORE 且无排序优势），
  // 界面照常给黄色提示与建议关键词，不会把弱结果伪装成强结果。
  const avgIdf = effective.size > 0 ? qIdfTotal / effective.size : 0
  const noDiscrimination = avgIdf < LOW_IDF_AVG && bestScore < MIN_HIT_SCORE
  const cutoff = noDiscrimination
    ? bestScore * RELATIVE_NOISE_RATIO
    : Math.max(bestScore * RELATIVE_NOISE_RATIO, MIN_HIT_SCORE)
  // 融合权重用的分母：把「本库根本不存在」的查询词也计入（按 df=0 时的 idf 上界）。
  // 不能复用上面的 coverage —— 它的分母剔除了 df=0 的词，于是「库里没有 amend」
  // 反而让只命中 git/commit 的块拿到 coverage=1.00，置信度判定和跨库排序双双被误导：
  // 越是缺关键词的库，越显得自信。
  const missingIdf = Math.log(1 + (N + 0.5) / 0.5)
  let qIdfFull = qIdfTotal
  for (const term of qTerms) if (!qIdf.has(term)) qIdfFull += missingIdf
  // 库级质量软衰减：库内最高分达不到 FUSION_SCALE 时按比例削弱，避免弱命中库靠排名第一
  // 拿到与强命中库同等的融合权重。
  const libQuality = Math.min(1, bestScore / FUSION_SCALE)
  const hits: KnowledgeHit[] = []
  for (const { i, score, adjacent } of scored) {
    if (hits.length >= limit) break
    if (score < cutoff) break
    const c = idx.chunks[i]
    // 命中词只对「进入目录的条目」计算（≤ limit 条）：为每个候选块都分配数组不值得。
    // 按 idf 降序 —— 排前面的才是真正拉开差距的词，低 idf 的常见词只是顺带沾到。
    const matched = [...effective]
      .filter(t => c.tf.has(t))
      .sort((a, b) => (qIdf.get(b) ?? 0) - (qIdf.get(a) ?? 0))
      .slice(0, MATCHED_TERM_KEEP)
    // 本条的融合权重 = 全量覆盖率 × 库级质量。全量覆盖率的分子只算「进入 effective 的词」
    // 的命中 idf，与分母口径一致。
    let matchedIdfFull = 0
    for (const term of effective) if (c.tf.has(term)) matchedIdfFull += qIdf.get(term) ?? 0
    hits.push({
      docName: c.docName, ordinal: c.ordinal, text: c.text, title: c.title || deriveChunkTitle(c.text),
      score: Math.round(score * 100) / 100, matched,
      ...(adjacent > 0 ? { adjacent: Math.round(adjacent * 100) / 100 } : {}),
      fusionWeight: qIdfFull > 0 ? Math.round((matchedIdfFull / qIdfFull) * libQuality * 1000) / 1000 : 0,
    })
  }
  // 置信度判定 = 绝对阈值 + 排序优势（后者可推翻前者，理由见文件头常量处注释）。
  // 排序优势：top 明显领先第二名，且 top 分不是噪声量级。
  const runnerUpScore = scored[1]?.score ?? 0
  const dominant = runnerUpScore > 0
    && bestScore >= DOMINANT_MIN_SCORE
    && bestScore / runnerUpScore >= DOMINANT_MARGIN
  const weakAbsolute = bestScore < LOW_CONFIDENCE_SCORE
    || (scored[0]?.coverage ?? 0) < LOW_CONFIDENCE_COVERAGE
  const lowConfidence = hits.length === 0 || (weakAbsolute && !dominant)
  // 建议关键词：库内真实存在、且 idf 最高的那几个词，供低置信时直接照抄重搜。
  // 中文经二元组切分后这里会是若干二元组（如「回滚 部署 失败」），对 BM25 而言正是有效查询。
  // 例外：noDiscrimination 时这批词就是用户原查询里那些没有区分度的词，
  // 原样建议回去等于「用同样的词再搜一次」——既帮不上忙，还会让工具白跑一轮自动重搜。
  // 这种情况直接不给建议，界面只留「换更具体的关键词」的提示，工具也跳过重搜。
  const suggestedQuery = noDiscrimination
    ? ''
    : [...effective]
      .sort((a, b) => (qIdf.get(b) ?? 0) - (qIdf.get(a) ?? 0))
      .slice(0, SUGGEST_TERM_COUNT)
      .join(' ')
  return { hits, lowConfidence, suggestedQuery }
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
    const meta = cachedKbMeta(f.slice(0, -5))
    if (meta) out.push({ id: meta.id, name: meta.name })
  }
  return out
}

// ── 按引用读取选中块的完整内容（两阶段检索第二段：模型先 knowledge_search 看标题目录，
// 再用 docName+ordinal 精确读取需要的块，避免把无关块灌进上下文）──
export function readKnowledgeChunks(
  kbId: string,
  refs: { docName?: string; ordinal?: number }[]
): { hits: { docName: string; ordinal: number; title: string; text: string; kbName: string }[]; error?: string } {
  const kb = loadKb(kbId)
  if (!kb) return { hits: [], error: '知识库不存在' }
  const list = Array.isArray(refs) ? refs.slice(0, 8) : []
  if (list.length === 0) return { hits: [], error: '未指定要读取的块' }
  const out: { docName: string; ordinal: number; title: string; text: string; kbName: string }[] = []
  for (const r of list) {
    if (typeof r?.ordinal !== 'number' || !Number.isInteger(r.ordinal) || r.ordinal < 0) continue
    const name = typeof r.docName === 'string' ? r.docName : ''
    const c = kb.chunks.find(x => x.ordinal === r.ordinal && (name ? x.docName === name : true))
    if (c && !out.some(o => o.docName === c.docName && o.ordinal === c.ordinal)) {
      out.push({ docName: c.docName, ordinal: c.ordinal, title: c.title || deriveChunkTitle(c.text), text: c.text, kbName: kb.name })
    }
  }
  return { hits: out }
}

// ── 查询单库（Agent 工具按库逐个调用；跨库合并在 mainTools 工具层做）──
export function queryKnowledgeBase(kbId: string, query: string, limit?: number): { hits: KnowledgeHit[]; lowConfidence: boolean; suggestedQuery: string } {
  if (!query || typeof query !== 'string') return { hits: [], lowConfidence: true, suggestedQuery: '' }
  const kb = loadKb(kbId)
  if (!kb) return { hits: [], lowConfidence: true, suggestedQuery: '' }
  const idx = getIndex(kb)
  const cap = Math.max(1, Math.min(Math.floor(limit ?? QUERY_LIMIT_DEFAULT), QUERY_LIMIT_MAX))
  const r = search(idx, query.slice(0, 2000), cap)
  // 标注来源库：跨库合并目录/读取时模型需要知道每条来自哪个库
  for (const h of r.hits) h.kbName = kb.name
  return r
}

// ── 跨全部知识库检索 ──
// 供知识库界面的「试搜索」使用：一次检索所有库、按相关度合并排序。
// 与 Agent 工具侧的合并语义保持一致（工具侧在此之上还有低置信自动重搜与硬门槛，
// 那是给模型用的；界面要展示真实检索质量，所以不过滤，只如实标注）。
export interface AllKbSearchResult {
  hits: KnowledgeHit[]
  /** 全部库都低置信：整体不可信 */
  lowConfidence: boolean
  /** 置信度偏低的库名（只统计有命中的库；零命中的库归入 missKbNames） */
  lowKbNames: string[]
  /** 完全没命中的库名（不是「不可靠」，只是库里没有相关内容） */
  missKbNames: string[]
  /** 库内真实存在的高 idf 词，低置信时可直接填入搜索框重搜 */
  suggestedQuery: string
  /** top 分相对第二名的倍数（不足两条命中时为 0）：界面据此解释置信度判定 */
  topMargin: number
  /** 实际参与检索的库，供界面展示检索范围 */
  searched: { id: string; name: string }[]
}

export function queryAllKnowledgeBases(query: string, limit?: number): AllKbSearchResult {
  const bases = listKnowledgeBases()
  const empty: AllKbSearchResult = { hits: [], lowConfidence: true, lowKbNames: [], missKbNames: [], suggestedQuery: '', topMargin: 0, searched: [] }
  if (!query || typeof query !== 'string' || !bases.length) return { ...empty, searched: bases }
  const cap = Math.max(1, Math.min(Math.floor(limit ?? QUERY_LIMIT_DEFAULT), QUERY_LIMIT_MAX))
  const per = bases.map(b => queryKnowledgeBase(b.id, query, cap))
  // 合并：与工具侧共用 mergeKbHits（RRF 排名融合 + 全局相对剪枝），保证「跨库搜索」两处行为一致。
  // 注意不要在这里再按 score 排序或比较——score 是各库内部的 BM25 分，量纲不可比。
  const hits = mergeKbHits(per, cap)
  const withHits = per.filter(r => r.hits.length > 0)
  const lowKbNames: string[] = []
  const missKbNames: string[] = []
  per.forEach((r, i) => {
    const name = bases[i]!.name
    // 零命中的库不能算「置信度偏低」——它只是没有相关内容。
    // 混为一谈会让人以为整个检索不可靠：明明 top 30 / 第二名 1.9 这种一眼有答案的结果，
    // 只因为列表里另一个库没命中就报警告。
    if (r.hits.length === 0) missKbNames.push(name)
    else if (r.lowConfidence) lowKbNames.push(name)
  })
  // 建议关键词：各库按 idf 给出的高区分度词取并集（去重保序，最多 6 个）
  const seen = new Set<string>()
  const terms: string[] = []
  for (const r of per) {
    for (const t of r.suggestedQuery.split(/\s+/)) {
      if (!t || seen.has(t)) continue
      seen.add(t)
      terms.push(t)
      if (terms.length >= 6) break
    }
    if (terms.length >= 6) break
  }
  return {
    hits,
    // 整体是否可信：只看「有命中的库」——它们全部不达标才算整体低置信。
    // 零命中的库不进这个判断：没有相关内容 ≠ 命中的结果不可靠。
    // （全部库都零命中时 hits 为空，界面走「未检索到相关内容」分支，这里给 false 避免双重提示。）
    lowConfidence: withHits.length > 0 && withHits.every(r => r.lowConfidence),
    lowKbNames,
    missKbNames,
    suggestedQuery: terms.join(' '),
    // top 相对第二名的倍数：界面用它解释「为什么这次算高置信」——
    // 倍数够大就说明 top 明显优于其余，不该被绝对阈值误判成低置信。
    // 只在「前两名同属一个库」时才算：库内 BM25 分可比，跨库不可比（idf 各算各的）。
    // 跨库时给 0，界面会跳过这段说明，免得用一个没意义的倍数去解释排序。
    topMargin: hits[0] && hits[1] && hits[0].kbName === hits[1].kbName && hits[1].score > 0
      ? Math.round((hits[0].score / hits[1].score) * 10) / 10
      : 0,
    searched: bases,
  }
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
      const meta = cachedKbMeta(f.slice(0, -5))
      if (meta) out.push(meta)
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

  ipcMain.handle('knowledge-query', async (_e, kbId: string, query: string, limit?: number): Promise<{ hits: KnowledgeHit[]; lowConfidence: boolean; suggestedQuery: string }> => {
    return queryKnowledgeBase(kbId, query, limit)
  })

  // 跨全部知识库检索（界面「试搜索」用；与 Agent 工具的合并语义一致，但不过滤低置信）
  ipcMain.handle('knowledge-query-all', async (_e, query: string, limit?: number): Promise<AllKbSearchResult> => {
    return queryAllKnowledgeBases(query, limit)
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
        const meta = cachedKbMeta(f.slice(0, -5))
        if (meta) existingNames.add(meta.name)
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
