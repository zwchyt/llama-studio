import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { Plus, Trash, ChevronDown, ChevronRight, Save, RotateCcw, Pencil, Check, X, Loader2 } from 'lucide-react'
import type { CommandsSchema, CommandCategory, CommandParam } from '../../../shared/types'
import { iconComponents, ICON_NAMES } from '../utils/iconMap'

const PARAM_TYPES = ['boolean', 'number', 'string', 'select', 'text']
const emptyCmd = (): CommandParam => ({
  arg: '', label: '', description: '', type: 'string', placeholder: ''
})
const emptyCategory = (): CommandCategory => ({
  name: 'New Category', icon: 'Sliders', commands: []
})
interface CmdFormProps {
  cmd: CommandParam
  onChange: (c: CommandParam) => void
  onDelete: () => void
}
function CmdForm({ cmd, onChange, onDelete }: CmdFormProps) {
  const set = (k: keyof CommandParam, v: any) => onChange({ ...cmd, [k]: v })
  return (
    <div className="ce-cmd-form">
      <div className="ce-cmd-form-grid">
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label">Argument (flag)</label>
          <input className="form-input" value={cmd.arg} onChange={e => set('arg', e.target.value)} placeholder="--ctx-size" aria-label="Argument (flag)" />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label">Short flag</label>
          <input className="form-input" value={cmd.short || ''} onChange={e => set('short', e.target.value)} placeholder="-c" aria-label="Short flag" />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label">Label</label>
          <input className="form-input" value={cmd.label} onChange={e => set('label', e.target.value)} placeholder="Context Size" aria-label="Label" />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label">Type</label>
          <select className="form-select" value={cmd.type} onChange={e => set('type', e.target.value)} aria-label="Type">
            {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {cmd.type === 'number' && (
          <>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Min</label>
              <input className="form-input" type="number" value={cmd.min ?? ''} onChange={e => set('min', e.target.value ? Number(e.target.value) : undefined)} aria-label="Min" />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Max</label>
              <input className="form-input" type="number" value={cmd.max ?? ''} onChange={e => set('max', e.target.value ? Number(e.target.value) : undefined)} aria-label="Max" />
            </div>
          </>
        )}
        {cmd.type === 'select' && (
          <div className="form-group" style={{ marginBottom: 8, gridColumn: '1/-1' }}>
            <label className="form-label">Options (comma-separated)</label>
            <input className="form-input" value={(cmd.options || []).join(',')} onChange={e => set('options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="auto,none,f16,q8_0" aria-label="Options" />
          </div>
        )}
        <div className="form-group" style={{ marginBottom: 8, gridColumn: '1/-1' }}>
          <label className="form-label">Description</label>
          <input className="form-input" value={cmd.description} onChange={e => set('description', e.target.value)} placeholder="What this parameter does..." aria-label="Description" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Default</label>
          <input className="form-input" value={String(cmd.default ?? '')} onChange={e => set('default', e.target.value)} placeholder="default value" aria-label="Default" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Placeholder</label>
          <input className="form-input" value={cmd.placeholder || ''} onChange={e => set('placeholder', e.target.value)} aria-label="Placeholder" />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm text-danger" onClick={onDelete}>
          <Trash size={13} /> Remove command
        </button>
      </div>
    </div>
  )
}
interface CategorySectionProps {
  cat: CommandCategory
  catIndex: number
  onChange: (c: CommandCategory) => void
  onDelete: () => void
}
function CategorySection({ cat, catIndex: _catIndex, onChange, onDelete }: CategorySectionProps) {
  const [open, setOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [pickingIcon, setPickingIcon] = useState(false)
  const [nameVal, setNameVal] = useState(cat.name)
  const [expandedCmds, setExpandedCmds] = useState<Set<number>>(new Set())
  const iconRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (iconRef.current && !iconRef.current.contains(e.target as Node)) setPickingIcon(false)
    }
    if (pickingIcon) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [pickingIcon])
  function updateCmd(i: number, cmd: CommandParam) {
    const cmds = [...cat.commands]; cmds[i] = cmd; onChange({ ...cat, commands: cmds })
  }
  function deleteCmd(i: number) {
    onChange({ ...cat, commands: cat.commands.filter((_, idx) => idx !== i) })
    setExpandedCmds(prev => { const s = new Set(prev); s.delete(i); return s })
  }
  function addCmd() {
    const newCmds = [...cat.commands, emptyCmd()]
    onChange({ ...cat, commands: newCmds })
    setExpandedCmds(prev => new Set([...prev, newCmds.length - 1]))
  }
  function toggleCmd(i: number) {
    setExpandedCmds(prev => {
      const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s
    })
  }
  function saveName() { onChange({ ...cat, name: nameVal }); setEditingName(false) }
  return (
    <div className="ce-category">
      <div className="ce-category-header" onClick={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {editingName ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
              <input className="form-input" style={{ padding: '3px 8px', fontSize: 12 }} value={nameVal} onChange={e => setNameVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveName() }} autoFocus aria-label="Category name" />
              <button className="btn btn-ghost btn-icon" style={{ padding: 3 }} onClick={saveName} aria-label="保存名称"><Check size={12} /></button>
              <button className="btn btn-ghost btn-icon" style={{ padding: 3 }} onClick={() => setEditingName(false)} aria-label="取消编辑"><X size={12} /></button>
            </div>
          ) : (
            <>
              <span className="ce-cat-name">{cat.name}</span>
              <span className="ce-cat-count">{cat.commands.length} commands</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, position: 'relative' }} ref={iconRef} onClick={e => e.stopPropagation()}>
          <button 
            className="btn btn-ghost btn-icon" 
            style={{ padding: 4 }} 
            onClick={() => setPickingIcon(!pickingIcon)}
            title={`Category Icon: ${cat.icon}`}
          >
            {React.createElement(iconComponents[cat.icon] || iconComponents.Sliders, { size: 14 })}
          </button>
          {pickingIcon && (
            <div className="dropdown-menu" style={{ right: 'auto', left: 0, minWidth: 'auto', padding: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, zIndex: 100 }}>
              {ICON_NAMES.map(i => (
                <button 
                  key={i}
                  className={`btn btn-ghost btn-icon`} 
                  style={{ padding: 6, background: cat.icon === i ? 'var(--border)' : 'transparent' }}
                  title={i}
                  onClick={() => { onChange({ ...cat, icon: i }); setPickingIcon(false) }}
                >
                  {React.createElement(iconComponents[i] || iconComponents.Sliders, { size: 14 })}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-ghost btn-icon" style={{ padding: 4 }} onClick={() => setEditingName(true)} title="Rename"><Pencil size={12} /></button>
          <button className="btn btn-ghost btn-icon text-danger" style={{ padding: 4 }} onClick={onDelete} title="Delete category"><Trash size={12} /></button>
        </div>
      </div>
      {open && (
        <div className="ce-category-body">
          {cat.commands.map((cmd, i) => (
            <div key={i} className="ce-cmd-item">
              <div className="ce-cmd-item-header" onClick={() => toggleCmd(i)}>
                {expandedCmds.has(i) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="ce-cmd-arg">{cmd.arg || <em style={{ color: 'var(--text-muted)' }}>new command</em>}</span>
                <span className="ce-cmd-label">{cmd.label}</span>
                <span className="ce-cmd-type-badge">{cmd.type}</span>
              </div>
              {expandedCmds.has(i) && (
                <CmdForm cmd={cmd} onChange={c => updateCmd(i, c)} onDelete={() => deleteCmd(i)} />
              )}
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={addCmd}>
            <Plus size={13} /> Add Command
          </button>
        </div>
      )}
    </div>
  )
}
export default function CommandsEditor({ backendName }: { backendName: string }) {
  const { setCommandsSchema } = useStore(s => ({ setCommandsSchema: s.setCommandsSchema }), shallow)
  const [schema, setSchema] = useState<CommandsSchema | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setLoading(true)
    window.api.getCommands(backendName).then(s => {
      setSchema(s ? JSON.parse(JSON.stringify(s)) : { version: '1.0', categories: [] })
      setLoading(false)
    })
  }, [backendName])
  async function handleSave() {
    if (!schema) return
    setSaving(true)
    const res = await window.api.saveBackendCommands(backendName, schema)
    setSaving(false)
    if (res.success) {
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      const updated = await window.api.getCommands(backendName)
      if (updated) setCommandsSchema(updated)
    } else { notify('Save failed: ' + res.error, 'error') }
  }
  async function handleReset() {
    if (!confirm('Reset to current saved schema?')) return
    setLoading(true)
    const s = await window.api.getCommands(backendName)
    setSchema(s ? JSON.parse(JSON.stringify(s)) : null)
    setLoading(false)
  }
  function addCategory() {
    if (!schema) return
    setSchema({ ...schema, categories: [...schema.categories, emptyCategory()] })
  }
  function updateCategory(i: number, cat: CommandCategory) {
    if (!schema) return
    const cats = [...schema.categories]; cats[i] = cat
    setSchema({ ...schema, categories: cats })
  }
  function deleteCategory(i: number) {
    if (!schema) return
    setSchema({ ...schema, categories: schema.categories.filter((_, idx) => idx !== i) })
  }
  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>Loading schema...</div>
  if (!schema) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No schema available.</div>
  return (
    <div className="ce-container">
      <div className="ce-toolbar">
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {schema.categories.length} categories · {schema.categories.reduce((a, c) => a + c.commands.length, 0)} commands
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={handleReset}><RotateCcw size={13} /> Reset</button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={13} className="spin" /> : saved ? <Check size={13} /> : <Save size={13} />}
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
      {schema.categories.map((cat, i) => (
        <CategorySection
          key={i} cat={cat} catIndex={i}
          onChange={c => updateCategory(i, c)}
          onDelete={() => deleteCategory(i)}
        />
      ))}
      <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={addCategory}>
        <Plus size={13} /> Add Category
      </button>
    </div>
  )
}
