import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { Search, Copy, Check, Lock } from 'lucide-react'
import type { CommandParam, Template, TemplateArgs, CommandsSchema } from '../../../shared/types'
import { iconElements } from '../utils/iconMap'
import { ENGINE_LABELS, paramSetOf, ALL_ENGINES } from '../utils/engine'
import CustomSelect from './CustomSelect'
import ModelFileSelect from './ModelFileSelect'

const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']

interface Props {
  templateId: string
  args: TemplateArgs
  onClose: () => void
  cardName: string
}

export default function ParamsModal({ templateId, args, onClose, cardName }: Props) {
  const { commandsSchema, cards, imageModels, chatTemplates, paramTooltipEnabled, backends, setActiveBackend } = useStore(s => ({ commandsSchema: s.commandsSchema, cards: s.cards, imageModels: s.imageModels, chatTemplates: s.chatTemplates, paramTooltipEnabled: s.paramTooltipEnabled, backends: s.backends, setActiveBackend: s.setActiveBackend }), shallow)
  const updateCard = useStore(s => s.updateCard)
  const setChatTemplates = useStore(s => s.setChatTemplates)
  const [activeTab, setActiveTab] = useState('主要设置')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredParam, setHoveredParam] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [copiedParam, setCopiedParam] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)

  const card = cards.find(c => c.template.id === templateId)
  const isRunning = card?.status === 'running'
  const disabled = isRunning
  // 参数集：模板里手动选择的优先，未选时按后端类型默认；切换按钮在下方
  const [paramSet, setParamSet] = useState(() => {
    const b = backends.find(x => x.name === card?.template.backendVersion)
    return paramSetOf(card?.template.paramSet ?? b?.kind)
  })
  // 按卡片自身的参数集拉取 schema（不依赖全局 activeBackend 的 schema）
  const [localSchema, setLocalSchema] = useState<CommandsSchema | null>(null)
  // 预览跟随参数集选择（切换参数集时 exe 标志和参数形态同步切换）
  const isTensorSharp = paramSet === 'tensorsharp'
  // 预览 exe 跟随参数集：参数集决定命令格式，与实际后端 exe 无关
  const backendExe = isTensorSharp ? 'TensorSharp.Server' : 'llama-server'
  const activeArgs = args

  // debounce save: 合并高频写入，400ms 内只触发一次 IPC
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<Partial<Template> | null>(null)

  const flushSave = useCallback(() => {
    if (!pendingSaveRef.current) return
    const { cards } = useStore.getState()
    const card = cards.find(c => c.template.id === templateId)
    if (card) {
      window.api.saveTemplate({ ...card.template, ...pendingSaveRef.current })
    }
    pendingSaveRef.current = null
  }, [templateId])

  // 组件卸载或关闭时确保落盘
  useEffect(() => () => { flushSave() }, [flushSave])

  // 按卡片参数集拉取专属 schema；切换参数集时重新拉取
  const backendName = card?.template.backendVersion ?? ''
  useEffect(() => {
    let cancelled = false
    window.api.getCommands(backendName, paramSet).then((cmds) => {
      if (!cancelled && cmds) setLocalSchema(cmds)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [backendName, paramSet])
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

  // 切换参数集：更新显示 + 切换活跃后端 + 切换后端版本 + 保存到模板。
  // 目标引擎后端未安装时也持久化参数集选择（否则关闭弹窗后切换丢失，与编辑模板界面不同步）
  const handleParamSetChange = useCallback((next: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama') => {
    if (next === paramSet) return
    setParamSet(next)
    // 同步切换活跃后端到对应引擎 + 更新模板后端版本
    const targetBackend = backends.find(b => b.kind === next)
    const nextPort = next === 'tensorsharp' ? 5000 : 8080
    const { cards } = useStore.getState()
    const card = cards.find(c => c.template.id === templateId)
    if (card) {
      const patch: Partial<Template> = { paramSet: next, serverPort: nextPort }
      if (targetBackend) {
        setActiveBackend(targetBackend)
        patch.backendVersion = targetBackend.name
      }
      updateCard(templateId, patch)
      pendingSaveRef.current = patch
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 400)
  }, [paramSet, backends, setActiveBackend, templateId, updateCard, flushSave])

  useEffect(() => {
    window.api.listChatTemplates().then(setChatTemplates).catch(() => {})
  }, [])

  // 关闭动画结束（或兜底定时器）后真正卸载；closedRef 防止重复调用
  const closedRef = useRef(false)
  const doClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }, [onClose])

  // 点击遮罩 / 关闭按钮 / Esc：先播放关闭动画，结束后再真正卸载
  const handleClose = useCallback(() => {
    setClosing(true)
    // 兜底：万一 animationend 未触发（动画被中断/替换等），
    // 定时强制卸载，避免透明遮罩残留在 DOM 中挡住界面交互
    window.setTimeout(doClose, 220)
  }, [doClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  const handleUpdate = useCallback((argName: string, value: any) => {
    const { cards } = useStore.getState()
    const card = cards.find(c => c.template.id === templateId)
    if (!card) return
    // 写入模板 args（参数集已按引擎专属文件加载，这里只记录用户修改的值）
    const latestArgs = card?.template.args || {}
    const newArgs = { ...latestArgs }
    if (value === null || value === false || value === '') {
      delete newArgs[argName]
    } else {
      newArgs[argName] = value
    }
    updateCard(templateId, { args: newArgs })

    // debounce 持久化
    pendingSaveRef.current = { args: newArgs }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 400)
  }, [templateId, updateCard, flushSave])

  const tabs = useMemo(() => {
    if (!activeSchema) return []
    const allCmds: CommandParam[] = []
    activeSchema.categories.forEach(cat => allCmds.push(...cat.commands))
    const featured = allCmds
      .filter(c => FEATURED_ARGS.includes(c.arg))
      .sort((a, b) => FEATURED_ARGS.indexOf(a.arg) - FEATURED_ARGS.indexOf(b.arg))
    const tabList: { name: string; icon: React.ReactNode; commands: CommandParam[] }[] = []
    if (featured.length > 0) {
      tabList.push({ name: '主要设置', icon: iconElements['Star'] ?? null, commands: featured })
    }
    for (const cat of activeSchema.categories) {
      const filtered = cat.commands.filter(cmd => cmd.arg !== '--model' && cmd.arg !== '--port' && cmd.arg !== '--urls')
      if (filtered.length > 0) {
        tabList.push({ name: cat.name, icon: iconElements[cat.icon] ?? null, commands: filtered })
      }
    }
    return tabList
  }, [activeSchema])

  const currentCommands = useMemo(() => {
    if (!activeSchema) return []
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const results: CommandParam[] = []
      for (const cat of activeSchema.categories) {
        for (const cmd of cat.commands) {
          if (cmd.arg === '--model' || cmd.arg === '--port' || cmd.arg === '--urls') continue
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
  }, [activeSchema, searchQuery, activeTab, tabs])

  const cmdPreviewItems = useMemo(() => {
    const items: { id: string; label: string; value?: string; fullText: string }[] = []
    const finalModelPath = card?.template.modelPath
    if (finalModelPath) {
      const modelFlag = isTensorSharp ? '--model' : '-m'
      items.push({ id: 'model', label: modelFlag, value: `"${finalModelPath}"`, fullText: `${modelFlag} "${finalModelPath}"` })
    }
    Object.entries(activeArgs).forEach(([key, val]) => {
      // 只显示当前参数集允许的参数（避免另一引擎的参数残留在预览里）
      if (!allowedArgs.has(key)) return
      if (val === true) {
        items.push({ id: key, label: key, fullText: key })
      } else if (val !== false && val !== null && val !== '') {
        items.push({ id: key, label: key, value: String(val), fullText: `${key} ${val}` })
      }
    })
    // TensorSharp 监听地址固定 http://0.0.0.0:5000，无端口参数，预览不显示端口项
    const finalPort = card?.template.serverPort
    if (finalPort && !isTensorSharp && activeArgs['--port'] === undefined) {
      items.push({ id: '--port', label: '--port', value: String(finalPort), fullText: `--port ${finalPort}` })
    }
    return items
  }, [activeArgs, card, isTensorSharp, allowedArgs])

  const fullCommand = useMemo(() => {
    let cmd = backendExe
    cmdPreviewItems.forEach(item => {
      cmd += ` ${item.fullText}`
    })
    return cmd
  }, [cmdPreviewItems, backendExe])

  const handleCopyAll = async () => {
    await navigator.clipboard.writeText(fullCommand)
    setCopiedParam('__all__')
    setTimeout(() => setCopiedParam(null), 1500)
  }

  // 只复制参数部分（去掉 llama-server 与 -m "模型路径" 开头）
  const argsOnly = useMemo(
    () => cmdPreviewItems
      .filter(item => item.id !== 'model')
      .map(item => item.fullText)
      .join(' '),
    [cmdPreviewItems]
  )
  const handleCopyArgs = async () => {
    await navigator.clipboard.writeText(argsOnly)
    setCopiedParam('__args__')
    setTimeout(() => setCopiedParam(null), 1500)
  }

  const renderCommand = (cmd: CommandParam) => {
    const rawVal = activeArgs[cmd.arg]
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
            <ModelFileSelect
              className="cmd-select-mmproj"
              value={displayVal}
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
              value={displayVal}
              onChange={(v) => handleUpdate(cmd.arg, v)}
              items={chatTemplates}
              defaultLabel="Default"
              disabled={disabled}
              ariaLabel="--chat-template-file"
            />
          )}
          {cmd.type === 'string' && cmd.arg !== '--mmproj' && cmd.arg !== '--chat-template-file' && (
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

  if (!activeSchema) {
    return (
      <div
        className={`modal-overlay modal-overlay--plain${closing ? ' closing' : ''}`}
        onClick={handleClose}
        onContextMenu={(e) => {
          // 在输入框/文本域/下拉等可编辑元素上保留原生右键菜单，不关闭
          const t = e.target as HTMLElement
          if (t.closest('input, textarea, select, [contenteditable="true"]')) return
          e.preventDefault()
          handleClose()
        }}
      >
        <div className="modal modal-params" onClick={e => e.stopPropagation()} onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) doClose() }}>
          <div className="modal-header">
            <div>
              <h2 className="modal-title">参数设置</h2>
              <div className="param-modal-subtitle">{cardName}</div>
            </div>
          </div>
          <div className="modal-body">
            <div className="text-muted text-sm">参数 schema 未加载，请确保已安装后端。</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`modal-overlay modal-overlay--plain${closing ? ' closing' : ''}`}
      onClick={handleClose}
      onContextMenu={(e) => {
        // 在输入框/文本域/下拉等可编辑元素上保留原生右键菜单，不关闭
        const t = e.target as HTMLElement
        if (t.closest('input, textarea, select, [contenteditable="true"]')) return
        e.preventDefault()
        handleClose()
      }}
    >
      <div className="modal modal-params" onClick={e => e.stopPropagation()} onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) doClose() }}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">参数设置</h2>
            <div className="param-modal-subtitle">{cardName}</div>
          </div>
        </div>

        <div className="modal-body param-modal-body">
          {disabled && (
            <div className="param-locked-banner">
              <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
              参数已锁定：模型正在运行，请先停止后再修改。
            </div>
          )}

          <div className="param-set-row" style={{ margin: '0 20px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="text-muted text-sm" style={{ flexShrink: 0 }}>参数集</span>
            <div className="launch-mode-row" style={{ flex: 1 }}>
              {ALL_ENGINES.map(e => {
                const installed = backends.some(b => b.kind === e)
                return (
                  <button
                    key={e}
                    type="button"
                    className={`launch-mode-btn ${paramSet === e ? 'active' : ''}`}
                    onClick={() => handleParamSetChange(e)}
                    disabled={disabled || !installed}
                    title={installed ? undefined : `${ENGINE_LABELS[e]} 尚未安装，可在设置中下载`}
                  >
                    {ENGINE_LABELS[e]}
                  </button>
                )
              })}
            </div>
          </div>

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
              <div className="cmd-grid" key={activeTab}>
                {currentCommands.map(renderCommand)}
              </div>
            )}
          </div>
        </div>

        <div className="params-preview">
          <div className="params-preview-header">
            <span>Preview</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="cmd-copy-all-btn" onClick={handleCopyArgs}>
                {copiedParam === '__args__' ? <Check size={12} /> : <Copy size={12} />}
                {copiedParam === '__args__' ? '已复制' : '复制参数'}
              </button>
              <button className="cmd-copy-all-btn" onClick={handleCopyAll}>
                {copiedParam === '__all__' ? <Check size={12} /> : <Copy size={12} />}
                {copiedParam === '__all__' ? '已复制' : '复制全部'}
              </button>
            </div>
          </div>
          <div className="cmd-preview">
            <span className="cmd-preview-base">{backendExe}</span>
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
              </span>
            ))}
          </div>
          {paramTooltipEnabled && hoveredParam && tooltipPos && (() => {
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
