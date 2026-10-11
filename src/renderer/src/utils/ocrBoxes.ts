/**
 * OCR 结果解析：从视觉模型输出里提取「文字块 + 位置框」，整理成结构化结果。
 *
 * 支持两种坐标格式：
 * 1. JSON 数组（提示词引导的首选格式）
 *      {"text": "内容", "x1": 0-1000, "y1": ..., "x2": ..., "y2": ...}
 *    坐标为整图 0-1000 归一化坐标。
 * 2. 行格式（专用 OCR 微调模型的常见输出）
 *      text [18, 480, 953, 536]识别出的文字
 *    坐标为图片像素坐标；标签可省略；无坐标的行并入上一块作为续行。
 *
 * 出口统一走 parseOcrResult，返回结构化结果（框列表 / 命中格式 / 警告 / 失败原因），
 * 并完成坐标归一、清洗去重、阅读顺序排序。各环节的取舍见对应函数说明。
 *
 * 已知局限：坐标类型靠数值量级判断，图片本身不超过 1000px 时两种坐标系数值范围重叠，
 * 只能按提示词约定视为归一化；竖排与旋转文字不在排序能力范围内。
 */

export type CoordKind = 'norm' | 'pixel'
export type ParseFormat = 'json' | 'json-slice' | 'line' | 'objects' | 'text-only' | 'plain' | 'none'

export interface OcrBox {
  text: string
  /** 行格式首列的标签（如 text / title）；JSON 格式为 undefined */
  label?: string
  x1: number
  y1: number
  x2: number
  y2: number
  coordKind: CoordKind
  /** 归一化到 0-1000 的坐标：排序与下游统一用这个基准 */
  n: { x1: number; y1: number; x2: number; y2: number }
  /** 是否有可用坐标：false 时 n 全为 0，只展示文字、不画框 */
  hasBox: boolean
  /** 阅读顺序：行号、行内序号；未排序时为 -1 */
  row: number
  col: number
}

export interface OcrParseOptions {
  /** 图片真实宽高。像素坐标按它归一化；缺省时退化为按本批最大坐标估算 */
  imageWidth?: number
  imageHeight?: number
  /** 是否按阅读顺序排序（默认 true） */
  sort?: boolean
  /** 排序策略：auto 自动判断单栏/多栏；rows 只按行；none 保持原顺序 */
  strategy?: 'auto' | 'rows' | 'none'
}

export interface OcrParseResult {
  /** 是否解析出可用结果（空数组也算成功：图片里确实没文字） */
  ok: boolean
  /** 命中的解析格式；none 表示都没命中 */
  format: ParseFormat
  boxes: OcrBox[]
  sorted: boolean
  /** 清洗与降级过程中的提示 */
  warnings: string[]
  rawText: string
  /** ok=false 时的原因 */
  reason?: string
}

export interface BoxesToTextOptions {
  /** 同一行内多块之间、行与行之间的连接符 */
  colSeparator?: string
  rowSeparator?: string
  /** 是否把同一行合并为一行（false = 每块一行） */
  mergeSameRow?: boolean
  /** 是否保留行格式的标签前缀 */
  keepLabel?: boolean
}

const NORM_MAX = 1000
/** 归一化基准下的最小块尺寸，小于它视为噪点。
 *  1 = 图像尺寸的 0.1%（2000px 宽的图上约 2px）；单字小框被误删时可下调。 */
const MIN_NORM_SIZE = 1
/** 分栏检测要求的最小列间距（归一化基准） */
const COLUMN_GAP = 40
/** 同一行判据：纵向重叠比例 / 中心线距离相对中位行高的比例 */
const ROW_OVERLAP = 0.5
const ROW_CENTER_RATIO = 0.6

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 宽松取数：兼容数字与字符串形式的数字 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 解析中间态：坐标仍是原始值，n 与 row/col 待归一化、排序后填 */
interface RawBox {
  text: string
  label?: string
  /** null = 只有文字、没有可用坐标（坐标缺失或非法） */
  rect: { x1: number; y1: number; x2: number; y2: number; coordKind: CoordKind } | null
}

