import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { ChevronDown, ChevronRight, Copy, Check, Search, Lock } from 'lucide-react'
import { CpuIcon, ZapIcon, TimerIcon, SparklesIcon, ImageIcon } from '@animateicons/react/lucide'
import type { CommandParam, TemplateArgs, CommandsSchema } from '../../../shared/types'
import { iconComponents } from '../utils/iconMap'
import { ENGINE_LABELS, paramSetOf, ALL_ENGINES } from '../utils/engine'
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
  /** 参数集选择（参数设置里切换）：'llamacpp' → commands.json，'tensorsharp' → commands-tensorsharp.json，llama.cpp 分支 → 各自专属文件 */
  paramSet?: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp'
  onParamSetChange?: (s: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp') => void
}
export default function CmdParamsEditor({ templateId, backendName, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp, paramSet, onParamSetChange }: Props) {
  const { commandsSchema, updateCard, cards, imageModels, chatTemplates, backends, models } = useStore(s => ({ commandsSchema: s.commandsSchema, updateCard: s.updateCard, cards: s.cards, imageModels: s.imageModels, chatTemplates: s.chatTemplates, backends: s.backends, models: s.models }), shallow)
  // stable-diffusion.cpp 图像生成组件下拉数据源（来自设置里的 sd 模型文件夹）
  const sdVaeModels = models.filter(m => m.sdRole === 'vae')
  const sdLlmModels = models.filter(m => m.sdRole === 'llm')
  const setChatTemplates = useStore(s => s.setChatTemplates)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [descTooltip, setDescTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [copiedParam, setCopiedParam] = useState<string | null>(null)
  const initialSchemaRef = useRef(true)
  const catIconRefs = useRef<Record<string, { startAnimation: () => void; stopAnimation: () => void }>>({})
  const engineIconRefs = useRef<Record<string, { startAnimation: () => void; stopAnimation: () => void }>>({})
  const engineIconMap: Record<string, React.ElementType> = {
    llamacpp: CpuIcon,
    tensorsharp: ZapIcon,
    turboquant: TimerIcon,
    beellama: SparklesIcon,
    sdcpp: ImageIcon
  }

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning
  // 预览跟随参数集选择（切换参数集时 exe 标志和参数形态同步切换）
  const resolvedBackend = backends.find(b => b.name === (card?.template.backendVersion || backendName))
  const effectiveParamSet = paramSet ?? paramSetOf(resolvedBackend?.kind)
  const isTensorSharp = effectiveParamSet === 'tensorsharp'
  const isSdcpp = effectiveParamSet === 'sdcpp'
  // 预览 exe 跟随参数集：参数集决定命令格式，与实际后端 exe 无关
  const backendExe = isTensorSharp ? 'TensorSharp.Server' : isSdcpp ? 'sd-server' : 'llama-server'
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
  const handleParamSetChange = (next: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp') => {
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
      // stable-diffusion.cpp 的扩散模型用 --diffusion-model（Z-Image 等 GGUF 必须，-m 识别不了）
      const modelFlag = isTensorSharp ? '--model' : isSdcpp ? '--diffusion-model' : '-m'
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
    // TensorSharp 监听地址固定 http://0.0.0.0:5000，无端口参数，预览不显示端口项；
    // stable-diffusion.cpp 的 sd-server 端口参数是 --listen-port（默认 1234）
    if (finalPort && !isTensorSharp && activeArgs['--port'] === undefined) {
      const portFlag = isSdcpp ? '--listen-port' : '--port'
      items.push({ id: portFlag, label: portFlag, value: String(finalPort), fullText: `${portFlag} ${finalPort}` })
    }
    return items
  }, [activeArgs, cards, templateId, modelPathFallback, serverPortFallback, isTensorSharp, isSdcpp, allowedArgs])

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
    // --model / --diffusion-model 始终隐藏（由模板模型路径统一管理）；端口参数由应用统一管理，按引擎类型隐藏
    // （llama.cpp: --port，TensorSharp: --urls，stable-diffusion.cpp: --listen-port）
    if (cmd.arg === '--model' || cmd.arg === '--diffusion-model') return null
    if (isTensorSharp ? cmd.arg === '--urls' : isSdcpp ? cmd.arg === '--listen-port' : cmd.arg === '--port') return null
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
          {cmd.type === 'string' && cmd.arg === '--vae' && (
            <ModelFileSelect
              className="cmd-select-vae"
              value={val}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              items={sdVaeModels}
              defaultLabel="不指定"
              disabled={disabled}
              ariaLabel="--vae"
            />
          )}
          {cmd.type === 'string' && cmd.arg === '--llm' && (
            <ModelFileSelect
              className="cmd-select-llm"
              value={val}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              items={sdLlmModels}
              defaultLabel="不指定"
              disabled={disabled}
              ariaLabel="--llm"
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
          {cmd.type === 'string' && cmd.arg !== '--mmproj' && cmd.arg !== '--chat-template-file' && cmd.arg !== '--vae' && cmd.arg !== '--llm' && (
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
          {ALL_ENGINES.map(e => {
            const installed = backends.some(b => b.kind === e)
            const EngineIcon = engineIconMap[e]
            return (
              <button
                key={e}
                type="button"
                className={`launch-mode-btn ${effectiveParamSet === e ? 'active' : ''}`}
                onClick={() => handleParamSetChange(e)}
                disabled={disabled || !installed}
                title={installed ? undefined : `${ENGINE_LABELS[e]} 尚未安装，可在设置中下载`}
                onMouseEnter={() => engineIconRefs.current[e]?.startAnimation?.()}
                onMouseLeave={() => engineIconRefs.current[e]?.stopAnimation?.()}
              >
                {EngineIcon && React.createElement(EngineIcon, {
                  ref: (el: any) => {
                    if (el) engineIconRefs.current[e] = el
                  },
                  size: 12,
                  className: 'nav-animate-icon'
                })}
                {ENGINE_LABELS[e]}
              </button>
            )
          })}
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
            const CatIcon = iconComponents[cat.icon] ?? null
            return (
              <div key={cat.name} className="cmd-section">
                <div
                  className={`cmd-section-header ${isMainSettings ? 'main-settings-header' : 'collapsible-section-header'}`}
                  style={isMainSettings ? { color: 'var(--text)' } : {}}
                  onClick={() => !isMainSettings && toggleCategory(cat.name)}
                  onMouseEnter={() => catIconRefs.current[cat.name]?.startAnimation?.()}
                  onMouseLeave={() => catIconRefs.current[cat.name]?.stopAnimation?.()}
                >
                  {!isMainSettings && (
                    <span className="section-chevron">
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                  )}
                  {CatIcon && React.createElement(CatIcon, {
                    ref: (el: any) => {
                      if (el) catIconRefs.current[cat.name] = el
                    },
                    size: 14,
                    className: 'nav-animate-icon'
                  })}
                  {cat.name}
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
