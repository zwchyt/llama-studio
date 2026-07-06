import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { X, Search, Copy, Check, Lock } from 'lucide-react'
import type { CommandParam, TemplateArgs } from '../../../shared/types'
import { iconElements } from '../utils/iconMap'
import CustomSelect from './CustomSelect'

const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']

interface Props {
  templateId: string
  args: TemplateArgs
  onClose: () => void
  cardName: string
}

export default function ParamsModal({ templateId, args, onClose, cardName }: Props) {
  const { commandsSchema, cards } = useStore(s => ({ commandsSchema: s.commandsSchema, cards: s.cards }), shallow)
  const updateCard = useStore(s => s.updateCard)
  const imageModels = useStore(s => s.imageModels)
  const [activeTab, setActiveTab] = useState('主要设置')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredParam, setHoveredParam] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [copiedParam, setCopiedParam] = useState<string | null>(null)

  const card = cards.find(c => c.template.id === templateId)
  const isRunning = card?.status === 'running'
  const disabled = isRunning

  // debounce save: 合并高频写入，400ms 内只触发一次 IPC
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingArgsRef = useRef<TemplateArgs | null>(null)

  const flushSave = useCallback(() => {
    if (pendingArgsRef.current === null) return
    const { cards } = useStore.getState()
    const card = cards.find(c => c.template.id === templateId)
    if (card) {
      window.api.saveTemplate({ ...card.template, args: pendingArgsRef.current })
    }
    pendingArgsRef.current = null
  }, [templateId])

  // 组件卸载或关闭时确保落盘
  useEffect(() => () => { flushSave() }, [flushSave])

  const handleUpdate = useCallback((argName: string, value: any) => {
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

    // debounce 持久化
    pendingArgsRef.current = newArgs
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 400)
  }, [templateId, updateCard, flushSave])

  const tabs = useMemo(() => {
    if (!commandsSchema) return []
    const allCmds: CommandParam[] = []
    commandsSchema.categories.forEach(cat => allCmds.push(...cat.commands))
    const featured = allCmds
      .filter(c => FEATURED_ARGS.includes(c.arg))
      .sort((a, b) => FEATURED_ARGS.indexOf(a.arg) - FEATURED_ARGS.indexOf(b.arg))
    const tabList: { name: string; icon: React.ReactNode; commands: CommandParam[] }[] = []
    if (featured.length > 0) {
      tabList.push({ name: '主要设置', icon: iconElements['Star'] ?? null, commands: featured })
    }
    for (const cat of commandsSchema.categories) {
      const filtered = cat.commands.filter(cmd => cmd.arg !== '--model' && cmd.arg !== '--port')
      if (filtered.length > 0) {
        tabList.push({ name: cat.name, icon: iconElements[cat.icon] ?? null, commands: filtered })
      }
    }
    return tabList
  }, [commandsSchema])

  const currentCommands = useMemo(() => {
    if (!commandsSchema) return []
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const results: CommandParam[] = []
      for (const cat of commandsSchema.categories) {
        for (const cmd of cat.commands) {
          if (cmd.arg === '--model' || cmd.arg === '--port') continue
          if (
            cmd.label.toLowerCase().includes(q) ||
            cmd.arg.toLowerCase().includes(q) ||
            (cmd.short && cmd.short.toLowerCase().includes(q))
          ) {
            results.push(cmd)
          }
        }
      }
      return results
    }
    const activeTabData = tabs.find(t => t.name === activeTab)
    if (!activeTabData && tabs.length > 0) return tabs[0].commands
    return activeTabData?.commands ?? []
  }, [commandsSchema, searchQuery, activeTab, tabs])

  const cmdPreviewItems = useMemo(() => {
    const items: { id: string; label: string; value?: string; fullText: string }[] = []
    const finalModelPath = card?.template.modelPath
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
    const finalPort = card?.template.serverPort
    if (finalPort && args['--port'] === undefined) {
      items.push({ id: '--port', label: '--port', value: String(finalPort), fullText: `--port ${finalPort}` })
    }
    return items
  }, [args, card])

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

  const renderCommand = (cmd: CommandParam) => {
    const rawVal = args[cmd.arg]
    const isActive = rawVal !== undefined && rawVal !== false && rawVal !== ''
    const val = rawVal ?? (cmd.type === 'boolean' ? false : '')
    const displayVal: string | number = val === false || val === null || val === true ? '' : val
    return (
      <div
          key={cmd.arg}
          className={`cmd-row ${isActive ? 'active-param' : ''} ${cmd.type === 'text' ? 'cmd-row-full' : ''}`}
        >
          <div
            className="cmd-label-group"
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setHoveredParam(cmd.arg)
              setTooltipPos({ x: rect.left, y: rect.bottom + 4 })
            }}
            onMouseLeave={() => { setHoveredParam(null); setTooltipPos(null) }}
          >
            <div className="cmd-label">{cmd.label}</div>
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
                type="number" className="cmd-input num" value={displayVal} placeholder={cmd.default?.toString()} min={cmd.min} max={cmd.max} step="any"
                onChange={(e) => handleUpdate(cmd.arg, e.target.value === '' ? '' : Number(e.target.value))}
                disabled={disabled}
              />
              <button className="num-btn" onClick={() => handleUpdate(cmd.arg, Math.min((cmd.max ?? Infinity), (Number(val) || 0) + 1))} disabled={disabled}>+</button>
            </div>
          )}
          {cmd.type === 'string' && cmd.arg === '--mmproj' && (
            <CustomSelect
              className="cmd-select-mmproj"
              value={displayVal}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              options={[
                { value: '', label: '不指定' },
...imageModels.map(m => ({ value: m.path, label: m.name })),
                 ...(displayVal && !imageModels.find(m => m.path === displayVal) ? [{ value: String(displayVal), label: String(displayVal).split(/[/\\]/).pop() ?? '' }] : [])
              ]}
              disabled={disabled}
              aria-label="--mmproj"
            />
          )}
          {cmd.type === 'string' && cmd.arg !== '--mmproj' && (
            <input type="text" className="cmd-input" value={displayVal} placeholder={cmd.placeholder || cmd.default?.toString()} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
          )}
          {cmd.type === 'select' && (
            <CustomSelect
              value={displayVal}
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
          <textarea className="cmd-textarea" value={displayVal} placeholder={cmd.placeholder} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
        )}
      </div>
    )
  }

  if (!commandsSchema) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal modal-params" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h2 className="modal-title">参数设置</h2>
              <div className="param-modal-subtitle">{cardName}</div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭">
              <X size={20} />
            </button>
          </div>
          <div className="modal-body">
            <div className="text-muted text-sm">参数 schema 未加载，请确保已安装后端。</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-params" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">参数设置</h2>
            <div className="param-modal-subtitle">{cardName}</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body param-modal-body">
          {disabled && (
            <div className="param-locked-banner">
              <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
              参数已锁定：模型正在运行，请先停止后再修改。
            </div>
          )}

          <div className="params-search-box" style={{ margin: '0 20px 16px' }}>
            <Search size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="搜索参数..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {!searchQuery && tabs.length > 0 && (
            <div className="param-tabs">
              {tabs.map(tab => (
                <button
                  key={tab.name}
                  className={`param-tab ${activeTab === tab.name ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.name)}
                >
                  {tab.icon} {tab.name}
                </button>
              ))}
            </div>
          )}

          <div
            className="param-content"
            style={disabled ? { opacity: 0.55, pointerEvents: 'none', userSelect: 'none' } : {}}
          >
            {currentCommands.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted">无匹配参数。</div>
            ) : (
              <div className="cmd-grid">
                {currentCommands.map(renderCommand)}
              </div>
            )}
          </div>
        </div>

        <div className="params-preview">
          <div className="params-preview-header">
            <span>Preview</span>
            <button className="cmd-copy-all-btn" onClick={handleCopyAll} title="复制完整命令">
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
          {hoveredParam && tooltipPos && (() => {
            const desc = currentCommands.find(c => c.arg === hoveredParam)?.description
            return desc ? (
              <div
                className="tooltip visible"
                style={{ position: 'fixed', left: tooltipPos.x, top: tooltipPos.y, zIndex: 10000 }}
              >
                {desc}
              </div>
            ) : null
          })()}
        </div>
      </div>
    </div>
  )
}