/** 坐标类型判断：>1000 不可能是 0-1000 归一化坐标 → 按像素坐标处理 */
function coordKindOf(max: number): CoordKind {
  return max > NORM_MAX ? 'pixel' : 'norm'
}

/** 统一构造：坐标非法（缺失 / 反向 / 零面积）时不丢弃文字，只标记为无位置 */
function makeRaw(text: string, label: string | undefined, c: number[] | null): RawBox | null {
  const t = text.trim()
  if (!t) return null
  const noPos: RawBox = { text: t, label, rect: null }
  if (!c) return noPos
  let [x1, y1, x2, y2] = c
  if (![x1, y1, x2, y2].every(Number.isFinite)) return noPos
  if (x1 > x2) [x1, x2] = [x2, x1]
  if (y1 > y2) [y1, y2] = [y2, y1]
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return noPos
  return { text: t, label, rect: { x1, y1, x2, y2, coordKind: coordKindOf(Math.max(x1, y1, x2, y2)) } }
}

const TEXT_KEYS = ['text', 'content', 'value']
const BOX_KEYS = ['bbox', 'box', 'rect', 'coords', 'coordinates']

/** 坐标字段兼容：x1/y1/x2/y2、left/top/right/bottom，或 bbox/box/rect 四元数组 */
function readCoords(o: Record<string, unknown>): number[] | null {
  const direct = [num(o.x1 ?? o.left), num(o.y1 ?? o.top), num(o.x2 ?? o.right), num(o.y2 ?? o.bottom)]
  if (direct.every((v) => v !== undefined)) return direct as number[]
  for (const k of BOX_KEYS) {
    const arr = o[k]
    if (Array.isArray(arr) && arr.length >= 4) {
      const v = arr.slice(0, 4).map(num)
      if (v.every((n) => n !== undefined)) return v as number[]
    }
  }
  return null
}

function rawFromObject(item: unknown): RawBox | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const text = TEXT_KEYS.map((k) => o[k]).find((v): v is string => typeof v === 'string')
  if (!text) return null
  // 坐标拿不到也要保留文字：只标记为无位置，交给上层决定怎么展示
  return makeRaw(text, typeof o.label === 'string' ? o.label : undefined, readCoords(o))
}

/** 宽松 JSON：先直解，失败再修补常见毛病（尾逗号、无引号键名、整体单引号、
 *  形如 "x1": 0-1000 的占位符范围值——模型常把示例里的范围原样抄下来） */
function looseParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch { /* 继续修补 */ }
  let t = s.replace(/,\s*([\]}])/g, '$1')
  t = t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
  t = t.replace(/:\s*-?\d+(?:\.\d+)?\s*-\s*-?\d+(?:\.\d+)?\s*(?=[,}])/g, ': null')
  if (!t.includes('"')) t = t.replace(/'/g, '"')
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

/** 从第一个 [ 起做括号配对扫描，返回完整数组文本（容忍字符串内的括号与转义） */
function sliceBalancedArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** 逐个收集配对完整的 {...} 片段（数组被截断、或无数组包裹时兜底） */
function collectBalancedObjects(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        out.push(text.slice(i, j + 1))
        i = j
        break
      }
    }
  }
  return out
}

const LINE_COORD_RE = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/
const LINE_LABEL_RE = /^[A-Za-z_][\w-]*$/

/** 续行拼接：表格块内保留换行（换行就是表格的行边界，吃掉就再也还原不了）；
 *  其余情况按中英文习惯接续——两侧都是 ASCII 单词字符时补空格，中日韩文本直接相接。 */
function joinContinuation(prev: string, next: string): string {
  if (/<table>/i.test(prev) || next.startsWith('|')) return `${prev}\n${next}`
  return /[\w]$/.test(prev) && /^\w/.test(next) ? `${prev} ${next}` : prev + next
}

