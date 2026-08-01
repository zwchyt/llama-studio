import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { ChevronDown, ChevronRight, Copy, Check, Search, Lock } from 'lucide-react'
import type { CommandParam, TemplateArgs, CommandsSchema } from '../../../shared/types'
import { iconElements } from '../utils/iconMap'
import CustomSelect from './CustomSelect'
import ModelFileSelect from './ModelFileSelect'

const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']
interface Props {
  templateId?: string
  /** 无 templateId 时（如新建模板弹窗）显式指定后端，用于预览命令与隐藏参数判断 */
  backendName?: string
  args: TemplateArgs
  onChange?: (args: TemplateArgs) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
  /** 参数集选择（参数设置里切换）：'llamacpp' → commands.json，'tensorsharp' → commands-tensorsharp.json */
  paramSet?: 'llamacpp' | 'tensorsharp'
  onParamSetChange?: (s: 'llamacpp' | 'tensorsharp') => void
}
export default function CmdParamsEditor({ templateId, backendName, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp, paramSet, onParamSetChange }: Props) {
  const { commandsSchema, updateCard, cards, imageModels, chatTemplates, backends } = useStore(s => ({ commandsSchema: s.commandsSchema, updateCard: s.updateCard, cards: s.cards, imageModels: s.imageModels, chatTemplates: s.chatTemplates, backends: s.backends }), shallow)
  const setChatTemplates = useStore(s => s.setChatTemplates)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [descTooltip, setDescTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [copiedParam, setCopiedParam] = useState<string | null>(null)
  const initialSchemaRef = useRef(true)

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning
  // 预览跟随参数集选择（切换参数集时 exe 标志和参数形态同步切换）
  const resolvedBackend = backends.find(b => b.name === (card?.template.backendVersion || backendName))
  const effectiveParamSet: 'llamacpp' | 'tensorsharp' = paramSet ?? (resolvedBackend?.kind === 'tensorsharp' ? 'tensorsharp' : 'llamacpp')
  const isTensorSharp = effectiveParamSet === 'tensorsharp'
  // 预览 exe 跟随参数集：参数集决定命令格式，与实际后端 exe 无关
  const backendExe = isTensorSharp ? 'TensorSharp.Server' : 'llama-server'
  const activeArgs = args
  // 按参数集拉取专属 schema（llama.cpp → commands.json，TensorSharp → commands-tensorsharp.json）
  const [localSchema, setLocalSchema] = useState<CommandsSchema | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.getCommands(backendName ?? '', effectiveParamSet).then((cmds) => {
      if (!cancelled && cmds) setLocalSchema(cmds)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [backendName, effectiveParamSet])
  const activeSchema = localSchema ?? commandsSchema
  // 当前参数集允许的参数名集合（用于预览过滤：只显示属于当前参数集的参数）
  const allowedArgs = useMemo(() => {
    if (!activeSchema) return new Set<string>()
    const s = new Set<string>()
    for (const cat of activeSchema.categories) {
      for (const cmd of cat.commands || []) {
        if (cmd.arg) s.add(cmd.arg)
        if (cmd.short) s.add(cmd.short)
      }
    }
    return s
  }, [activeSchema])
  const handleParamSetChange = (next: 'llamacpp' | 'tensorsharp') => {
    if (next === effectiveParamSet) return
    onParamSetChange?.(next)
  }

  useEffect(() => {
    window.api.listChatTemplates().then(setChatTemplates).catch(() => {})
  }, [])

  useEffect(() => {
    if (activeSchema) {
      if (initialSchemaRef.current) {
        initialSchemaRef.current = false
        const initialCollapsed = new Set<string>()
        activeSchema.categories.forEach(cat => {
          initialCollapsed.add(cat.name)
        })
        setCollapsedCategories(initialCollapsed)
      }
    }
  }, [activeSchema])

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
      const modelFlag = isTensorSharp ? '--model' : '-m'
      items.push({ id: 'model', label: modelFlag, value: `"${finalModelPath}"`, fullText: `${modelFlag} "${finalModelPath}"` })
    }
    Object.entries(activeArgs).forEach(([key, val]) => {
      // 只显示当前参数集允许的参数（避免另一引擎的参数残留在预览里）
      if (!allowedArgs.has(key)) return
      // --urls（TensorSharp 端口）由应用统一管理，避免与自动追加的端口参数重复
      if (key === '--urls' && isTensorSharp) return
      if (val === true) {
        items.push({ id: key, label: key, fullText: key })
      } else if (val !== false && val !== null && val !== '') {
        items.push({ id: key, label: key, value: String(val), fullText: `${key} ${val}` })
      }
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    // TensorSharp 监听地址固定 http://0.0.0.0:5000，无端口参数，预览不显示端口项
    if (finalPort && !isTensorSharp && activeArgs['--port'] === undefined) {
      items.push({ id: '--port', label: '--port', value: String(finalPort), fullText: `--port ${finalPort}` })
    }
    return items
  }, [activeArgs, cards, templateId, modelPathFallback, serverPortFallback, isTensorSharp, allowedArgs])

  const fullCommand = useMemo(() => {
    let cmd = backendExe
    cmdPreviewItems.forEach(item => {
      cmd += ` ${item.fullText}`
    })
    return cmd
  }, [cmdPreviewItems, backendExe])

  const copyText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      /* fall through to legacy method */
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  const handleCopyAll = async () => {
    const ok = await copyText(fullCommand)
    if (ok) {
      setCopiedParam('__all__')
      setTimeout(() => setCopiedParam(null), 1500)
    }
  }
  const filteredCategories = useMemo(() => {
    if (!activeSchema) return []
    const q = searchQuery.toLowerCase()
    if (q) {
      return activeSchema.categories.map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd =>
          cmd.label.toLowerCase().includes(q) ||
          cmd.arg.toLowerCase().includes(q) ||
          (cmd.short && cmd.short.toLowerCase().includes(q))
        )
      })).filter(cat => cat.commands.length > 0)
    }
    let allCommands: CommandParam[] = []
    activeSchema.categories.forEach(cat => allCommands.push(...cat.commands))
    const featuredCommands = allCommands.filter(c => FEATURED_ARGS.includes(c.arg))
    const cats = activeSchema.categories.map(cat => ({
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
  }, [activeSchema, searchQuery])
  if (!activeSchema) {
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
    // --model 始终隐藏；端口参数按引擎类型隐藏（llama.cpp: --port，TensorSharp: --urls）
    if (cmd.arg === '--model') return null
    if (isTensorSharp ? cmd.arg === '--urls' : cmd.arg === '--port') return null
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
          {cmd.type === 'string' && cmd.arg === '--mmproj' && (
            <ModelFileSelect
              className="cmd-select-mmproj"
              value={val}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              items={imageModels}
              defaultLabel="不指定"
              disabled={disabled}
              ariaLabel="--mmproj"
            />
          )}
          {cmd.type === 'string' && cmd.arg === '--chat-template-file' && (
            <ModelFileSelect
              className="cmd-select-chat-template"
              value={val}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              items={chatTemplates}
              defaultLabel="Default"
              disabled={disabled}
              ariaLabel="--chat-template-file"
            />
          )}
          {cmd.type === 'string' && cmd.arg !== '--mmproj' && cmd.arg !== '--chat-template-file' && (
            <input type="text" className="cmd-input" value={typeof val === 'boolean' ? '' : val} placeholder={cmd.placeholder || cmd.default?.toString()} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
          )}
          {cmd.type === 'select' && (
            <CustomSelect
              value={typeof val === 'boolean' ? '' : val}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              options={[
                { value: '', label: 'Default' },
                ...(cmd.options?.map(opt => ({ value: opt, label: opt })) || [])
              ]}
              disabled={disabled}
              aria-label={cmd.arg}
            />
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
      <div className="param-set-row" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="text-muted text-sm" style={{ flexShrink: 0 }}>参数集</span>
        <div className="launch-mode-row" style={{ flex: 1 }}>
          <button
            type="button"
            className={`launch-mode-btn ${effectiveParamSet === 'llamacpp' ? 'active' : ''}`}
            onClick={() => handleParamSetChange('llamacpp')}
            disabled={disabled}
          >
            llama.cpp
          </button>
          <button
            type="button"
            className={`launch-mode-btn ${effectiveParamSet === 'tensorsharp' ? 'active' : ''}`}
            onClick={() => handleParamSetChange('tensorsharp')}
            disabled={disabled}
          >
            TensorSharp
          </button>
        </div>
      </div>
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
          <div className="cmd-section-header preview-header" data-section="preview">
            <span className="preview-title">Preview</span>
            <button
              type="button"
              className="cmd-copy-all-btn"
              data-action="copy-all"
              onClick={handleCopyAll}
            >
              {copiedParam === '__all__' ? <Check size={12} /> : <Copy size={12} />}
              {copiedParam === '__all__' ? '已复制' : '复制全部'}
            </button>
          </div>
          <div className="cmd-preview">
            <span className="cmd-preview-base">{backendExe}</span>
            {cmdPreviewItems.map((item) => (
              <span
                key={item.id}
                className="cmd-preview-item-wrap"
              >
                <span className="cmd-preview-item">
                  {' '}
                  <span className="arg">{item.label}</span>
                  {item.value && <> <span className="val">{item.value}</span></>}
                </span>
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
