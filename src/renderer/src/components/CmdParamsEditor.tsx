import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { ChevronDown, ChevronRight, Copy, Check, Search, Lock } from 'lucide-react'
import type { CommandParam, TemplateArgs } from '../../../shared/types'
import { iconElements } from '../utils/iconMap'

const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']
interface Props {
  templateId?: string
  args: TemplateArgs
  onChange?: (args: TemplateArgs) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
}
export default function CmdParamsEditor({ templateId, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp }: Props) {
  const { commandsSchema, updateCard, cards } = useStore(s => ({ commandsSchema: s.commandsSchema, updateCard: s.updateCard, cards: s.cards }), shallow)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [hoveredParam, setHoveredParam] = useState<string | null>(null)
  const [descTooltip, setDescTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [copiedParam, setCopiedParam] = useState<string | null>(null)
  const initialSchemaRef = useRef(true)

  useEffect(() => {
    if (commandsSchema) {
      if (initialSchemaRef.current) {
        initialSchemaRef.current = false
        const initialCollapsed = new Set<string>()
        commandsSchema.categories.forEach(cat => {
          initialCollapsed.add(cat.name)
        })
        setCollapsedCategories(initialCollapsed)
      }
    }
  }, [commandsSchema])

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning

  interface PreviewParam {
    id: string
    label: string
    value?: string
    fullText: string
  }

  const cmdPreviewItems = useMemo(() => {
    const items: PreviewParam[] = []
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) {
      items.push({ id: 'model', label: '-m', value: `"${finalModelPath}"`, fullText: `-m "${finalModelPath}"` })
    }
    Object.entries(args).forEach(([key, val]) => {
      if (val === true) {
        items.push({ id: key, label: key, fullText: key })
      } else if (val !== false && val !== null && val !== '') {
        items.push({ id: key, label: key, value: String(val), fullText: `${key} ${val}` })
      }
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && args['--port'] === undefined) {
      items.push({ id: '--port', label: '--port', value: String(finalPort), fullText: `--port ${finalPort}` })
    }
    return items
  }, [args, cards, templateId, modelPathFallback, serverPortFallback])

  const fullCommand = useMemo(() => {
    let cmd = 'llama-server'
    cmdPreviewItems.forEach(item => {
      cmd += ` ${item.fullText}`
    })
    return cmd
  }, [cmdPreviewItems])

  const handleCopyParam = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedParam(id)
    setTimeout(() => setCopiedParam(null), 1500)
  }

  const handleCopyAll = async () => {
    await navigator.clipboard.writeText(fullCommand)
    setCopiedParam('__all__')
    setTimeout(() => setCopiedParam(null), 1500)
  }
  const filteredCategories = useMemo(() => {
    if (!commandsSchema) return []
    const q = searchQuery.toLowerCase()
    if (q) {
      return commandsSchema.categories.map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd =>
          cmd.label.toLowerCase().includes(q) ||
          cmd.arg.toLowerCase().includes(q) ||
          (cmd.short && cmd.short.toLowerCase().includes(q))
        )
      })).filter(cat => cat.commands.length > 0)
    }
    let allCommands: CommandParam[] = []
    commandsSchema.categories.forEach(cat => allCommands.push(...cat.commands))
    const featuredCommands = allCommands.filter(c => FEATURED_ARGS.includes(c.arg))
    const cats = commandsSchema.categories.map(cat => ({
      ...cat,
      commands: cat.commands.filter(c => !FEATURED_ARGS.includes(c.arg))
    })).filter(cat => cat.commands.length > 0)
    if (featuredCommands.length > 0) {
      featuredCommands.sort((a, b) => FEATURED_ARGS.indexOf(a.arg) - FEATURED_ARGS.indexOf(b.arg))
      cats.unshift({
        name: '主要设置',
        icon: 'Star',
        commands: featuredCommands
      })
    }
    return cats
  }, [commandsSchema, searchQuery])
  if (!commandsSchema) {
    return <div className="text-muted text-sm">No commands schema loaded. Ensure a backend is installed.</div>
  }
  const handleUpdate = (argName: string, value: any) => {
    if (onChange) {
      const newArgs = { ...args }
      if (value === null || value === false || value === '') {
        delete newArgs[argName]
      } else {
        newArgs[argName] = value
      }
      onChange(newArgs)
    } else if (templateId) {
      const { cards } = useStore.getState()
      const card = cards.find(c => c.template.id === templateId)
      const latestArgs = card?.template.args || {}
      const newArgs = { ...latestArgs }
      if (value === null || value === false || value === '') {
        delete newArgs[argName]
      } else {
        newArgs[argName] = value
      }
      updateCard(templateId, { args: newArgs })
    }
  }

  const toggleCategory = (catName: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(catName)) {
        next.delete(catName)
      } else {
        next.add(catName)
      }
      return next
    })
  }

  const isCategoryCollapsed = (catName: string) => {
    if (searchQuery) return false
    return collapsedCategories.has(catName)
  }
  const renderCommand = (cmd: CommandParam) => {
    if (cmd.arg === '--model' || cmd.arg === '--port') return null
    const val = args[cmd.arg] ?? (cmd.type === 'boolean' ? false : '')
    const isActive = args[cmd.arg] !== undefined && args[cmd.arg] !== false && args[cmd.arg] !== ''
    return (
      <div key={cmd.arg} className={`cmd-row ${isActive ? 'active-param' : ''} ${cmd.type === 'text' ? 'cmd-row-full' : ''}`}>
          <div
            className="cmd-label-group"
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setDescTooltip({ text: cmd.description, x: rect.left, y: rect.bottom + 4 })
            }}
            onMouseLeave={() => setDescTooltip(null)}
          >
            <div className="cmd-label">
              {cmd.label}
            </div>
            <div className="cmd-arg">{cmd.short ? `${cmd.short}, ` : ''}{cmd.arg}</div>
          </div>
        <div className="cmd-input-group">
          {cmd.type === 'boolean' && (
            <div className="toggle-wrap">
              <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
                <input type="checkbox" checked={!!val} onChange={(e) => handleUpdate(cmd.arg, e.target.checked)} disabled={disabled} aria-label={cmd.arg} />
                <span className="toggle-track"></span>
                <span className="toggle-thumb"></span>
              </label>
            </div>
          )}
          {cmd.type === 'number' && (
            <div className="num-input-wrap">
              <button className="num-btn" onClick={() => handleUpdate(cmd.arg, Math.max((cmd.min ?? -Infinity), (Number(val) || 0) - 1))} disabled={disabled}>-</button>
              <input
                type="number" className="cmd-input num" value={typeof val === 'boolean' ? '' : val} placeholder={cmd.default?.toString()} min={cmd.min} max={cmd.max} step="any"
                onChange={(e) => handleUpdate(cmd.arg, e.target.value === '' ? '' : Number(e.target.value))}
                disabled={disabled}
              />
              <button className="num-btn" onClick={() => handleUpdate(cmd.arg, Math.min((cmd.max ?? Infinity), (Number(val) || 0) + 1))} disabled={disabled}>+</button>
            </div>
          )}
          {cmd.type === 'string' && (
            <input type="text" className="cmd-input" value={typeof val === 'boolean' ? '' : val} placeholder={cmd.placeholder || cmd.default?.toString()} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
          )}
          {cmd.type === 'select' && (
            <select className="cmd-select" value={typeof val === 'boolean' ? '' : val} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} aria-label={cmd.arg}>
              <option value="">Default</option>
              {cmd.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </div>
        {cmd.type === 'text' && (
          <textarea className="cmd-textarea" value={typeof val === 'boolean' ? '' : val} placeholder={cmd.placeholder} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
        )}
      </div>
    )
  }
  return (
    <div className="params-editor-container">
      {disabled && isRunning && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', marginBottom: 12, borderRadius: 8,
          background: 'var(--surface-2, rgba(255,255,255,0.04))',
          border: '1px solid var(--border, rgba(255,255,255,0.08))',
          color: 'var(--text-muted)', fontSize: 12
        }}>
          <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
          Parameters are locked while the model is running. Stop it first to make changes.
        </div>
      )}
      <div className="params-search-box">
        <Search size={16} style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          className="form-input"
          placeholder="Search parameters..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="params-scroll-area" style={disabled ? { opacity: 0.55, pointerEvents: 'none', userSelect: 'none' } : {}}>
        {filteredCategories.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted">No parameters matched your search.</div>
        ) : (
          filteredCategories.map((cat) => {
            const isCollapsed = isCategoryCollapsed(cat.name)
            const isMainSettings = cat.name === '主要设置'
            return (
              <div key={cat.name} className="cmd-section">
                <div
                  className={`cmd-section-header ${isMainSettings ? 'main-settings-header' : 'collapsible-section-header'}`}
                  style={isMainSettings ? { color: 'var(--text)' } : {}}
                  onClick={() => !isMainSettings && toggleCategory(cat.name)}
                >
                  {!isMainSettings && (
                    <span className="section-chevron">
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                  )}
                  {iconElements[cat.icon]} {cat.name}
                </div>
                <div className={`cmd-grid-wrapper ${isCollapsed ? 'cmd-grid-collapsed' : ''}`}>
                  <div className="cmd-grid">
                    {cat.commands.map(renderCommand)}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div className="cmd-section" style={{ marginBottom: 0, marginTop: 16 }}>
          <div className="cmd-section-header">
            Preview
            <button
              className="cmd-copy-all-btn"
              onClick={handleCopyAll}
              title="复制完整命令"
            >
              {copiedParam === '__all__' ? <Check size={12} /> : <Copy size={12} />}
              {copiedParam === '__all__' ? '已复制' : '复制全部'}
            </button>
          </div>
          <div className="cmd-preview">
            <span className="cmd-preview-base">llama-server</span>
            {cmdPreviewItems.map((item) => (
              <span
                key={item.id}
                className="cmd-preview-item-wrap"
                onMouseEnter={() => setHoveredParam(item.id)}
                onMouseLeave={() => setHoveredParam(null)}
              >
                <span className="cmd-preview-item">
                  {' '}
                  <span className="arg">{item.label}</span>
                  {item.value && <> <span className="val">{item.value}</span></>}
                </span>
                {hoveredParam === item.id && (
                  <button
                    className="cmd-param-copy-btn"
                    onClick={() => handleCopyParam(item.fullText, item.id)}
                    title="复制此参数"
                  >
                    {copiedParam === item.id ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
      {descTooltip && (
        <div
          className="tooltip visible"
          style={{ position: 'fixed', left: descTooltip.x, top: descTooltip.y, zIndex: 10000 }}
        >
          {descTooltip.text}
        </div>
      )}
    </div>
  )
}