/** 行格式：`标签? [x1,y1,x2,y2]内容`；标签可省略，无坐标的行并入上一块 */
function parseLineFormat(text: string): RawBox[] {
  const boxes: RawBox[] = []
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = LINE_COORD_RE.exec(line)
    if (!m) {
      const last = boxes[boxes.length - 1]
      if (last) last.text = joinContinuation(last.text, line)
      continue
    }
    const before = line.slice(0, m.index).trim()
    const after = line.slice(m.index + m[0].length).trim()
    const label = LINE_LABEL_RE.test(before) ? before : undefined
    const content = label ? after : `${before} ${after}`.trim()
    const b = makeRaw(content, label, [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
    if (b) boxes.push(b)
  }
  return boxes
}

const TABLE_TAG_RE = /^\s*<table>([\s\S]*?)<\/table>\s*$/i

/**
 * 表格块整理：
 * 1) 剥掉模型的 <table>…</table> 包裹；
 * 2) 只有当内容里存在**一致**的列分隔（每行的 `|` 或制表符数量相同、且至少两列）时才转成 Markdown 表格；
 * 3) 否则原样返回纯文本。
 *
 * 为什么这么保守：实测（Baidu-OCR）模型大多把单元格首尾相连地吐出来，中间没有分隔符；
 * 偶尔出现的 `|` 是它自己插错的，按它硬拆只会造出列数错误的表格，比不拆更糟。
 */
function normalizeTableText(text: string): string {
  const m = TABLE_TAG_RE.exec(text)
  if (!m) return text
  const inner = m[1].trim()
  if (!inner) return ''

  for (const sep of ['|', '\t']) {
    const rows = inner.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean)
    if (rows.length < 2) continue
    const cells = rows.map((r) => {
      const parts = r.split(sep).map((c) => c.trim())
      // 行首/行尾的 | 会产生空单元格，去掉
      if (parts.length > 1 && parts[0] === '') parts.shift()
      if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
      return parts
    })
    const cols = cells[0].length
    if (cols < 2 || !cells.every((c) => c.length === cols)) continue
    const header = `| ${cells[0].join(' | ')} |`
    const divider = `| ${cells[0].map(() => '---').join(' | ')} |`
    const body = cells.slice(1).map((c) => `| ${c.join(' | ')} |`)
    return [header, divider, ...body].join('\n')
  }
  return inner
}

/**
 * 归一化：pixel 按真实图片尺寸折算到 0-1000（缺尺寸时按本批最大坐标估算并记警告），
 * norm 直接裁剪到 0-1000。结果填进 box.n，供排序与下游统一使用。
 */
function finalize(rawBoxes: RawBox[], opts: OcrParseOptions, warnings: string[]): OcrBox[] {
  const positioned = rawBoxes.filter((b): b is RawBox & { rect: NonNullable<RawBox['rect']> } => b.rect !== null)
  const pix = positioned.filter((b) => b.rect.coordKind === 'pixel')
  let sx = 1
  let sy = 1
  if (pix.length > 0) {
    const w = opts.imageWidth
    const h = opts.imageHeight
    if (w && h) {
      sx = NORM_MAX / w
      sy = NORM_MAX / h
    } else {
      // 用 reduce 而不是 Math.max(...arr)：框数很多时展开会超参数上限
      const maxOf = (pick: (b: (typeof pix)[number]) => number): number =>
        pix.reduce((m, b) => Math.max(m, pick(b)), 1)
      sx = NORM_MAX / maxOf((b) => b.rect.x2)
      sy = NORM_MAX / maxOf((b) => b.rect.y2)
      warnings.push('未提供图片尺寸，像素坐标按本批最大坐标估算基准，排序可能不准')
    }
  }
  const kinds = new Set(positioned.map((b) => b.rect.coordKind))
  if (kinds.size > 1) warnings.push('同一批结果里混用了归一化与像素坐标，已分别换算到统一基准')
  // 只有「一部分有坐标、一部分没有」时才提示；全都无坐标属于 plain 兜底，那条警告说得更具体
  if (positioned.length > 0 && positioned.length < rawBoxes.length) {
    warnings.push(`${rawBoxes.length - positioned.length} 个文字块没有可用坐标，只展示文字、不在图上标注`)
  }

  return rawBoxes.map((b): OcrBox => {
    const text = normalizeTableText(b.text)
    if (!b.rect) {
      return {
        text, label: b.label, x1: 0, y1: 0, x2: 0, y2: 0, coordKind: 'norm',
        n: { x1: 0, y1: 0, x2: 0, y2: 0 }, hasBox: false, row: -1, col: -1
      }
    }
    const kx = b.rect.coordKind === 'pixel' ? sx : 1
    const ky = b.rect.coordKind === 'pixel' ? sy : 1
    return {
      text,
      label: b.label,
      x1: b.rect.x1,
      y1: b.rect.y1,
      x2: b.rect.x2,
      y2: b.rect.y2,
      coordKind: b.rect.coordKind,
      n: {
        x1: clamp(b.rect.x1 * kx, 0, NORM_MAX),
        y1: clamp(b.rect.y1 * ky, 0, NORM_MAX),
        x2: clamp(b.rect.x2 * kx, 0, NORM_MAX),
        y2: clamp(b.rect.y2 * ky, 0, NORM_MAX)
      },
      hasBox: true,
      row: -1,
      col: -1
    }
  })
}

