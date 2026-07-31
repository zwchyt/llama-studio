import React, { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, Plus, Trash2, FileText, Loader2, Search, Upload, X } from 'lucide-react'
import { notify } from '../store/notificationStore'
import { extractTextFromFile } from '../utils/extractText'
import type { KnowledgeBaseMeta, KnowledgeDoc, KnowledgeHit } from '../../../shared/types'
import '../styles/knowledge.css'

export default function KnowledgeView() {
  const [bases, setBases] = useState<KnowledgeBaseMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [ingestMsg, setIngestMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  async function handleDeleteBase(id: string) {
    if (!confirm('确定删除该知识库？其中所有文档与索引都会被移除，不可撤销。')) return
    const res = await window.api.knowledgeDelete(id)
    if (res.success) {
      const list = await refreshBases()
      if (activeId === id) setActiveId(list[0]?.id || null)
    } else notify('删除失败：' + (res.error || '未知错误'), 'error')
  }

  const ingestFiles = useCallback(async (files: File[]) => {
    if (!activeId || files.length === 0) return
    setIngesting(true)
    let ok = 0, skip = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setIngestMsg(`正在解析 ${i + 1}/${files.length}：${f.name}`)
      const text = await extractTextFromFile(f)
      if (!text.trim()) { skip++; continue }
      const res = await window.api.knowledgeAddDoc(activeId, { name: f.name, text })
      if (res.success) ok++
      else skip++
    }
    setIngesting(false)
    setIngestMsg('')
    await loadDocs(activeId)
    await refreshBases()
    notify(`已添加 ${ok} 个文档${skip > 0 ? `，跳过 ${skip} 个（无法解析或为空）` : ''}`, ok > 0 ? 'success' : 'error')
  }, [activeId, loadDocs, refreshBases])

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
            <button className="btn btn-ghost btn-icon" onClick={() => setCreating(v => !v)} title="新建知识库">
              <Plus size={15} />
            </button>
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
              >
                <div className="kb-list-item-main">
                  <span className="kb-list-item-name">{b.name}</span>
                  <span className="kb-list-item-sub">{b.docCount} 文档 · {b.chunkCount} 块</span>
                </div>
                <button
                  className="btn btn-ghost btn-icon text-danger kb-list-item-del"
                  onClick={(e) => { e.stopPropagation(); handleDeleteBase(b.id) }}
                  title="删除知识库"
                >
                  <Trash2 size={13} />
                </button>
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

              {/* 文档列表 */}
              <div className="kb-doc-list">
                {docs.length === 0 ? (
                  <div className="kb-empty-sm">该知识库还没有文档</div>
                ) : docs.map(d => (
                  <div key={d.id} className="kb-doc-row">
                    <FileText size={15} className="kb-doc-icon" />
                    <span className="kb-doc-name" title={d.name}>{d.name}</span>
                    <span className="kb-doc-chunks">{d.chunkCount} 块</span>
                    <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleDeleteDoc(d.id)} title="移除文档">
                      <X size={13} />
                    </button>
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
                    onChange={e => setQuery(e.target.value)}
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
                            <div className="kb-hit-text">{h.text.length > 400 ? h.text.slice(0, 400) + '…' : h.text}</div>
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
    </div>
  )
}
