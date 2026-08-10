/**
 * OCR 结果解析：从视觉模型输出的文本中提取「文字块 + 位置框」。
 *
 * 支持两种坐标格式：
 * 1. JSON 数组（提示词引导的首选格式），每项形如：
 *      {"text": "文字内容", "x1": 100, "y1": 120, "x2": 320, "y2": 150}
 *    坐标为整张图片的 0-1000 归一化坐标系（左上角 0,0，右下角 1000,1000）。
 * 2. 行格式（部分视觉模型训练习得的格式，如 Qwen 系 OCR 微调模型），每行形如：
 *      text [18, 480, 953, 536]识别出的文字
 *      title [12, 357, 264, 406]标题内容
 *    坐标为图片像素坐标。
 *
 * 实际输出常带 markdown 代码块、前后散文、或对象被截断，这里做多级容错：
 * 整段 JSON 数组 → 截取 [..] → 行格式逐行 → 逐对象收集。
 */

export interface OcrBox {
  text: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** norm = 0-1000 归一化坐标（JSON 格式）；pixel = 图片像素坐标（行格式） */
  coordKind: 'norm' | 'pixel'
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 坐标基准判断：模型输出可能混用两种坐标系——
 * - 0-1000 归一化（Qwen 系惯例，数值 ≤ 1000）
 * - 图片像素坐标（数值接近图片实际宽高，常 > 1000）
 * 按最大值粗略区分：> 1000 视为像素坐标，否则视为 0-1000 归一化。
 */
function coordKindOf(x1: number, y1: number, x2: number, y2: number): 'norm' | 'pixel' {
  return Math.max(x1, y1, x2, y2) > 1000 ? 'pixel' : 'norm'
}

function toBox(item: unknown): OcrBox | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  if (typeof o.text !== 'string' || !o.text.trim()) return null
  if (!isNum(o.x1) || !isNum(o.y1) || !isNum(o.x2) || !isNum(o.y2)) return null
  // 只约束下限（负数），上限不 clamp：像素坐标必须保留原值才能按图片尺寸归一化
  let x1 = Math.max(0, o.x1)
  let y1 = Math.max(0, o.y1)
  let x2 = Math.max(0, o.x2)
  let y2 = Math.max(0, o.y2)
  if (x1 > x2) [x1, x2] = [x2, x1]
  if (y1 > y2) [y1, y2] = [y2, y1]
  if (x2 - x1 < 1 || y2 - y1 < 1) return null
  return { text: o.text.trim(), x1, y1, x2, y2, coordKind: coordKindOf(x1, y1, x2, y2) }
}

/** 行格式：`text [12, 357, 264, 406]内容` / `title [18, 480, 953, 536]标题` */
const LINE_FORMAT_RE = /^\s*([a-zA-Z_][\w-]*)\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*(.+)$/

function parseLineFormat(text: string): OcrBox[] | null {
  const boxes: OcrBox[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(LINE_FORMAT_RE)
    if (!m) continue
    const x1 = Number(m[2])
    const y1 = Number(m[3])
    const x2 = Number(m[4])
    const y2 = Number(m[5])
    const content = m[6].trim()
    if (!content) continue
    if (x2 - x1 < 1 || y2 - y1 < 1) continue
    boxes.push({ text: content, x1, y1, x2, y2, coordKind: coordKindOf(x1, y1, x2, y2) })
  }
  return boxes.length > 0 ? boxes : null
}

export function extractOcrBoxes(raw: string): OcrBox[] | null {
  if (!raw) return null
  let text = raw.trim()
  // 去掉 markdown 代码块围栏（```json ... ```）
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

  const tryParse = (s: string): OcrBox[] | null => {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) {
        const boxes = arr.map(toBox).filter((b): b is OcrBox => b !== null)
        if (boxes.length > 0 || arr.length === 0) return boxes
      }
    } catch { /* 继续尝试下一级 */ }
    return null
  }

  // 1) 整段直接解析（JSON 数组，0-1000 归一化）
  const direct = tryParse(text)
  if (direct) return direct

  // 2) 截取第一个 [ 到最后一个 ] 之间的内容再解析（容忍前后散文）
  const s = text.indexOf('[')
  const e = text.lastIndexOf(']')
  if (s >= 0 && e > s) {
    const sliced = tryParse(text.slice(s, e + 1))
    if (sliced) return sliced
  }

  // 3) 行格式逐行（text/title [x1,y1,x2,y2]内容，像素坐标）
  const lineBoxes = parseLineFormat(text)
  if (lineBoxes) return lineBoxes

  // 4) 逐对象收集（容忍模型按行输出 JSON 对象、无数组包裹）
  const boxes: OcrBox[] = []
  const objRe = /\{[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = objRe.exec(text)) !== null) {
    try {
      const b = toBox(JSON.parse(m[0]))
      if (b) boxes.push(b)
    } catch { /* 跳过无法解析的对象 */ }
  }
  return boxes.length > 0 ? boxes : null
}

/** 解析成功时用于复制的纯文本（每块一行） */
export function boxesToText(boxes: OcrBox[]): string {
  return boxes.map(b => b.text).join('\n')
}