function iou(a: OcrBox['n'], b: OcrBox['n']): number {
  const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (areaA + areaB - inter)
}

/** 清洗：丢弃过小/无效块；同一位置重复识别时保留文字更长的那个 */
function cleanBoxes(boxes: OcrBox[], warnings: string[]): OcrBox[] {
  const kept: OcrBox[] = []
  let tiny = 0
  let dup = 0
  for (const b of boxes) {
    // 无位置的块不做尺寸过滤：它的尺寸本来就是 0，但它承载着识别到的文字
    if (b.hasBox && (b.n.x2 - b.n.x1 < MIN_NORM_SIZE || b.n.y2 - b.n.y1 < MIN_NORM_SIZE)) {
      tiny++
      continue
    }
    const hit = kept.find((o) => iou(o.n, b.n) > 0.9)
    if (hit) {
      if (b.text.length > hit.text.length) hit.text = b.text
      dup++
      continue
    }
    kept.push(b)
  }
  if (tiny > 0) warnings.push(`丢弃 ${tiny} 个过小或无效的文字块`)
  if (dup > 0) warnings.push(`合并 ${dup} 个位置重复的文字块`)
  return kept
}

/**
 * 分栏检测（XY-cut 简化版）：找一条没有框跨越的纵向空白，把页面切成左右两栏。
 * 取间隙最大的一条切分；要求每侧至少 2 个框、间隙不小于 COLUMN_GAP。
 */
function splitColumns(boxes: OcrBox[]): [OcrBox[], OcrBox[]] | null {
  const byLeft = [...boxes].sort((a, b) => a.n.x1 - b.n.x1)
  let best: { i: number; gap: number } | null = null
  let leftMax = -Infinity
  for (let i = 0; i < byLeft.length - 1; i++) {
    leftMax = Math.max(leftMax, byLeft[i].n.x2)
    if (i + 1 < 2 || byLeft.length - i - 1 < 2) continue
    const rightMin = Math.min(...byLeft.slice(i + 1).map((b) => b.n.x1))
    const gap = rightMin - leftMax
    if (gap >= COLUMN_GAP && (!best || gap > best.gap)) best = { i, gap }
  }
  return best ? [byLeft.slice(0, best.i + 1), byLeft.slice(best.i + 1)] : null
}

/**
 * 行聚类：先按上边排序，再贪心成行。
 * 同一行 = 纵向重叠 ≥ 较小块高的一半，或中心线距离 ≤ 中位行高的 ROW_CENTER_RATIO 倍
 * （后者应对行高不齐、块高矮不一的情况）。
 */
