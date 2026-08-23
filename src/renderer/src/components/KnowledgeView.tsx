import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Plus, Trash2, FileText, Loader2, Search, Upload, X, AlertTriangle, Download, FileUp, Pencil, Check, ChevronUp, ChevronDown, Copy, Eye, Settings2 } from 'lucide-react'
import { notify } from '../store/notificationStore'
import CustomSelect from './CustomSelect'
import { extractTextFromFile } from '../utils/extractText'
import type { KnowledgeBaseMeta, KnowledgeDoc, KnowledgeDocContent, KnowledgeHit } from '../../../shared/types'
import '../styles/knowledge.css'

// ── 预览高亮：按大小写不敏感切分文本为 命中/未命中 片段 ──
function splitHighlight(text: string, q: string): { t: string; hit: boolean }[] {
  const query = q.trim()
  if (!query) return [{ t: text, hit: false }]
  const lower = text.toLowerCase()
  const ql = query.toLowerCase()
  const out: { t: string; hit: boolean }[] = []
  let pos = 0
  while (pos < text.length) {
    const i = lower.indexOf(ql, pos)
    if (i === -1) { out.push({ t: text.slice(pos), hit: false }); break }
    if (i > pos) out.push({ t: text.slice(pos, i), hit: false })
    out.push({ t: text.slice(i, i + query.length), hit: true })
    pos = i + query.length
  }
  return out
}

function Hl({ text, q }: { text: string; q: string }) {
  if (!q.trim()) return <>{text}</>
  return (
    <>
      {splitHighlight(text, q).map((s, i) =>
        s.hit ? <mark key={i} className="kb-hl">{s.t}</mark> : <React.Fragment key={i}>{s.t}</React.Fragment>
      )}
    </>
  )
}

function formatChars(n?: number): string {
  if (n === undefined) return '—'
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字'
  return n + ' 字'
}

type ChunkMode = 'auto' | 'heading' | 'delim' | 'single' | 'manual' | 'code'

// ── 分块偏好按知识库记忆：每个库各自记住上次用的分块方式，切换库时同步回显 ──
const KB_CHUNK_PREFS_KEY = 'llama-studio-kb-chunk-prefs'
interface KbChunkPref { mode: ChunkMode; size: number; delimiter: string }

