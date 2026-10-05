// 浏览器预览类工具（browser_show / browser_screenshot）的结果区渲染：
// 把结果 JSON 摊成项目统一的「标签 | 值」参数框（.agent-tool-io-group）。
//
// 原则：结果里的字段一个都不省略——已知字段用中文标签并按固定顺序排列，
// 表里没有的字段按 JSON 原顺序追加在末尾；工具将来新增字段时界面也不会静默丢掉。
// 只做「结构 + 可读性」的加工（布尔转中文、URL 解码、宽高合成尺寸），不改内容。
import React, { useMemo } from 'react'

const LABELS: Record<string, string> = {
  ok: '状态',
  date: '日期',
  time: '时间',
  type: '类型',
  title: '标题',
  url: '地址',
  error: '错误',
  imageId: '图片',
  mimeType: '格式',
  fullPage: '范围',
  note: '说明',
}

// 已知字段的渲染顺序（未列出的字段按 JSON 原顺序追加）
const ORDER = ['date', 'time', 'type', 'title', 'url', 'imageId', 'mimeType', 'fullPage', 'note', 'error']

function formatValue(key: string, v: unknown): string {
  if (key === 'ok') return v === true ? '成功' : '失败'
  if (key === 'fullPage') return v === true ? '完整可滚动页面' : '当前可视区域'
  // imageId 形如 chatimg://xxx.png，协议前缀对用户没有意义
  if (key === 'imageId' && typeof v === 'string') return v.replace(/^chatimg:\/\//, '')
  // url 可能是百分号转义的 file:/// 形式，解码后去掉协议头才读得出是哪个文件
  if (key === 'url' && typeof v === 'string') {
    const decoded = (() => { try { return decodeURIComponent(v) } catch { return v } })()
    return decoded.replace(/^file:\/\/\/?/i, '')
  }
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// skip：已在别处展示过的字段（例如尺寸已作为图片题注），这里不再重复成行——
// 只是不重复，不是丢弃：那些值在上方已经可见。
export function buildResultRows(o: Record<string, unknown>, skip: string[] = []): Array<[string, string]> {
  const skipped = new Set(skip)
  const rows: Array<[string, string]> = []
  const used = new Set<string>()
  if ('ok' in o && !skipped.has('ok')) {
    rows.push(['状态', formatValue('ok', o.ok)])
    used.add('ok')
  }
  // 宽高合成一行「尺寸」，比拆成两行好读
  if (!skipped.has('width') && !skipped.has('height')
    && typeof o.width === 'number' && typeof o.height === 'number') {
    rows.push(['尺寸', `${o.width}×${o.height}`])
    used.add('width')
    used.add('height')
  }
  for (const k of ORDER) {
    if (used.has(k) || skipped.has(k) || !(k in o)) continue
    used.add(k)
    rows.push([LABELS[k] ?? k, formatValue(k, o[k])])
  }
  for (const k of Object.keys(o)) {
    if (used.has(k) || skipped.has(k)) continue
    rows.push([k, formatValue(k, o[k])])
  }
  return rows
}

/** 结果文本 → 结果对象；非 JSON / 无 ok 字段时返回 null（交给默认结果视图） */
export function parseResultObject(result?: string): Record<string, unknown> | null {
  if (!result) return null
  try {
    const o = JSON.parse(result) as unknown
    if (o && typeof o === 'object' && typeof (o as { ok?: unknown }).ok === 'boolean') return o as Record<string, unknown>
  } catch { /* 非 JSON 结果（例如异常文本）交给默认结果视图 */ }
  return null
}

/** 结果不是预期 JSON 时的兜底：原文放进结果框，保证内容不被丢掉。
    调用方已从通用结果视图里排除，这里必须自己兜住。 */
export function RawResultFallback({ result }: { result?: string }) {
  if (!result) return null
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">结果</span>
      </div>
      <pre className="agent-tool-result-pre">{result}</pre>
    </div>
  )
}

// 横向键值流：字段横向排开、宽度不够才换行。
// 结果字段个数不定（3~6 个），用参数区那种「一行一个字段」的三列网格会竖向拉得很长；
// 这里改用横向流，卡片高度稳定在一两行内。
export default function ToolResultRows({ rows }: { rows: Array<[string, string]> }) {
  if (!rows.length) return null
  return (
    <div className="agent-tool-kv-flow">
      {rows.map(([label, value], i) => (
        <span className="agent-tool-kv-item" key={`${label}-${i}`}>
          <span className="agent-tool-kv-key">{label}</span>
          <span className="agent-tool-kv-val">{value}</span>
        </span>
      ))}
    </div>
  )
}

/** 结果文本 → 普通 JSON 对象（不要求 ok 字段，get_datetime 这类工具没有它） */
export function parseJsonObject(result?: string): Record<string, unknown> | null {
  if (!result) return null
  try {
    const o = JSON.parse(result) as unknown
    if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>
  } catch { /* 非 JSON 结果交给兜底 */ }
  return null
}

/** 通用「结果是一个扁平 JSON 对象」的结果卡：摊成横向键值行（如 get_datetime 的日期/时间）。
    非 JSON 时退回原文，内容不丢。 */
export function JsonResultCard({ result, label = '结果' }: { result?: string; label?: string }) {
  const parsed = useMemo(() => parseJsonObject(result), [result])
  if (!parsed) return <RawResultFallback result={result} />
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">{label}</span>
      </div>
      <ToolResultRows rows={buildResultRows(parsed)} />
    </div>
  )
}