function clusterRows(boxes: OcrBox[]): OcrBox[][] {
  const sorted = [...boxes].sort((a, b) => a.n.y1 - b.n.y1 || a.n.x1 - b.n.x1)
  const heights = sorted.map((b) => b.n.y2 - b.n.y1).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 1
  const rows: OcrBox[][] = []
  let cur: OcrBox[] = []
  let curTop = 0
  let curBottom = 0
  for (const b of sorted) {
    if (cur.length === 0) {
      cur = [b]
      curTop = b.n.y1
      curBottom = b.n.y2
      continue
    }
    const overlap = Math.min(curBottom, b.n.y2) - Math.max(curTop, b.n.y1)
    const minH = Math.min(curBottom - curTop, b.n.y2 - b.n.y1)
    const centerDiff = Math.abs((b.n.y1 + b.n.y2) / 2 - (curTop + curBottom) / 2)
    if (overlap >= minH * ROW_OVERLAP || centerDiff <= medianH * ROW_CENTER_RATIO) {
      cur.push(b)
      curTop = Math.min(curTop, b.n.y1)
      curBottom = Math.max(curBottom, b.n.y2)
    } else {
      rows.push(cur)
      cur = [b]
      curTop = b.n.y1
      curBottom = b.n.y2
    }
  }
  if (cur.length > 0) rows.push(cur)
  return rows
}

/**
 * 阅读顺序排序：栏（auto 时先分栏）→ 行 → 行内从左到右，同时写入 row / col。
 * 局限：多栏与表格能靠空白切分处理，竖排与旋转文字仍不适用。
 */
function sortReadingOrder(boxes: OcrBox[], strategy: 'auto' | 'rows'): OcrBox[] {
  const positioned = boxes.filter((b) => b.hasBox)
  const unpositioned = boxes.filter((b) => !b.hasBox)

  const blocks: OcrBox[][] = []
  const collect = (list: OcrBox[], depth: number): void => {
    if (list.length === 0) return
    const split = strategy === 'auto' && depth < 2 ? splitColumns(list) : null
    if (split) {
      collect(split[0], depth + 1)
      collect(split[1], depth + 1)
    } else {
      blocks.push(list)
    }
  }
  collect(positioned, 0)

  const out: OcrBox[] = []
  let rowIdx = 0
  for (const block of blocks) {
    for (const row of clusterRows(block)) {
      row.sort((a, b) => a.n.x1 - b.n.x1)
      row.forEach((b, ci) => {
        b.row = rowIdx
        b.col = ci
      })
      out.push(...row)
      rowIdx++
    }
  }
  // 无位置块按原顺序追加到末尾，各自独占一行
  for (const b of unpositioned) {
    b.row = rowIdx
    b.col = 0
    out.push(b)
    rowIdx++
  }
  return out
}

/** 最后的兜底：直接从原文里抽取 "text" 字段的内容。
 *  坐标非法导致整段 JSON 解析失败时（例如模型把示例里的 0-1000 原样抄下来），
 *  文字本身往往是对的，不该跟着一起丢掉。 */
function extractTextFieldValues(text: string): string[] {
  const out: string[] = []
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // 单遍解转义。分成多次 replace 会把 \\n（转义的反斜杠 + 字母 n）误当成换行
    const v = m[1]
      .replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
        if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16))
        if (esc === 'n') return '\n'
        if (esc === 't') return '\t'
        if (esc === 'r') return '\r'
        return esc
      })
      .trim()
    if (v) out.push(v)
  }
  return out
}