function loadKbChunkPrefs(): Record<string, KbChunkPref> {
  try {
    const raw = localStorage.getItem(KB_CHUNK_PREFS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

// ── 手动分块编辑器：行号预览，点击两行定义一个块的区间；点击已覆盖行删除该区间 ──
function ManualChunkModal({ fileName, text, ranges, onChange, onCancel, onConfirm, busy }: {
  fileName: string
  text: string
  ranges: number[][]
  onChange: (r: number[][]) => void
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  const lines = useMemo(() => text.replace(/\r\n/g, '\n').split('\n'), [text])
  const [anchor, setAnchor] = useState<number | null>(null)
  const inRange = useMemo(() => {
    const m = new Map<number, number>()
    ranges.forEach((r, ri) => {
      for (let i = r[0]; i <= Math.min(r[1], lines.length); i++) m.set(i, ri)
    })
    return m
  }, [ranges, lines.length])
  const uncovered = useMemo(
    () => lines.filter((l, i) => !inRange.has(i + 1) && l.trim()).length,
    [lines, inRange]
  )

  const clickLine = (n: number) => {
    const ri = inRange.get(n)
    if (ri !== undefined) { onChange(ranges.filter((_, i) => i !== ri)); setAnchor(null); return }
    if (anchor === null) { setAnchor(n); return }
    const s = Math.min(anchor, n)
    const e = Math.max(anchor, n)
    onChange([...ranges, [s, e]])
    setAnchor(null)
  }

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onCancel])

  return createPortal(
    <div className="kb-modal-backdrop" onClick={onCancel}>
      <div className="kb-preview kb-manual" onClick={e => e.stopPropagation()}>
        <div className="kb-preview-head">
          <FileText size={16} />
          <span className="kb-preview-title">手动分块 · {fileName}</span>
          <span className="kb-preview-stats">{ranges.length} 块 · 已覆盖 {inRange.size}/{lines.length} 行</span>
          <button className="kb-row-btn" onClick={onCancel} title="关闭"><X size={14} /></button>
        </div>
        <div className="kb-manual-tip">
          点击行号设为起点，再点另一行即成一个块（{anchor !== null ? `起点：第 ${anchor} 行` : '未选起点'}）；点击已覆盖的行可删除所在区间。未覆盖的 {uncovered} 行会自动并入最后一块，不会丢失。
        </div>
        <div className="kb-manual-body">
          {lines.map((l, i) => {
            const n = i + 1
            const ri = inRange.get(n)
            return (
              <div
                key={n}
                className={`kb-manual-line${ri !== undefined ? ` in-range r${ri % 6}` : ''}${anchor === n ? ' anchor' : ''}`}
                style={{ ['--ri' as string]: String(ri ?? 0) }}
                onClick={() => clickLine(n)}
              >
                <span className="kb-manual-num">{n}</span>
                <span className="kb-manual-text">{l || '\u00a0'}</span>
              </div>
            )
          })}
        </div>
        <div className="kb-manual-foot">
          <button className="kb-manual-btn" onClick={() => { onChange([]); setAnchor(null) }} disabled={busy}>清空</button>
          <span className="kb-manual-space" />
          <button className="kb-manual-btn" onClick={onCancel} disabled={busy}>取消</button>
          <button className="kb-manual-btn primary" onClick={onConfirm} disabled={busy || ranges.length === 0}>
            {busy ? '导入中…' : `确认导入（${ranges.length} 块）`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function KnowledgeView() {
  const [bases, setBases] = useState<KnowledgeBaseMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [ingestMsg, setIngestMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  // ── 用户可控分块设置（导入文档时生效）──
  const [chunkMode, setChunkMode] = useState<ChunkMode>('auto')
  const [chunkSize, setChunkSize] = useState(1000)
  const [chunkDelim, setChunkDelim] = useState('---')
  // 手动分块：拖入单个文件后打开行号预览，点击行号区间定义块边界
  const [manualEditor, setManualEditor] = useState<{ name: string; text: string } | null>(null)
  const [manualRanges, setManualRanges] = useState<number[][]>([])

  // 切换知识库时恢复该库自己的分块偏好（无记录则回默认值）
  useEffect(() => {
    if (!activeId) return
    const p = loadKbChunkPrefs()[activeId]
    setChunkMode(p?.mode ?? 'auto')
    setChunkSize(typeof p?.size === 'number' ? p.size : 1000)
    setChunkDelim(typeof p?.delimiter === 'string' ? p.delimiter : '---')
  }, [activeId])

  // 任一分块设置变化时写回当前库的偏好（下次进入该库自动还原）
  useEffect(() => {
    if (!activeId) return
    try {
      const all = loadKbChunkPrefs()
      all[activeId] = { mode: chunkMode, size: chunkSize, delimiter: chunkDelim }
      localStorage.setItem(KB_CHUNK_PREFS_KEY, JSON.stringify(all))
    } catch { /* ignore */ }
  }, [activeId, chunkMode, chunkSize, chunkDelim])
  // 删除确认悬浮弹窗（锚定在删除按钮旁）
  const [delPop, setDelPop] = useState<{ id: string; name: string; anchor: DOMRect } | null>(null)
  const delPopRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  // ── 文档内容预览（点击文档行打开）──
  const [previewDoc, setPreviewDoc] = useState<KnowledgeDoc | null>(null)
  const [docContent, setDocContent] = useState<KnowledgeDocContent | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'full' | 'chunks'>('full')
  const [copied, setCopied] = useState(false)
  // ── 预览内搜索高亮 ──
  const [hlQuery, setHlQuery] = useState('')
  const [hlIdx, setHlIdx] = useState(0)
  const previewBodyRef = useRef<HTMLDivElement>(null)

  // ── 行内重命名（库 / 文档共用）──
  const [renaming, setRenaming] = useState<{ kind: 'kb' | 'doc'; id: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 试搜索
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [lowConf, setLowConf] = useState(false)
  const [searched, setSearched] = useState(false)

  const activeBase = bases.find(b => b.id === activeId) || null

  const refreshBases = useCallback(async () => {
    const list = await window.api.knowledgeList().catch(() => [])
    setBases(list)
    return list
  }, [])

  const loadDocs = useCallback(async (kbId: string) => {
    const kb = await window.api.knowledgeGet(kbId).catch(() => null)
    setDocs(kb?.docs || [])
  }, [])

  useEffect(() => {
    refreshBases().then(list => {
      if (list.length > 0) setActiveId(prev => prev || list[0].id)
    })
  }, [refreshBases])

  useEffect(() => {
    if (activeId) { loadDocs(activeId); setHits([]); setSearched(false); setQuery('') }
    else setDocs([])
  }, [activeId, loadDocs])

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    const res = await window.api.knowledgeCreate(name)
    if (res.success && res.meta) {
      setNewName(''); setCreating(false)
      await refreshBases()
      setActiveId(res.meta.id)
    } else notify('创建失败：' + (res.error || '未知错误'), 'error')
  }

  // Esc 关闭删除确认悬浮弹窗
  useEffect(() => {
    if (!delPop) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDelPop(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [delPop])

  // 弹窗渲染后实测尺寸，精准锚在按钮旁：优先右侧垂直居中，空间不足翻到左侧
  useLayoutEffect(() => {
    const el = delPopRef.current
    if (!delPop || !el) return
    const { anchor } = delPop
    const w = el.offsetWidth
    const h = el.offsetHeight
    let x = anchor.right + 8
    if (x + w > window.innerWidth - 8) x = anchor.left - w - 8
    x = Math.max(8, x)
    let y = anchor.top + anchor.height / 2 - h / 2
    y = Math.max(8, Math.min(y, window.innerHeight - h - 8))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.visibility = 'visible'
  }, [delPop])

  function openDeletePop(e: React.MouseEvent, base: KnowledgeBaseMeta) {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDelPop({ id: base.id, name: base.name, anchor })
  }

  async function handleDeleteBase(id: string) {
    const res = await window.api.knowledgeDelete(id)
    if (res.success) {
      const list = await refreshBases()
      if (activeId === id) setActiveId(list[0]?.id || null)
    } else notify('删除失败：' + (res.error || '未知错误'), 'error')
  }

  const ingestFiles = useCallback(async (files: File[]) => {
    if (!activeId || files.length === 0) return
    // 手动分块：一次只处理一个文件，解析后打开行号预览编辑器，由用户确认后再入库
    if (chunkMode === 'manual') {
      if (files.length > 1) { notify('手动分块一次只能导入一个文件，请单独拖入', 'error'); return }
      setIngesting(true)
      setIngestMsg(`正在解析：${files[0].name}`)
      const text = await extractTextFromFile(files[0])
      setIngesting(false)
      setIngestMsg('')
      if (!text.trim()) { notify('文件无法解析或为空', 'error'); return }
      setManualRanges([])
      setManualEditor({ name: files[0].name, text })
      return
    }
    setIngesting(true)
    let ok = 0, skip = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setIngestMsg(`正在解析 ${i + 1}/${files.length}：${f.name}`)
      const text = await extractTextFromFile(f)
      if (!text.trim()) { skip++; continue }
      const res = await window.api.knowledgeAddDoc(activeId, {
        name: f.name,
        text,
        chunking: {
          mode: chunkMode,
          ...(chunkMode !== 'single' ? { size: chunkSize } : {}),
          ...(chunkMode === 'delim' ? { delimiter: chunkDelim } : {}),
          ...(chunkMode === 'code' ? { lang: (f.name.split('.').pop() || '').toLowerCase() } : {})
        }
      })
      if (res.success) ok++
      else skip++
    }
    setIngesting(false)
    setIngestMsg('')
    await loadDocs(activeId)
    await refreshBases()
    notify(`已添加 ${ok} 个文档${skip > 0 ? `，跳过 ${skip} 个（无法解析或为空）` : ''}`, ok > 0 ? 'success' : 'error')
  }, [activeId, loadDocs, refreshBases, chunkMode, chunkSize, chunkDelim])

  // 手动分块确认：按用户点击的行号区间入库
  const confirmManualChunks = useCallback(async () => {
    if (!activeId || !manualEditor || manualRanges.length === 0) return
    setIngesting(true)
    const res = await window.api.knowledgeAddDoc(activeId, {
      name: manualEditor.name,
      text: manualEditor.text,
      chunking: { mode: 'manual', ranges: manualRanges }
    })
    setIngesting(false)
    setManualEditor(null)
    setManualRanges([])
    if (res.success) notify(`已按 ${res.chunkCount ?? manualRanges.length} 块导入「${manualEditor.name}」`, 'success')
    else notify('导入失败：' + (res.error || '未知错误'), 'error')
    await loadDocs(activeId)
    await refreshBases()
  }, [activeId, manualEditor, manualRanges, loadDocs, refreshBases])

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) ingestFiles(files)
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) ingestFiles(files)
  }

  async function handleDeleteDoc(docId: string) {
    if (!activeId) return
    const res = await window.api.knowledgeDeleteDoc(activeId, docId)
    if (res.success) { await loadDocs(activeId); await refreshBases() }
  }

  async function handleSearch() {
    if (!activeId || !query.trim()) return
    setSearching(true); setSearched(true)
    const res = await window.api.knowledgeQuery(activeId, query.trim(), 6).catch(() => ({ hits: [], lowConfidence: true }))
    setHits(res.hits); setLowConf(res.lowConfidence)
    setSearching(false)
  }

  // ── 打开/关闭预览时加载文档全文 ──
  useEffect(() => {
    if (!previewDoc || !activeId) { setDocContent(null); return }
    let cancelled = false
    setContentLoading(true); setDocContent(null); setHlQuery(''); setHlIdx(0); setViewMode('full')
    window.api.knowledgeDocContent(activeId, previewDoc.id).then(res => {
      if (cancelled) return
      if (res.success && typeof res.text === 'string') {
        setDocContent({
          name: res.name ?? previewDoc.name, text: res.text,
          chunkCount: res.chunkCount ?? 0, chars: res.chars ?? res.text.length,
          chunks: res.chunks ?? []
        })
      } else {
        notify(res.error || '读取文档内容失败', 'error')
        setPreviewDoc(null)
      }
      setContentLoading(false)
    })
    return () => { cancelled = true }
  }, [previewDoc, activeId])

  // Esc 关闭预览
  useEffect(() => {
    if (!previewDoc) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreviewDoc(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [previewDoc])

  // 命中数（整篇文档范围统计，与视图模式无关）
  const matchCount = useMemo(() => {
    const q = hlQuery.trim().toLowerCase()
    if (!q || !docContent) return 0
    let n = 0, pos = 0
    const lower = docContent.text.toLowerCase()
    while ((pos = lower.indexOf(q, pos)) !== -1) { n++; pos += q.length }
    return n
  }, [hlQuery, docContent])

  // 高亮导航：把当前命中滚动到视口中央并标记 .cur
  useEffect(() => {
    const el = previewBodyRef.current
    if (!el || !hlQuery.trim()) return
    const marks = el.querySelectorAll('mark.kb-hl')
    marks.forEach(m => m.classList.remove('cur'))
    if (marks.length === 0) return
    const cur = marks[Math.min(hlIdx, marks.length - 1)]
    cur.classList.add('cur')
    cur.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [hlIdx, hlQuery, docContent, viewMode])

  function nextMatch() {
    if (matchCount === 0) return
    setHlIdx(i => (i + 1) % matchCount)
  }
  function prevMatch() {
    if (matchCount === 0) return
    setHlIdx(i => (i - 1 + matchCount) % matchCount)
  }

  async function handleCopyDoc() {
    if (!docContent) return
    try {
      await navigator.clipboard.writeText(docContent.text)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch { notify('复制失败', 'error') }
  }

  // ── 导出：JSON 下载 ──
  async function handleExport() {
    if (!activeBase) return
    const res = await window.api.knowledgeExport(activeBase.id)
    if (!res.success || !res.json) { notify(res.error || '导出失败', 'error'); return }
    const blob = new Blob([res.json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${res.name || activeBase.name}.kb.json`
    a.click()
    URL.revokeObjectURL(url)
    notify(`已导出「${activeBase.name}」`, 'success')
  }

  // ── 导入：读取 .kb.json → 建新库 ──
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const json = await f.text()
      const res = await window.api.knowledgeImport(json)
      if (res.success && res.meta) {
        await refreshBases()
        setActiveId(res.meta.id)
        notify(`已导入「${res.meta.name}」（${res.meta.docCount} 个文档）`, 'success')
      } else notify(res.error || '导入失败', 'error')
    } catch { notify('读取文件失败', 'error') }
  }

  // ── 行内重命名 ──
  function startRename(kind: 'kb' | 'doc', id: string, current: string) {
    setRenaming({ kind, id }); setRenameValue(current)
  }
  async function commitRename() {
    if (!renaming) return
    const v = renameValue.trim()
    const { kind, id } = renaming
    setRenaming(null)
    if (!v) return
    if (kind === 'kb') {
      const r = await window.api.knowledgeRename(id, v)
      if (r.success) await refreshBases()
      else notify(r.error || '重命名失败', 'error')
    } else if (activeId) {
      const r = await window.api.knowledgeRenameDoc(activeId, id, v)
      if (r.success) await loadDocs(activeId)
      else notify(r.error || '重命名失败', 'error')
    }
  }

  return (
    <div className="kb-view">
      <div className="kb-header">
        <BookOpen size={22} />
        <h2>知识库</h2>
        <span className="kb-header-hint">BM25 关键词检索 · 全程本地</span>
      </div>

      <div className="kb-body">
        {/* 左栏：知识库列表 */}
        <div className="kb-sidebar">
          <div className="kb-sidebar-head">
            <span>我的知识库</span>
            <div className="kb-sidebar-actions">
              <button className="btn btn-ghost btn-icon" title="导出当前知识库（JSON）" disabled={!activeBase} onClick={handleExport}>
                <Download size={15} />
              </button>
              <button className="btn btn-ghost btn-icon" title="导入知识库（.kb.json）" onClick={() => importInputRef.current?.click()}>
                <FileUp size={15} />
              </button>
              <button className="btn btn-ghost btn-icon" title="新建知识库" onClick={() => setCreating(v => !v)}>
                <Plus size={15} />
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </div>
          </div>
          {creating && (
            <div className="kb-create-row">
              <input
                autoFocus
                className="kb-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
                placeholder="知识库名称…"
              />
              <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={!newName.trim()}>创建</button>
            </div>
          )}
          <div className="kb-list">
            {bases.length === 0 && !creating && (
              <div className="kb-empty-sm">还没有知识库，点击 + 新建</div>
            )}
            {bases.map(b => (
              <div
                key={b.id}
                className={`kb-list-item ${activeId === b.id ? 'active' : ''}`}
                onClick={() => setActiveId(b.id)}
                onDoubleClick={() => startRename('kb', b.id, b.name)}
              >
                {renaming?.kind === 'kb' && renaming.id === b.id ? (
                  <input
                    autoFocus
                    className="kb-input kb-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                      e.stopPropagation()
                    }}
                  />
                ) : (
                  <div className="kb-list-item-main">
                    <span className="kb-list-item-name">{b.name}</span>
                    <span className="kb-list-item-sub">{b.docCount} 文档 · {b.chunkCount} 块</span>
                  </div>
                )}
                <div className="kb-row-actions">
                  {renaming?.kind !== 'kb' || renaming.id !== b.id ? (
                    <button
                      className="btn btn-ghost btn-icon kb-row-btn"
                      title="重命名"
                      onClick={(e) => { e.stopPropagation(); startRename('kb', b.id, b.name) }}
                    >
                      <Pencil size={12} />
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost btn-icon kb-row-btn"
                      title="确认"
                      onClick={(e) => { e.stopPropagation(); commitRename() }}
                    >
                      <Check size={13} />
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-icon text-danger kb-list-item-del"
                    title="删除知识库"
                    onClick={(e) => { e.stopPropagation(); openDeletePop(e, b) }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右栏：文档管理 + 试搜索 */}
        <div className="kb-main">
          {!activeBase ? (
            <div className="kb-empty">
              <BookOpen size={40} strokeWidth={1.2} style={{ opacity: 0.3 }} />
              <p>选择或新建一个知识库开始</p>
            </div>
          ) : (
            <>
              {/* 文档拖拽区 */}
              {/* 分块设置（对本次导入的所有文档生效）*/}
              <div className="kb-chunk-settings" onClick={e => e.stopPropagation()}>
                <Settings2 size={13} />
                <span className="kb-chunk-label">分块</span>
                <CustomSelect
                  value={chunkMode}
                  onChange={v => setChunkMode(v as ChunkMode)}
                  disabled={ingesting}
                  aria-label="选择文档切分方式"
                  className="kb-chunk-select"
                  options={[
                    { value: 'auto', label: '自动分段' },
                    { value: 'heading', label: '按 Markdown 标题' },
                    { value: 'delim', label: '自定义分隔符' },
                    { value: 'single', label: '整篇单块' },
                    { value: 'code', label: '代码结构' },
                    { value: 'manual', label: '手动点行号' }
                  ]}
                />
                {chunkMode === 'manual' && (
                  <span className="kb-chunk-hint">拖入单个文件 → 预览里逐对点击行号划块</span>
                )}
                {chunkMode !== 'single' && chunkMode !== 'manual' && (
                  <label>
                    块大小
                    <input
                      type="number" min={200} max={4000} step={100}
                      value={chunkSize}
                      disabled={ingesting}
                      onChange={e => setChunkSize(Math.max(200, Math.min(4000, parseInt(e.target.value) || 1000)))}
                      title="单块目标字符数（200-4000）"
                    />
                  </label>
                )}
                {chunkMode === 'delim' && (
                  <label>
                    分隔符
                    <input
                      type="text"
                      value={chunkDelim}
                      disabled={ingesting}
                      onChange={e => setChunkDelim(e.target.value)}
                      placeholder="如 --- 或 ==="
                      title="按此字符串切分文档，每段一块，不跨边界合并"
                    />
                  </label>
                )}
              </div>

              <div
                className={`kb-dropzone ${dragOver ? 'dragover' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => !ingesting && fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.pdf,.docx,.json,.csv,.log,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.html,.css,.xml,.yaml,.yml"
                  style={{ display: 'none' }}
                  onChange={handleFileInput}
                />
                {ingesting ? (
                  <><Loader2 size={20} className="kb-spin" /><span>{ingestMsg || '正在导入…'}</span></>
                ) : (
                  <><Upload size={20} /><span>拖入或点击选择文档（txt / md / pdf / docx / 代码）</span></>
                )}
              </div>

              {/* 文档列表（点击行查看内容） */}
              <div className="kb-doc-list">
                {docs.length === 0 ? (
                  <div className="kb-empty-sm">该知识库还没有文档</div>
                ) : docs.map(d => (
                  <div key={d.id} className="kb-doc-row" onClick={() => setPreviewDoc(d)} title="点击查看文档内容">
                    <FileText size={15} className="kb-doc-icon" />
                    {renaming?.kind === 'doc' && renaming.id === d.id ? (
                      <input
                        autoFocus
                        className="kb-input kb-rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setRenaming(null)
                          e.stopPropagation()
                        }}
                      />
                    ) : (
                      <span className="kb-doc-name" title={d.name}>{d.name}</span>
                    )}
                    <span className="kb-doc-chunks">
                      {d.chunkMode && <span className="kb-doc-mode">{d.chunkMode}</span>}
                      {d.chunkCount} 块 · {formatChars(d.chars)}
                    </span>
                    <div className="kb-row-actions" onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-icon kb-row-btn" title="预览内容" onClick={() => setPreviewDoc(d)}>
                        <Eye size={12} />
                      </button>
                      {renaming?.kind !== 'doc' || renaming.id !== d.id ? (
                        <button className="btn btn-ghost btn-icon kb-row-btn" title="重命名" onClick={() => startRename('doc', d.id, d.name)}>
                          <Pencil size={12} />
                        </button>
                      ) : (
                        <button className="btn btn-ghost btn-icon kb-row-btn" title="确认" onClick={() => commitRename()}>
                          <Check size={13} />
                        </button>
                      )}
                      <button className="btn btn-ghost btn-icon text-danger" title="删除文档" onClick={() => handleDeleteDoc(d.id)}>
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 试搜索 */}
              <div className="kb-search">
                <div className="kb-search-bar">
                  <Search size={15} />
                  <input
                    className="kb-input"
                    value={query}
                    onChange={e => {
                      setQuery(e.target.value)
                      // 清空输入即复位结果区，恢复默认布局（不留旧卡片）
                      if (!e.target.value.trim()) { setSearched(false); setHits([]); setLowConf(false) }
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
                    placeholder="试搜索：输入关键词，验证检索质量…"
                  />
                  <button className="btn btn-primary btn-sm" onClick={handleSearch} disabled={!query.trim() || searching}>
                    {searching ? <Loader2 size={13} className="kb-spin" /> : '搜索'}
                  </button>
                </div>
                {searched && (
                  <div className="kb-hits">
                    {hits.length === 0 ? (
                      <div className="kb-empty-sm">未检索到相关内容</div>
                    ) : (
                      <>
                        {lowConf && <div className="kb-lowconf">命中置信度较低，结果可能不相关</div>}
                        {hits.map((h, i) => (
                          <div key={i} className="kb-hit">
                            <div className="kb-hit-head">
                              <span className="kb-hit-doc">{h.docName} · 第 {h.ordinal + 1} 块</span>
                              <span className="kb-hit-score">{h.score.toFixed(2)}</span>
                            </div>
                            <div className="kb-hit-text"><Hl text={h.text} q={query} /></div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 文档内容预览：Portal 到 body 的居中大面板（全文/分块双视图 + 关键词高亮导航） */}
      {manualEditor && createPortal(
        <ManualChunkModal
          fileName={manualEditor.name}
          text={manualEditor.text}
          ranges={manualRanges}
          onChange={setManualRanges}
          onCancel={() => { setManualEditor(null); setManualRanges([]) }}
          onConfirm={confirmManualChunks}
          busy={ingesting}
        />,
        document.body
      )}
      {previewDoc && createPortal(
        <>
          <div className="kb-modal-backdrop" onClick={() => setPreviewDoc(null)} />
          <div className="kb-preview">
            <div className="kb-preview-head">
              <FileText size={16} className="kb-doc-icon" />
              <span className="kb-preview-title" title={docContent?.name || previewDoc.name}>{docContent?.name || previewDoc.name}</span>
              <span className="kb-preview-stats">
                {contentLoading ? '读取中…' : `${docContent?.chunkCount ?? 0} 块 · ${formatChars(docContent?.chars)}`}
              </span>
              <div className="kb-view-toggle">
                <button className={viewMode === 'full' ? 'on' : ''} onClick={() => setViewMode('full')}>全文</button>
                <button className={viewMode === 'chunks' ? 'on' : ''} onClick={() => setViewMode('chunks')}>分块</button>
              </div>
              <div className="kb-hl-bar">
                <Search size={12} />
                <input
                  className="kb-input kb-hl-input"
                  value={hlQuery}
                  onChange={e => { setHlQuery(e.target.value); setHlIdx(0) }}
                  onKeyDown={e => { if (e.key === 'Enter') nextMatch() }}
                  placeholder="预览内搜索…"
                />
                {hlQuery.trim() && (
                  <>
                    <span className="kb-hl-count">{matchCount > 0 ? `${Math.min(hlIdx, matchCount - 1) + 1}/${matchCount}` : '无命中'}</span>
                    <button className="btn btn-ghost btn-icon" disabled={matchCount === 0} onClick={prevMatch}><ChevronUp size={13} /></button>
                    <button className="btn btn-ghost btn-icon" disabled={matchCount === 0} onClick={nextMatch}><ChevronDown size={13} /></button>
                  </>
                )}
              </div>
              <button className="btn btn-ghost btn-icon" title="复制全文" disabled={!docContent} onClick={handleCopyDoc}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button className="btn btn-ghost btn-icon text-danger" title="关闭（Esc）" onClick={() => setPreviewDoc(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="kb-preview-body" ref={previewBodyRef}>
              {contentLoading ? (
                <div className="kb-preview-loading"><Loader2 size={22} className="kb-spin" /></div>
              ) : !docContent ? (
                <div className="kb-empty-sm">无法加载文档内容</div>
              ) : viewMode === 'full' ? (
                <div className="kb-preview-text"><Hl text={docContent.text} q={hlQuery} /></div>
              ) : (
                <div className="kb-chunk-list">
                  {docContent.chunks.map(c => (
                    <div key={c.ordinal} className="kb-chunk-card">
                      <div className="kb-chunk-head">第 {c.ordinal + 1} 块 · {c.text.replace(/\s/g, '').length.toLocaleString()} 字</div>
                      <div className="kb-chunk-text"><Hl text={c.text} q={hlQuery} /></div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>,
        document.body
      )}

      {/* 删除确认悬浮弹窗：Portal 到 body，锚定在删除按钮旁 */}
      {delPop && createPortal(
        <>
          <div className="kb-del-pop-backdrop" onClick={() => setDelPop(null)} />
          <div ref={delPopRef} className="kb-del-pop" style={{ visibility: 'hidden' }}>
            <div className="kb-del-pop-title">
              <AlertTriangle size={13} />
              <span>删除知识库</span>
            </div>
            <div className="kb-del-pop-msg">「{delPop.name}」的所有文档与索引都会被移除，不可撤销。</div>
            <div className="kb-del-pop-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setDelPop(null)}>取消</button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => { handleDeleteBase(delPop.id); setDelPop(null) }}
              >删除</button>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