export function parseOcrResult(raw: string, opts: OcrParseOptions = {}): OcrParseResult {
  const rawText = raw ?? ''
  const warnings: string[] = []
  const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const fail = (reason: string): OcrParseResult =>
    ({ ok: false, format: 'none', boxes: [], sorted: false, warnings, rawText, reason })

  if (!text) return fail('模型没有输出任何内容')

  // 解析数组文本：null = 不是数组也不是对象；[] = 合法空数组（图片里没文字）
  const fromArray = (s: string): RawBox[] | null => {
    const v = looseParse(s)
    // 数组是首选；模型偶尔只给单个对象，也接受
    const items = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null
    if (!items) return null
    return items.map(rawFromObject).filter((b): b is RawBox => b !== null)
  }

  let format: ParseFormat = 'none'
  let rawBoxes: RawBox[] = []

  // 只有真的解析出文字块才算命中；否则继续往下试下一级。
  // （例如行格式里的 `text [8, 16, 740, 85]…` 会被 sliceBalancedArray 误当成数组，
  //   若就此收手就会得到 0 个块——必须继续走到 parseLineFormat。）
  const take = (f: ParseFormat, boxes: RawBox[]): void => {
    if (boxes.length > 0) {
      format = f
      rawBoxes = boxes
    }
  }

  const direct = fromArray(text)
  if (direct !== null) take('json', direct)
  // 「整段本身就是一个空数组」才算空结果。正文里出现 [1,2,3] 这类括号同样会被解析成空数组，
  // 若据此判定「图里没文字」，会把真正识别到的文字降级掉。
  const isBareEmptyArray = direct !== null && direct.length === 0 && text.replace(/[\s,[\]]/g, '') === ''
  if (format === 'none') {
    const sliced = sliceBalancedArray(text)
    const arr = sliced ? fromArray(sliced) : null
    if (arr !== null) take('json-slice', arr)
  }
  if (format === 'none') {
    take('line', parseLineFormat(text))
  }
  if (format === 'none') {
    const objs = collectBalancedObjects(text)
      .map((s) => rawFromObject(looseParse(s)))
      .filter((b): b is RawBox => b !== null)
    take('objects', objs)
  }
  // 兜底：坐标坏掉导致结构化解析全失败时，至少把文字捞回来
  if (format === 'none') {
    take('text-only', extractTextFieldValues(text).map((t) => ({ text: t, rect: null })))
  }
  // 整段就是一个空数组：图里确实没文字，与解析失败区分开
  if (format === 'none' && isBareEmptyArray) {
    warnings.push('模型未识别到文字（返回空数组）')
    return { ok: true, format: 'json', boxes: [], sorted: false, warnings, rawText }
  }
  // 最后兜底：模型完全没按结构输出（直接一整段纯文本，实测 Baidu-OCR 会这样）。
  // 整段当作一个无位置文字块——比把原文丢给界面强：结果区仍能正常渲染（含公式），只是没有框。
  if (format === 'none') {
    format = 'plain'
    rawBoxes = [{ text: text.trim(), rect: null }]
    warnings.push('模型未按结构化格式输出，已把整段文字作为单个文字块展示（无位置）')
  }

  const cleaned = cleanBoxes(finalize(rawBoxes, opts, warnings), warnings)
  if (cleaned.length === 0) return fail('解析出的文字块全部无效（尺寸过小或坐标为零）')

  const strategy = opts.strategy ?? 'auto'
  const doSort = opts.sort !== false && strategy !== 'none'
  const boxes = doSort ? sortReadingOrder(cleaned, strategy) : cleaned
  return { ok: true, format, boxes, sorted: doSort, warnings, rawText }
}

/**
 * 纯文本输出。默认按行合并：同一行的多块用 colSeparator 连接，行与行用 rowSeparator。
 * 未排序（row 为 -1）时每块独占一行。
 */
export function boxesToText(boxes: OcrBox[], opts: BoxesToTextOptions = {}): string {
  const {
    colSeparator = ' ',
    rowSeparator = '\n',
    mergeSameRow = true,
    keepLabel = false
  } = opts
  const fmt = (b: OcrBox): string => (keepLabel && b.label ? `${b.label} ${b.text}` : b.text)

  if (!mergeSameRow) return boxes.map(fmt).join(rowSeparator)

  const lines: string[] = []
  let curRow = -2
  for (const b of boxes) {
    if (b.row < 0) {
      lines.push(fmt(b))
      curRow = -2
    } else if (b.row !== curRow) {
      lines.push(fmt(b))
      curRow = b.row
    } else {
      lines[lines.length - 1] += colSeparator + fmt(b)
    }
  }
  return lines.join(rowSeparator)
}
